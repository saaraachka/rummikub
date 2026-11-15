// Render the built-in placeholder sounds (js/audio/synth.js) into /sounds.
//   node scripts/make-sounds.js           write any missing files
//   node scripts/make-sounds.js --force   overwrite everything (careful: replaces your samples)
// Uses ffmpeg for mp3/m4a/ogg output; writes .wav directly without it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOUNDS } from '../js/config.js';
import { renderSound } from '../js/audio/synth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');
const SR = 44100;

function wav(samples, sr) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((x, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x)) * 32767), 44 + i * 2));
  return buf;
}

let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

const done = new Set();
for (const [name, { file }] of Object.entries(SOUNDS)) {
  const out = path.join(root, file);
  if (done.has(out)) continue;
  done.add(out);
  if (fs.existsSync(out) && !force) { console.log(`keep   ${file}`); continue; }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const data = wav(renderSound(name, SR), SR);
  const ext = path.extname(out).toLowerCase();
  if (ext === '.wav') {
    fs.writeFileSync(out, data);
  } else if (hasFfmpeg) {
    const tmp = path.join(os.tmpdir(), `snd-${name}.wav`);
    fs.writeFileSync(tmp, data);
    const codec = ext === '.mp3' ? ['-c:a', 'libmp3lame', '-b:a', '128k'] : ext === '.ogg' ? ['-c:a', 'libvorbis'] : ['-c:a', 'aac', '-b:a', '128k'];
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-ac', '1', ...codec, out]);
    fs.unlinkSync(tmp);
  } else {
    console.warn(`skip   ${file} (needs ffmpeg for ${ext}; point the manifest at a .wav instead)`);
    continue;
  }
  console.log(`wrote  ${file}`);
}
