import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSet, validateBoard, validateTurn, meldPointsFromRack } from '../js/game/rules.js';
import { makeDeck, parseTile, tileValue, sortByColor, sortByNumber, isTileId } from '../js/game/tiles.js';

describe('tiles', () => {
  test('deck has 106 unique, valid tiles with 2 jokers', () => {
    const d = makeDeck();
    assert.equal(d.length, 106);
    assert.equal(new Set(d).size, 106);
    assert.ok(d.every(isTileId));
    assert.equal(d.filter((id) => parseTile(id).joker).length, 2);
    for (const color of ['black', 'red', 'blue', 'orange']) {
      assert.equal(d.filter((id) => parseTile(id).color === color).length, 26);
    }
  });
  test('values', () => {
    assert.equal(tileValue('r7a'), 7);
    assert.equal(tileValue('k13b'), 13);
    assert.equal(tileValue('Ja'), 30);
  });
  test('rejects malformed ids', () => {
    for (const bad of ['r0a', 'r14a', 'x5a', 'r5c', 'J', 'Jc', '', null, 5]) assert.equal(isTileId(bad), false, String(bad));
  });
  test('sorting', () => {
    assert.deepEqual(sortByColor(['Ja', 'b2a', 'k9a', 'r1a', 'k3a']), ['k3a', 'k9a', 'r1a', 'b2a', 'Ja']);
    assert.deepEqual(sortByNumber(['Ja', 'b2a', 'k9a', 'r2a', 'o1a']), ['o1a', 'r2a', 'b2a', 'k9a', 'Ja']);
  });
});

describe('analyzeSet: groups', () => {
  test('valid group of 3 and 4', () => {
    const a = analyzeSet(['r7a', 'b7a', 'k7b']);
    assert.equal(a.valid, true);
    assert.equal(a.type, 'group');
    assert.equal(a.value, 21);
    assert.equal(analyzeSet(['r7a', 'b7a', 'k7b', 'o7a']).value, 28);
  });
  test('duplicate color is rejected with a clear reason', () => {
    const a = analyzeSet(['r7a', 'r7b', 'k7a']);
    assert.equal(a.valid, false);
    assert.match(a.reason, /Group of 7s has two red tiles/);
  });
  test('more than 4 tiles is rejected', () => {
    const a = analyzeSet(['r7a', 'b7a', 'k7a', 'o7a', 'Ja']);
    assert.equal(a.valid, false);
    assert.match(a.reason, /at most 4/);
  });
  test('jokers fill a group', () => {
    const a = analyzeSet(['r7a', 'Ja', 'b7a']);
    assert.equal(a.valid, true);
    assert.equal(a.type, 'group');
    assert.equal(a.value, 21);
    assert.deepEqual(analyzeSet(['r7a', 'Ja', 'b7a', 'Jb']).value, 28);
  });
  test('display order puts jokers last', () => {
    assert.deepEqual(analyzeSet(['Ja', 'o7a', 'k7a']).ordered, ['k7a', 'o7a', 'Ja']);
  });
});

describe('analyzeSet: runs', () => {
  test('valid run in any layout order', () => {
    assert.equal(analyzeSet(['r4a', 'r5a', 'r6a']).value, 15);
    const a = analyzeSet(['r6a', 'r4a', 'r5a']);
    assert.equal(a.valid, true);
    assert.equal(a.type, 'run');
    assert.deepEqual(a.ordered, ['r4a', 'r5a', 'r6a']);
  });
  test('descending layout is tidied to ascending', () => {
    assert.deepEqual(analyzeSet(['b9a', 'b8a', 'b7a']).ordered, ['b7a', 'b8a', 'b9a']);
  });
  test('non-consecutive run', () => {
    const a = analyzeSet(['r4a', 'r5a', 'r7a']);
    assert.equal(a.valid, false);
    assert.match(a.reason, /Run 4-5-7 \(red\) isn't consecutive/);
  });
  test('mixed colors', () => {
    const a = analyzeSet(['r4a', 'b5a', 'r6a']);
    assert.equal(a.valid, false);
    assert.match(a.reason, /groups need one number/);
  });
  test('duplicate number in run', () => {
    const a = analyzeSet(['r4a', 'r5a', 'r5b', 'r6a']);
    assert.equal(a.valid, false);
    assert.match(a.reason, /two 5s/);
  });
  test('1 cannot follow 13 (no wraparound)', () => {
    assert.equal(analyzeSet(['k12a', 'k13a', 'k1a']).valid, false);
  });
  test('full 1-13 run', () => {
    const ids = Array.from({ length: 13 }, (_, i) => `o${i + 1}a`);
    const a = analyzeSet(ids);
    assert.equal(a.valid, true);
    assert.equal(a.value, 91);
  });
  test('14 tiles is too long', () => {
    const ids = Array.from({ length: 13 }, (_, i) => `o${i + 1}a`).concat('Ja');
    assert.equal(analyzeSet(ids).valid, false);
  });
});

describe('analyzeSet: jokers in runs', () => {
  test('joker fills a gap', () => {
    const a = analyzeSet(['r4a', 'Ja', 'r6a']);
    assert.equal(a.valid, true);
    assert.deepEqual(a.numbers, [4, 5, 6]);
    assert.equal(a.value, 15);
  });
  test('joker position chosen by layout: front vs back', () => {
    assert.deepEqual(analyzeSet(['Ja', 'r4a', 'r5a']).numbers, [3, 4, 5]);
    assert.deepEqual(analyzeSet(['r4a', 'r5a', 'Ja']).numbers, [4, 5, 6]);
  });
  test('unordered layout fills gaps first, then extends high', () => {
    const a = analyzeSet(['r8a', 'Ja', 'r6a']);
    assert.equal(a.valid, true);
    assert.deepEqual(a.numbers, [6, 7, 8]);
    assert.deepEqual(a.ordered, ['r6a', 'Ja', 'r8a']);
  });
  test('extends low when the run already reaches 13', () => {
    const a = analyzeSet(['r12a', 'r13a', 'Ja']);
    assert.equal(a.valid, true);
    assert.deepEqual(a.numbers, [11, 12, 13]);
  });
  test('joker cannot be 14 or 0 even when placed there', () => {
    // Laid out as 12-13-J, which would make J a 14; falls back to 11.
    assert.deepEqual(analyzeSet(['r12a', 'r13a', 'Ja']).numbers, [11, 12, 13]);
    assert.deepEqual(analyzeSet(['Ja', 'r1a', 'r2a']).numbers, [1, 2, 3]);
  });
  test('two jokers bridge a two-gap', () => {
    const a = analyzeSet(['b3a', 'Ja', 'Jb', 'b6a']);
    assert.equal(a.valid, true);
    assert.equal(a.value, 3 + 4 + 5 + 6);
  });
  test('not enough jokers for the gaps', () => {
    const a = analyzeSet(['b3a', 'Ja', 'b7a']);
    assert.equal(a.valid, false);
    assert.match(a.reason, /3 gaps but only 1 joker/);
  });
  test('one real tile + two jokers takes the more valuable reading', () => {
    // 7-8-9 run (24) beats a group of 7s (21).
    const a = analyzeSet(['r7a', 'Ja', 'Jb']);
    assert.equal(a.valid, true);
    assert.equal(a.type, 'run');
    assert.equal(a.value, 24);
    // 13 can't extend upward: 11-12-13 (36) vs group 39 -> group.
    const b = analyzeSet(['Ja', 'Jb', 'k13a']);
    assert.equal(b.type, 'group');
    assert.equal(b.value, 39);
  });
});

describe('analyzeSet: size and junk', () => {
  test('fewer than 3 tiles', () => {
    const a = analyzeSet(['r4a', 'r5a']);
    assert.equal(a.valid, false);
    assert.match(a.reason, /at least 3 tiles/);
  });
  test('all jokers is not a set', () => {
    assert.equal(analyzeSet(['Ja', 'Jb']).valid, false);
  });
  test('unknown tile', () => {
    assert.equal(analyzeSet(['r4a', 'r5a', 'zz']).valid, false);
  });
});

describe('validateBoard', () => {
  test('reports each invalid set', () => {
    const r = validateBoard([['r4a', 'r5a', 'r6a'], ['k1a', 'k2a'], ['b9a', 'o9a', 'k9a']]);
    assert.equal(r.valid, false);
    assert.deepEqual(r.results.map((x) => x.valid), [true, false, true]);
  });
});

describe('validateTurn: initial meld', () => {
  const rack = ['r10a', 'r11a', 'r12a', 'k1a', 'k2a', 'k3a', 'b5a', 'o5a', 'r5a', 'Ja'];

  test('30+ points from the rack passes', () => {
    const v = validateTurn({ before: [], after: [['r10a', 'r11a', 'r12a']], rack, hasMelded: false });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.equal(v.meldPoints, 33);
    assert.deepEqual(v.played.sort(), ['r10a', 'r11a', 'r12a']);
    assert.equal(v.rackAfter.length, rack.length - 3);
  });
  test('below 30 fails with the total', () => {
    const v = validateTurn({ before: [], after: [['k1a', 'k2a', 'k3a'], ['b5a', 'o5a', 'r5a']], rack, hasMelded: false });
    assert.equal(v.ok, false);
    assert.match(v.errors[0].message, /totals 21 points; it needs at least 30/);
  });
  test('several sets add up', () => {
    const v = validateTurn({ before: [], after: [['k1a', 'k2a', 'k3a'], ['b5a', 'o5a', 'r5a'], ['r10a', 'r11a', 'r12a']], rack, hasMelded: false });
    assert.equal(v.ok, true);
    assert.equal(v.meldPoints, 6 + 15 + 33);
  });
  test('joker counts as the tile it represents', () => {
    // J-11-12 => 10+11+12 = 33
    const v = validateTurn({ before: [], after: [['Ja', 'r11a', 'r12a']], rack, hasMelded: false });
    assert.equal(v.ok, true);
    assert.equal(v.meldPoints, 33);
  });
  test('cannot use table tiles for the first meld', () => {
    const before = [['o7a', 'o8a', 'o9a']];
    const v = validateTurn({ before, after: [['o7a', 'o8a', 'o9a', 'o10a'], ['r10a', 'r11a', 'r12a']], rack: [...rack, 'o10a'], hasMelded: false });
    assert.equal(v.ok, false);
    assert.match(v.errors[0].message, /only tiles from your rack/);
    assert.equal(v.errors[0].setIndex, 0);
  });
  test('cannot rearrange table sets during the first meld', () => {
    const before = [['o7a', 'o8a', 'o9a', 'o10a', 'o11a', 'o12a']];
    const after = [['o7a', 'o8a', 'o9a'], ['o10a', 'o11a', 'o12a'], ['r10a', 'r11a', 'r12a']];
    const v = validateTurn({ before, after, rack, hasMelded: false });
    assert.equal(v.ok, false);
    assert.match(v.errors[0].message, /only tiles from your rack/);
  });
  test('untouched table sets (even reordered) are fine', () => {
    const before = [['o7a', 'o8a', 'o9a']];
    const after = [['o9a', 'o8a', 'o7a'], ['r10a', 'r11a', 'r12a']];
    const v = validateTurn({ before, after, rack, hasMelded: false });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.equal(v.meldPoints, 33);
  });
  test('table tiles do not count toward the meld', () => {
    const before = [['o11a', 'o12a', 'o13a']];
    const v = validateTurn({ before, after: [...before, ['k1a', 'k2a', 'k3a']], rack, hasMelded: false });
    assert.equal(v.ok, false);
    assert.match(v.errors[0].message, /totals 6 points/);
  });
});

describe('validateTurn: after melding', () => {
  const before = [['r4a', 'r5a', 'r6a', 'r7a'], ['k9a', 'b9a', 'o9a']];

  test('adding one tile to an existing set', () => {
    const v = validateTurn({ before, after: [['r4a', 'r5a', 'r6a', 'r7a', 'r8a'], before[1]], rack: ['r8a', 'k2a'], hasMelded: true });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.deepEqual(v.played, ['r8a']);
    assert.deepEqual(v.rackAfter, ['k2a']);
  });
  test('splitting a run and building a new group', () => {
    // r4-r5-r6-r7 + rack b7,k7 -> r4-r5-r6 and r7-b7-k7
    const after = [['r4a', 'r5a', 'r6a'], ['r7a', 'b7a', 'k7a'], before[1]];
    const v = validateTurn({ before, after, rack: ['b7a', 'k7a', 'o1a'], hasMelded: true });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
  });
  test('rearranging that leaves an invalid set fails and points at it', () => {
    const after = [['r4a', 'r5a'], ['r6a', 'r7a', 'r8a'], before[1]];
    const v = validateTurn({ before, after, rack: ['r8a'], hasMelded: true });
    assert.equal(v.ok, false);
    assert.equal(v.errors[0].setIndex, 0);
    assert.match(v.errors[0].message, /at least 3 tiles/);
  });
  test('must play at least one rack tile', () => {
    const v = validateTurn({ before, after: [before[1], before[0]], rack: ['r8a'], hasMelded: true });
    assert.equal(v.ok, false);
    assert.match(v.errors[0].message, /at least one tile/);
  });
  test('cannot take table tiles back', () => {
    const v = validateTurn({ before, after: [['r4a', 'r5a', 'r6a'], before[1], ['k1a', 'k2a', 'k3a']], rack: ['k1a', 'k2a', 'k3a'], hasMelded: true });
    assert.equal(v.ok, false);
    assert.match(v.errors[0].message, /can't go back to your rack/);
  });
  test('cannot play tiles you do not have', () => {
    const v = validateTurn({ before, after: [...before, ['k1a', 'k2a', 'k3a']], rack: ['k1a', 'k2a'], hasMelded: true });
    assert.equal(v.ok, false);
    assert.match(v.errors[0].message, /black 3 isn't in your rack/);
  });
  test('cannot duplicate a tile', () => {
    const v = validateTurn({ before, after: [...before, ['k1a', 'k2a', 'k1a']], rack: ['k1a', 'k2a'], hasMelded: true });
    assert.equal(v.ok, false);
    assert.match(v.errors[0].message, /appears twice/);
  });
  test('moving a joker off the table to another set is allowed if everything stays valid', () => {
    const b = [['r4a', 'Ja', 'r6a']];
    // Replace the joker with the real r5 and use the joker in a new run.
    const after = [['r4a', 'r5a', 'r6a'], ['k10a', 'k11a', 'Ja']];
    const v = validateTurn({ before: b, after, rack: ['r5a', 'k10a', 'k11a'], hasMelded: true });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
  });
  test('empty sets are ignored and output is tidied', () => {
    const v = validateTurn({ before: [], after: [[], ['r6a', 'r4a', 'r5a']], rack: ['r4a', 'r5a', 'r6a'], hasMelded: true });
    assert.equal(v.ok, true);
    assert.deepEqual(v.sets, [['r4a', 'r5a', 'r6a']]);
  });
});

describe('meldPointsFromRack', () => {
  test('counts only valid all-rack sets', () => {
    const pts = meldPointsFromRack([['r10a', 'r11a', 'r12a'], ['k1a', 'k2a'], ['o1a', 'o2a', 'o3a']], ['r10a', 'r11a', 'r12a', 'k1a', 'k2a']);
    assert.equal(pts, 33);
  });
});
