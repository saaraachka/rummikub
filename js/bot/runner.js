// Host-side bot runner: sends a search to the worker and enforces a hard time
// limit. The search itself stops at `budgetMs` and returns its best move so
// far; if the worker still hasn't answered `graceMs` later (stuck, crashed or
// too slow a device), it is killed and replaced, and the bot draws (null).

export function createBotRunner({ budgetMs = 1500, graceMs = 700 } = {}) {
  let worker = null;
  let seq = 0;
  const pending = new Map(); // id -> {resolve, timer}

  function settle(id, move) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(move);
  }

  function spawn() {
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (data.error) console.warn('Bot search failed:', data.error);
        settle(data.id, data.move ?? null);
      };
      worker.onerror = (e) => {
        console.warn('Bot worker error:', e.message);
        restart();
      };
    } catch (e) {
      console.warn('Web Workers unavailable; bots will think on the main thread.', e);
      worker = null;
    }
  }

  function restart() {
    worker?.terminate();
    for (const id of [...pending.keys()]) settle(id, null);
    spawn();
  }

  spawn();

  return {
    /** Resolves with {sets, played, value} or null (draw). Never rejects. */
    think(args) {
      if (!worker) {
        return import('./search.js')
          .then(({ findMove }) => findMove({ ...args, budgetMs }))
          .catch(() => null);
      }
      const id = ++seq;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          console.warn('Bot search exceeded its time limit; restarting the worker and drawing.');
          pending.delete(id);
          resolve(null);
          restart();
        }, budgetMs + graceMs);
        pending.set(id, { resolve, timer });
        worker.postMessage({ id, args: { ...args, budgetMs } });
      });
    },
    terminate() {
      worker?.terminate();
      worker = null;
    },
  };
}
