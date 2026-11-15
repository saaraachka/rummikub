// Pure rule validation. No DOM, no network, no randomness: every function
// here takes plain data and returns plain data, so it can be unit-tested
// in Node and shared by the host (authoritative) and phones (live hints).

import { parseTile, tileLabel, isTileId, MIN_NUMBER, MAX_NUMBER } from './tiles.js';

export const MIN_SET_SIZE = 3;
export const MAX_GROUP_SIZE = 4;
export const INITIAL_MELD_POINTS = 30;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const numsLabel = (n) => `${n}s`;

function describeTiles(tiles) {
  return tiles.map((t) => tileLabel(t.id)).join(', ');
}

/** "4-5-J-7" in the order the player laid the tiles out. */
function runSequence(tiles) {
  return tiles.map((t) => (t.joker ? 'J' : t.num)).join('-');
}

function tryGroup(tiles) {
  const real = tiles.filter((t) => !t.joker);
  const num = real[0].num;
  if (real.some((t) => t.num !== num)) return { ok: false, kind: 'mixed' };
  const seen = new Set();
  for (const t of real) {
    if (seen.has(t.color)) {
      return { ok: false, kind: 'group', reason: `Group of ${numsLabel(num)} has two ${t.color} tiles` };
    }
    seen.add(t.color);
  }
  if (tiles.length > MAX_GROUP_SIZE) {
    return { ok: false, kind: 'group', reason: `A group can have at most ${MAX_GROUP_SIZE} tiles (this group of ${numsLabel(num)} has ${tiles.length})` };
  }
  return {
    ok: true,
    type: 'group',
    numbers: tiles.map(() => num),
    value: num * tiles.length,
    // Display order: real tiles in color order, jokers last.
    ordered: [...real].sort((a, b) => colorOrder(a) - colorOrder(b)).concat(tiles.filter((t) => t.joker)),
  };
}

const COLOR_ORDER = { black: 0, red: 1, blue: 2, orange: 3 };
const colorOrder = (t) => COLOR_ORDER[t.color];

function tryRun(tiles) {
  const real = tiles.filter((t) => !t.joker);
  const jokers = tiles.filter((t) => t.joker);
  const color = real[0].color;
  if (real.some((t) => t.color !== color)) return { ok: false, kind: 'mixed' };

  const seq = runSequence(tiles);
  const seen = new Set();
  for (const t of real) {
    if (seen.has(t.num)) return { ok: false, kind: 'run', reason: `Run ${seq} (${color}) has two ${numsLabel(t.num)}` };
    seen.add(t.num);
  }
  if (tiles.length > MAX_NUMBER - MIN_NUMBER + 1) {
    return { ok: false, kind: 'run', reason: `A run can't be longer than ${MAX_NUMBER} tiles` };
  }

  // 1) Respect the player's layout if it already reads as a run, ascending
  //    or descending. This is how a player chooses what a joker stands for
  //    (J-4-5 means the joker is a 3, 4-5-J means it's a 6).
  for (const dir of [1, -1]) {
    const firstReal = tiles.findIndex((t) => !t.joker);
    const start = tiles[firstReal].num - dir * firstReal;
    const numbers = tiles.map((_, i) => start + dir * i);
    const inRange = numbers.every((n) => n >= MIN_NUMBER && n <= MAX_NUMBER);
    if (inRange && tiles.every((t, i) => t.joker || t.num === numbers[i])) {
      const ordered = dir === 1 ? tiles : [...tiles].reverse();
      const nums = dir === 1 ? numbers : [...numbers].reverse();
      return { ok: true, type: 'run', numbers: nums, value: sum(nums), ordered };
    }
  }

  // 2) Otherwise treat it as unordered: sort the real tiles, fill gaps with
  //    jokers, and put any leftover jokers on the high end (or low end if
  //    the run already reaches 13).
  const sorted = [...real].sort((a, b) => a.num - b.num);
  const min = sorted[0].num;
  const max = sorted[sorted.length - 1].num;
  const gaps = max - min + 1 - sorted.length;
  if (gaps > jokers.length) {
    const sortedSeq = sorted.map((t) => t.num).join('-');
    const why = jokers.length
      ? `Run ${sortedSeq} (${color}) has ${plural(gaps, 'gap')} but only ${plural(jokers.length, 'joker')} to fill them`
      : `Run ${seq} (${color}) isn't consecutive`;
    return { ok: false, kind: 'run', reason: why };
  }
  let extra = jokers.length - gaps;
  const high = Math.min(extra, MAX_NUMBER - max);
  const low = extra - high;
  const start = min - low;
  const ordered = [];
  const numbers = [];
  const byNum = new Map(sorted.map((t) => [t.num, t]));
  const spare = [...jokers];
  for (let n = start; n < start + tiles.length; n++) {
    ordered.push(byNum.get(n) ?? spare.shift());
    numbers.push(n);
  }
  return { ok: true, type: 'run', numbers, value: sum(numbers), ordered };
}

const sum = (a) => a.reduce((s, n) => s + n, 0);

/**
 * Analyse one set on the board.
 * @param {string[]} ids tile ids in the order they are laid out
 * @returns {{valid: boolean, type?: 'group'|'run', value?: number,
 *            numbers?: number[], ordered?: string[], reason?: string}}
 *   `value` is the points the set is worth (jokers count as the number they
 *   represent), `ordered` is a tidy display order for the same tiles.
 */
export function analyzeSet(ids) {
  if (!Array.isArray(ids) || ids.some((id) => !isTileId(id))) {
    return { valid: false, reason: 'Unknown tile in set' };
  }
  const tiles = ids.map(parseTile);
  if (tiles.length < MIN_SET_SIZE) {
    const what = tiles.length ? describeTiles(tiles) : 'Empty set';
    return { valid: false, reason: `${what}: a set needs at least ${MIN_SET_SIZE} tiles` };
  }
  const real = tiles.filter((t) => !t.joker);
  if (real.length === 0) return { valid: false, reason: 'A set needs at least one non-joker tile' };

  const group = tryGroup(tiles);
  const run = tryRun(tiles);
  // A set with a single real tile plus jokers can be read either way; take
  // whichever reading is worth more (it only matters for the first meld).
  let best = null;
  if (group.ok) best = group;
  if (run.ok && (!best || run.value > best.value)) best = run;
  if (best) {
    return { valid: true, type: best.type, value: best.value, numbers: best.numbers, ordered: best.ordered.map((t) => t.id) };
  }
  if (group.kind === 'group') return { valid: false, reason: group.reason };
  if (run.kind === 'run') return { valid: false, reason: run.reason };
  return {
    valid: false,
    reason: `${describeTiles(tiles)}: groups need one number in different colors, runs need one color in a row`,
  };
}

/** Value of a set as played (0 if invalid). */
export function setValue(ids) {
  const a = analyzeSet(ids);
  return a.valid ? a.value : 0;
}

/** Validate every set on a board. */
export function validateBoard(sets) {
  const results = sets.map((ids, index) => ({ index, ...analyzeSet(ids) }));
  return { valid: results.every((r) => r.valid), results };
}

const multisetKey = (ids) => [...ids].sort().join(',');

/**
 * End-of-turn check. Compares the board before the turn with the board the
 * player wants to commit.
 *
 * @param {object} p
 * @param {string[][]} p.before   sets on the table at the start of the turn
 * @param {string[][]} p.after    sets the player wants to leave on the table
 * @param {string[]}   p.rack     the player's rack at the start of the turn
 * @param {boolean}    p.hasMelded whether the player already made their initial meld
 * @param {number}    [p.minMeld] initial meld threshold (default 30)
 * @returns {{ok: boolean, errors: {message: string, setIndex?: number}[],
 *            played: string[], rackAfter: string[], meldPoints: number,
 *            sets: string[][]}}
 *   `sets` is `after` with empty sets dropped and each set tidied into
 *   display order. `setIndex` refers to positions in `sets`.
 */
export function validateTurn({ before, after, rack, hasMelded, minMeld = INITIAL_MELD_POINTS }) {
  const errors = [];
  const sets = (after || []).filter((s) => Array.isArray(s) && s.length > 0);
  const beforeIds = before.flat();
  const beforeSet = new Set(beforeIds);
  const rackSet = new Set(rack);
  const afterIds = sets.flat();
  const result = (extra = {}) => ({
    ok: errors.length === 0,
    errors,
    played: [],
    rackAfter: rack.slice(),
    meldPoints: 0,
    sets,
    ...extra,
  });

  // --- Tile bookkeeping: nothing invented, duplicated, or taken back.
  const seen = new Set();
  for (const id of afterIds) {
    if (!isTileId(id)) {
      errors.push({ message: 'Unknown tile on the board' });
      return result();
    }
    if (seen.has(id)) {
      errors.push({ message: `The ${tileLabel(id)} appears twice` });
      return result();
    }
    seen.add(id);
    if (!beforeSet.has(id) && !rackSet.has(id)) {
      errors.push({ message: `The ${tileLabel(id)} isn't in your rack` });
      return result();
    }
  }
  const missing = beforeIds.filter((id) => !seen.has(id));
  if (missing.length) {
    errors.push({ message: `Tiles already on the table can't go back to your rack (${missing.map(tileLabel).join(', ')})` });
    return result();
  }
  const played = afterIds.filter((id) => !beforeSet.has(id));
  const playedSet = new Set(played);
  const rackAfter = rack.filter((id) => !playedSet.has(id));
  if (played.length === 0) {
    errors.push({ message: 'Play at least one tile from your rack, or draw a tile' });
    return result({ played, rackAfter });
  }

  // --- Every set must be valid.
  const analyses = sets.map(analyzeSet);
  analyses.forEach((a, i) => {
    if (!a.valid) errors.push({ message: a.reason, setIndex: i });
  });

  // --- Initial meld: only rack tiles, table sets untouched, >= 30 points.
  let meldPoints = 0;
  if (!hasMelded) {
    const untouched = new Map();
    for (const s of before) {
      const k = multisetKey(s);
      untouched.set(k, (untouched.get(k) || 0) + 1);
    }
    let touchedAt = -1;
    sets.forEach((s, i) => {
      const fromTable = s.filter((id) => beforeSet.has(id));
      if (fromTable.length === 0) {
        if (analyses[i].valid) meldPoints += analyses[i].value;
        return;
      }
      const k = multisetKey(s);
      if (fromTable.length === s.length && untouched.get(k) > 0) {
        untouched.set(k, untouched.get(k) - 1);
        return;
      }
      if (touchedAt < 0) touchedAt = i;
    });
    if (touchedAt >= 0) {
      errors.push({ message: "Your first meld must use only tiles from your rack; leave the table's sets as they are", setIndex: touchedAt });
    }
    if (errors.length === 0 && meldPoints < minMeld) {
      errors.push({ message: `Your first meld totals ${meldPoints} points; it needs at least ${minMeld}` });
    }
  }

  const tidy = sets.map((s, i) => (analyses[i].valid ? analyses[i].ordered : s));
  return { ok: errors.length === 0, errors, played, rackAfter, meldPoints, sets: tidy };
}

/** Points the player would get toward the first meld from sets made only of rack tiles. */
export function meldPointsFromRack(sets, rackIds) {
  const rack = new Set(rackIds);
  let pts = 0;
  for (const s of sets) {
    if (s.length && s.every((id) => rack.has(id))) pts += setValue(s);
  }
  return pts;
}
