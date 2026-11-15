// Web Worker wrapper around the bot search, so the table's UI thread never
// blocks while a bot thinks. Messages: {id, args} in, {id, move, error} out.
import { findMove } from './search.js';

self.onmessage = (e) => {
  const { id, args } = e.data;
  try {
    self.postMessage({ id, move: findMove(args) });
  } catch (err) {
    self.postMessage({ id, move: null, error: String(err?.message || err) });
  }
};
