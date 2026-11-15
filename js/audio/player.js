// Sound player: Web Audio with every sound decoded up front, so playback is
// instant. Files from the manifest take priority; a slot whose file is missing
// or won't decode is synthesized from js/audio/synth.js instead.
//
// Browsers (iOS especially) keep audio locked until a user gesture, so call
// unlock() from a tap handler (the phone's Join button, the table's Start or
// "Enable sound"). unlock() also asks Safari to treat this as media playback
// so sounds play with the ring/silent switch on, where that API exists.
//
// Everything browser-specific is injectable, which is how the unit tests run
// this in Node with a fake AudioContext.

import { renderSound } from './synth.js';

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

export function createSoundPlayer({
  manifest,
  where = null, // only load slots for this screen ('table' | 'phone'); null = all
  baseUrl = globalThis.location?.href,
  storageKey = 'sound',
  storage = safeLocalStorage(),
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  nav = globalThis.navigator,
} = {}) {
  const prefs = readPrefs();
  const buffers = new Map(); // name -> AudioBuffer
  const sources = new Map(); // name -> 'file' | 'synth'
  let ctx = null;
  let master = null;
  let loading = null;
  const names = Object.keys(manifest).filter((n) => !where || manifest[n].where === where);

  function readPrefs() {
    try {
      const p = JSON.parse(storage.getItem(storageKey) || '{}');
      return { muted: !!p.muted, volume: typeof p.volume === 'number' ? clamp(p.volume) : 0.8 };
    } catch {
      return { muted: false, volume: 0.8 };
    }
  }
  function savePrefs() {
    try { storage.setItem(storageKey, JSON.stringify(prefs)); } catch {}
  }

  function ensureContext() {
    if (ctx || !AudioContextImpl) return ctx;
    try {
      ctx = new AudioContextImpl({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = prefs.volume;
      master.connect(ctx.destination);
    } catch (e) {
      console.warn('Web Audio unavailable:', e);
      ctx = null;
    }
    return ctx;
  }

  async function loadOne(name) {
    const entry = manifest[name];
    if (entry.file && fetchImpl) {
      try {
        const res = await fetchImpl(new URL(entry.file, baseUrl).href);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.arrayBuffer();
        const buf = await decode(data);
        buffers.set(name, buf);
        sources.set(name, 'file');
        return;
      } catch {
        // fall through to the synth
      }
    }
    try {
      const samples = renderSound(name, ctx.sampleRate);
      const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buf.getChannelData(0).set(samples);
      buffers.set(name, buf);
      sources.set(name, 'synth');
    } catch (e) {
      console.warn(`No sound for "${name}":`, e.message);
    }
  }

  // Safari < 14.1 only has the callback form of decodeAudioData.
  function decode(data) {
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p?.then) p.then(resolve, reject);
    });
  }

  const api = {
    /** Create the audio context and decode every sound. Safe to call more than once. */
    load() {
      if (!ensureContext()) return Promise.resolve();
      loading ||= Promise.all(names.map(loadOne));
      return loading;
    },

    /** Call from a user gesture. Resumes the context and plays a silent buffer (iOS needs both). */
    async unlock() {
      try {
        if (nav && 'audioSession' in nav && nav.audioSession) nav.audioSession.type = 'playback';
      } catch {}
      if (!ensureContext()) return false;
      try {
        const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = silent;
        src.connect(ctx.destination);
        src.start(0);
        if (ctx.state !== 'running') await ctx.resume();
      } catch {}
      api.load();
      return ctx.state === 'running';
    },

    get unlocked() {
      return !!ctx && ctx.state === 'running';
    },

    /** Play a sound now. Returns true if it was started. Never throws. */
    play(name, { delay = 0, gain = 1 } = {}) {
      if (prefs.muted || !ctx || ctx.state !== 'running') return false;
      const buf = buffers.get(name);
      const entry = manifest[name];
      if (!buf || !entry) return false;
      try {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.value = (entry.volume ?? 1) * gain;
        src.connect(g);
        g.connect(master);
        src.start(ctx.currentTime + delay / 1000);
        return true;
      } catch {
        return false;
      }
    },

    get muted() { return prefs.muted; },
    setMuted(m) {
      prefs.muted = !!m;
      savePrefs();
    },
    get volume() { return prefs.volume; },
    setVolume(v) {
      prefs.volume = clamp(v);
      if (master) master.gain.value = prefs.volume;
      savePrefs();
    },
    /** 'file' or 'synth' for each loaded slot (handy for checking your samples were picked up). */
    sources: () => Object.fromEntries(sources),
  };
  return api;
}

const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function safeLocalStorage() {
  try {
    const s = globalThis.localStorage;
    s.getItem('x');
    return s;
  } catch {
    return memoryStorage();
  }
}
