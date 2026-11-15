import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../js/play/diagnose.js';

const ctx = { code: 'ABCD' };

test('first attempt says connecting', () => {
  assert.deepEqual(diagnose('connecting', undefined, ctx), { tone: 'wait', text: 'Connecting to room ABCD…' });
});
test('connected', () => {
  assert.equal(diagnose('connected', undefined, ctx).tone, 'ok');
});
test('direct connection failing points at the Wi-Fi', () => {
  const d = diagnose('reconnecting', { error: 'p2p-failed', attempt: 1 }, ctx);
  assert.equal(d.tone, 'bad');
  assert.match(d.text, /Couldn't reach the table — try joining the same Wi-Fi/);
});
test('repeated generic failures also point at the Wi-Fi', () => {
  assert.match(diagnose('reconnecting', { error: 'lost', attempt: 3 }, ctx).text, /same Wi-Fi/);
  assert.equal(diagnose('reconnecting', { error: 'lost', attempt: 1 }, ctx).tone, 'wait');
});
test('no internet', () => {
  assert.match(diagnose('reconnecting', { error: 'broker-unreachable', attempt: 1 }, ctx).text, /Can't reach the internet/);
});
test('wrong code / table closed', () => {
  assert.equal(diagnose('reconnecting', { error: 'not-found', attempt: 1 }, ctx).tone, 'wait');
  assert.match(diagnose('not-found', { error: 'not-found', attempt: 3 }, ctx).text, /No table found for room ABCD/);
});
test('rejection shows the table\'s reason', () => {
  assert.deepEqual(diagnose('rejected', 'The table is full (4 players).', ctx), { tone: 'bad', text: 'The table is full (4 players).' });
});
test('falls back to the last error when no detail is given', () => {
  assert.match(diagnose('reconnecting', undefined, { code: 'ABCD', lastError: 'p2p-failed', attempt: 1 }).text, /same Wi-Fi/);
});
