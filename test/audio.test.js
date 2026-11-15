import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SOUNDS } from '../js/config.js';
import { tableCues, phoneCues, timerCue, commitCue, editCue, pickupCue } from '../js/audio/cues.js';
import { createSoundPlayer } from '../js/audio/player.js';
import { RECIPES, renderSound } from '../js/audio/synth.js';
import { createHaptics, PATTERNS } from '../js/ui/haptics.js';
import { createGame, addPlayer, startRound, commitTurn, drawTile, publicView, playerView } from '../js/game/engine.js';

// ------------------------------------------------------------ fixtures

function game() {
  let s = createGame();
  s = addPlayer(s, { id: 'p1', name: 'Ana' });
  s = addPlayer(s, { id: 'p2', name: 'Ben' });
  return startRound(s, 3);
}
function rig(s, racks, board = []) {
  const t = structuredClone(s);
  Object.assign(t.racks, racks);
  t.board = board.map((tiles, i) => ({ id: `x${i}`, tiles }));
  return t;
}
const sounds = (cues) => cues.map((c) => c.sound);
const views = (a, b, pid) => [playerView(a, pid), playerView(b, pid)];

// ------------------------------------------------------------ manifest

describe('sound manifest', () => {
  test('every slot has a file, a volume, a screen and a synth fallback', () => {
    for (const [name, e] of Object.entries(SOUNDS)) {
      assert.ok(e.file && /^sounds\//.test(e.file), name);
      assert.ok(e.volume >= 0 && e.volume <= 1, name);
      assert.ok(['table', 'phone'].includes(e.where), name);
      assert.ok(RECIPES[name], `synth recipe for ${name}`);
    }
  });
  test('synth placeholders are short, finite and do not clip', () => {
    for (const name of Object.keys(SOUNDS)) {
      const s = renderSound(name, 22050);
      assert.ok(s.length > 0 && s.length / 22050 <= 1.5, `${name} length`);
      for (const x of s) assert.ok(Number.isFinite(x) && Math.abs(x) <= 1, name);
    }
  });
});

// ------------------------------------------------------------ table vs phone mapping

describe('cues: table', () => {
  test('lobby joins and leaves', () => {
    let a = createGame();
    let b = addPlayer(a, { id: 'p1', name: 'Ana' });
    assert.deepEqual(sounds(tableCues(publicView(a), publicView(b))), ['playerJoin']);
    const c = addPlayer(b, { id: 'b1', name: 'Robo', bot: 'easy' });
    assert.deepEqual(sounds(tableCues(publicView(b), publicView(c))), ['playerJoin'], 'adding a bot counts as a join');
    assert.deepEqual(sounds(tableCues(publicView(c), publicView(b))), ['playerLeave']);
  });
  test('game start, then commit + next turn chime, draw + chime, invalid', () => {
    let s = createGame();
    s = addPlayer(addPlayer(s, { id: 'p1', name: 'A' }), { id: 'p2', name: 'B' });
    const started = startRound(s, 3);
    assert.deepEqual(sounds(tableCues(publicView(s), publicView(started))), ['gameStart']);

    const rigged = rig(started, { p1: ['r10a', 'r11a', 'r12a', 'k1a'] });
    const bad = commitTurn(rigged, 'p1', [['r10a', 'r11a']]);
    assert.deepEqual(sounds(tableCues(publicView(rigged), publicView(bad.state))), ['invalid']);

    const good = commitTurn(rigged, 'p1', [['r10a', 'r11a', 'r12a']]);
    const cues = tableCues(publicView(rigged), publicView(good.state));
    assert.deepEqual(sounds(cues), ['place', 'turnStart']);
    assert.ok(cues[1].delay > 0, 'turn chime waits for the placement sound');

    const drew = drawTile(good.state, 'p2');
    assert.deepEqual(sounds(tableCues(publicView(good.state), publicView(drew.state))), ['draw', 'turnStart']);
  });
  test('going out plays the placement and the win', () => {
    const s = rig(game(), { p1: ['r10a', 'r11a', 'r12a'] });
    const r = commitTurn(s, 'p1', [['r10a', 'r11a', 'r12a']]);
    assert.deepEqual(sounds(tableCues(publicView(s), publicView(r.state))), ['place', 'roundWon']);
  });
  test('bot turns produce exactly the same cues as human turns', () => {
    let s = createGame();
    s = addPlayer(addPlayer(s, { id: 'b1', name: 'Robo', bot: 'normal' }), { id: 'p2', name: 'B' });
    s = rig(startRound(s, 3), { b1: ['r10a', 'r11a', 'r12a', 'k1a'] });
    const r = commitTurn(s, 'b1', [['r10a', 'r11a', 'r12a']]);
    assert.deepEqual(sounds(tableCues(publicView(s), publicView(r.state))), ['place', 'turnStart']);
  });
  test('first view after a reload is silent', () => {
    assert.deepEqual(tableCues(null, publicView(game())), []);
  });
  test('timer warning fires once when crossing 10 seconds', () => {
    assert.deepEqual(sounds(timerCue(10200, 9900)), ['timerWarning']);
    assert.deepEqual(timerCue(9900, 9600), []);
    assert.deepEqual(timerCue(30000, 20000), []);
  });
  test('table cues only use table sounds', () => {
    let s = createGame();
    let prev = publicView(s);
    const seen = new Set();
    s = addPlayer(addPlayer(s, { id: 'p1', name: 'A' }), { id: 'p2', name: 'B' });
    for (const next of [s, startRound(s, 1)]) {
      for (const c of tableCues(prev, publicView(next))) seen.add(c.sound);
      prev = publicView(next);
    }
    for (const name of seen) assert.equal(SOUNDS[name].where, 'table', name);
  });
});

describe('cues: phone (only the player it concerns)', () => {
  test("your turn fires only on the phone whose turn it is, with haptic and flash", () => {
    const s = rig(game(), { p1: ['r10a', 'r11a', 'r12a', 'k1a'] });
    const r = commitTurn(s, 'p1', [['r10a', 'r11a', 'r12a']]).state; // now p2's turn
    const ben = phoneCues(...views(s, r, 'p2'));
    assert.deepEqual(ben, [{ sound: 'yourTurn', haptic: 'turn', flash: true, delay: 0 }]);
    assert.deepEqual(phoneCues(...views(s, r, 'p1')), [], "Ana's phone stays quiet after her own commit (commitOk covers it)");
  });
  test('your turn at the start of a round if you go first', () => {
    let s = createGame();
    s = addPlayer(addPlayer(s, { id: 'p1', name: 'A' }), { id: 'p2', name: 'B' });
    const started = startRound(s, 1);
    assert.deepEqual(sounds(phoneCues(playerView(s, 'p1'), playerView(started, 'p1'))), ['yourTurn']);
    assert.deepEqual(phoneCues(playerView(s, 'p2'), playerView(started, 'p2')), []);
  });
  test('your own draw plays on your phone only', () => {
    const s = game();
    const d = drawTile(s, 'p1').state;
    assert.deepEqual(sounds(phoneCues(...views(s, d, 'p1'))), ['drew']);
    assert.deepEqual(sounds(phoneCues(...views(s, d, 'p2'))), ['yourTurn'], "Ben hears his turn, not Ana's draw");
  });
  test('round over: winner hears "won", others "roundOver"', () => {
    const s = rig(game(), { p1: ['r10a', 'r11a', 'r12a'] });
    const r = commitTurn(s, 'p1', [['r10a', 'r11a', 'r12a']]).state;
    assert.deepEqual(phoneCues(...views(s, r, 'p1')), [{ sound: 'won', haptic: 'double' }]);
    assert.deepEqual(phoneCues(...views(s, r, 'p2')), [{ sound: 'roundOver' }]);
  });
  test('unchanged snapshots (e.g. a rack reorder echo) are silent', () => {
    const s = game();
    assert.deepEqual(phoneCues(playerView(s, 'p1'), playerView(s, 'p1')), []);
  });
  test('commit result, pickup and edit cues', () => {
    assert.deepEqual(commitCue(true), { sound: 'commitOk', haptic: 'double' });
    assert.deepEqual(commitCue(false), { sound: 'commitError', haptic: 'triple' });
    assert.equal(pickupCue().haptic, 'tick');
    assert.equal(editCue([['r4a', 'r5a']], [['r4a', 'r5a', 'r6a']]).sound, 'snap');
    assert.equal(editCue([['r4a', 'r5a', 'r6a']], [['r4a', 'r5a'], ['r6a']]).sound, 'setInvalid');
    assert.equal(editCue([['r4a', 'r5a', 'r6a']], [['r4a', 'r5a', 'r6a'], ['k1a']]).sound, 'drop');
  });
  test('phone cues only use phone sounds', () => {
    const all = [commitCue(true), commitCue(false), pickupCue(), editCue([], [['r1a']]), editCue([['r4a', 'r5a']], [['r4a', 'r5a', 'r6a']]), editCue([['r4a', 'r5a', 'r6a']], [['r4a', 'r5a'], ['r6a']])];
    const s = rig(game(), { p1: ['r10a', 'r11a', 'r12a'] });
    const r = commitTurn(s, 'p1', [['r10a', 'r11a', 'r12a']]).state;
    all.push(...phoneCues(...views(s, r, 'p1')), ...phoneCues(...views(s, r, 'p2')), ...phoneCues(...views(game(), drawTile(game(), 'p1').state, 'p1')));
    for (const c of all) assert.equal(SOUNDS[c.sound].where, 'phone', c.sound);
  });
});

// ------------------------------------------------------------ player

class FakeParam { constructor() { this.value = 1; } }
class FakeNode { connect() {} }
function fakeAudio() {
  const log = { started: [], decoded: 0, buffers: 0 };
  class Ctx {
    constructor() { this.state = 'suspended'; this.sampleRate = 22050; this.currentTime = 0; this.destination = new FakeNode(); }
    createGain() { const g = new FakeNode(); g.gain = new FakeParam(); return g; }
    createBuffer(ch, len, sr) { log.buffers++; const d = new Float32Array(len); return { length: len, sampleRate: sr, getChannelData: () => d }; }
    createBufferSource() { const s = new FakeNode(); s.start = (t) => log.started.push(s.buffer); return s; }
    decodeAudioData(data) { log.decoded++; if (data.byteLength === 0) return Promise.reject(new Error('bad data')); return Promise.resolve({ fromFile: true }); }
    async resume() { this.state = 'running'; }
  }
  return { Ctx, log };
}
const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const okFetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
const missingFetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
const brokenFetch = async () => { throw new Error('offline'); };
const garbageFetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });

describe('sound player', () => {
  const base = 'http://x/';
  test('loads files for its screen only and plays after unlock', async () => {
    const { Ctx, log } = fakeAudio();
    const p = createSoundPlayer({ manifest: SOUNDS, where: 'table', baseUrl: base, storage: memStore(), AudioContextImpl: Ctx, fetchImpl: okFetch, nav: {} });
    assert.equal(p.play('place'), false, 'nothing plays before unlock');
    await p.unlock();
    await p.load();
    const src = p.sources();
    assert.ok(Object.keys(src).every((n) => SOUNDS[n].where === 'table'));
    assert.ok(Object.values(src).every((v) => v === 'file'));
    assert.equal(p.play('place'), true);
    assert.equal(log.started.length, 2, 'silent unlock buffer + the sound');
  });
  test('muting suppresses playback and is remembered', async () => {
    const { Ctx, log } = fakeAudio();
    const storage = memStore();
    const p = createSoundPlayer({ manifest: SOUNDS, where: 'phone', baseUrl: base, storage, AudioContextImpl: Ctx, fetchImpl: okFetch, nav: {} });
    await p.unlock();
    await p.load();
    const before = log.started.length;
    p.setMuted(true);
    assert.equal(p.play('yourTurn'), false);
    assert.equal(log.started.length, before, 'no source started while muted');
    const again = createSoundPlayer({ manifest: SOUNDS, storage, AudioContextImpl: Ctx, fetchImpl: okFetch, nav: {} });
    assert.equal(again.muted, true, 'mute survives a reload');
    p.setMuted(false);
    assert.equal(p.play('yourTurn'), true);
  });
  test('volume is clamped and remembered', () => {
    const storage = memStore();
    const p = createSoundPlayer({ manifest: SOUNDS, storage, AudioContextImpl: fakeAudio().Ctx, fetchImpl: okFetch, nav: {} });
    p.setVolume(3);
    assert.equal(p.volume, 1);
    p.setVolume(0.25);
    assert.equal(createSoundPlayer({ manifest: SOUNDS, storage, nav: {} }).volume, 0.25);
  });
  for (const [label, fetchImpl] of [['404', missingFetch], ['network error', brokenFetch], ['undecodable file', garbageFetch]]) {
    test(`missing sound files fall back to the synth without errors (${label})`, async () => {
      const { Ctx } = fakeAudio();
      const p = createSoundPlayer({ manifest: SOUNDS, where: 'phone', baseUrl: base, storage: memStore(), AudioContextImpl: Ctx, fetchImpl, nav: {} });
      await p.unlock();
      await assert.doesNotReject(p.load());
      const src = p.sources();
      assert.equal(Object.keys(src).length, Object.values(SOUNDS).filter((s) => s.where === 'phone').length);
      assert.ok(Object.values(src).every((v) => v === 'synth'));
      assert.equal(p.play('commitError'), true);
    });
  }
  test('sets the iOS audio session to playback when available', async () => {
    const nav = { audioSession: { type: 'auto' } };
    const p = createSoundPlayer({ manifest: SOUNDS, storage: memStore(), AudioContextImpl: fakeAudio().Ctx, fetchImpl: okFetch, nav });
    await p.unlock();
    assert.equal(nav.audioSession.type, 'playback');
  });
  test('no Web Audio at all: everything is a silent no-op', async () => {
    const p = createSoundPlayer({ manifest: SOUNDS, storage: memStore(), AudioContextImpl: undefined, fetchImpl: okFetch, nav: {} });
    assert.equal(await p.unlock(), false);
    await p.load();
    assert.equal(p.play('place'), false);
  });
  test('unknown sound names are ignored', async () => {
    const p = createSoundPlayer({ manifest: SOUNDS, storage: memStore(), AudioContextImpl: fakeAudio().Ctx, fetchImpl: okFetch, nav: {} });
    await p.unlock();
    await p.load();
    assert.equal(p.play('nope'), false);
  });
});

// ------------------------------------------------------------ haptics

describe('haptics', () => {
  test('uses navigator.vibrate with the named patterns', () => {
    const calls = [];
    const h = createHaptics({ storage: memStore(), nav: { vibrate: (p) => (calls.push(p), true) }, doc: null });
    assert.equal(h.support, 'vibrate');
    h.fire('tick');
    h.fire('double');
    h.fire('triple');
    h.fire('turn');
    assert.deepEqual(calls, [PATTERNS.tick, PATTERNS.double, PATTERNS.triple, PATTERNS.turn]);
    assert.equal(PATTERNS.double.filter((_, i) => i % 2 === 0).length, 2);
    assert.equal(PATTERNS.triple.filter((_, i) => i % 2 === 0).length, 3);
  });
  test('disabled haptics do nothing, and the setting is remembered', () => {
    const calls = [];
    const storage = memStore();
    const h = createHaptics({ storage, nav: { vibrate: (p) => calls.push(p) }, doc: null });
    assert.equal(h.enabled, true, 'on by default');
    h.setEnabled(false);
    h.fire('turn');
    assert.equal(calls.length, 0);
    assert.equal(createHaptics({ storage, nav: {}, doc: null }).enabled, false);
  });
  test('a throwing vibrate never escapes', () => {
    const h = createHaptics({ storage: memStore(), nav: { vibrate: () => { throw new Error('blocked'); } }, doc: null });
    assert.doesNotThrow(() => h.fire('triple'));
  });
  test('no support at all is a silent no-op', () => {
    const h = createHaptics({ storage: memStore(), nav: {}, doc: null });
    assert.equal(h.support, 'none');
    assert.equal(h.fire('turn'), false);
  });
  test('iOS switch trick: clicks a hidden switch label once per pulse', async () => {
    let clicks = 0;
    const appended = [];
    const doc = {
      body: { append: (...els) => appended.push(...els) },
      createElement(tag) {
        const el = { tag, style: {}, setAttribute(k) { if (k === 'switch') this.switch = true; }, click: () => clicks++ };
        return el;
      },
    };
    const h = createHaptics({ storage: memStore(), nav: {}, doc });
    assert.equal(h.support, 'ios-switch');
    h.fire('double');
    assert.equal(clicks, 1, 'first pulse immediately (inside the gesture)');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(clicks, 2);
    assert.equal(appended.length, 2, 'input + label added once');
  });
});
