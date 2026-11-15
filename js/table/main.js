// The table is the authoritative host: it owns the game state, validates
// every move with the pure engine, and sends each phone a snapshot of the
// public state plus that phone's own rack.

import { APP_ID, peerOptions } from '../config.js';
import { hostRoom } from '../net/room.js';
import { transportFromUrl } from '../net/transports.js';
import {
  createGame, addPlayer, renamePlayer, removePlayer, setTimer, setStrictJokers, startRound, commitTurn,
  drawTile, reorderRack, resetToLobby, publicView, playerView, currentPlayerId,
  MIN_PLAYERS, MAX_PLAYERS, TIMER_OPTIONS,
} from '../game/engine.js';
import { tileHtml, escapeHtml } from '../ui/tile-view.js';
import qrcode from '../../vendor/qrcode.mjs';

const params = new URLSearchParams(location.search);
const forcedCode = params.get('code'); // dev harness pins a code
const STORE_KEY = `${APP_ID}:host${forcedCode ? ':' + forcedCode : ''}`;
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ state

let game = createGame();
let seats = {}; // clientId -> playerId
let nextPid = 0;
let room = null;
let deadline = 0; // ms timestamp when current turn times out (0 = no timer)
let deadlineTurn = -1;

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ code: room?.code, game, seats, nextPid }));
  } catch {}
}

function load() {
  if (params.has('fresh')) return null;
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    return null;
  }
}

const playerName = (pid) => game.players.find((p) => p.id === pid)?.name ?? 'Someone';
const clientOf = (pid) => Object.keys(seats).find((c) => seats[c] === pid);
const isOnline = (pid) => {
  const c = clientOf(pid);
  return !!(c && room?.isConnected(c));
};

// ------------------------------------------------------------------ boot

async function boot() {
  const saved = load();
  if (saved?.game) {
    game = saved.game;
    seats = saved.seats || {};
    nextPid = saved.nextPid || 0;
  }
  try {
    room = await hostRoom({
      appId: APP_ID,
      code: forcedCode || saved?.code,
      transport: transportFromUrl(location.search, peerOptions()),
      accept: (clientId) => {
        if (seats[clientId]) return true;
        if (game.phase !== 'lobby') return 'This game has already started. Ask the table to go back to the lobby to join.';
        if (game.players.length >= MAX_PLAYERS) return `The table is full (${MAX_PLAYERS} players).`;
        return true;
      },
    });
  } catch (e) {
    $('boot').textContent = `Couldn't open the room: ${e.message}. Check your internet connection and reload.`;
    $('boot').classList.add('error');
    return;
  }
  $('boot').hidden = true;
  room.on('join', onJoin);
  room.on('leave', () => commit({ broadcast: true }));
  room.on('message', onMessage);
  room.on('status', (s) => {
    $('netStatus').hidden = s === 'online';
    $('netStatus').textContent = 'Reconnecting to the internet… players already in can keep playing';
  });
  setupLobby();
  commit({ broadcast: false });
  setInterval(tick, 250);
}

// ------------------------------------------------------------------ network

function onJoin(clientId, hello) {
  const name = hello?.name;
  if (!seats[clientId]) {
    const pid = `p${++nextPid}`;
    seats[clientId] = pid;
    game = addPlayer(game, { id: pid, name });
  } else if (name && name !== playerName(seats[clientId])) {
    game = renamePlayer(game, seats[clientId], name);
  }
  commit({ broadcast: true });
}

function onMessage(clientId, msg) {
  const pid = seats[clientId];
  if (!pid || !msg) return;
  try {
    switch (msg.type) {
      case 'commit': {
        if (msg.turnNumber !== game.turnNumber) return reply(clientId, { type: 'commitResult', ok: false, errors: [{ message: 'That turn is already over.' }] });
        const r = commitTurn(game, pid, sanitizeSets(msg.sets));
        game = r.state;
        reply(clientId, { type: 'commitResult', ok: r.ok, errors: r.errors });
        commit({ broadcast: true });
        break;
      }
      case 'draw': {
        if (msg.turnNumber !== game.turnNumber) return;
        game = drawTile(game, pid, 'draw').state;
        commit({ broadcast: true });
        break;
      }
      case 'rackOrder': {
        game = reorderRack(game, pid, msg.order);
        save();
        sendState(clientId);
        break;
      }
      case 'leave': {
        if (game.phase !== 'lobby') return;
        delete seats[clientId];
        game = removePlayer(game, pid);
        commit({ broadcast: true });
        break;
      }
      case 'sync':
        sendState(clientId);
        break;
    }
  } catch (e) {
    reply(clientId, { type: 'error', message: e.message });
  }
}

function sanitizeSets(sets) {
  if (!Array.isArray(sets)) return [];
  return sets.slice(0, 60).map((s) => (Array.isArray(s) ? s.slice(0, 20).map(String) : []));
}

function reply(clientId, msg) {
  room.send(clientId, msg);
}

function sendState(clientId) {
  const pid = seats[clientId];
  if (!pid) return;
  room.send(clientId, {
    type: 'state',
    state: { ...playerView(game, pid), online: onlineMap() },
    turnRemainingMs: deadline ? Math.max(0, deadline - Date.now()) : null,
  });
}

function onlineMap() {
  return Object.fromEntries(game.players.map((p) => [p.id, isOnline(p.id)]));
}

function broadcastState() {
  for (const clientId of Object.keys(seats)) if (room.isConnected(clientId)) sendState(clientId);
}

/** After any state change: reset the timer if the turn moved, persist, sync, redraw. */
function commit({ broadcast }) {
  if (game.phase === 'playing' && game.settings.timer && deadlineTurn !== game.turnNumber) {
    deadlineTurn = game.turnNumber;
    deadline = Date.now() + game.settings.timer * 1000;
  }
  if (game.phase !== 'playing' || !game.settings.timer) {
    deadline = 0;
    deadlineTurn = -1;
  }
  save();
  if (broadcast) broadcastState();
  render();
}

function tick() {
  if (deadline && game.phase === 'playing' && Date.now() >= deadline) {
    const pid = currentPlayerId(game);
    game = drawTile(game, pid, 'timeout').state;
    commit({ broadcast: true });
    return;
  }
  renderTimer();
}

// ------------------------------------------------------------------ lobby

function setupLobby() {
  const url = new URL('../play/', location.href);
  url.searchParams.set('room', room.code);
  if (params.get('net') === 'local') url.searchParams.set('net', 'local');
  if (params.get('relay') === '1') url.searchParams.set('relay', '1');
  const qr = qrcode(0, 'M');
  qr.addData(url.href);
  qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true, alt: `Join link ${url.href}` });
  const short = new URL('../play/', location.href);
  $('joinUrl').textContent = short.host + short.pathname;
  $('roomCode').innerHTML = [...room.code].map((c) => `<span>${c}</span>`).join('');
  $('sideCode').textContent = room.code;

  $('timerOptions').innerHTML = TIMER_OPTIONS.map(
    (s) => `<button role="radio" data-s="${s}">${s ? `${s / 60} min` : 'Off'}</button>`,
  ).join('');
  $('timerOptions').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-s]');
    if (!b) return;
    game = setTimer(game, Number(b.dataset.s));
    commit({ broadcast: true });
  });

  $('jokerOptions').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-strict]');
    if (!b) return;
    game = setStrictJokers(game, b.dataset.strict === '1');
    commit({ broadcast: true });
  });

  $('startBtn').addEventListener('click', () => {
    requestWakeLock();
    game = startRound(game);
    commit({ broadcast: true });
  });

  $('lobbyPlayers').addEventListener('click', (e) => {
    const b = e.target.closest('button.kick');
    if (!b) return;
    const pid = b.dataset.pid;
    const c = clientOf(pid);
    if (c) {
      room.kick(c, 'The table removed you from the game.');
      delete seats[c];
    }
    game = removePlayer(game, pid);
    commit({ broadcast: true });
  });

  $('resetBtn').addEventListener('click', () => {
    if (!confirm('Start a brand-new table with a new room code? Everyone will need to rejoin.')) return;
    localStorage.removeItem(STORE_KEY);
    room.close();
    const u = new URL(location.href);
    u.searchParams.delete('code');
    location.replace(u.href);
  });

  $('menuBtn').addEventListener('click', () => {
    if (!confirm('End this game and go back to the lobby? Scores will be reset.')) return;
    game = resetToLobby(game);
    commit({ broadcast: true });
  });
  $('nextRoundBtn').addEventListener('click', () => {
    game = startRound(game);
    commit({ broadcast: true });
  });
  $('toLobbyBtn').addEventListener('click', () => {
    game = resetToLobby(game);
    commit({ broadcast: true });
  });
  $('players').addEventListener('click', (e) => {
    const b = e.target.closest('button.skip');
    if (!b || currentPlayerId(game) !== b.dataset.pid) return;
    game = drawTile(game, b.dataset.pid, 'skip').state;
    commit({ broadcast: true });
  });
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && game.phase !== 'lobby') requestWakeLock();
});
document.addEventListener('click', requestWakeLock, { once: true });

// ------------------------------------------------------------------ render

function render() {
  const v = publicView(game);
  $('lobby').hidden = v.phase !== 'lobby';
  $('game').hidden = v.phase === 'lobby';
  $('roundOver').hidden = v.phase !== 'roundOver';
  if (v.phase === 'lobby') renderLobby(v);
  else {
    renderPlayers(v);
    renderBoard(v);
    $('turnName').innerHTML = v.currentPlayerId ? `<span>${escapeHtml(playerName(v.currentPlayerId))}</span>'s turn` : '';
    $('poolCount').textContent = v.poolCount;
  }
  if (v.phase === 'roundOver') renderRoundOver(v);
  renderEvent(v);
}

function renderLobby(v) {
  const rows = v.players.map((p) => `
    <li><span class="dot ${isOnline(p.id) ? 'on' : 'off'}"></span>${escapeHtml(p.name)}
      ${p.score ? `<span class="score">${p.score} pts</span>` : ''}
      <button class="kick" data-pid="${p.id}" aria-label="Remove ${escapeHtml(p.name)}">✕</button></li>`);
  for (let i = v.players.length; i < MAX_PLAYERS; i++) rows.push(`<li class="empty">Waiting for player ${i + 1}…</li>`);
  const html = rows.join('');
  if ($('lobbyPlayers').dataset.html !== html) {
    $('lobbyPlayers').innerHTML = html;
    $('lobbyPlayers').dataset.html = html;
  }
  $('playerCount').textContent = `${v.players.length}/${MAX_PLAYERS}`;
  for (const b of $('timerOptions').children) b.setAttribute('aria-checked', String(Number(b.dataset.s) === v.settings.timer));
  for (const b of $('jokerOptions').children) b.setAttribute('aria-checked', String((b.dataset.strict === '1') === v.settings.strictJokers));
  const enough = v.players.length >= MIN_PLAYERS;
  $('startBtn').disabled = !enough;
  $('lobbyHint').textContent = enough
    ? 'Everyone in? Start when ready. Late arrivals can join between games.'
    : `Need at least ${MIN_PLAYERS} players to start.`;
}

let lastPlayersHtml = '';
function renderPlayers(v) {
  const html = v.players.map((p) => {
    const online = isOnline(p.id);
    const current = p.id === v.currentPlayerId;
    return `<li class="player ${current ? 'current' : ''}" data-pid="${p.id}">
      <div class="row">
        <span class="dot ${online ? 'on' : 'off'}" title="${online ? 'connected' : 'disconnected'}"></span>
        <span class="name">${escapeHtml(p.name)}</span>
        <span class="count">${p.tileCount}<small>tiles</small></span>
      </div>
      <div class="meta">
        <span class="turn-tag">Playing</span>
        ${online ? '' : '<span class="badge off">offline</span>'}
        ${p.melded ? '' : '<span class="badge">no meld</span>'}
        ${v.round > 1 || p.score ? `<span>${p.score} pts</span>` : ''}
        ${current && !online && v.phase === 'playing' ? `<button class="skip" data-pid="${p.id}">Skip turn</button>` : ''}
      </div>
      ${current && deadline ? '<div class="timer"><i></i></div>' : ''}
    </li>`;
  }).join('');
  if (html !== lastPlayersHtml) {
    $('players').innerHTML = html;
    lastPlayersHtml = html;
  }
  renderTimer();
}

function renderTimer() {
  const clock = $('turnClock');
  clock.hidden = !deadline;
  const bar = document.querySelector('.player.current .timer');
  if (!deadline) return;
  const total = game.settings.timer * 1000;
  const left = Math.max(0, deadline - Date.now());
  const secs = Math.ceil(left / 1000);
  clock.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  clock.classList.toggle('low', left < 10000);
  if (!bar) return;
  bar.firstElementChild.style.transform = `scaleX(${left / total})`;
  bar.classList.toggle('low', left < 10000);
}

let lastBoardKey = '';
let animatedSeq = 0;
function renderBoard(v) {
  const key = JSON.stringify(v.board);
  if (key === lastBoardKey) return;
  const ev = v.lastEvent;
  const animate = ev?.type === 'commit' && ev.seq !== animatedSeq;
  const newTiles = new Set(animate ? ev.played : []);
  const oldSetIds = new Set(lastBoardKey ? JSON.parse(lastBoardKey).map((s) => s.id) : []);
  if (animate) animatedSeq = ev.seq;
  lastBoardKey = key;

  const inner = $('boardInner');
  if (!v.board.length) {
    inner.innerHTML = '<div class="board-empty">The table is empty. First meld needs 30 points.</div>';
    return;
  }
  inner.innerHTML = v.board.map((s) => {
    const changed = animate && !oldSetIds.has(s.id);
    return `<div class="set ${changed ? 'changed' : ''}">${s.tiles.map((id) => tileHtml(id, newTiles.has(id) ? 'new' : '')).join('')}</div>`;
  }).join('');
  inner.querySelectorAll('.tile.new').forEach((el, i) => (el.style.animationDelay = `${i * 60}ms, ${i * 60}ms`));
  fitBoard();
}

/** Largest tile size at which the whole board fits without scrolling. */
function fitBoard() {
  const inner = $('boardInner');
  const avail = inner.clientHeight;
  // Cap the size so a near-empty board doesn't show absurdly big tiles.
  let lo = 18, hi = Math.min(avail / 6, inner.clientWidth / 14);
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2;
    inner.style.setProperty('--tw', `${mid}px`);
    if (inner.scrollHeight <= avail + 1 && inner.scrollWidth <= inner.clientWidth + 1) lo = mid;
    else hi = mid;
  }
  inner.style.setProperty('--tw', `${Math.floor(lo)}px`);
}
window.addEventListener('resize', () => {
  if (game.phase !== 'lobby') fitBoard();
});

function renderRoundOver(v) {
  const r = v.result;
  const winner = playerName(r.winnerId);
  $('roWinner').textContent = `${winner} wins round ${v.round}!`;
  $('roReason').textContent = r.reason === 'out'
    ? `${winner} played their last tile.`
    : `No tiles left to draw and nobody could play. ${winner} had the lowest rack.`;
  $('roRows').innerHTML = [...v.players]
    .sort((a, b) => b.score - a.score)
    .map((p) => {
      const d = r.deltas[p.id] ?? 0;
      return `<tr class="${p.id === r.winnerId ? 'win' : ''}">
        <td>${escapeHtml(p.name)}</td><td>${r.rackValues[p.id]} pts</td>
        <td class="${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${d > 0 ? '+' : ''}${d}</td><td>${p.score}</td></tr>`;
    }).join('');
}

let bannerSeq = 0;
let bannerTimer = null;
function renderEvent(v) {
  const ev = v.lastEvent;
  if (!ev || ev.seq === bannerSeq) return;
  bannerSeq = ev.seq;
  const name = escapeHtml(playerName(ev.playerId));
  let text = '';
  let kind = '';
  switch (ev.type) {
    case 'commit': {
      const n = ev.played.length;
      text = `${name} played ${n} tile${n === 1 ? '' : 's'}`;
      if (ev.firstMeld) text += ` · first meld, ${ev.meldPoints} points`;
      kind = 'good';
      break;
    }
    case 'draw': text = ev.drew ? `${name} drew a tile` : `${name} passed (no tiles left to draw)`; break;
    case 'timeout': text = `Time's up! ${name} ${ev.drew ? 'draws a tile' : 'passes'}`; kind = 'bad'; break;
    case 'skip': text = `${name} was skipped`; break;
    case 'invalid': text = `${name}'s move didn't work: ${escapeHtml(ev.message)}`; kind = 'bad'; break;
    case 'roundStart': text = `Round ${v.round} · ${escapeHtml(playerName(v.currentPlayerId))} goes first`; break;
    default: return;
  }
  const b = $('banner');
  b.className = `banner ${kind}`;
  b.innerHTML = text;
  requestAnimationFrame(() => b.classList.add('show'));
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), ev.type === 'invalid' ? 4500 : 2800);
}

// Test hook for the offline bench / automated tests only.
if (params.get('net') === 'local') {
  window.__host = {
    get game() { return game; },
    set game(g) { game = g; commit({ broadcast: true }); },
  };
}

boot();
