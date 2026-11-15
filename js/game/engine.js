// Game state machine. Pure functions: each takes a state and returns a new
// state (inputs are never mutated). The table page is the only caller that
// owns real state; phones only ever see the views produced at the bottom.

import { makeDeck, shuffle, mulberry32, rackValue } from './tiles.js';
import { validateTurn } from './rules.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const RACK_SIZE = 14;
export const TIMER_OPTIONS = [0, 30, 60, 120];

const clone = (x) => structuredClone(x);
const multisetKey = (ids) => [...ids].sort().join(',');

export function createGame() {
  return {
    phase: 'lobby', // lobby | playing | roundOver
    settings: { timer: 0, pendingTimer: null, strictJokers: true },
    players: [], // [{id, name, score, bot?: 'easy'|'normal'}]
    round: 0,
    pool: [],
    board: [], // [{id, tiles: string[]}]
    racks: {}, // playerId -> string[]
    melded: {}, // playerId -> bool
    turn: 0, // index into players
    turnNumber: 0,
    passesInRow: 0,
    finished: [], // player ids in the order they emptied their racks this round
    scoreSnapshot: null, // {winnerId, rackValues} taken the moment the first player goes out
    setCounter: 0,
    seq: 0,
    lastEvent: null,
    result: null,
  };
}

// ---------------------------------------------------------------- lobby

export const BOT_LEVELS = ['easy', 'normal'];

/** Add a seat. Pass `bot: 'easy' | 'normal'` for a computer player; humans omit it. */
export function addPlayer(state, { id, name, bot }) {
  if (state.phase !== 'lobby') throw new Error('Game already started');
  if (state.players.length >= MAX_PLAYERS) throw new Error('Table is full');
  if (state.players.some((p) => p.id === id)) return state;
  if (bot !== undefined && !BOT_LEVELS.includes(bot)) throw new Error('Bad bot level');
  const s = clone(state);
  s.players.push({ id, name: cleanName(name), score: 0, ...(bot ? { bot } : {}) });
  return s;
}

export function setBotLevel(state, id, level) {
  if (!BOT_LEVELS.includes(level)) throw new Error('Bad bot level');
  const s = clone(state);
  const p = s.players.find((p) => p.id === id);
  if (!p?.bot) throw new Error('Not a bot');
  p.bot = level;
  return s;
}

export const isBot = (state, id) => !!state.players.find((p) => p.id === id)?.bot;

export function renamePlayer(state, id, name) {
  const s = clone(state);
  const p = s.players.find((p) => p.id === id);
  if (p) p.name = cleanName(name);
  return s;
}

export function removePlayer(state, id) {
  if (state.phase !== 'lobby') throw new Error('Players can only be removed in the lobby');
  const s = clone(state);
  s.players = s.players.filter((p) => p.id !== id);
  return s;
}

/**
 * Set the turn timer (seconds; 0 = off).
 *   Lobby or between rounds: applies right away.
 *   During a round: applies when the NEXT turn starts, so nobody is cut off
 *   mid-move. Turning the timer off is the exception: it stops the current
 *   countdown immediately, since that never hurts anyone.
 * Records a 'timerChange' event ({timer, when: 'now' | 'nextTurn'}) for the screens.
 */
export function setTimer(state, seconds) {
  if (!TIMER_OPTIONS.includes(seconds)) throw new Error('Bad timer');
  const s = clone(state);
  let when = 'now';
  if (s.phase !== 'playing' || seconds === 0) {
    s.settings.timer = seconds;
    s.settings.pendingTimer = null;
  } else if (seconds === s.settings.timer) {
    s.settings.pendingTimer = null; // changed back before it took effect
  } else {
    s.settings.pendingTimer = seconds;
    when = 'nextTurn';
  }
  event(s, { type: 'timerChange', timer: seconds, when });
  return s;
}

/** "Off", "30s", "1 min", "2 min". */
export const timerLabel = (seconds) => (!seconds ? 'Off' : seconds < 60 ? `${seconds}s` : `${seconds / 60} min`);

/** The timer that will be running once any pending change applies. */
export const effectiveTimer = (state) => state.settings.pendingTimer ?? state.settings.timer;

function applyPendingTimer(s) {
  if (s.settings.pendingTimer != null) {
    s.settings.timer = s.settings.pendingTimer;
    s.settings.pendingTimer = null;
  }
}

/**
 * The turn countdown, as a pure function of the game. `prev` is the last
 * clock ({turnNumber, deadline, total}) or null; `now` is a ms timestamp.
 * A new deadline is set once per turn; it's cleared as soon as the timer is
 * off or the round isn't being played.
 */
export function turnClock(prev, state, now) {
  const timer = state.settings.timer;
  if (state.phase !== 'playing' || !timer) return { turnNumber: state.turnNumber, deadline: 0, total: 0 };
  if (prev && prev.turnNumber === state.turnNumber) return prev;
  return { turnNumber: state.turnNumber, deadline: now + timer * 1000, total: timer * 1000 };
}

/**
 * Bring a saved game up to date with the current state shape. Games saved
 * before a setting existed keep the timer they started with and get sensible
 * defaults for anything new.
 */
export function restoreGame(saved) {
  const s = clone(saved);
  s.settings ||= {};
  if (!TIMER_OPTIONS.includes(s.settings.timer)) s.settings.timer = 0;
  if (!TIMER_OPTIONS.includes(s.settings.pendingTimer)) s.settings.pendingTimer = null;
  if (typeof s.settings.strictJokers !== 'boolean') s.settings.strictJokers = true;
  if (!Array.isArray(s.finished)) s.finished = [];
  if (s.scoreSnapshot === undefined) s.scoreSnapshot = null;
  return s;
}

/** Official joker-retrieval rule on (default) or the looser "move jokers freely" house rule. */
export function setStrictJokers(state, on) {
  const s = clone(state);
  s.settings.strictJokers = !!on;
  return s;
}

/** Saved games from before the setting existed count as strict. */
export const strictJokersOn = (state) => state.settings.strictJokers !== false;

function cleanName(name) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n || 'Player';
}

// ---------------------------------------------------------------- rounds

/** Shuffle, deal 14 each and start a round. Scores carry over between rounds. */
export function startRound(state, seed = (Math.random() * 2 ** 32) >>> 0) {
  if (state.players.length < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} players`);
  if (state.phase === 'playing') throw new Error('Round already in progress');
  const s = clone(state);
  const pool = shuffle(makeDeck(), mulberry32(seed));
  s.round += 1;
  s.racks = {};
  s.melded = {};
  for (const p of s.players) {
    s.racks[p.id] = pool.splice(0, RACK_SIZE);
    s.melded[p.id] = false;
  }
  s.pool = pool;
  s.board = [];
  s.phase = 'playing';
  s.turn = (s.round - 1) % s.players.length;
  s.turnNumber += 1;
  s.passesInRow = 0;
  s.finished = [];
  s.scoreSnapshot = null;
  s.result = null;
  applyPendingTimer(s);
  event(s, { type: 'roundStart' });
  return s;
}

/** Back to the lobby with scores reset (players stay seated). */
export function resetToLobby(state) {
  const s = clone(state);
  Object.assign(s, {
    phase: 'lobby', round: 0, pool: [], board: [], racks: {}, melded: {},
    passesInRow: 0, finished: [], scoreSnapshot: null, result: null,
  });
  s.players.forEach((p) => (p.score = 0));
  event(s, { type: 'lobby' });
  return s;
}

export function currentPlayerId(state) {
  return state.phase === 'playing' ? state.players[state.turn]?.id ?? null : null;
}

function event(s, e) {
  s.seq += 1;
  s.lastEvent = { seq: s.seq, ...e };
}

function assertTurn(state, playerId) {
  if (state.phase !== 'playing') throw new Error('No round in progress');
  if (currentPlayerId(state) !== playerId) throw new Error("It isn't your turn");
}

/** Players still holding tiles this round, in seat order. */
export function activePlayerIds(state) {
  const done = new Set(state.finished || []);
  return state.players.map((p) => p.id).filter((id) => !done.has(id));
}

/** 1-based finishing place of a player, or null if they're still playing. */
export function placeOf(state, playerId) {
  const i = (state.finished || []).indexOf(playerId);
  return i < 0 ? null : i + 1;
}

function nextTurn(s) {
  const done = new Set(s.finished);
  for (let k = 1; k <= s.players.length; k++) {
    const i = (s.turn + k) % s.players.length;
    if (!done.has(s.players[i].id)) {
      s.turn = i;
      break;
    }
  }
  s.turnNumber += 1;
  applyPendingTimer(s);
}

/**
 * Try to commit a turn. `sets` is the full board the player wants to leave
 * (array of arrays of tile ids). Returns {state, ok, errors}. On failure the
 * state is unchanged except for an 'invalid' event so the table can show it.
 */
export function commitTurn(state, playerId, sets) {
  assertTurn(state, playerId);
  const before = state.board.map((b) => b.tiles);
  const v = validateTurn({
    before,
    after: sets,
    rack: state.racks[playerId],
    hasMelded: state.melded[playerId],
    strictJokers: strictJokersOn(state),
  });
  const s = clone(state);
  if (!v.ok) {
    event(s, { type: 'invalid', playerId, message: v.errors[0]?.message ?? 'Invalid move' });
    return { state: s, ok: false, errors: v.errors };
  }

  // Keep ids of sets that didn't change, so the table only animates real changes.
  const oldByKey = new Map();
  for (const b of state.board) {
    const k = multisetKey(b.tiles);
    if (!oldByKey.has(k)) oldByKey.set(k, []);
    oldByKey.get(k).push(b.id);
  }
  s.board = v.sets.map((tiles) => {
    const ids = oldByKey.get(multisetKey(tiles));
    const id = ids?.length ? ids.shift() : `s${++s.setCounter}`;
    return { id, tiles };
  });
  s.racks[playerId] = v.rackAfter;
  const firstMeld = !state.melded[playerId];
  s.melded[playerId] = true;
  s.passesInRow = 0;
  const out = v.rackAfter.length === 0;
  if (out) {
    // Official scoring is fixed the moment the first player goes out;
    // play continues only to decide the remaining places.
    if (!s.finished.length) {
      s.scoreSnapshot = {
        winnerId: playerId,
        rackValues: Object.fromEntries(s.players.map((p) => [p.id, rackValue(s.racks[p.id])])),
      };
    }
    s.finished.push(playerId);
  }
  event(s, {
    type: 'commit', playerId, played: v.played, firstMeld, meldPoints: firstMeld ? v.meldPoints : undefined,
    ...(out ? { out: true, place: s.finished.length } : {}),
  });

  const remaining = activePlayerIds(s);
  if (out && remaining.length <= 1) {
    endRound(s, 'out', { viaCommit: true });
  } else if (out && onlyBotsLeft(s)) {
    endRound(s, 'botsOnly', { viaCommit: true });
  } else {
    nextTurn(s);
  }
  return { state: s, ok: true, errors: [] };
}

/**
 * Draw a tile and end the turn. `reason` is 'draw' (player chose to),
 * 'timeout' (timer ran out) or 'skip' (host skipped an absent player).
 * With an empty pool this is a pass; if everyone passes in a row the round
 * ends and the lowest rack wins.
 */
export function drawTile(state, playerId, reason = 'draw') {
  assertTurn(state, playerId);
  const s = clone(state);
  let drew = false;
  if (s.pool.length) {
    s.racks[playerId].push(s.pool.pop());
    drew = true;
    s.passesInRow = 0;
  } else {
    s.passesInRow += 1;
  }
  event(s, { type: reason, playerId, drew });
  if (!drew && s.passesInRow >= activePlayerIds(s).length) {
    endRound(s, 'blocked');
  } else {
    nextTurn(s);
  }
  return { state: s };
}

/** Rearrange a rack. `order` may be partial; unknown ids are ignored. */
export function reorderRack(state, playerId, order) {
  const rack = state.racks[playerId];
  if (!rack || !Array.isArray(order)) return state;
  const have = new Set(rack);
  const seen = new Set();
  const next = [];
  for (const id of order) {
    if (have.has(id) && !seen.has(id)) {
      next.push(id);
      seen.add(id);
    }
  }
  for (const id of rack) if (!seen.has(id)) next.push(id);
  if (next.every((id, i) => id === rack[i])) return state;
  const s = clone(state);
  s.racks[playerId] = next;
  return s;
}

/**
 * Scoring: each loser loses the value of the tiles left in their rack
 * (joker = 30); the winner gains the sum of those losses.
 */
export function scoreRound(racks, winnerId) {
  const deltas = {};
  let total = 0;
  for (const [pid, rack] of Object.entries(racks)) {
    if (pid === winnerId) continue;
    const v = rackValue(rack);
    deltas[pid] = -v;
    total += v;
  }
  deltas[winnerId] = total;
  return deltas;
}

/**
 * True when at least one person is seated, every person has finished, and
 * only bots still hold tiles. (All-bot games, like watch mode, play out fully.)
 */
function onlyBotsLeft(s) {
  const humans = s.players.filter((p) => !p.bot);
  if (!humans.length) return false;
  const done = new Set(s.finished);
  return humans.every((p) => done.has(p.id)) && s.players.some((p) => p.bot && !done.has(p.id));
}

/**
 * End the round now (table's "End round now" button): players still holding
 * tiles are ranked by lowest rack value. Scoring is unchanged: if someone
 * already went out it comes from the snapshot taken at that moment.
 */
export function endRoundNow(state) {
  if (state.phase !== 'playing') throw new Error('No round in progress');
  const s = clone(state);
  endRound(s, 'ended');
  return s;
}

/**
 * Final placements: players who went out, in order, then everyone still
 * holding tiles by lowest rack value (ties keep seat order).
 */
export function rankPlayers(state) {
  const done = state.finished || [];
  const rest = activePlayerIds(state)
    .map((id, seat) => ({ id, seat, v: rackValue(state.racks[id] || []) }))
    .sort((a, b) => a.v - b.v || a.seat - b.seat)
    .map((x) => x.id);
  return [...done, ...rest];
}

/**
 * reason: 'out'      everyone but one player went out
 *         'blocked'  pool empty and every remaining player passed in a row
 *         'ended'    the table ended the round early
 *         'botsOnly' every person finished; the bots still playing were ranked
 */
function endRound(s, reason, { viaCommit = false } = {}) {
  const order = rankPlayers(s);
  const done = new Set(s.finished);
  const placements = order.map((id, i) => ({
    id,
    place: i + 1,
    how: done.has(id) ? 'out' : 'rack',
    rackValue: rackValue(s.racks[id] || []),
  }));
  // Official scoring: from the first player out, at that moment. If nobody
  // went out, the lowest rack wins and racks are scored as they are now.
  const basis = s.scoreSnapshot ?? {
    winnerId: order[0],
    rackValues: Object.fromEntries(s.players.map((p) => [p.id, rackValue(s.racks[p.id])])),
  };
  const deltas = scoreFromValues(basis.rackValues, basis.winnerId);
  for (const p of s.players) p.score += deltas[p.id] ?? 0;
  s.phase = 'roundOver';
  s.result = {
    winnerId: basis.winnerId,
    reason,
    deltas,
    rackValues: basis.rackValues, // the values points were scored from
    scoredAtFirstOut: !!s.scoreSnapshot,
    placements,
  };
  event(s, { type: 'roundOver', playerId: basis.winnerId, reason, viaCommit });
}

function scoreFromValues(values, winnerId) {
  const deltas = {};
  let total = 0;
  for (const [pid, v] of Object.entries(values)) {
    if (pid === winnerId) continue;
    deltas[pid] = -v;
    total += v;
  }
  deltas[winnerId] = total;
  return deltas;
}

/** Placements for any result, including ones saved before placements existed. */
export function resultPlacements(result, players) {
  if (result?.placements) return result.placements;
  if (!result) return [];
  const ids = players.map((p) => p.id);
  const order = [result.winnerId, ...ids.filter((id) => id !== result.winnerId)
    .sort((a, b) => (result.rackValues[a] ?? 0) - (result.rackValues[b] ?? 0))];
  return order.map((id, i) => ({ id, place: i + 1, how: i === 0 ? 'out' : 'rack', rackValue: result.rackValues[id] ?? 0 }));
}

// ---------------------------------------------------------------- views

/** Everything that may be shown on the shared table screen: no racks. */
export function publicView(state) {
  return {
    phase: state.phase,
    settings: { ...state.settings, pendingTimer: state.settings.pendingTimer ?? null, strictJokers: strictJokersOn(state) },
    round: state.round,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      bot: p.bot ?? null,
      tileCount: state.racks[p.id]?.length ?? 0,
      melded: !!state.melded[p.id],
      place: placeOf(state, p.id),
    })),
    board: state.board,
    poolCount: state.pool.length,
    currentPlayerId: currentPlayerId(state),
    finished: state.finished || [],
    turnNumber: state.turnNumber,
    lastEvent: state.lastEvent,
    result: state.result,
  };
}

/** The public view plus one player's own rack. */
export function playerView(state, playerId) {
  return {
    ...publicView(state),
    you: playerId,
    rack: state.racks[playerId] ?? [],
    hasMelded: !!state.melded[playerId],
  };
}
