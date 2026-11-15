// Bot move search. Pure and synchronous: given what a bot can see (the board
// and its own rack) it returns the full board it wants to commit, or null to
// draw. The table runs this inside a Web Worker; tests run it directly.
//
// The result is only a proposal. The table still sends it through the same
// commitTurn() validation as a human's move, and this module also checks its
// own answer with validateTurn() before returning it.
//
// Levels
//   easy    initial meld from rack-only sets worth 30+. Afterwards: new sets
//           from the rack, plus single tiles added to the ends of runs or into
//           groups. Never rearranges the table.
//   normal  everything easy does, plus rearranging: splitting a run to insert
//           a tile, and taking a tile off a group of 4, the end of a run (or the
//           middle of a long run) to complete a new set with rack tiles.
//           Picks the moves that play the most tile value from the rack.
//
// Bots never take jokers off the table (whatever joker rule is active): a
// joker already on the table must keep standing for the same tile.

import { parseTile, isJoker, tileValue, COLORS } from '../game/tiles.js';
import { analyzeSet, jokerRoles, validateTurn, INITIAL_MELD_POINTS } from '../game/rules.js';

const CODE = { black: 'k', red: 'r', blue: 'b', orange: 'o' };
const kindOf = (id) => (isJoker(id) ? 'J' : id.slice(0, -1)); // "r10a" -> "r10"
const sum = (a) => a.reduce((s, n) => s + n, 0);
const defaultNow = () => (globalThis.performance?.now ? performance.now() : Date.now());

/**
 * @param {object} o
 * @param {string[][]} o.board       sets currently on the table
 * @param {string[]}   o.rack        the bot's rack
 * @param {boolean}    o.hasMelded   whether the bot made its initial meld
 * @param {boolean}   [o.strictJokers=true]
 * @param {'easy'|'normal'} [o.level='normal']
 * @param {number}    [o.budgetMs=1500]  wall-clock limit; the best move found so far is returned
 * @param {number}    [o.maxNodes=60000] cap on set-packing search nodes (keeps tests deterministic)
 * @param {() => number} [o.now]
 * @returns {{sets: string[][], played: string[], value: number} | null}  null = draw
 */
export function findMove({
  board, rack, hasMelded, strictJokers = true, level = 'normal',
  budgetMs = 1500, maxNodes = 60000, now = defaultNow,
}) {
  const deadline = now() + budgetMs;
  const clock = { timeUp: () => now() >= deadline, maxNodes };
  const check = (sets) => {
    const v = validateTurn({ before: board, after: sets, rack, hasMelded, strictJokers });
    return v.ok ? { sets: v.sets, played: v.played, value: sum(v.played.map(tileValue)) } : null;
  };

  // Before the initial meld: rack-only sets, table untouched, 30+ points.
  if (!hasMelded) {
    const sets = pack(rack, 'meld', clock).sets;
    if (!sets.length) return null;
    const meld = sum(sets.map((s) => analyzeSet(s).value));
    if (meld < INITIAL_MELD_POINTS) return null;
    return check([...board, ...sets]);
  }

  const tableJokers = new Map();
  for (const s of board) for (const [id, role] of jokerRoles(s)) tableJokers.set(id, role);
  const ctx = { tableJokers, clock };

  const plans = [];
  // Order A: new sets from the rack first, then add tiles to the table.
  plans.push(improve(applyPack(start(board, rack), clock), level, ctx));
  if (level === 'normal' && !clock.timeUp()) {
    // Order B: work tiles into the table first, then pack what's left.
    plans.push(applyPack(improve(start(board, rack), level, ctx), clock));
  }
  plans.sort((a, b) => b.value - a.value);
  for (const p of plans) {
    if (!p.played.length) continue;
    const r = check(p.sets);
    if (r) return r;
  }
  // Something unexpected failed validation: fall back to rack-only sets.
  const safe = applyPack(start(board, rack), clock);
  return safe.played.length ? check(safe.sets) : null;
}

const start = (board, rack) => ({ sets: board.map((s) => s.slice()), rack: rack.slice(), played: [], value: 0 });

function applyPack(state, clock) {
  const { sets } = pack(state.rack, 'tiles', clock);
  if (!sets.length) return state;
  const used = new Set(sets.flat());
  return {
    sets: [...state.sets, ...sets],
    rack: state.rack.filter((id) => !used.has(id)),
    played: [...state.played, ...used],
    value: state.value + sum([...used].map(tileValue)),
  };
}

// ------------------------------------------------------------------ set packing

/** Every set that could be built from the tiles in `rack` (as tile kinds + joker count). */
export function candidateSets(rack) {
  const have = new Set();
  let jokers = 0;
  for (const id of rack) {
    if (isJoker(id)) jokers++;
    else have.add(kindOf(id));
  }
  const out = [];
  for (let n = 1; n <= 13; n++) {
    const colors = COLORS.filter((c) => have.has(CODE[c] + n));
    for (let mask = 1; mask < 1 << colors.length; mask++) {
      const sub = colors.filter((_, i) => mask & (1 << i));
      for (let j = 0; j <= jokers; j++) {
        const size = sub.length + j;
        if (size < 3 || size > 4) continue;
        const kinds = sub.map((c) => CODE[c] + n);
        out.push({ type: 'group', num: n, kinds, jokers: j, meld: n * size, tiles: n * sub.length + 30 * j });
      }
    }
  }
  for (const c of COLORS) {
    for (let s = 1; s <= 11; s++) {
      for (let e = s + 2; e <= 13; e++) {
        const nums = [];
        for (let n = s; n <= e; n++) if (have.has(CODE[c] + n)) nums.push(n);
        const missing = e - s + 1 - nums.length;
        if (!nums.length || missing > jokers) continue;
        out.push({ type: 'run', color: c, s, e, kinds: nums.map((n) => CODE[c] + n), jokers: missing, meld: sum(range(s, e)), tiles: sum(nums) + 30 * missing });
      }
    }
  }
  return out;
}

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/**
 * Choose disjoint sets from the rack maximizing `objective`:
 *   'meld'  points as counted for the initial meld (jokers = the tile they stand for)
 *   'tiles' rack value removed (jokers = 30)
 * Branch and bound with a node cap and the time limit; anytime.
 */
function pack(rack, objective, clock) {
  const cands = candidateSets(rack)
    .map((c) => ({ ...c, val: c[objective] }))
    .sort((a, b) => b.val - a.val || b.kinds.length + b.jokers - (a.kinds.length + a.jokers));
  const counts = new Map();
  let jokers = 0;
  let remaining = 0; // optimistic value of everything still in the rack
  for (const id of rack) {
    if (isJoker(id)) jokers++;
    else counts.set(kindOf(id), (counts.get(kindOf(id)) || 0) + 1);
    remaining += isJoker(id) ? (objective === 'meld' ? 13 : 30) : parseTile(id).num;
  }
  const tileVal = (k) => Number(k.slice(1));
  const jokerVal = objective === 'meld' ? 13 : 30;

  let best = { score: 0, chosen: [] };
  const chosen = [];
  let nodes = 0;
  let stop = false;
  const fits = (c) => c.jokers <= jokers && c.kinds.every((k) => counts.get(k) > 0);
  const take = (c, d) => {
    jokers -= d * c.jokers;
    remaining -= d * (c.jokers * jokerVal + sum(c.kinds.map(tileVal)));
    for (const k of c.kinds) counts.set(k, counts.get(k) - d);
  };
  const dfs = (i, score) => {
    if (score > best.score) best = { score, chosen: chosen.slice() };
    if (stop) return;
    if (++nodes > clock.maxNodes || ((nodes & 255) === 0 && clock.timeUp())) {
      stop = true;
      return;
    }
    if (score + remaining <= best.score) return;
    for (let j = i; j < cands.length; j++) {
      const c = cands[j];
      if (!fits(c)) continue;
      take(c, 1);
      chosen.push(c);
      dfs(j, score + c.val); // j, not j+1: duplicate tiles allow the same set twice
      chosen.pop();
      take(c, -1);
      if (stop) return;
    }
  };
  dfs(0, 0);
  return { sets: materialize(best.chosen, rack), score: best.score };
}

/** Turn abstract candidates into concrete tile ids laid out so the jokers mean what we planned. */
function materialize(chosen, rack) {
  const pool = new Map();
  const jokers = [];
  for (const id of rack) {
    if (isJoker(id)) jokers.push(id);
    else (pool.get(kindOf(id)) || pool.set(kindOf(id), []).get(kindOf(id))).push(id);
  }
  const takeKind = (k) => pool.get(k).shift();
  return chosen.map((c) => {
    if (c.type === 'group') return [...c.kinds.map(takeKind), ...jokers.splice(0, c.jokers)];
    const set = [];
    for (let n = c.s; n <= c.e; n++) {
      const k = CODE[c.color] + n;
      set.push(c.kinds.includes(k) ? takeKind(k) : jokers.shift());
    }
    return set;
  });
}

// ------------------------------------------------------------------ table moves

/** A set is acceptable if it's valid and any table joker in it still stands for the same tile. */
function setOk(ids, ctx) {
  const a = analyzeSet(ids);
  if (!a.valid) return null;
  const tj = ids.filter((id) => ctx.tableJokers.has(id));
  if (tj.length) {
    const roles = jokerRoles(ids);
    for (const j of tj) {
      const before = ctx.tableJokers.get(j);
      const now = roles.get(j);
      const colors = (r) => (r.type === 'run' ? [r.color] : r.colors);
      if (!now || now.num !== before.num || !colors(now).some((c) => colors(before).includes(c))) return null;
    }
  }
  return a;
}

/** Repeatedly apply the most valuable single change until nothing more can be played. */
function improve(state, level, ctx) {
  let s = state;
  for (let guard = 0; guard < 60 && s.rack.length && !ctx.clock.timeUp(); guard++) {
    const options = [...addOneOptions(s, ctx)];
    if (level === 'normal') options.push(...splitInsertOptions(s, ctx), ...stealOptions(s, ctx));
    if (!options.length) break;
    options.sort((a, b) => b.gain - a.gain || a.rank - b.rank);
    s = applyOption(s, options[0]);
  }
  return s;
}

function applyOption(s, opt) {
  const sets = s.sets.slice();
  // Replace sets from the highest index down so earlier indices stay valid.
  const reps = [...opt.replace].sort((a, b) => b.index - a.index);
  for (const r of reps) sets.splice(r.index, 1, ...r.with);
  if (opt.add) sets.push(...opt.add);
  const used = new Set(opt.fromRack);
  return {
    sets,
    rack: s.rack.filter((id) => !used.has(id)),
    played: [...s.played, ...opt.fromRack],
    value: s.value + opt.gain,
  };
}

const uniqueByKind = (ids) => {
  const seen = new Set();
  return ids.filter((id) => !seen.has(kindOf(id)) && seen.add(kindOf(id)));
};

/** Easy + Normal: put one rack tile on the end of a run or into a group. */
function* addOneOptions(s, ctx) {
  for (const t of uniqueByKind(s.rack)) {
    for (let i = 0; i < s.sets.length; i++) {
      const set = s.sets[i];
      const type = analyzeSet(set).type;
      const tries = type === 'run' ? [[...set, t], [t, ...set]] : [[...set, t]];
      for (const next of tries) {
        const a = setOk(next, ctx);
        if (!a) continue;
        yield { gain: tileValue(t), rank: 0, fromRack: [t], replace: [{ index: i, with: [a.ordered] }] };
        break;
      }
    }
  }
}

/** Normal: split a run around a duplicate number, e.g. 3-4-5-6-7 + 5 -> 3-4-5 and 5-6-7. */
function* splitInsertOptions(s, ctx) {
  for (const t of uniqueByKind(s.rack.filter((id) => !isJoker(id)))) {
    const tt = parseTile(t);
    for (let i = 0; i < s.sets.length; i++) {
      const set = s.sets[i];
      if (set.some(isJoker)) continue;
      const a = analyzeSet(set);
      if (a.type !== 'run' || parseTile(set[0]).color !== tt.color) continue;
      const first = a.numbers[0];
      const last = a.numbers[a.numbers.length - 1];
      if (tt.num < first + 2 || tt.num > last - 2) continue;
      const cut = tt.num - first + 1;
      const left = a.ordered.slice(0, cut);
      const right = [t, ...a.ordered.slice(cut)];
      const l = setOk(left, ctx);
      const r = setOk(right, ctx);
      if (l && r) yield { gain: tileValue(t), rank: 1, fromRack: [t], replace: [{ index: i, with: [l.ordered, r.ordered] }] };
    }
  }
}

/** Table tiles that can be taken without breaking the set they're in. */
function freeTiles(sets, ctx) {
  const out = [];
  sets.forEach((set, i) => {
    const a = analyzeSet(set);
    if (!a.valid) return;
    const o = a.ordered; // tidy order, so run indices follow the numbers
    const tryRemove = (k, parts) => {
      const id = o[k];
      if (isJoker(id)) return; // never take a joker
      const oks = parts.map((p) => setOk(p, ctx));
      if (oks.every(Boolean)) out.push({ id, index: i, rest: oks.map((x) => x.ordered) });
    };
    if (a.type === 'group' && o.length === 4) {
      o.forEach((_, k) => tryRemove(k, [o.filter((__, x) => x !== k)]));
    } else if (a.type === 'run' && o.length >= 4) {
      tryRemove(0, [o.slice(1)]);
      tryRemove(o.length - 1, [o.slice(0, -1)]);
      for (let k = 3; k <= o.length - 4; k++) tryRemove(k, [o.slice(0, k), o.slice(k + 1)]);
    }
  });
  return out;
}

/** Could these two tiles ever sit in the same set? Cheap filter before analyzeSet. */
function compatible(a, b) {
  if (isJoker(a) || isJoker(b)) return true;
  const x = parseTile(a);
  const y = parseTile(b);
  if (x.color === y.color) return x.num !== y.num && Math.abs(x.num - y.num) <= 2;
  return x.num === y.num;
}

/** Normal: take tiles off the table to complete a new set with rack tiles. */
function* stealOptions(s, ctx) {
  const free = freeTiles(s.sets, ctx);
  if (!free.length) return;
  const rack = uniqueByKind(s.rack);
  // Two rack tiles + one table tile.
  for (let x = 0; x < s.rack.length; x++) {
    for (let y = x + 1; y < s.rack.length; y++) {
      const a = s.rack[x];
      const b = s.rack[y];
      if (!compatible(a, b)) continue;
      for (const f of free) {
        if (!compatible(a, f.id) || !compatible(b, f.id)) continue;
        const set = setOk([a, b, f.id], ctx);
        if (set) {
          yield { gain: tileValue(a) + tileValue(b), rank: 2, fromRack: [a, b], replace: [{ index: f.index, with: f.rest }], add: [set.ordered] };
        }
      }
    }
  }
  // One rack tile + two table tiles from different sets.
  for (const a of rack) {
    const fs = free.filter((f) => compatible(a, f.id));
    for (let p = 0; p < fs.length; p++) {
      for (let q = p + 1; q < fs.length; q++) {
        if (fs[p].index === fs[q].index || !compatible(fs[p].id, fs[q].id)) continue;
        const set = setOk([a, fs[p].id, fs[q].id], ctx);
        if (set) {
          yield {
            gain: tileValue(a), rank: 3, fromRack: [a],
            replace: [{ index: fs[p].index, with: fs[p].rest }, { index: fs[q].index, with: fs[q].rest }],
            add: [set.ordered],
          };
        }
      }
    }
  }
}
