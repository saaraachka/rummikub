// Placeholder sound recipes. Pure: each recipe renders mono Float32 samples
// for a given sample rate, with no Web Audio needed. Used two ways:
//   - scripts/make-sounds.js renders them to the files in /sounds
//   - at runtime, if a sound file is missing or won't decode, the player
//     synthesizes the same sound instead, so the game is never silent.
// Real samples in /sounds always take priority over these.

const TAU = Math.PI * 2;

/** Deterministic noise so rendered files are reproducible. */
function noiseGen(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const note = (name) => {
  const m = /^([A-G])(#?)(\d)$/.exec(name);
  const semis = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1]] + (m[2] ? 1 : 0);
  return 440 * 2 ** ((Number(m[3]) - 4) + semis / 12);
};

/**
 * Mix a list of voices into one buffer. Voice:
 *   {at, dur, freq, to?, type?, gain?, attack?, decay?, partials?, noise?, lowpass?}
 *   type: 'sine' | 'triangle' | 'soft-square'   decay: exponential time constant (s)
 *   partials: [[ratio, gain], ...] for bell-like tones   noise: true for a filtered noise burst
 */
function mix(sr, voices, { length } = {}) {
  const end = length ?? Math.max(...voices.map((v) => (v.at ?? 0) + v.dur));
  const out = new Float32Array(Math.ceil(end * sr));
  voices.forEach((v, vi) => {
    const start = Math.floor((v.at ?? 0) * sr);
    const n = Math.floor(v.dur * sr);
    const attack = Math.max(1, Math.floor((v.attack ?? 0.004) * sr));
    const decay = v.decay ?? v.dur / 4;
    const gain = v.gain ?? 0.5;
    const rnd = noiseGen(7 + vi);
    let lp = 0;
    const lpA = v.lowpass ? 1 - Math.exp((-TAU * v.lowpass) / sr) : 1;
    const partials = v.partials ?? [[1, 1]];
    const phases = partials.map(() => 0);
    for (let i = 0; i < n && start + i < out.length; i++) {
      const t = i / sr;
      const env = Math.min(1, i / attack) * Math.exp(-t / decay) * Math.min(1, (n - i) / (0.004 * sr));
      let s;
      if (v.noise) {
        lp += lpA * (rnd() - lp);
        s = lp;
      } else {
        const f = v.to ? v.freq * (v.to / v.freq) ** (t / v.dur) : v.freq;
        s = 0;
        partials.forEach(([ratio, g], k) => {
          phases[k] += (TAU * f * ratio) / sr;
          const p = phases[k];
          if (v.type === 'triangle') s += g * (2 / Math.PI) * Math.asin(Math.sin(p));
          else if (v.type === 'soft-square') s += g * Math.tanh(3 * Math.sin(p)) * 0.7;
          else s += g * Math.sin(p);
        });
      }
      out[start + i] += s * env * gain;
    }
  });
  // Normalize every placeholder to the same peak; relative loudness is set
  // per slot by `volume` in the manifest (js/config.js).
  let peak = 0;
  for (const x of out) peak = Math.max(peak, Math.abs(x));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= 0.85 / peak;
  return out;
}

const bell = [[1, 1], [2, 0.35], [3.01, 0.12], [4.2, 0.05]];

/** name -> (sampleRate) => Float32Array */
export const RECIPES = {
  // ---------------- table
  gameStart: (sr) => mix(sr, ['C5', 'E5', 'G5', 'C6'].map((n, i) => ({ at: i * 0.09, dur: 0.6 - i * 0.05, freq: note(n), partials: bell, decay: 0.22, gain: 0.32 }))),
  turnStart: (sr) => mix(sr, [
    { at: 0, dur: 0.5, freq: note('G5'), partials: bell, decay: 0.2, gain: 0.4 },
    { at: 0.11, dur: 0.6, freq: note('D6'), partials: bell, decay: 0.25, gain: 0.35 },
  ]),
  place: (sr) => mix(sr, [
    { at: 0, dur: 0.05, noise: true, lowpass: 2500, decay: 0.012, gain: 0.9 },
    { at: 0, dur: 0.12, freq: 190, to: 150, decay: 0.03, gain: 0.5 },
    { at: 0.055, dur: 0.05, noise: true, lowpass: 3000, decay: 0.01, gain: 0.5 },
    { at: 0.055, dur: 0.1, freq: 230, to: 180, decay: 0.025, gain: 0.35 },
  ]),
  draw: (sr) => mix(sr, [
    { at: 0, dur: 0.2, noise: true, lowpass: 1800, attack: 0.05, decay: 0.07, gain: 0.5 },
    { at: 0.14, dur: 0.06, noise: true, lowpass: 3500, decay: 0.01, gain: 0.5 },
  ]),
  invalid: (sr) => mix(sr, [
    { at: 0, dur: 0.16, freq: note('E4'), type: 'soft-square', decay: 0.1, gain: 0.3 },
    { at: 0.16, dur: 0.24, freq: note('C4'), type: 'soft-square', decay: 0.12, gain: 0.3 },
  ]),
  roundWon: (sr) => mix(sr, [
    ...['C5', 'E5', 'G5'].map((n, i) => ({ at: i * 0.1, dur: 0.3, freq: note(n), partials: bell, decay: 0.12, gain: 0.3 })),
    ...['C6', 'E5', 'G5'].map((n) => ({ at: 0.3, dur: 1.0, freq: note(n), type: 'triangle', attack: 0.01, decay: 0.45, gain: 0.22 })),
  ]),
  playerOut: (sr) => mix(sr, [
    ...['G5', 'C6', 'E6'].map((n, i) => ({ at: i * 0.08, dur: 0.5, freq: note(n), partials: bell, decay: 0.18, gain: 0.32 })),
    { at: 0.24, dur: 0.7, freq: note('G6'), partials: bell, decay: 0.3, gain: 0.25 },
  ]),
  timerWarning: (sr) => mix(sr, [0, 0.16].map((at) => ({ at, dur: 0.09, freq: note('A5'), type: 'triangle', decay: 0.04, gain: 0.45 }))),
  playerJoin: (sr) => mix(sr, [{ at: 0, dur: 0.16, freq: note('E5'), to: note('A5'), type: 'triangle', decay: 0.07, gain: 0.4 }]),
  playerLeave: (sr) => mix(sr, [{ at: 0, dur: 0.16, freq: note('A5'), to: note('E5'), type: 'triangle', decay: 0.07, gain: 0.35 }]),

  // ---------------- phone
  yourTurn: (sr) => mix(sr, [
    ...['C6', 'E6', 'G6'].map((n, i) => ({ at: i * 0.1, dur: 0.55, freq: note(n), partials: bell, decay: 0.22, gain: 0.42 })),
    { at: 0.3, dur: 0.6, freq: note('C7'), partials: bell, decay: 0.25, gain: 0.25 },
  ]),
  pickup: (sr) => mix(sr, [{ at: 0, dur: 0.04, freq: 1400, to: 1800, decay: 0.012, gain: 0.35 }]),
  drop: (sr) => mix(sr, [
    { at: 0, dur: 0.04, noise: true, lowpass: 2800, decay: 0.008, gain: 0.7 },
    { at: 0, dur: 0.07, freq: 260, to: 200, decay: 0.02, gain: 0.35 },
  ]),
  snap: (sr) => mix(sr, [
    { at: 0, dur: 0.04, noise: true, lowpass: 3000, decay: 0.008, gain: 0.6 },
    { at: 0.02, dur: 0.18, freq: note('E6'), partials: bell, decay: 0.06, gain: 0.3 },
  ]),
  setInvalid: (sr) => mix(sr, [{ at: 0, dur: 0.1, freq: 150, to: 120, decay: 0.03, gain: 0.35 }]),
  commitOk: (sr) => mix(sr, [
    { at: 0, dur: 0.25, freq: note('G5'), partials: bell, decay: 0.09, gain: 0.35 },
    { at: 0.08, dur: 0.35, freq: note('C6'), partials: bell, decay: 0.12, gain: 0.35 },
  ]),
  commitError: (sr) => mix(sr, [
    { at: 0, dur: 0.12, freq: note('D4'), type: 'soft-square', decay: 0.07, gain: 0.28 },
    { at: 0.13, dur: 0.18, freq: note('A3'), type: 'soft-square', decay: 0.09, gain: 0.28 },
  ]),
  drew: (sr) => mix(sr, [
    { at: 0, dur: 0.16, noise: true, lowpass: 2000, attack: 0.04, decay: 0.05, gain: 0.45 },
    { at: 0.1, dur: 0.12, freq: note('A5'), partials: bell, decay: 0.04, gain: 0.18 },
  ]),
  won: (sr) => RECIPES.roundWon(sr),
  roundOver: (sr) => mix(sr, ['G5', 'E5', 'C5'].map((n, i) => ({ at: i * 0.13, dur: 0.4, freq: note(n), partials: bell, decay: 0.15, gain: 0.3 }))),
};

export function renderSound(name, sampleRate = 44100) {
  const recipe = RECIPES[name];
  if (!recipe) throw new Error(`No synth recipe for sound "${name}"`);
  return recipe(sampleRate);
}
