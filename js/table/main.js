// The table is the authoritative host: it owns the game state, validates
// every move with the pure engine, and sends each phone a snapshot of the
// public state plus that phone's own rack.

import { APP_ID, SOUNDS, SITE_ROOT, peerOptions } from '../config.js';
import { createSoundPlayer } from '../audio/player.js';
import { tableCues, timerCue, ordinal } from '../audio/cues.js';
import { hostRoom } from '../net/room.js';
import { transportFromUrl } from '../net/transports.js';
import {
  createGame, addPlayer, renamePlayer, removePlayer, setTimer, setStrictJokers, startRound, commitTurn,
  drawTile, reorderRack, resetToLobby, publicView, playerView, currentPlayerId, setBotLevel, strictJokersOn,
  turnClock, restoreGame, effectiveTimer, timerLabel, endRoundNow, resultPlacements,
  MIN_PLAYERS, MAX_PLAYERS, TIMER_OPTIONS, BOT_LEVELS,
} from '../game/engine.js';
import { tileHtml, escapeHtml, BOT_ICON } from '../ui/tile-view.js';
import { createBotRunner } from '../bot/runner.js';
import qrcode from '../../vendor/qrcode.mjs';

const params = new URLSearchParams(location.search);
const forcedCode = params.get('code'); // dev harness pins a code
// Watch mode (?bots=2..4): an all-bot game for testing. No room, nothing saved.
const WATCH = Math.min(4, Math.max(0, Number(params.get('bots')) || 0)) >= 2 ? Math.min(4, Number(params.get('bots'))) : 0;
const WATCH_LEVEL = params.get('level'); // easy | normal | mix (default)
const THINK_MS = params.has('think') ? Math.max(0, Number(params.get('think'))) : null; // fixed bot "thinking" delay
const STORE_KEY = `${APP_ID}:host${forcedCode ? ':' + forcedCode : ''}`;
const BOT_NAMES = ['Robo Ada', 'Robo Bix', 'Robo Cog', 'Robo Dot'];
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ state

let game = createGame();
let seats = {}; // clientId -> playerId
let nextPid = 0;
let room = null;
// Turn countdown, derived from the game by the pure turnClock() in the engine.
let clockState = null; // {turnNumber, deadline, total}
let deadline = 0; // ms timestamp when the current turn times out (0 = no timer)
let deadlineTurn = -1;

function save() {
  if (WATCH) return;
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
const botLevel = (pid) => game.players.find((p) => p.id === pid)?.bot ?? null;
const clientOf = (pid) => Object.keys(seats).find((c) => seats[c] === pid);
const isOnline = (pid) => {
  if (botLevel(pid)) return true;
  const c = clientOf(pid);
  return !!(c && room?.isConnected(c));
};

// ------------------------------------------------------------------ boot

async function boot() {
  if (WATCH) return bootWatch();
  const saved = load();
  if (saved?.game) {
    game = restoreGame(saved.game); // older saves get any newer settings filled in
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
  room?.send(clientId, msg);
}

function sendState(clientId) {
  const pid = seats[clientId];
  if (!pid || !room) return;
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
  if (!room) return;
  for (const clientId of Object.keys(seats)) if (room.isConnected(clientId)) sendState(clientId);
}

/** After any state change: reset the timer if the turn moved, persist, sync, redraw. */
function commit({ broadcast }) {
  // New deadline once per turn; cleared at once if the timer is turned off.
  // Timer changes made mid-turn only reach game.settings.timer when the next turn starts.
  clockState = turnClock(clockState, game, Date.now());
  deadline = clockState.deadline;
  deadlineTurn = deadline ? clockState.turnNumber : -1;
  save();
  if (broadcast) broadcastState();
  render();
  setTimeout(maybeRunBot, 0);
  if (WATCH && game.phase === 'roundOver') scheduleWatchNextRound();
}

let lastLeft = Infinity;
let lastLeftTurn = -1;
function tick() {
  if (deadline && game.phase === 'playing') {
    if (lastLeftTurn !== deadlineTurn) {
      lastLeftTurn = deadlineTurn;
      lastLeft = Infinity;
    }
    const left = deadline - Date.now();
    for (const c of timerCue(lastLeft, left)) sfx.play(c.sound);
    lastLeft = left;
  }
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
  setupLobbyControls();
  if (!room) return;
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
}

function setupLobbyControls() {

  $('timerOptions').innerHTML = TIMER_OPTIONS.map(
    (s) => `<button role="radio" data-s="${s}">${timerLabel(s)}</button>`,
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
    enableSound();
    game = startRound(game);
    commit({ broadcast: true });
  });

  $('addBotBtn').addEventListener('click', () => {
    if (game.players.length >= MAX_PLAYERS) return;
    const name = BOT_NAMES.find((n) => !game.players.some((p) => p.name === n)) ?? `Robo ${game.players.length + 1}`;
    game = addPlayer(game, { id: `b${++nextPid}`, name, bot: 'normal' });
    commit({ broadcast: true });
  });

  $('lobbyPlayers').addEventListener('click', (e) => {
    const lvl = e.target.closest('button[data-level]');
    if (lvl) {
      game = setBotLevel(game, lvl.dataset.pid, lvl.dataset.level);
      commit({ broadcast: true });
      return;
    }
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
    room?.close();
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

// ------------------------------------------------------------------ sound

// Sounds follow the public state, so bot turns sound exactly like human ones.
const sfx = createSoundPlayer({ manifest: SOUNDS, baseUrl: SITE_ROOT, where: 'table', storageKey: `${APP_ID}:sound:table` });
let lastSoundView = null;

function playCues(v) {
  for (const c of tableCues(lastSoundView, v)) sfx.play(c.sound, { delay: c.delay ?? 0 });
  lastSoundView = v;
}

async function enableSound() {
  await sfx.unlock();
  renderSoundCtl();
}

function renderSoundCtl() {
  const ctl = $('soundCtl');
  ctl.classList.toggle('locked', !sfx.unlocked);
  ctl.classList.toggle('muted', sfx.unlocked && sfx.muted);
  $('soundBtn').title = !sfx.unlocked ? 'Enable sound' : sfx.muted ? 'Unmute' : 'Mute';
  $('volume').value = String(sfx.volume);
}

$('soundBtn').addEventListener('click', async () => {
  if (!sfx.unlocked) {
    // "Tap to enable sound": unlock and make sure it's audible.
    await enableSound();
    sfx.setMuted(false);
  } else {
    sfx.setMuted(!sfx.muted);
  }
  renderSoundCtl();
  sfx.play('turnStart');
});
$('volume').addEventListener('input', (e) => sfx.setVolume(Number(e.target.value)));
$('volume').addEventListener('change', () => sfx.play('place'));
// Any first tap on the iPad unlocks audio (iOS requires a gesture). A tap on
// the sound button itself is left to its own handler, so it doesn't unlock
// and then immediately toggle mute.
function firstTap(e) {
  if (e.target.closest?.('#soundBtn')) return;
  window.removeEventListener('pointerdown', firstTap, true);
  enableSound();
}
window.addEventListener('pointerdown', firstTap, true);
renderSoundCtl();
// For checking your own samples: run __sounds.sources() in the browser console.
window.__sounds = sfx;

function render() {
  const v = publicView(game);
  playCues(v);
  $('lobby').hidden = v.phase !== 'lobby';
  $('game').hidden = v.phase === 'lobby';
  $('roundOver').hidden = v.phase !== 'roundOver';
  if (v.phase === 'lobby') renderLobby(v);
  else {
    renderPlayers(v);
    renderBoard(v);
    const cur = v.currentPlayerId;
    $('turnName').innerHTML = !cur ? ''
      : botLevel(cur) ? `${BOT_ICON}<span>${escapeHtml(playerName(cur))}</span> is thinking…`
      : `<span>${escapeHtml(playerName(cur))}</span>'s turn`;
    $('poolCount').textContent = v.poolCount;
    renderSettingsPanel(v);
    $('endRoundBtn').hidden = v.phase !== 'playing';
    if (v.phase !== 'playing') {
      disarmEndRound();
      $('celebrate').hidden = true;
    }
  }
  if (v.phase === 'roundOver') renderRoundOver(v);
  renderEvent(v);
}

function renderLobby(v) {
  const rows = v.players.map((p) => p.bot ? `
    <li class="bot-row">${BOT_ICON}<span class="pname">${escapeHtml(p.name)}</span>
      <span class="seg small-seg" role="radiogroup" aria-label="Difficulty for ${escapeHtml(p.name)}">${BOT_LEVELS.map((l) =>
        `<button role="radio" data-pid="${p.id}" data-level="${l}" aria-checked="${p.bot === l}">${l === 'easy' ? 'Easy' : 'Normal'}</button>`).join('')}</span>
      <button class="kick" data-pid="${p.id}" aria-label="Remove ${escapeHtml(p.name)}">✕</button></li>` : `
    <li><span class="dot ${isOnline(p.id) ? 'on' : 'off'}"></span><span class="pname">${escapeHtml(p.name)}</span>
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
  $('addBotBtn').disabled = v.players.length >= MAX_PLAYERS;
  $('lobbyHint').textContent = enough
    ? 'Everyone in? Start when ready. Late arrivals can join between games.'
    : `Need at least ${MIN_PLAYERS} players to start. Short on people? Add a bot.`;
}

let lastPlayersHtml = '';
function renderPlayers(v) {
  const html = v.players.map((p) => {
    const online = isOnline(p.id);
    const current = p.id === v.currentPlayerId;
    const thinking = current && p.bot && botTurn === v.turnNumber;
    const done = p.place != null;
    return `<li class="player ${current ? 'current' : ''} ${p.bot ? 'is-bot' : ''} ${done ? 'finished' : ''}" data-pid="${p.id}">
      <div class="row">
        ${p.bot ? BOT_ICON : `<span class="dot ${online ? 'on' : 'off'}" title="${online ? 'connected' : 'disconnected'}"></span>`}
        <span class="name">${escapeHtml(p.name)}</span>
        ${done ? medal(p.place) : ''}
        <span class="count">${p.tileCount}<small>tiles</small></span>
      </div>
      <div class="meta">
        <span class="turn-tag">${thinking ? 'Thinking<i class="dots"><b>.</b><b>.</b><b>.</b></i>' : 'Playing'}</span>
        ${p.bot ? `<span class="badge">${p.bot === 'easy' ? 'Easy bot' : 'Bot'}</span>` : ''}
        ${done ? `<span>Finished ${ordinal(p.place)}</span>` : ''}
        ${online || done ? '' : '<span class="badge off">offline</span>'}
        ${p.melded || done ? '' : '<span class="badge">no meld</span>'}
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
  const total = clockState?.total || game.settings.timer * 1000;
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

const medal = (place) => `<span class="medal m${place}">${ordinal(place)}</span>`;

const REASONS = {
  out: 'Everyone but one player went out.',
  blocked: 'No tiles left to draw and nobody could play, so the rest are ranked by lowest rack value.',
  ended: 'The table ended the round; everyone still playing is ranked by lowest rack value.',
  botsOnly: 'Every person finished, so the bots still playing were ranked by lowest rack value.',
};

function renderRoundOver(v) {
  const r = v.result;
  const winner = playerName(r.winnerId);
  const byId = Object.fromEntries(v.players.map((p) => [p.id, p]));
  $('roWinner').textContent = `${winner} wins round ${v.round}!`;
  $('roReason').textContent = REASONS[r.reason] ?? '';
  $('roRows').innerHTML = resultPlacements(r, v.players).map((pl) => {
    const p = byId[pl.id];
    const d = r.deltas[pl.id] ?? 0;
    return `<tr class="${pl.place === 1 ? 'win' : ''}">
      <td class="place">${medal(pl.place)}</td>
      <td>${p.bot ? BOT_ICON + ' ' : ''}${escapeHtml(p.name)}</td>
      <td class="finish">${pl.how === 'out' ? 'Went out' : `${pl.rackValue} pts left`}</td>
      <td class="${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${d > 0 ? '+' : ''}${d}</td><td>${p.score}</td></tr>`;
  }).join('');
  $('roScoring').textContent = r.scoredAtFirstOut
    ? `Points use official scoring from the moment ${winner} went out: everyone else loses what was in their rack then (joker = 30), and ${winner} gets the total. Places after that don't change points.`
    : `Nobody went out, so ${winner} (lowest rack) takes the points: everyone else loses their rack value (joker = 30).`;
}

// ------------------------------------------------------------------ celebration & ending early

let celebrateTimer = null;
function celebrate(pid, place) {
  const el = $('celebrate');
  el.innerHTML = `${medal(place)}<span>${escapeHtml(playerName(pid))} finished ${ordinal(place)}!</span>`;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(celebrateTimer);
  celebrateTimer = setTimeout(() => (el.hidden = true), 2900);
}

let endArmTimer = null;
function disarmEndRound() {
  clearTimeout(endArmTimer);
  const b = $('endRoundBtn');
  b.classList.remove('confirm');
  b.textContent = 'End round now…';
}
$('endRoundBtn').addEventListener('click', () => {
  const b = $('endRoundBtn');
  if (game.phase !== 'playing') return;
  if (!b.classList.contains('confirm')) {
    // Two-step so a stray tap doesn't end the round.
    b.classList.add('confirm');
    b.textContent = 'Tap again: rank by tiles left';
    clearTimeout(endArmTimer);
    endArmTimer = setTimeout(disarmEndRound, 5000);
    return;
  }
  disarmEndRound();
  game = endRoundNow(game);
  commit({ broadcast: true });
});

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
      if (ev.out) {
        text = `${name} went out · ${ordinal(ev.place)} place!`;
        celebrate(ev.playerId, ev.place);
      }
      kind = 'good';
      break;
    }
    case 'draw': text = ev.drew ? `${name} drew a tile` : `${name} passed (no tiles left to draw)`; break;
    case 'timeout': text = `Time's up! ${name} ${ev.drew ? 'draws a tile' : 'passes'}`; kind = 'bad'; break;
    case 'skip': text = `${name} was skipped`; break;
    case 'invalid': text = `${name}'s move didn't work: ${escapeHtml(ev.message)}`; kind = 'bad'; break;
    case 'roundStart': text = `Round ${v.round} · ${escapeHtml(playerName(v.currentPlayerId))} goes first`; break;
    case 'timerChange':
      if (v.phase !== 'playing') return;
      text = ev.when === 'nextTurn'
        ? `Timer set to ${timerLabel(ev.timer)} — starts next turn`
        : ev.timer ? `Timer set to ${timerLabel(ev.timer)}` : 'Timer off';
      break;
    default: return;
  }
  const b = $('banner');
  b.className = `banner ${kind}`;
  b.innerHTML = text;
  requestAnimationFrame(() => b.classList.add('show'));
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), ev.type === 'invalid' ? 4500 : 2800);
}

// ------------------------------------------------------------------ in-game settings

// The gear on the table opens the timer options. Only the table can change
// them (phones have no such control, and the table ignores anything else).
// The panel closes itself after a few idle seconds so it never sits on the TV.
const PANEL_IDLE_MS = 8000;
const PANEL_AFTER_PICK_MS = 1600;
let panelTimer = null;
let panelCloseAt = 0;

$('gameTimerOptions').innerHTML = TIMER_OPTIONS.map((t) => `<button role="radio" data-t="${t}">${timerLabel(t)}</button>`).join('');

function openPanel() {
  $('settingsPanel').hidden = false;
  $('settingsBtn').setAttribute('aria-expanded', 'true');
  renderSettingsPanel(publicView(game));
  armPanelClose(PANEL_IDLE_MS);
}
function closePanel() {
  clearTimeout(panelTimer);
  $('settingsPanel').hidden = true;
  $('settingsBtn').setAttribute('aria-expanded', 'false');
}
function armPanelClose(ms) {
  clearTimeout(panelTimer);
  panelCloseAt = Date.now() + ms;
  panelTimer = setTimeout(closePanel, ms);
  const bar = $('spBar');
  bar.style.transition = 'none';
  bar.style.transform = 'scaleX(1)';
  void bar.offsetWidth;
  bar.style.transition = `transform ${ms}ms linear`;
  bar.style.transform = 'scaleX(0)';
}

function renderSettingsPanel(v) {
  const pending = v.settings.pendingTimer;
  const pt = $('pendingTimer');
  pt.hidden = !(v.phase === 'playing' && pending != null);
  if (!pt.hidden) pt.textContent = `Next turn: ${timerLabel(pending)}`;
  if (v.phase !== 'playing') closePanel();
  if ($('settingsPanel').hidden) return;
  const chosen = pending ?? v.settings.timer;
  for (const b of $('gameTimerOptions').children) b.setAttribute('aria-checked', String(Number(b.dataset.t) === chosen));
  $('timerNote').innerHTML = pending != null
    ? `<b>${timerLabel(pending)}</b> starts next turn. This turn keeps ${v.settings.timer ? timerLabel(v.settings.timer) : 'no timer'}.`
    : 'New times start with the next turn, so nobody is cut off. <b>Off</b> stops the clock right away.';
}

$('settingsBtn').addEventListener('click', () => ($('settingsPanel').hidden ? openPanel() : closePanel()));
$('settingsClose').addEventListener('click', closePanel);
$('settingsPanel').addEventListener('pointerdown', () => {
  if (Date.now() < panelCloseAt) armPanelClose(Math.max(PANEL_IDLE_MS, panelCloseAt - Date.now()));
});
$('gameTimerOptions').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-t]');
  if (!b || game.phase !== 'playing') return;
  game = setTimer(game, Number(b.dataset.t));
  commit({ broadcast: true });
  armPanelClose(PANEL_AFTER_PICK_MS);
});
document.addEventListener('pointerdown', (e) => {
  if ($('settingsPanel').hidden || e.target.closest('#settingsPanel, #settingsBtn')) return;
  closePanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePanel();
});

// ------------------------------------------------------------------ bots

// Bots act on the table, through exactly the same commitTurn/drawTile path as
// a phone's move. The search runs in a Web Worker with a hard time limit, and a
// short "thinking" pause keeps the game followable.
const bots = createBotRunner({ budgetMs: 1500 });
let botTurn = null; // turnNumber the current bot is working on

async function maybeRunBot() {
  if (game.phase !== 'playing') return;
  const pid = currentPlayerId(game);
  const level = botLevel(pid);
  if (!level || botTurn === game.turnNumber) return;
  const turn = (botTurn = game.turnNumber);
  render(); // show "thinking…"
  const started = Date.now();
  const pause = THINK_MS ?? 1000 + Math.random() * 1000;
  const move = await bots.think({
    board: game.board.map((b) => b.tiles),
    rack: game.racks[pid],
    hasMelded: game.melded[pid],
    strictJokers: strictJokersOn(game),
    level,
  });
  const left = pause - (Date.now() - started);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
  // The turn may have ended meanwhile (timer ran out, table went back to the lobby).
  if (game.phase !== 'playing' || game.turnNumber !== turn) return;
  if (move) {
    const r = commitTurn(game, pid, move.sets);
    game = r.state;
    if (!r.ok) {
      console.error('Bot move rejected by the rules engine:', r.errors, move);
      game = drawTile(game, pid, 'draw').state;
    }
  } else {
    game = drawTile(game, pid, 'draw').state;
  }
  commit({ broadcast: true });
}

function watchGame() {
  let g = createGame();
  for (let i = 0; i < WATCH; i++) {
    const level = WATCH_LEVEL === 'easy' || WATCH_LEVEL === 'normal' ? WATCH_LEVEL : i % 2 ? 'easy' : 'normal';
    g = addPlayer(g, { id: `b${i + 1}`, name: BOT_NAMES[i], bot: level });
  }
  if (params.get('jokers') === 'loose') g = setStrictJokers(g, false);
  return startRound(g);
}

function bootWatch() {
  $('boot').hidden = true;
  game = watchGame();
  $('sideCode').parentElement.innerHTML = `Watch mode · ${WATCH} bots<br><small>Next round starts by itself</small>`;
  $('menuBtn').hidden = true;
  setupLobbyControls();
  commit({ broadcast: false });
  setInterval(tick, 250);
}

let watchTimer = null;
function scheduleWatchNextRound() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    if (game.phase !== 'roundOver') return;
    game = startRound(game);
    commit({ broadcast: false });
  }, 6000);
}

// Test hook for the offline bench / automated tests only.
if (params.get('net') === 'local' || WATCH) {
  window.__host = {
    get game() { return game; },
    set game(g) { game = g; commit({ broadcast: true }); },
    sfx,
  };
}

boot();
