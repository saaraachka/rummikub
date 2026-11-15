import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findMove, candidateSets } from '../js/bot/search.js';
import { validateTurn, analyzeSet } from '../js/game/rules.js';

const ok = (args, m) => {
  const v = validateTurn({ before: args.board, after: m.sets, rack: args.rack, hasMelded: args.hasMelded, strictJokers: args.strictJokers ?? true });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  return v;
};
const has = (sets, ids) => sets.some((s) => ids.every((id) => s.includes(id)) && s.length === ids.length);

describe('bot: initial meld', () => {
  for (const level of ['easy', 'normal']) {
    test(`${level}: finds a 30-point meld from the rack`, () => {
      const args = { board: [], rack: ['r10a', 'r11a', 'r12a', 'k1a', 'b5a', 'o8a', 'k9b'], hasMelded: false, level };
      const m = findMove(args);
      assert.ok(m, 'expected a move');
      const v = ok(args, m);
      assert.ok(v.meldPoints >= 30);
      assert.ok(has(m.sets, ['r10a', 'r11a', 'r12a']));
    });
  }
  test('combines several small sets to reach 30', () => {
    const args = { board: [], rack: ['k1a', 'k2a', 'k3a', 'b7a', 'o7a', 'r7a', 'b4a', 'b5a', 'b6a', 'o13a'], hasMelded: false, level: 'easy' };
    const m = findMove(args);
    assert.ok(m);
    assert.ok(ok(args, m).meldPoints >= 30);
  });
  test('uses a joker toward the meld', () => {
    const args = { board: [], rack: ['o11a', 'o13a', 'Ja', 'k2a', 'b9b'], hasMelded: false };
    const m = findMove(args);
    assert.ok(m);
    assert.equal(ok(args, m).meldPoints, 36);
  });
  test('draws when no 30-point meld exists (sets worth less are not enough)', () => {
    assert.equal(findMove({ board: [], rack: ['k1a', 'k2a', 'k3a', 'b5a', 'o8a', 'r1a', 'b12a'], hasMelded: false }), null);
  });
  test('draws when there are no sets at all', () => {
    assert.equal(findMove({ board: [], rack: ['k1a', 'r3a', 'b5a', 'o7a', 'k9a', 'r11a', 'b13a'], hasMelded: false }), null);
  });
  test('initial meld never touches the table', () => {
    const board = [['o3a', 'o4a', 'o5a']];
    const args = { board, rack: ['o6a', 'r10a', 'r11a', 'r12a'], hasMelded: false, level: 'normal' };
    const m = findMove(args);
    ok(args, m);
    assert.ok(has(m.sets, ['o3a', 'o4a', 'o5a']), 'table set untouched');
    assert.ok(!m.played.includes('o6a'));
  });
});

describe('bot: after melding', () => {
  test('easy adds a tile to the end of a run', () => {
    const args = { board: [['r4a', 'r5a', 'r6a']], rack: ['r7a', 'k1a'], hasMelded: true, level: 'easy' };
    const m = findMove(args);
    ok(args, m);
    assert.deepEqual(m.played, ['r7a']);
    assert.ok(has(m.sets, ['r4a', 'r5a', 'r6a', 'r7a']));
  });
  test('easy adds to the front of a run and into a group', () => {
    const args = { board: [['b5a', 'b6a', 'b7a'], ['k9a', 'r9a', 'b9a']], rack: ['b4a', 'o9a', 'k1a'], hasMelded: true, level: 'easy' };
    const m = findMove(args);
    ok(args, m);
    assert.deepEqual([...m.played].sort(), ['b4a', 'o9a']);
  });
  test('easy plays new sets from the rack too', () => {
    const args = { board: [['b5a', 'b6a', 'b7a']], rack: ['k1a', 'k2a', 'k3a', 'o12a'], hasMelded: true, level: 'easy' };
    const m = findMove(args);
    ok(args, m);
    assert.ok(has(m.sets, ['k1a', 'k2a', 'k3a']));
  });
  test('easy never rearranges: draws when only a split would work', () => {
    assert.equal(findMove({ board: [['r3a', 'r4a', 'r5a', 'r6a', 'r7a']], rack: ['r5b', 'k1a'], hasMelded: true, level: 'easy' }), null);
  });
  test('normal splits a run to insert a tile', () => {
    const args = { board: [['r3a', 'r4a', 'r5a', 'r6a', 'r7a']], rack: ['r5b', 'k1a'], hasMelded: true, level: 'normal' };
    const m = findMove(args);
    ok(args, m);
    assert.deepEqual(m.played, ['r5b']);
    assert.ok(has(m.sets, ['r3a', 'r4a', 'r5a']) && has(m.sets, ['r5b', 'r6a', 'r7a']));
  });
  test('normal takes a tile off a group of 4 to complete a new set', () => {
    const args = { board: [['k5a', 'r5a', 'b5a', 'o5a']], rack: ['k6a', 'k7a', 'o1a'], hasMelded: true, level: 'normal' };
    const m = findMove(args);
    ok(args, m);
    assert.ok(has(m.sets, ['k5a', 'k6a', 'k7a']));
  });
  test('normal takes the end of a run to complete a new group', () => {
    const args = { board: [['b6a', 'b7a', 'b8a', 'b9a']], rack: ['k9a', 'o9a', 'r2a'], hasMelded: true, level: 'normal' };
    const m = findMove(args);
    ok(args, m);
    assert.ok(has(m.sets, ['b6a', 'b7a', 'b8a']));
    assert.ok(m.sets.some((s) => analyzeSet(s).type === 'group' && s.includes('b9a')));
  });
  test('normal combines moves to play the most value', () => {
    // Take the orange 13 off the end of a run for a group of 13s, and put the black 1 on a run.
    const args = { board: [['k2a', 'k3a', 'k4a'], ['o10a', 'o11a', 'o12a', 'o13a']], rack: ['r13a', 'b13a', 'k1a'], hasMelded: true, level: 'normal' };
    const m = findMove(args);
    ok(args, m);
    assert.deepEqual([...m.played].sort(), ['b13a', 'k1a', 'r13a']);
    // Easy can only manage the black 1.
    assert.deepEqual(findMove({ ...args, level: 'easy' }).played, ['k1a']);
  });
  test('never takes a joker off the table', () => {
    const board = [['r4a', 'Ja', 'r6a', 'r7a']];
    for (const level of ['easy', 'normal']) {
      for (const strictJokers of [true, false]) {
        const m = findMove({ board, rack: ['r5a', 'k8a', 'k9a'], hasMelded: true, level, strictJokers });
        if (!m) continue;
        const set = m.sets.find((s) => s.includes('Ja'));
        const a = analyzeSet(set);
        assert.equal(a.numbers[a.ordered.indexOf('Ja')], 5, `${level}/${strictJokers}: joker still stands for red 5`);
      }
    }
  });
  test('plays its own jokers', () => {
    const args = { board: [['b5a', 'b6a', 'b7a']], rack: ['Ja', 'k1a'], hasMelded: true, level: 'easy' };
    const m = findMove(args);
    ok(args, m);
    assert.deepEqual(m.played, ['Ja']);
  });
  test('draws with nothing playable', () => {
    assert.equal(findMove({ board: [['b5a', 'b6a', 'b7a']], rack: ['k1a', 'r12a'], hasMelded: true, level: 'normal' }), null);
  });
});

describe('bot: limits', () => {
  test('a zero time budget still returns quickly with a valid move or a draw', () => {
    const rack = ['r10a', 'r11a', 'r12a', 'k1a', 'k2a', 'k3a', 'b7a', 'o7a', 'r7a', 'Ja', 'Jb', 'o1a', 'o2a', 'o3a'];
    const t = Date.now();
    const m = findMove({ board: [], rack, hasMelded: false, budgetMs: 0 });
    assert.ok(Date.now() - t < 200);
    if (m) ok({ board: [], rack, hasMelded: false }, m);
  });
  test('candidate generation covers groups, runs and joker fills', () => {
    const c = candidateSets(['r4a', 'r6a', 'Ja', 'b4a', 'k4a']);
    assert.ok(c.some((x) => x.type === 'run' && x.s === 4 && x.e === 6 && x.jokers === 1));
    assert.ok(c.some((x) => x.type === 'group' && x.num === 4 && x.kinds.length === 3 && x.jokers === 0));
  });
});
