// Turn the room layer's connection status into a one-line message a player
// can act on. Pure, so it's unit-tested alongside the rules.
//
// status: connecting | connected | reconnecting | not-found | rejected | closed
// detail: rejection reason (string) or {error, attempt}
// tone:   'wait' (still trying, nothing wrong yet) | 'ok' | 'bad' (player should do something)

const P2P_FAILURES = new Set(['p2p-failed', 'no-welcome', 'timeout']);

export function diagnose(status, detail, { code = '', lastError = null, attempt = 0 } = {}) {
  const error = (detail && typeof detail === 'object' ? detail.error : null) ?? lastError;
  const tries = (detail && typeof detail === 'object' ? detail.attempt : null) ?? attempt;
  switch (status) {
    case 'connected':
      return { tone: 'ok', text: 'Connected' };
    case 'rejected':
      return { tone: 'bad', text: typeof detail === 'string' && detail ? detail : 'The table turned this phone away.' };
    case 'not-found':
      return { tone: 'bad', text: `No table found for room ${code}. Check the code and make sure the table screen is open. Still trying…` };
    case 'closed':
      return { tone: 'wait', text: '' };
  }
  if (error === 'unsupported') return { tone: 'bad', text: "This browser can't make the connection. Try Safari or Chrome." };
  if (error === 'broker-unreachable') return { tone: 'bad', text: "Can't reach the internet. Check your Wi-Fi or mobile data. Still trying…" };
  if (P2P_FAILURES.has(error) || tries >= 3) {
    return { tone: 'bad', text: "Couldn't reach the table — try joining the same Wi-Fi as the table. Still trying…" };
  }
  if (error === 'not-found') return { tone: 'wait', text: `Looking for room ${code}…` };
  if (error === 'lost') return { tone: 'wait', text: 'Connection lost. Reconnecting…' };
  return { tone: 'wait', text: `Connecting to room ${code}…` };
}
