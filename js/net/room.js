// Reusable "one host screen + many phone controllers" room layer.
// Knows nothing about any particular game.
//
// HOST
//   const room = await hostRoom({ appId: 'mygame', code, accept })
//   room.code                         // e.g. "KXQT"
//   room.on('join',    (clientId, hello, {rejoin}) => {})   // rejoin: seen this clientId before
//   room.on('leave',   (clientId) => {})               // connection lost (may come back)
//   room.on('message', (clientId, msg) => {})
//   room.on('status',  ('online'|'reconnecting')) => {})  // broker status
//   room.send(clientId, msg); room.broadcast(msg); room.isConnected(clientId)
//   room.kick(clientId, reason); room.close()
//   `accept(clientId, hello)` decides admission: return true, or a string reason to reject.
//
// CLIENT
//   const conn = joinRoom({ appId: 'mygame', code, hello: {name} })
//   conn.clientId                     // stable per device+room (localStorage)
//   conn.on('status', (s, detail) => {})  // connecting | connected | reconnecting | rejected | not-found
//   conn.on('message', (msg) => {})
//   conn.send(msg); conn.setHello(h); conn.close()
//
// Reconnection: the client keeps a token in localStorage and reconnects with
// backoff whenever the link drops, when the page becomes visible again (phone
// unlocked) or when the host goes quiet. Both sides heartbeat, so a phone that
// silently went away is marked as disconnected within a few seconds.

import { transportFromUrl } from './transports.js';

const PING_MS = 3000;
const DEAD_MS = 10000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O

function emitter() {
  const handlers = {};
  return {
    on(ev, fn) {
      (handlers[ev] ||= []).push(fn);
      return () => (handlers[ev] = handlers[ev].filter((f) => f !== fn));
    },
    emit(ev, ...args) {
      for (const fn of handlers[ev] || []) {
        try { fn(...args); } catch (e) { console.error(e); }
      }
    },
  };
}

function randomToken(len = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

export function randomCode(length = 4) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
}

const peerIdFor = (appId, code) => `${appId}-room-${code}`.toLowerCase();

// ------------------------------------------------------------------ host

/**
 * @param {object} o
 * @param {string} o.appId       namespace so different games never collide
 * @param {string} [o.code]      preferred room code (e.g. restored after a reload)
 * @param {number} [o.codeLength]
 * @param {(clientId:string, hello:any) => true|string} [o.accept]
 * @param {object} [o.transport] defaults to transportFromUrl()
 */
export async function hostRoom({ appId, code, codeLength = 4, accept = () => true, transport = transportFromUrl() }) {
  const ev = emitter();
  const clients = new Map(); // clientId -> {conn, lastSeen}
  const known = new Set(); // every clientId admitted this session
  let listener = null;

  // Claim a peer id. A remembered code may still be held by the broker for a
  // few seconds after a reload, so retry it before giving up and picking anew.
  let attempts = 0;
  let wanted = normalizeCode(code) || randomCode(codeLength);
  for (;;) {
    try {
      listener = await transport.listen(peerIdFor(appId, wanted));
      break;
    } catch (e) {
      attempts++;
      if (e.code !== 'id-taken') {
        if (attempts > 5) throw e;
        await sleep(1500);
        continue;
      }
      if (code && attempts < 8) {
        await sleep(1500);
        continue;
      }
      code = null;
      wanted = randomCode(codeLength);
    }
  }

  listener.onStatus = (s) => ev.emit('status', s);
  listener.onConnection = (conn) => {
    let clientId = null;
    const helloTimer = setTimeout(() => conn.close(), 8000);
    conn.onData = (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'hello') {
        clearTimeout(helloTimer);
        const id = String(m.clientId || '').slice(0, 40);
        if (!id) return conn.close();
        const verdict = accept(id, m.hello);
        if (verdict !== true) {
          conn.send({ t: 'reject', reason: typeof verdict === 'string' ? verdict : 'Not allowed' });
          setTimeout(() => conn.close(), 300);
          return;
        }
        const prev = clients.get(id);
        if (prev && prev.conn !== conn) {
          prev.conn.onClose = null;
          prev.conn.close();
        }
        clientId = id;
        clients.set(id, { conn, lastSeen: Date.now() });
        conn.send({ t: 'welcome', clientId: id });
        const rejoin = known.has(id);
        known.add(id);
        ev.emit('join', id, m.hello, { rejoin });
        return;
      }
      if (!clientId) return;
      const c = clients.get(clientId);
      if (c?.conn !== conn) return;
      c.lastSeen = Date.now();
      if (m.t === 'ping') conn.send({ t: 'pong' });
      else if (m.t === 'msg') ev.emit('message', clientId, m.data);
    };
    conn.onClose = () => {
      clearTimeout(helloTimer);
      if (clientId && clients.get(clientId)?.conn === conn) {
        clients.delete(clientId);
        ev.emit('leave', clientId);
      }
    };
  };

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [id, c] of clients) {
      if (now - c.lastSeen > DEAD_MS) {
        clients.delete(id);
        c.conn.onClose = null;
        c.conn.close();
        ev.emit('leave', id);
      } else {
        c.conn.send({ t: 'ping' });
      }
    }
  }, PING_MS);

  return {
    code: wanted,
    on: ev.on,
    send(clientId, data) {
      clients.get(clientId)?.conn.send({ t: 'msg', data });
    },
    broadcast(data) {
      for (const c of clients.values()) c.conn.send({ t: 'msg', data });
    },
    isConnected: (clientId) => clients.has(clientId),
    connectedIds: () => [...clients.keys()],
    kick(clientId, reason = 'Removed by host') {
      const c = clients.get(clientId);
      if (!c) return;
      c.conn.send({ t: 'reject', reason });
      clients.delete(clientId);
      setTimeout(() => c.conn.close(), 300);
    },
    close() {
      clearInterval(heartbeat);
      for (const c of clients.values()) c.conn.close();
      listener.close();
    },
  };
}

// ------------------------------------------------------------------ client

/** Stable id for this device in this room. `slot` lets several tabs of one browser act as different phones. */
export function clientIdFor(appId, code, slot = '') {
  const key = `${appId}:client:${normalizeCode(code)}${slot ? ':' + slot : ''}`;
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = randomToken();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return (clientIdFor.mem ||= {})[key] ||= randomToken();
  }
}

/**
 * @param {object} o
 * @param {string} o.appId
 * @param {string} o.code
 * @param {any}    o.hello   sent with every (re)connect, e.g. {name}
 * @param {string} [o.slot]  storage namespace for multi-tab testing
 * @param {object} [o.transport]
 */
export function joinRoom({ appId, code, hello, slot = '', transport = transportFromUrl() }) {
  const ev = emitter();
  code = normalizeCode(code);
  const clientId = clientIdFor(appId, code, slot);
  let conn = null;
  let status = 'idle';
  let closed = false;
  let attempt = 0;
  let retryTimer = null;
  let lastHeard = 0;
  let connecting = false;

  const setStatus = (s, detail) => {
    if (s === status && !detail) return;
    status = s;
    ev.emit('status', s, detail);
  };

  function drop() {
    if (conn) {
      conn.onClose = null;
      conn.onData = null;
      conn.close();
      conn = null;
    }
  }

  function scheduleRetry(delay) {
    clearTimeout(retryTimer);
    if (closed) return;
    const d = delay ?? Math.min(500 * 2 ** attempt, 5000);
    retryTimer = setTimeout(connect, d);
  }

  async function connect() {
    if (closed || connecting) return;
    clearTimeout(retryTimer);
    connecting = true;
    drop();
    setStatus(attempt === 0 && status !== 'reconnecting' ? 'connecting' : 'reconnecting');
    try {
      const c = await transport.connect(peerIdFor(appId, code));
      if (closed) return c.close();
      conn = c;
      let welcomed = false;
      const welcomeTimer = setTimeout(() => {
        if (!welcomed && conn === c) {
          drop();
          attempt++;
          scheduleRetry();
        }
      }, 6000);
      c.onData = (m) => {
        lastHeard = Date.now();
        if (!m || typeof m !== 'object') return;
        if (m.t === 'welcome') {
          welcomed = true;
          clearTimeout(welcomeTimer);
          attempt = 0;
          setStatus('connected');
        } else if (m.t === 'reject') {
          clearTimeout(welcomeTimer);
          closed = true;
          drop();
          setStatus('rejected', m.reason);
        } else if (m.t === 'ping') {
          c.send({ t: 'pong' });
        } else if (m.t === 'msg') {
          ev.emit('message', m.data);
        }
      };
      c.onClose = () => {
        clearTimeout(welcomeTimer);
        if (conn !== c) return;
        conn = null;
        if (!closed) {
          setStatus('reconnecting');
          attempt++;
          scheduleRetry();
        }
      };
      lastHeard = Date.now();
      c.send({ t: 'hello', clientId, hello });
    } catch (e) {
      attempt++;
      if (e.code === 'not-found') setStatus(attempt > 2 ? 'not-found' : 'reconnecting');
      else setStatus('reconnecting');
      scheduleRetry(e.code === 'not-found' ? Math.min(1500 * attempt, 6000) : undefined);
    } finally {
      connecting = false;
    }
  }

  // Watchdog: the host pings every few seconds. If it goes quiet (phone was
  // locked, Wi-Fi switched) tear down and reconnect rather than wait for the
  // underlying channel to notice.
  const watchdog = setInterval(() => {
    if (closed || !conn || status !== 'connected') return;
    if (Date.now() - lastHeard > DEAD_MS) {
      drop();
      setStatus('reconnecting');
      connect();
    } else {
      conn.send({ t: 'ping' });
    }
  }, PING_MS);

  const onVisible = () => {
    if (document.visibilityState !== 'visible' || closed) return;
    if (!conn || status !== 'connected' || Date.now() - lastHeard > PING_MS * 2) {
      attempt = 0;
      connect();
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);
  window.addEventListener('pageshow', onVisible);

  connect();

  return {
    clientId,
    code,
    on: ev.on,
    get status() { return status; },
    send(data) {
      if (conn && status === 'connected') {
        conn.send({ t: 'msg', data });
        return true;
      }
      return false;
    },
    setHello(h) { hello = h; },
    reconnect() {
      attempt = 0;
      connect();
    },
    close() {
      closed = true;
      clearInterval(watchdog);
      clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      window.removeEventListener('pageshow', onVisible);
      drop();
      setStatus('closed');
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
