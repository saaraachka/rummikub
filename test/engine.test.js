import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, addPlayer, removePlayer, renamePlayer, setTimer, startRound, commitTurn, drawTile,
  reorderRack, scoreRound, publicView, playerView, currentPlayerId, resetToLobby, setStrictJokers,
} from '../js/game/engine.js';

function twoPlayerGame(seed = 1) {
  let s = createGame();
  s = addPlayer(s, { id: 'p1', name: 'Ana' });
  s = addPlayer(s, { id: 'p2', name: 'Ben' });
  return startRound(s, seed);
}

/** Force a known rack/board so turns are predictable. */
function rig(s, { racks, board = [], melded = {}, pool }) {
  const t = structuredClone(s);
  Object.assign(t.racks, racks);
  t.board = board.map((tiles, i) => ({ id: `x${i}`, tiles }));
  Object.assign(t.melded, melded);
  if (pool) t.pool = pool;
  return t;
}

describe('lobby', () => {
  test('add, rename, remove, cap at 4', () => {
    let s = createGame();
    for (const id of ['a', 'b', 'c', 'd']) s = addPlayer(s, { id, name: `  ${id}  name ` });
    assert.equal(s.players.length, 4);
    assert.equal(s.players[0].name, 'a name');
    assert.throws(() => addPlayer(s, { id: 'e', name: 'e' }), /full/);
    s = renamePlayer(s, 'a', 'Zed');
    assert.equal(s.players[0].name, 'Zed');
    s = removePlayer(s, 'b');
    assert.deepEqual(s.players.map((p) => p.id), ['a', 'c', 'd']);
  });
  test('needs 2 players to start', () => {
    const s = addPlayer(createGame(), { id: 'a', name: 'A' });
    assert.throws(() => startRound(s), /at least 2/);
  });
  test('timer options', () => {
    assert.equal(setTimer(createGame(), 60).settings.timer, 60);
    assert.equal(setTimer(createGame(), 30).settings.timer, 30);
    assert.throws(() => setTimer(createGame(), 45));
  });
  test('inputs are not mutated', () => {
    const s = createGame();
    addPlayer(s, { id: 'a', name: 'A' });
    assert.equal(s.players.length, 0);
  });
});

describe('dealing', () => {
  test('14 tiles each, rest in pool, all 106 accounted for', () => {
    const s = twoPlayerGame();
    assert.equal(s.racks.p1.length, 14);
    assert.equal(s.racks.p2.length, 14);
    assert.equal(s.pool.length, 106 - 28);
    assert.equal(new Set([...s.pool, ...s.racks.p1, ...s.racks.p2]).size, 106);
    assert.equal(currentPlayerId(s), 'p1');
  });
  test('same seed, same deal', () => {
    assert.deepEqual(twoPlayerGame(42).racks, twoPlayerGame(42).racks);
    assert.notDeepEqual(twoPlayerGame(42).racks, twoPlayerGame(43).racks);
  });
});

describe('turns', () => {
  test('only the current player may act', () => {
    const s = twoPlayerGame();
    assert.throws(() => drawTile(s, 'p2'), /isn't your turn/);
    assert.throws(() => commitTurn(s, 'p2', []), /isn't your turn/);
  });
  test('drawing adds a tile and passes the turn', () => {
    const s = twoPlayerGame();
    const { state } = drawTile(s, 'p1');
    assert.equal(state.racks.p1.length, 15);
    assert.equal(state.pool.length, s.pool.length - 1);
    assert.equal(currentPlayerId(state), 'p2');
    assert.equal(state.lastEvent.type, 'draw');
    assert.equal(state.turnNumber, s.turnNumber + 1);
  });
  test('valid initial meld commits, keeps rack order, passes the turn', () => {
    let s = twoPlayerGame();
    s = rig(s, { racks: { p1: ['k2a', 'r10a', 'k5a', 'r11a', 'r12a'] } });
    const r = commitTurn(s, 'p1', [['r12a', 'r10a', 'r11a']]);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.state.racks.p1, ['k2a', 'k5a']);
    assert.deepEqual(r.state.board.map((b) => b.tiles), [['r10a', 'r11a', 'r12a']]);
    assert.equal(r.state.melded.p1, true);
    assert.equal(r.state.lastEvent.type, 'commit');
    assert.equal(r.state.lastEvent.firstMeld, true);
    assert.equal(r.state.lastEvent.meldPoints, 33);
    assert.equal(currentPlayerId(r.state), 'p2');
  });
  test('invalid commit leaves the game unchanged and records an invalid event', () => {
    let s = twoPlayerGame();
    s = rig(s, { racks: { p1: ['k1a', 'k2a', 'k3a', 'o9a'] } });
    const r = commitTurn(s, 'p1', [['k1a', 'k2a', 'k3a']]);
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /needs at least 30/);
    assert.deepEqual(r.state.racks, s.racks);
    assert.deepEqual(r.state.board, s.board);
    assert.equal(currentPlayerId(r.state), 'p1');
    assert.equal(r.state.lastEvent.type, 'invalid');
  });
  test('unchanged sets keep their ids, changed sets get new ones', () => {
    let s = twoPlayerGame();
    s = rig(s, { racks: { p1: ['r8a', 'k1a'] }, board: [['r5a', 'r6a', 'r7a'], ['b9a', 'k9a', 'o9a']], melded: { p1: true } });
    const r = commitTurn(s, 'p1', [['b9a', 'k9a', 'o9a'], ['r5a', 'r6a', 'r7a', 'r8a']]);
    assert.equal(r.ok, true);
    assert.equal(r.state.board[0].id, 'x1');
    assert.notEqual(r.state.board[1].id, 'x0');
    assert.deepEqual(r.state.lastEvent.played, ['r8a']);
  });
});

describe('end of round', () => {
  test('emptying the rack wins and scores', () => {
    let s = twoPlayerGame();
    s = rig(s, { racks: { p1: ['r10a', 'r11a', 'r12a'], p2: ['Ja', 'k5a', 'o7a'] } });
    const r = commitTurn(s, 'p1', [['r10a', 'r11a', 'r12a']]);
    assert.equal(r.ok, true);
    const st = r.state;
    assert.equal(st.phase, 'roundOver');
    assert.equal(st.result.winnerId, 'p1');
    assert.equal(st.result.reason, 'out');
    assert.deepEqual(st.result.deltas, { p1: 42, p2: -42 });
    assert.equal(st.players.find((p) => p.id === 'p1').score, 42);
    assert.equal(st.players.find((p) => p.id === 'p2').score, -42);
  });
  test('scores carry into the next round, which rotates the first player', () => {
    let s = twoPlayerGame();
    s = rig(s, { racks: { p1: ['r10a', 'r11a', 'r12a'], p2: ['k5a'] } });
    s = commitTurn(s, 'p1', [['r10a', 'r11a', 'r12a']]).state;
    s = startRound(s, 7);
    assert.equal(s.round, 2);
    assert.equal(s.phase, 'playing');
    assert.equal(currentPlayerId(s), 'p2');
    assert.equal(s.players[0].score, 5);
    assert.equal(s.board.length, 0);
    s = resetToLobby(s);
    assert.equal(s.phase, 'lobby');
    assert.equal(s.players[0].score, 0);
  });
  test('empty pool: drawing passes; everyone passing ends the round, lowest rack wins', () => {
    let s = twoPlayerGame();
    s = rig(s, { racks: { p1: ['k9a', 'k10a'], p2: ['r2a', 'Ja'] }, pool: [] });
    s = drawTile(s, 'p1').state;
    assert.equal(s.phase, 'playing');
    assert.equal(s.lastEvent.drew, false);
    s = drawTile(s, 'p2').state;
    assert.equal(s.phase, 'roundOver');
    assert.equal(s.result.reason, 'blocked');
    assert.equal(s.result.winnerId, 'p1');
    assert.deepEqual(s.result.deltas, { p1: 32, p2: -32 });
  });
  test('timeout and skip are draws with their own event type', () => {
    const s = twoPlayerGame();
    assert.equal(drawTile(s, 'p1', 'timeout').state.lastEvent.type, 'timeout');
    assert.equal(drawTile(s, 'p1', 'skip').state.racks.p1.length, 15);
  });
});

describe('scoreRound', () => {
  test('winner gets the sum, losers lose their rack value, jokers 30', () => {
    assert.deepEqual(scoreRound({ a: [], b: ['Ja', 'r1a'], c: ['k13a'] }, 'a'), { a: 44, b: -31, c: -13 });
  });
});

describe('rack order', () => {
  test('reorders, ignores junk, keeps unmentioned tiles at the end', () => {
    let s = twoPlayerGame();
    s = rig(s, { racks: { p1: ['k1a', 'k2a', 'k3a'] } });
    const t = reorderRack(s, 'p1', ['k3a', 'zz', 'k1a', 'k3a']);
    assert.deepEqual(t.racks.p1, ['k3a', 'k1a', 'k2a']);
  });
});

describe('views', () => {
  test('public view never contains rack contents', () => {
    const s = twoPlayerGame();
    const v = publicView(s);
    const json = JSON.stringify(v);
    for (const id of s.racks.p1) assert.ok(!json.includes(`"${id}"`), `leaked ${id}`);
    assert.equal(v.players[0].tileCount, 14);
    assert.equal(v.poolCount, 78);
  });
  test('player view includes only their own rack', () => {
    const s = twoPlayerGame();
    const v = playerView(s, 'p2');
    assert.deepEqual(v.rack, s.racks.p2);
    const json = JSON.stringify(v);
    for (const id of s.racks.p1) assert.ok(!json.includes(`"${id}"`));
  });
});

describe('strict joker setting', () => {
  test('defaults on, can be switched off, and is enforced at commit', () => {
    let s = twoPlayerGame();
    assert.equal(publicView(s).settings.strictJokers, true);
    s = rig(s, { racks: { p1: ['o11a', 'o12a', 'k1a'] }, board: [['k3a', 'k4a', 'k5a', 'Ja']], melded: { p1: true } });
    const take = [['k3a', 'k4a', 'k5a'], ['o11a', 'o12a', 'Ja']];
    const strict = commitTurn(s, 'p1', take);
    assert.equal(strict.ok, false);
    assert.match(strict.errors[0].message, /joker that stands for black 6/);
    const loose = commitTurn(setStrictJokers(s, false), 'p1', take);
    assert.equal(loose.ok, true, JSON.stringify(loose.errors));
  });
  test('saved games without the setting are treated as strict', () => {
    const s = twoPlayerGame();
    delete s.settings.strictJokers;
    assert.equal(publicView(s).settings.strictJokers, true);
  });
});
