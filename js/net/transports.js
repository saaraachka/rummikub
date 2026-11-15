// Transports give room.js a tiny, uniform surface:
//
//   transport.listen(id) -> Promise<Listener>   (host side; rejects with err.code = 'id-taken')
//     listener.onConnection = (conn) => {}
//     listener.onStatus = ('online' | 'reconnecting') => {}
//     listener.close()
//   transport.connect(id) -> Promise<Conn>      (client side; rejects with err.code = 'not-found' | 'timeout' | ...)
//
//   conn.send(obj); conn.close();
//   conn.onData = (obj) => {}; conn.onClose = () => {}
//
// Two implementations:
//   peerTransport()  - WebRTC via PeerJS and its free public broker. For real play.
//   localTransport() - BroadcastChannel between tabs of one browser. For offline
//                      development and automated tests; no network at all.

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

// ------------------------------------------------------------------ PeerJS

let peerLibPromise = null;
function loadPeerJs() {
  if (globalThis.Peer) return Promise.resolve(globalThis.Peer);
  if (!peerLibPromise) {
    peerLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../../vendor/peerjs.min.js', import.meta.url).href;
      s.onload = () => resolve(globalThis.Peer);
      s.onerror = () => reject(err('load-failed', 'Could not load PeerJS'));
      document.head.appendChild(s);
    });
  }
  return peerLibPromise;
}

function wrapDataConnection(dc, onDestroy) {
  const conn = {
    onData: null,
    onClose: null,
    send(obj) {
      if (dc.open) dc.send(obj);
    },
    close() {
      try { dc.close(); } catch {}
      onDestroy?.();
    },
  };
  let closed = false;
  const fireClose = () => {
    if (closed) return;
    closed = true;
    conn.onClose?.();
    onDestroy?.();
  };
  dc.on('data', (d) => conn.onData?.(d));
  dc.on('close', fireClose);
  dc.on('error', fireClose);
  return conn;
}

/** @param {object} [peerOptions] passed straight to `new Peer()` (host, port, config.iceServers, ...) */
export function peerTransport(peerOptions = {}) {
  return {
    name: 'peer',
    async listen(id) {
      const Peer = await loadPeerJs();
      return new Promise((resolve, reject) => {
        const peer = new Peer(id, { debug: 1, ...peerOptions });
        let opened = false;
        let retryTimer = null;
        const listener = {
          onConnection: null,
          onStatus: null,
          close() {
            clearTimeout(retryTimer);
            peer.destroy();
          },
        };
        peer.on('open', () => {
          if (!opened) {
            opened = true;
            resolve(listener);
          }
          listener.onStatus?.('online');
        });
        peer.on('connection', (dc) => {
          dc.on('open', () => listener.onConnection?.(wrapDataConnection(dc)));
        });
        // Lost the broker (Wi-Fi blip, iPad slept). Existing data channels keep
        // working; we only need the broker for new joins, so keep retrying.
        peer.on('disconnected', () => {
          listener.onStatus?.('reconnecting');
          const retry = () => {
            if (peer.destroyed || !peer.disconnected) return;
            try { peer.reconnect(); } catch {}
            retryTimer = setTimeout(retry, 3000);
          };
          retryTimer = setTimeout(retry, 1000);
        });
        peer.on('error', (e) => {
          if (!opened) {
            peer.destroy();
            reject(e.type === 'unavailable-id' ? err('id-taken', 'Room code in use') : err(e.type || 'error', e.message));
          }
        });
      });
    },
    async connect(id, { timeoutMs = 10000 } = {}) {
      const Peer = await loadPeerJs();
      return new Promise((resolve, reject) => {
        const peer = new Peer({ debug: 1, ...peerOptions });
        let settled = false;
        const fail = (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          peer.destroy();
          reject(e);
        };
        const timer = setTimeout(() => fail(err('timeout', 'Connection timed out')), timeoutMs);
        peer.on('error', (e) => fail(e.type === 'peer-unavailable' ? err('not-found', 'Room not found') : err(e.type || 'error', e.message)));
        peer.on('open', () => {
          const dc = peer.connect(id, { reliable: true, serialization: 'json' });
          dc.on('open', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(wrapDataConnection(dc, () => peer.destroy()));
          });
          dc.on('error', () => fail(err('error', 'Connection failed')));
        });
      });
    },
  };
}

// ------------------------------------------------------------------ Local

export function localTransport(channelName = 'netlocal') {
  const rand = () => Math.random().toString(36).slice(2, 10);

  function makeConn(bc, connId, side) {
    const other = side === 'host' ? 'client' : 'host';
    let open = true;
    const conn = {
      onData: null,
      onClose: null,
      send(obj) {
        if (open) bc.postMessage({ kind: 'data', connId, to: other, data: obj });
      },
      close() {
        if (!open) return;
        open = false;
        bc.postMessage({ kind: 'close', connId, to: other });
        bc.close();
      },
      _receive(m) {
        if (!open) return;
        if (m.kind === 'data') conn.onData?.(structuredClone(m.data));
        if (m.kind === 'close') {
          open = false;
          bc.close();
          conn.onClose?.();
        }
      },
    };
    bc.onmessage = (ev) => {
      const m = ev.data;
      if (m.connId === connId && m.to === side) conn._receive(m);
    };
    return conn;
  }

  return {
    name: 'local',
    async listen(id) {
      const bc = new BroadcastChannel(channelName);
      // Check nobody else holds this id.
      const probe = rand();
      const taken = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 200);
        bc.onmessage = (ev) => {
          if (ev.data.kind === 'taken' && ev.data.probe === probe) {
            clearTimeout(t);
            resolve(true);
          }
        };
        bc.postMessage({ kind: 'probe', id, probe });
      });
      if (taken) {
        bc.close();
        throw err('id-taken', 'Room code in use');
      }
      const listener = {
        onConnection: null,
        onStatus: null,
        close() { bc.close(); },
      };
      bc.onmessage = (ev) => {
        const m = ev.data;
        if (m.kind === 'probe' && m.id === id) bc.postMessage({ kind: 'taken', probe: m.probe });
        if (m.kind === 'connect' && m.id === id) {
          const conn = makeConn(new BroadcastChannel(channelName), m.connId, 'host');
          bc.postMessage({ kind: 'accept', connId: m.connId });
          listener.onConnection?.(conn);
        }
      };
      queueMicrotask(() => listener.onStatus?.('online'));
      return listener;
    },
    async connect(id, { timeoutMs = 3000 } = {}) {
      const connId = rand();
      const bc = new BroadcastChannel(channelName);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          bc.close();
          reject(err('not-found', 'Room not found'));
        }, timeoutMs);
        bc.onmessage = (ev) => {
          if (ev.data.kind === 'accept' && ev.data.connId === connId) {
            clearTimeout(t);
            resolve(makeConn(bc, connId, 'client'));
          }
        };
        bc.postMessage({ kind: 'connect', id, connId });
      });
    },
  };
}

/** Pick a transport from the page URL: `?net=local` for offline tabs, PeerJS otherwise. */
export function transportFromUrl(search = location.search) {
  const p = new URLSearchParams(search);
  return p.get('net') === 'local' ? localTransport() : peerTransport();
}
