import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, addPlayer, startRound, commitTurn, drawTile, setTimer, turnClock, restoreGame,
  effectiveTimer, publicView, currentPlayerId,
} from '../js/game/engine.js';
import { findMove } from '../js/bot/search.js';

function playing(timer = 60, players = [{ id: 'p1', name: 'Ana' }, { id: 'p2', name: 'Ben' }]) {
  let s = createGame();
  for (const p of players) s = addPlayer(s, p);
  s = setTimer(s, timer);
  return startRound(s, 5);
}
/** What the table does: keep the clock in step with the game after every change. */
const roundTrip = (s) => restoreGame(JSON.parse(JSON.stringify(s))); // table save -> reload

describe('turn timer changed mid-game', () => {
  test('a change applies at the start of the next turn, not the current one', () => {
    let s = playing(60);
    let clock = turnClock(null, s, 1000);
    assert.equal(clock.deadline, 1000 + 60000);

    s = setTimer(s, 120);
    assert.equal(s.settings.timer, 60, 'current turn keeps its timer');
    assert.equal(s.settings.pendingTimer, 120);
    assert.equal(effectiveTimer(s), 120);
    assert.deepEqual(s.lastEvent.type === 'timerChange' && [s.lastEvent.timer, s.lastEvent.when], [120, 'nextTurn']);
    const same = turnClock(clock, s, 5000);
    assert.equal(same.deadline, 61000, 'the running countdown is untouched');

    s = drawTile(s, currentPlayerId(s)).state; // next turn
    assert.equal(s.settings.timer, 120);
    assert.equal(s.settings.pendingTimer, null);
    clock = turnClock(same, s, 9000);
    assert.equal(clock.deadline, 9000 + 120000);
    assert.equal(clock.total, 120000);
  });

  test('turning the timer on mid-turn starts with the next turn', () => {
    let s = playing(0);
    let clock = turnClock(null, s, 0);
    assert.equal(clock.deadline, 0);
    s = setTimer(s, 30);
    clock = turnClock(clock, s, 100);
    assert.equal(clock.deadline, 0, 'no countdown sprung on the current player');
    s = drawTile(s, currentPlayerId(s)).state;
    assert.equal(turnClock(clock, s, 200).deadline, 200 + 30000);
  });

  test('turning the timer off mid-turn stops the countdown immediately', () => {
    let s = playing(60);
    const clock = turnClock(null, s, 0);
    assert.ok(clock.deadline > 0);
    s = setTimer(s, 0);
    assert.equal(s.settings.timer, 0);
    assert.equal(s.lastEvent.when, 'now');
    assert.equal(turnClock(clock, s, 10).deadline, 0);
    s = drawTile(s, currentPlayerId(s)).state;
    assert.equal(turnClock(null, s, 20).deadline, 0, 'and it stays off');
  });

  test('turning it off cancels a pending change too', () => {
    let s = setTimer(playing(60), 120);
    s = setTimer(s, 0);
    assert.equal(s.settings.pendingTimer, null);
    s = drawTile(s, currentPlayerId(s)).state;
    assert.equal(s.settings.timer, 0);
  });

  test('changing back before the next turn cancels the pending change', () => {
    let s = setTimer(playing(60), 30);
    s = setTimer(s, 60);
    assert.equal(s.settings.pendingTimer, null);
    s = drawTile(s, currentPlayerId(s)).state;
    assert.equal(s.settings.timer, 60);
  });

  test('a commit also starts the next turn with the new timer', () => {
    let s = playing(60);
    const pid = currentPlayerId(s);
    s = structuredClone(s);
    s.racks[pid] = ['r10a', 'r11a', 'r12a', 'k1a'];
    s = setTimer(s, 30);
    s = commitTurn(s, pid, [['r10a', 'r11a', 'r12a']]).state;
    assert.equal(s.settings.timer, 30);
  });

  test('between rounds and in the lobby, changes apply at once', () => {
    assert.equal(setTimer(createGame(), 30).settings.timer, 30);
    let s = playing(60);
    s = structuredClone(s);
    s.racks.p1 = ['r10a', 'r11a', 'r12a'];
    s = commitTurn(s, 'p1', [['r10a', 'r11a', 'r12a']]).state;
    assert.equal(s.phase, 'roundOver');
    s = setTimer(s, 120);
    assert.equal(s.settings.timer, 120);
    s = startRound(s, 9);
    assert.equal(turnClock(null, s, 0).total, 120000);
  });

  test('phones see the current and pending timer in their snapshot', () => {
    const s = setTimer(playing(60), 120);
    const v = publicView(s);
    assert.equal(v.settings.timer, 60);
    assert.equal(v.settings.pendingTimer, 120);
    assert.equal(v.lastEvent.type, 'timerChange');
  });
});

describe('timer persistence', () => {
  test('a pending change survives a table save and reload, then applies next turn', () => {
    let s = setTimer(playing(60), 30);
    s = roundTrip(s);
    assert.equal(s.settings.timer, 60);
    assert.equal(s.settings.pendingTimer, 30);
    s = drawTile(s, currentPlayerId(s)).state;
    assert.equal(s.settings.timer, 30);
    assert.equal(roundTrip(s).settings.timer, 30);
  });
  test('an applied setting survives save and reload', () => {
    const s = roundTrip(setTimer(playing(0), 0));
    assert.equal(s.settings.timer, 0);
    assert.equal(roundTrip(setTimer(createGame(), 120)).settings.timer, 120);
  });
  test('games saved before this change still load, keeping the timer they started with', () => {
    // Shape of a save from earlier versions: no pendingTimer (and the oldest had no strictJokers).
    const old = playing(120);
    delete old.settings.pendingTimer;
    delete old.settings.strictJokers;
    const s = restoreGame(JSON.parse(JSON.stringify(old)));
    assert.equal(s.settings.timer, 120);
    assert.equal(s.settings.pendingTimer, null);
    assert.equal(s.settings.strictJokers, true);
    assert.equal(turnClock(null, s, 0).total, 120000);
    // and it keeps playing normally
    const next = drawTile(s, currentPlayerId(s)).state;
    assert.equal(next.settings.timer, 120);
  });
  test('garbage timer values in a save fall back safely', () => {
    const s = restoreGame({ ...createGame(), settings: { timer: 45, pendingTimer: 'x' } });
    assert.equal(s.settings.timer, 0);
    assert.equal(s.settings.pendingTimer, null);
  });
});

describe('bots and the timer', () => {
  test('bots play under a mid-game timer change exactly like people (same draw/commit path)', () => {
    let s = createGame();
    s = addPlayer(addPlayer(s, { id: 'b1', name: 'Robo', bot: 'normal' }), { id: 'b2', name: 'Robo 2', bot: 'easy' });
    s = startRound(setTimer(s, 120), 11);
    let clock = turnClock(null, s, 0);
    s = setTimer(s, 30);
    for (let i = 0; i < 6 && s.phase === 'playing'; i++) {
      const pid = currentPlayerId(s);
      const timerThisTurn = s.settings.timer;
      assert.equal(clock.total, timerThisTurn * 1000, `turn ${i}: countdown matches the timer in force`);
      const m = findMove({ board: s.board.map((b) => b.tiles), rack: s.racks[pid], hasMelded: s.melded[pid], level: s.players.find((p) => p.id === pid).bot });
      s = m ? commitTurn(s, pid, m.sets).state : drawTile(s, pid).state;
      clock = turnClock(clock, s, (i + 1) * 1000);
    }
    assert.equal(s.settings.timer, 30);
  });
  test('a bot that runs out of time draws, like a person', () => {
    let s = createGame();
    s = addPlayer(addPlayer(s, { id: 'b1', name: 'Robo', bot: 'normal' }), { id: 'p2', name: 'Ben' });
    s = startRound(setTimer(s, 30), 2);
    const pid = currentPlayerId(s);
    const before = s.racks[pid].length;
    s = drawTile(s, pid, 'timeout').state;
    assert.equal(s.racks[pid].length, before + 1);
    assert.equal(s.lastEvent.type, 'timeout');
  });
});
