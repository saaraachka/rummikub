// Game state machine. Pure functions: each takes a state and returns a new
// state (inputs are never mutated). The table page is the only caller that
// owns real state; phones only ever see the views produced at the bottom.

import { makeDeck, shuffle, mulberry32, rackValue } from './tiles.js';
import { validateTurn } from './rules.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const RACK_SIZE = 14;
export const TIMER_OPTIONS = [0, 60, 120];

const clone = (x) => structuredClone(x);
const multisetKey = (ids) => [...ids].sort().join(',');

export function createGame() {
  return {
    phase: 'lobby', // lobby | playing | roundOver
    settings: { timer: 0 },
    players: [], // [{id, name, score}]
    round: 0,
    pool: [],
    board: [], // [{id, tiles: string[]}]
    racks: {}, // playerId -> string[]
    melded: {}, // playerId -> bool
    turn: 0, // index into players
    turnNumber: 0,
    passesInRow: 0,
    setCounter: 0,
    seq: 0,
    lastEvent: null,
    result: null,
  };
}

// ---------------------------------------------------------------- lobby

export function addPlayer(state, { id, name }) {
  if (state.phase !== 'lobby') throw new Error('Game already started');
  if (state.players.length >= MAX_PLAYERS) throw new Error('Table is full');
  if (state.players.some((p) => p.id === id)) return state;
  const s = clone(state);
  s.players.push({ id, name: cleanName(name), score: 0 });
  return s;
}

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

export function setTimer(state, seconds) {
  if (!TIMER_OPTIONS.includes(seconds)) throw new Error('Bad timer');
  const s = clone(state);
  s.settings.timer = seconds;
  return s;
}

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
  s.result = null;
  event(s, { type: 'roundStart' });
  return s;
}

/** Back to the lobby with scores reset (players stay seated). */
export function resetToLobby(state) {
  const s = clone(state);
  Object.assign(s, {
    phase: 'lobby', round: 0, pool: [], board: [], racks: {}, melded: {},
    passesInRow: 0, result: null,
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

function nextTurn(s) {
  s.turn = (s.turn + 1) % s.players.length;
  s.turnNumber += 1;
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
  event(s, { type: 'commit', playerId, played: v.played, firstMeld, meldPoints: firstMeld ? v.meldPoints : undefined });

  if (v.rackAfter.length === 0) {
    endRound(s, playerId, 'out');
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
  if (!drew && s.passesInRow >= s.players.length) {
    const winner = [...s.players].sort((a, b) => rackValue(s.racks[a.id]) - rackValue(s.racks[b.id]))[0];
    endRound(s, winner.id, 'blocked');
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

function endRound(s, winnerId, reason) {
  const deltas = scoreRound(s.racks, winnerId);
  const rackValues = {};
  for (const p of s.players) {
    rackValues[p.id] = rackValue(s.racks[p.id]);
    p.score += deltas[p.id];
  }
  s.phase = 'roundOver';
  s.result = { winnerId, reason, deltas, rackValues };
  event(s, { type: 'roundOver', playerId: winnerId, reason });
}

// ---------------------------------------------------------------- views

/** Everything that may be shown on the shared table screen: no racks. */
export function publicView(state) {
  return {
    phase: state.phase,
    settings: state.settings,
    round: state.round,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      tileCount: state.racks[p.id]?.length ?? 0,
      melded: !!state.melded[p.id],
    })),
    board: state.board,
    poolCount: state.pool.length,
    currentPlayerId: currentPlayerId(state),
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
