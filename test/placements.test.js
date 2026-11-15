import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, addPlayer, startRound, commitTurn, drawTile, endRoundNow, currentPlayerId, restoreGame,
  activePlayerIds, placeOf, publicView, playerView, resultPlacements,
} from '../js/game/engine.js';

/** Players with chosen racks (all past their initial meld); the first one plays first. */
function setup(racks, { bots = [], pool } = {}) {
  let s = createGame();
  for (const id of Object.keys(racks)) s = addPlayer(s, { id, name: id.toUpperCase(), ...(bots.includes(id) ? { bot: 'normal' } : {}) });
  s = structuredClone(startRound(s, 1));
  const used = new Set(Object.values(racks).flat());
  const rest = [...s.pool, ...Object.values(s.racks).flat()].filter((id) => !used.has(id));
  Object.assign(s.racks, racks);
  for (const id of Object.keys(racks)) s.melded[id] = true;
  s.pool = pool ?? rest;
  s.turn = 0;
  return s;
}
/** The current player goes out by laying their whole rack as one set. */
const goOut = (s) => {
  const pid = currentPlayerId(s);
  const r = commitTurn(s, pid, [...s.board.map((b) => b.tiles), s.racks[pid].slice()]);
  assert.equal(r.ok, true, `${pid}: ${JSON.stringify(r.errors)}`);
  return r.state;
};
const pass = (s) => drawTile(s, currentPlayerId(s)).state;
const roundTrip = (s) => restoreGame(JSON.parse(JSON.stringify(s)));
const order = (s) => s.result.placements.map((p) => p.id);

// Each rack is exactly one valid set, so any player can go out on their turn.
const FOUR = () => ({
  p1: ['r10a', 'r11a', 'r12a'], // 33
  p2: ['k1a', 'k2a', 'k3a'], // 6
  p3: ['b4a', 'b5a', 'b6a', 'Ja'], // 45 (joker = 30)
  p4: ['o2a', 'o3a', 'o4a'], // 9
});

describe('round continues after the first player goes out', () => {
  test('going out takes 1st place without ending the round', () => {
    const s = goOut(setup(FOUR()));
    assert.equal(s.phase, 'playing');
    assert.deepEqual(s.finished, ['p1']);
    assert.equal(placeOf(s, 'p1'), 1);
    assert.deepEqual([s.lastEvent.type, s.lastEvent.out, s.lastEvent.place], ['commit', true, 1]);
    assert.equal(currentPlayerId(s), 'p2');
  });

  test('finished players are skipped by the turn order', () => {
    let s = goOut(setup(FOUR()));
    s = pass(s); // p2
    s = goOut(s); // p3 out, 2nd
    const seen = [];
    for (let i = 0; i < 6; i++) {
      seen.push(currentPlayerId(s));
      s = pass(s);
    }
    assert.deepEqual(seen, ['p4', 'p2', 'p4', 'p2', 'p4', 'p2']);
    assert.deepEqual(activePlayerIds(s), ['p2', 'p4']);
  });

  test('places are assigned in the order players go out', () => {
    let s = goOut(setup(FOUR())); // p1 1st
    s = pass(s); // p2
    s = goOut(s); // p3 2nd
    assert.equal(s.lastEvent.place, 2);
    assert.deepEqual(s.finished, ['p1', 'p3']);
    assert.deepEqual(publicView(s).players.map((p) => p.place), [1, null, 2, null]);
    assert.deepEqual(publicView(s).finished, ['p1', 'p3']);
  });

  test('the round ends when only one player is left with tiles; they come last', () => {
    let s = goOut(setup(FOUR())); // p1
    s = goOut(s); // p2 2nd
    assert.equal(s.phase, 'playing');
    s = goOut(s); // p3 3rd -> only p4 left
    assert.equal(s.phase, 'roundOver');
    assert.equal(s.result.reason, 'out');
    assert.deepEqual(order(s), ['p1', 'p2', 'p3', 'p4']);
    assert.deepEqual(s.result.placements.map((p) => p.how), ['out', 'out', 'out', 'rack']);
    assert.equal(s.lastEvent.type, 'roundOver');
    assert.equal(s.lastEvent.viaCommit, true);
  });

  test('two players: going out still ends the round at once', () => {
    const s = goOut(setup({ p1: ['r10a', 'r11a', 'r12a'], p2: ['k1a', 'k2a', 'k3a'] }));
    assert.equal(s.phase, 'roundOver');
    assert.deepEqual(order(s), ['p1', 'p2']);
    assert.deepEqual(s.result.deltas, { p1: 6, p2: -6 });
  });
});

describe('official scoring is fixed when the first player goes out', () => {
  test('snapshot of every rack at the first out; later play changes places, not points', () => {
    let s = goOut(setup(FOUR(), { pool: ['o13b'] })); // p1 out; racks now p2 6, p3 45, p4 9
    assert.deepEqual(s.scoreSnapshot, { winnerId: 'p1', rackValues: { p1: 0, p2: 6, p3: 45, p4: 9 } });
    s = pass(s); // p2 draws the orange 13: rack now 19, but scoring won't see it
    s = goOut(s); // p3 out 2nd
    s = goOut(s); // p4 out 3rd -> only p2 left, last
    assert.equal(s.phase, 'roundOver');
    assert.deepEqual(order(s), ['p1', 'p3', 'p4', 'p2']);
    assert.equal(s.result.scoredAtFirstOut, true);
    assert.deepEqual(s.result.deltas, { p1: 60, p2: -6, p3: -45, p4: -9 });
    assert.deepEqual(s.players.map((p) => p.score), [60, -6, -45, -9]);
    assert.equal(s.result.winnerId, 'p1');
  });

  test('a later finisher still loses the points they held at the first out', () => {
    let s = goOut(setup(FOUR()));
    s = goOut(s); // p2 out 2nd, but held 6 points when p1 went out
    s = endRoundNow(s);
    assert.equal(s.result.deltas.p2, -6);
    assert.equal(s.result.placements.find((p) => p.id === 'p2').place, 2);
  });
});

describe('ending without everyone going out', () => {
  test('stall: pool empty and every remaining player passes -> ranked by lowest rack value', () => {
    const racks = { p1: ['r10a', 'r11a', 'r12a'], p2: ['k1a', 'k5a', 'o13a'], p3: ['b4a', 'Ja', 'r1a'], p4: ['o2a', 'k9b', 'r3b'] };
    let s = goOut(setup(racks, { pool: [] })); // p1 out
    s = pass(s); // p2
    s = pass(s); // p3
    assert.equal(s.phase, 'playing', 'only 2 of the 3 remaining have passed');
    s = pass(s); // p4: all 3 remaining passed
    assert.equal(s.phase, 'roundOver');
    assert.equal(s.result.reason, 'blocked');
    // p2 = 19, p3 = 35, p4 = 14
    assert.deepEqual(order(s), ['p1', 'p4', 'p2', 'p3']);
    assert.deepEqual(s.result.deltas, { p1: 68, p2: -19, p3: -35, p4: -14 }, 'still scored from the first out');
  });

  test('stall with nobody out: the lowest rack wins and racks are scored as they stand', () => {
    const racks = { p1: ['k9a', 'k10a'], p2: ['r2a', 'Ja'], p3: ['o5a'] };
    let s = setup(racks, { pool: [] });
    s = pass(pass(pass(s)));
    assert.equal(s.phase, 'roundOver');
    assert.deepEqual(order(s), ['p3', 'p1', 'p2']);
    assert.equal(s.result.scoredAtFirstOut, false);
    assert.deepEqual(s.result.deltas, { p3: 51, p1: -19, p2: -32 });
  });

  test('End round now ranks everyone still playing by rack value', () => {
    let s = goOut(setup(FOUR())); // p1 out; p2 6, p3 45, p4 9
    s = endRoundNow(s);
    assert.equal(s.phase, 'roundOver');
    assert.equal(s.result.reason, 'ended');
    assert.deepEqual(order(s), ['p1', 'p2', 'p4', 'p3']);
    assert.deepEqual(s.result.deltas, { p1: 60, p2: -6, p3: -45, p4: -9 });
    assert.equal(s.lastEvent.type, 'roundOver');
    assert.throws(() => endRoundNow(s), /No round in progress/);
  });

  test('End round now before anyone went out: lowest rack is 1st and takes the points', () => {
    const s = endRoundNow(setup(FOUR()));
    assert.deepEqual(order(s), ['p2', 'p4', 'p1', 'p3']);
    assert.deepEqual(s.result.deltas, { p2: 87, p4: -9, p1: -33, p3: -45 });
  });

  test('ties in rack value keep seat order', () => {
    const s = endRoundNow(setup({ p1: ['r5a'], p2: ['k5a'], p3: ['b1a'] }));
    assert.deepEqual(order(s), ['p3', 'p1', 'p2']);
  });
});

describe('bots', () => {
  test('when every person has finished and only bots are left, the round finishes itself', () => {
    const s = goOut(setup(FOUR(), { bots: ['p2', 'p3', 'p4'] })); // p1 is the only person
    assert.equal(s.phase, 'roundOver');
    assert.equal(s.result.reason, 'botsOnly');
    assert.deepEqual(order(s), ['p1', 'p2', 'p4', 'p3']);
    assert.deepEqual(s.result.placements.slice(1).map((p) => p.how), ['rack', 'rack', 'rack']);
    assert.equal(s.lastEvent.viaCommit, true);
  });

  test('a person still playing keeps the round going after a bot goes out', () => {
    const s = goOut(setup(FOUR(), { bots: ['p1', 'p3'] })); // bot p1 out; people p2, p4 still in
    assert.equal(s.phase, 'playing');
  });

  test('with two people, the round continues until both have finished', () => {
    let s = goOut(setup(FOUR(), { bots: ['p3', 'p4'] })); // person p1 out
    assert.equal(s.phase, 'playing', 'p2 (a person) is still playing');
    s = goOut(s); // person p2 out -> only bots left
    assert.equal(s.phase, 'roundOver');
    assert.equal(s.result.reason, 'botsOnly');
    assert.deepEqual(order(s), ['p1', 'p2', 'p4', 'p3']);
  });

  test('all-bot games (watch mode) play every place out', () => {
    const s = goOut(setup(FOUR(), { bots: ['p1', 'p2', 'p3', 'p4'] }));
    assert.equal(s.phase, 'playing');
  });
});

describe('save and restore', () => {
  test('finished places and the score snapshot survive a reload, and play carries on', () => {
    let s = goOut(setup(FOUR(), { pool: ['k13b'] }));
    s = pass(s); // p2 draws the black 13 (rack 19)
    s = roundTrip(s);
    assert.deepEqual(s.finished, ['p1']);
    assert.deepEqual(s.scoreSnapshot.rackValues, { p1: 0, p2: 6, p3: 45, p4: 9 });
    assert.equal(currentPlayerId(s), 'p3');
    s = goOut(s); // p3 2nd
    s = roundTrip(s);
    s = endRoundNow(s);
    assert.deepEqual(order(s), ['p1', 'p3', 'p4', 'p2']);
    assert.equal(s.result.deltas.p2, -6, 'scored from the snapshot taken before the reload');
    const after = roundTrip(s);
    assert.deepEqual(after.result.placements, s.result.placements);
  });

  test('older saves (no finished list, no snapshot) still load and play', () => {
    const old = setup(FOUR());
    delete old.finished;
    delete old.scoreSnapshot;
    let s = restoreGame(JSON.parse(JSON.stringify(old)));
    assert.deepEqual(s.finished, []);
    assert.equal(s.scoreSnapshot, null);
    s = goOut(s);
    assert.deepEqual(s.finished, ['p1']);
    assert.equal(playerView(s, 'p1').players[0].place, 1);
  });

  test('older round results without placements still show a ranking', () => {
    const players = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    const legacy = { winnerId: 'p2', reason: 'out', deltas: { p1: -20, p2: 25, p3: -5 }, rackValues: { p1: 20, p2: 0, p3: 5 } };
    assert.deepEqual(resultPlacements(legacy, players).map((p) => p.id), ['p2', 'p3', 'p1']);
  });
});
