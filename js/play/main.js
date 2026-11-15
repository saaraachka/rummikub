// Phone controller. A thin client: it renders whatever snapshot the table
// sends, keeps a private working copy of the board during your turn, and
// sends the finished board to the table for validation.

import { APP_ID, peerOptions } from '../config.js';
import { transportFromUrl } from '../net/transports.js';
import { diagnose } from './diagnose.js';
import { joinRoom, normalizeCode } from '../net/room.js';
import { analyzeSet, meldPointsFromRack, INITIAL_MELD_POINTS } from '../game/rules.js';
import { sortByColor, sortByNumber } from '../game/tiles.js';
import { tileHtml, escapeHtml } from '../ui/tile-view.js';

const params = new URLSearchParams(location.search);
const slot = params.get('slot') || ''; // lets several tabs in one browser be different players
const SESSION_KEY = `${APP_ID}:session${slot ? ':' + slot : ''}`;
const NAME_KEY = `${APP_ID}:name${slot ? ':' + slot : ''}`;
const $ = (id) => document.getElementById(id);

let conn = null;
let S = null; // latest snapshot from the table
let stateAt = 0; // when it arrived (for the countdown)
let remainingAtReceipt = null;
let work = null; // {turnNumber, sets: string[][], rack: string[], origRack: Set} during my turn
let selected = null; // tile id
let errors = []; // [{message, setIndex}] from the last rejected commit
let pending = false; // waiting for the table to validate a commit
let flash = ''; // short one-off notice
let flashTimer = null;
let drawArmed = false;
let drawArmTimer = null;
let prevRack = [];

// ------------------------------------------------------------------ storage

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ------------------------------------------------------------------ screens

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

// ------------------------------------------------------------------ join

function initJoin() {
  const session = store.get(SESSION_KEY);
  const roomParam = normalizeCode(params.get('room'));
  const nameParam = params.get('name');
  $('codeInput').value = roomParam || session?.room || '';
  $('nameInput').value = nameParam || store.get(NAME_KEY) || '';

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode($('codeInput').value);
    const name = $('nameInput').value.trim();
    if (code.length !== 4) return ($('joinError').textContent = 'Room codes are 4 letters.');
    if (!name) return ($('joinError').textContent = 'Enter your name.');
    start(code, name);
  });
  $('codeInput').addEventListener('input', (e) => (e.target.value = normalizeCode(e.target.value)));
  $('cancelJoin').addEventListener('click', () => {
    conn?.close();
    conn = null;
    store.del(SESSION_KEY);
    showDiag({ tone: 'wait', text: '' });
    setJoining(false);
  });

  show('join');
  // Coming back to a room we were in (refresh, reopened tab): rejoin straight away.
  if (session?.room && (!roomParam || roomParam === session.room)) return start(session.room, session.name);
  if (roomParam && nameParam && params.has('autojoin')) return start(roomParam, nameParam);
  if (roomParam) $('nameInput').focus();
}

/** Lock the form while a join is in flight; the diagnostics line says what's happening. */
function setJoining(on) {
  $('codeInput').disabled = on;
  $('nameInput').disabled = on;
  $('joinBtn').disabled = on;
  $('joinBtn').textContent = on ? 'Connecting…' : 'Join table';
  $('cancelJoin').hidden = !on;
  if (!on) $('diag').hidden = !$('diag').classList.contains('bad'); // keep a failure reason visible
}

function start(code, name) {
  store.set(NAME_KEY, name);
  store.set(SESSION_KEY, { room: code, name });
  const u = new URL(location.href);
  u.searchParams.set('room', code);
  u.searchParams.delete('autojoin');
  history.replaceState(null, '', u);
  $('codeInput').value = code;
  $('nameInput').value = name;
  $('joinError').textContent = '';
  show('join');
  setJoining(true);
  conn = joinRoom({ appId: APP_ID, code, hello: { name }, slot, transport: transportFromUrl(location.search, peerOptions()) });
  conn.on('status', onStatus);
  conn.on('message', onMessage);
  showDiag(diagnose('connecting', null, { code }));
}

function leave() {
  store.del(SESSION_KEY);
  conn?.send({ type: 'leave' });
  setTimeout(() => conn?.close(), 150);
  const u = new URL(location.href);
  u.searchParams.delete('room');
  setTimeout(() => location.replace(u.href), 200);
}
$('leaveBtn').addEventListener('click', leave);

function showDiag(d) {
  for (const id of ['diag', 'waitDiag']) {
    const el = $(id);
    el.className = `diag ${d.tone}`;
    el.querySelector('.dot').className = `dot ${d.tone === 'ok' ? 'on' : d.tone === 'bad' ? 'off' : 'wait'}`;
    el.lastElementChild.textContent = d.text;
  }
  $('diag').hidden = !d.text;
  // Once in the lobby, only show the line when something is wrong.
  $('waitDiag').hidden = !d.text || d.tone === 'ok';
  $('offline').textContent = d.tone === 'bad' ? d.text : 'Reconnecting… your rack is safe.';
}

function onStatus(status, detail) {
  if (!conn) return;
  const online = status === 'connected';
  showDiag(diagnose(status, detail, { code: conn.code, lastError: conn.lastError, attempt: conn.attempt }));
  $('connDot').className = `dot ${online ? 'on' : status === 'rejected' ? 'off' : 'wait'}`;
  $('offline').hidden = online || !S;
  if (status === 'rejected') {
    store.del(SESSION_KEY);
    S = null;
    conn = null;
    show('join');
    setJoining(false);
    return;
  }
  if (online) conn.send({ type: 'sync' });
  render();
}

function onMessage(msg) {
  if (msg.type === 'state') {
    const prev = S;
    S = msg.state;
    stateAt = Date.now();
    remainingAtReceipt = msg.turnRemainingMs;
    syncWork(prev);
    render();
  } else if (msg.type === 'commitResult') {
    pending = false;
    if (!msg.ok) {
      errors = msg.errors || [];
      navigator.vibrate?.([30, 60, 30]);
    } else {
      errors = [];
    }
    render();
    if (!msg.ok) document.querySelectorAll('.set.invalid').forEach((el) => el.classList.add('flagged'));
  } else if (msg.type === 'error') {
    pending = false;
    notice(msg.message);
  }
}

// ------------------------------------------------------------------ turn state

const isMyTurn = () => S?.phase === 'playing' && S.currentPlayerId === S.you;
const nameOf = (pid) => S?.players.find((p) => p.id === pid)?.name ?? '';

function syncWork(prev) {
  if (isMyTurn()) {
    if (!work || work.turnNumber !== S.turnNumber) {
      work = freshWork();
      errors = [];
      selected = null;
      pending = false;
      if (prev) {
        navigator.vibrate?.(120);
        const g = $('game');
        g.classList.remove('turn-start');
        void g.offsetWidth;
        g.classList.add('turn-start');
      }
    } else {
      // Same turn, e.g. the table echoed a rack reorder; keep the working copy
      // but follow the rack order for tiles still in hand.
      const inHand = new Set(work.rack);
      work.rack = S.rack.filter((id) => inHand.has(id));
    }
  } else {
    work = null;
    if (selected && !S.rack.includes(selected)) selected = null;
    pending = false;
  }
}

function freshWork() {
  return {
    turnNumber: S.turnNumber,
    sets: S.board.map((s) => s.tiles.slice()),
    rack: S.rack.slice(),
    origRack: new Set(S.rack),
  };
}

const boardSets = () => (work ? work.sets : S.board.map((s) => s.tiles));
const rackTiles = () => (work ? work.rack : S.rack);
const changed = () => work && work.rack.length !== work.origRack.size;
const madeEdits = () => work && JSON.stringify(work.sets) !== JSON.stringify(S.board.map((s) => s.tiles));

function locate(id) {
  const sets = boardSets();
  for (let i = 0; i < sets.length; i++) {
    const j = sets[i].indexOf(id);
    if (j >= 0) return { zone: 'set', set: i, index: j };
  }
  const r = rackTiles().indexOf(id);
  return r >= 0 ? { zone: 'rack', index: r } : null;
}

function canDrag(id) {
  const loc = locate(id);
  if (!loc || pending) return false;
  if (work) return true;
  return loc.zone === 'rack';
}

/**
 * Move a tile. dest: {zone:'set', set, index} | {zone:'new'} | {zone:'rack', index}
 * During your turn anything goes except returning table tiles to the rack.
 * Outside your turn only rack reordering is possible.
 */
function moveTile(id, dest) {
  const from = locate(id);
  if (!from || !dest) return false;
  if (!work) {
    if (from.zone !== 'rack' || dest.zone !== 'rack') return false;
    const rack = S.rack.slice();
    rack.splice(from.index, 1);
    let at = dest.index ?? rack.length;
    if (at > from.index) at--;
    rack.splice(Math.max(0, Math.min(at, rack.length)), 0, id);
    S.rack = rack;
    sendRackOrder(rack);
    return true;
  }
  if (dest.zone === 'rack' && !work.origRack.has(id)) {
    notice("Tiles from the table can't go back to your rack.");
    return false;
  }
  const sets = work.sets;
  // Remove from source (leave empty sets in place so indices stay valid).
  const src = from.zone === 'set' ? sets[from.set] : work.rack;
  src.splice(from.index, 1);
  if (dest.zone === 'set') {
    let at = dest.index ?? sets[dest.set].length;
    if (from.zone === 'set' && from.set === dest.set && at > from.index) at--;
    sets[dest.set].splice(at, 0, id);
  } else if (dest.zone === 'new') {
    sets.push([id]);
  } else {
    let at = dest.index ?? work.rack.length;
    if (from.zone === 'rack' && at > from.index) at--;
    work.rack.splice(at, 0, id);
  }
  work.sets = sets.filter((s) => s.length);
  errors = [];
  drawArmed = false;
  if (dest.zone === 'rack' && from.zone === 'rack') sendRackOrder(work.rack);
  return true;
}

function splitAt(id) {
  const loc = locate(id);
  if (!work || loc?.zone !== 'set' || loc.index === 0) return;
  const set = work.sets[loc.set];
  work.sets.splice(loc.set + 1, 0, set.splice(loc.index));
  errors = [];
}

let rackOrderTimer = null;
function sendRackOrder(order) {
  clearTimeout(rackOrderTimer);
  const full = work ? [...order, ...[...work.origRack].filter((id) => !order.includes(id))] : order;
  rackOrderTimer = setTimeout(() => conn?.send({ type: 'rackOrder', order: full }), 250);
}

function notice(text) {
  flash = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash = '';
    render();
  }, 2600);
  render();
}

// ------------------------------------------------------------------ actions

$('sortColor').addEventListener('click', () => sortRack(sortByColor));
$('sortNumber').addEventListener('click', () => sortRack(sortByNumber));
function sortRack(fn) {
  if (!S) return;
  if (work) {
    work.rack = fn(work.rack);
    sendRackOrder(work.rack);
  } else {
    S.rack = fn(S.rack);
    sendRackOrder(S.rack);
  }
  render();
}

$('resetBtn').addEventListener('click', () => {
  if (!isMyTurn() || pending) return;
  work = freshWork();
  errors = [];
  selected = null;
  render();
});

$('commitBtn').addEventListener('click', () => {
  if (!isMyTurn() || pending || !changed()) return;
  if (!conn.send({ type: 'commit', turnNumber: work.turnNumber, sets: work.sets.filter((s) => s.length) })) {
    return notice('Not connected to the table. Hang on…');
  }
  pending = true;
  selected = null;
  render();
});

$('drawBtn').addEventListener('click', () => {
  if (!isMyTurn() || pending) return;
  if (madeEdits() && !drawArmed) {
    drawArmed = true;
    clearTimeout(drawArmTimer);
    drawArmTimer = setTimeout(() => {
      drawArmed = false;
      render();
    }, 3000);
    return render();
  }
  drawArmed = false;
  if (!conn.send({ type: 'draw', turnNumber: S.turnNumber })) return notice('Not connected to the table. Hang on…');
  pending = true;
  render();
});

// ------------------------------------------------------------------ drag & tap

const game = $('game');
let drag = null;

game.addEventListener('pointerdown', (e) => {
  if (e.button > 0 || drag) return;
  const el = e.target.closest('.tile[data-id]');
  if (!el) return;
  drag = { id: el.dataset.id, el, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, pointerId: e.pointerId, active: false };
});

window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (!drag.active) {
    if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) < 8) return;
    if (!canDrag(drag.id)) {
      drag = null;
      return;
    }
    beginDrag();
  }
  e.preventDefault();
  moveGhost();
});

window.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  const target = d.active ? hitTest(d.x, d.y) : null;
  drag = null;
  if (d.active) {
    endDrag(d);
    if (target && moveTile(d.id, target)) selected = null;
    render();
  } else {
    onTapTile(d.id);
  }
});
window.addEventListener('pointercancel', () => {
  if (drag?.active) endDrag(drag);
  drag = null;
  render();
});

function beginDrag() {
  drag.active = true;
  const r = drag.el.getBoundingClientRect();
  const ghost = drag.el.cloneNode(true);
  ghost.classList.remove('selected', 'drag-src');
  ghost.classList.add('ghost');
  ghost.style.setProperty('--tw', `${r.width}px`);
  ghost.style.width = `${r.width}px`;
  ghost.style.height = `${r.height}px`;
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  drag.w = r.width;
  drag.h = r.height;
  drag.el.classList.add('drag-src');
  autoScroll();
}

function moveGhost() {
  // Float the tile above the finger so you can see where it's going.
  drag.ghost.style.left = `${drag.x - drag.w / 2}px`;
  drag.ghost.style.top = `${drag.y - drag.h * 1.15}px`;
  showTarget(hitTest(drag.x, drag.y));
}

function endDrag(d) {
  d.ghost?.remove();
  d.el.classList.remove('drag-src');
  showTarget(null);
}

function autoScroll() {
  if (!drag?.active) return;
  const area = $('boardArea');
  const r = area.getBoundingClientRect();
  const edge = 48;
  if (drag.y > r.top && drag.y < r.top + edge) area.scrollTop -= 10;
  else if (drag.y < r.bottom && drag.y > r.bottom - edge) area.scrollTop += 10;
  requestAnimationFrame(autoScroll);
}

/** What would a drop at (x, y) do? Uses the point the ghost tile is hovering. */
function hitTest(x, y) {
  const py = y - (drag?.h ?? 0) * 0.6;
  const el = document.elementFromPoint(x, py) || document.elementFromPoint(x, y);
  if (!el) return null;
  if (el.closest('#newSet')) return work ? { zone: 'new' } : null;
  const setEl = el.closest('.set[data-set]');
  if (setEl && work) return { zone: 'set', set: Number(setEl.dataset.set), index: insertIndex(setEl, x, py), el: setEl };
  if (el.closest('#rackArea')) return { zone: 'rack', index: insertIndex($('rack'), x, py), el: $('rack') };
  if (el.closest('#boardArea') && work) return { zone: 'new' };
  return null;
}

function insertIndex(container, x, y) {
  const tiles = [...container.querySelectorAll(':scope > .tile')];
  if (!tiles.length) return 0;
  let best = 0;
  let bestD = Infinity;
  tiles.forEach((t, i) => {
    const r = t.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const d = (x - cx) ** 2 + ((y - cy) * 2) ** 2;
    if (d < bestD) {
      bestD = d;
      best = x > cx ? i + 1 : i;
    }
  });
  return best;
}

function showTarget(t) {
  document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  const caret = $('caret');
  if (!t) return (caret.hidden = true);
  if (t.zone === 'new') {
    $('newSet').classList.add('drop-target');
    caret.hidden = true;
    return;
  }
  (t.zone === 'rack' ? $('rackArea') : t.el).classList.add('drop-target');
  const tiles = [...t.el.querySelectorAll(':scope > .tile')];
  if (!tiles.length) return (caret.hidden = true);
  const ref = tiles[Math.min(t.index, tiles.length - 1)].getBoundingClientRect();
  const x = t.index >= tiles.length ? ref.right + 2 : ref.left - 4;
  Object.assign(caret.style, { left: `${x}px`, top: `${ref.top}px`, height: `${ref.height}px` });
  caret.hidden = false;
}

function onTapTile(id) {
  if (pending || !S) return;
  if (!selected) {
    if (canDrag(id)) selected = id;
  } else if (selected === id) {
    selected = null;
  } else {
    const loc = locate(id);
    if (loc) moveTile(selected, loc.zone === 'set' ? { zone: 'set', set: loc.set, index: loc.index } : { zone: 'rack', index: loc.index });
    selected = null;
  }
  render();
}

// Taps on empty space: a set's background appends, the "new set" strip
// starts a set, the rack background returns the tile to the end of the rack.
game.addEventListener('click', (e) => {
  if (!selected || e.target.closest('.tile, button')) return;
  let dest = null;
  if (e.target.closest('#newSet')) dest = { zone: 'new' };
  else if (e.target.closest('.set[data-set]')) dest = { zone: 'set', set: Number(e.target.closest('.set').dataset.set) };
  else if (e.target.closest('#rackArea')) dest = { zone: 'rack' };
  if (!dest) return;
  moveTile(selected, dest);
  selected = null;
  render();
});
$('info').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'split') splitAt(selected);
  selected = null;
  render();
});

// ------------------------------------------------------------------ render

function render() {
  if (!S || drag?.active) return; // never rebuild the DOM under a finger; endDrag re-renders
  if (S.phase === 'lobby') return renderLobby();
  if (S.phase === 'roundOver') return renderOver();
  show('game');
  const mine = isMyTurn();
  game.classList.toggle('my-turn', mine);
  $('offline').hidden = conn.status === 'connected';

  const cur = S.currentPlayerId;
  $('turnText').textContent = mine ? 'Your turn' : `${nameOf(cur)}'s turn`;
  $('subText').textContent = mine
    ? (pending ? 'Checking with the table…' : S.hasMelded ? 'Play tiles, then commit' : `First meld: ${INITIAL_MELD_POINTS}+ points from your rack`)
    : `You're ${nameOf(S.you)} · ${S.hasMelded ? 'melded' : 'no meld yet'}`;
  $('poolCount').textContent = S.poolCount;
  renderBoard();
  renderRack();
  renderInfo();

  $('commitBtn').disabled = !mine || pending || !changed();
  $('resetBtn').disabled = !mine || pending || !madeEdits();
  $('drawBtn').disabled = !mine || pending;
  $('drawBtn').textContent = drawArmed ? 'Discard & draw?' : S.poolCount ? 'Draw' : 'Pass';
  $('drawBtn').classList.toggle('confirm', drawArmed);
  $('commitBtn').textContent = pending ? 'Checking…' : 'Commit';
  renderTimer();
}

function renderBoard() {
  const sets = boardSets();
  const flagged = new Set(errors.map((e) => e.setIndex).filter((i) => i != null));
  const vw = Math.min(window.innerWidth, 600);
  $('boardArea').style.setProperty('--tw', `${Math.max(28, Math.min(40, Math.floor((vw - 40) / 10.5)))}px`);
  if (!sets.length) {
    $('sets').innerHTML = `<div class="board-empty">${work ? 'The table is empty. Drag tiles from your rack to the strip below to start a set.' : 'The table is empty.'}</div>`;
    return;
  }
  $('sets').innerHTML = sets.map((ids, i) => {
    const a = work ? analyzeSet(ids) : { valid: true };
    const bad = work && (!a.valid || flagged.has(i));
    const why = bad && !a.valid ? `<div class="why">${escapeHtml(shortReason(a.reason))}</div>` : '';
    const tiles = ids.map((id) => tileHtml(id, [work?.origRack.has(id) ? 'mine' : '', selected === id ? 'selected' : ''].join(' '))).join('');
    return `<div class="set ${bad ? 'invalid' : ''}" data-set="${i}">${tiles}${why}</div>`;
  }).join('');
}

function shortReason(r) {
  return r.replace(/^.*?: a set needs/, 'Needs').replace(/^.*?: groups need.*$/, 'Not a group or run');
}

function renderRack() {
  const rack = rackTiles();
  const vw = Math.min(window.innerWidth, 600);
  const perRow = rack.length > 21 ? 9 : rack.length > 14 ? 8 : 7; // shrink a little as the rack grows
  $('rackArea').style.setProperty('--tw', `${Math.max(32, Math.min(54, Math.floor((vw - 24 - 6 * (perRow - 1)) / perRow)))}px`);
  const fresh = new Set(prevRack.length ? rack.filter((id) => !prevRack.includes(id)) : []);
  if (work && prevRack.length) fresh.clear();
  $('rack').innerHTML = rack.length
    ? rack.map((id) => tileHtml(id, [selected === id ? 'selected' : '', fresh.has(id) ? 'fresh' : ''].join(' '))).join('')
    : '<div class="rack-empty">All your tiles are on the table. Commit to win!</div>';
  $('rackCount').textContent = `${rack.length} tile${rack.length === 1 ? '' : 's'}`;
  if (!work) prevRack = rack.slice();
}

function renderInfo() {
  const parts = [];
  if (errors.length) {
    parts.push(`<ul class="errors">${errors.map((e) => `<li>${escapeHtml(e.message)}</li>`).join('')}</ul>`);
  } else if (flash) {
    parts.push(`<div class="note">${escapeHtml(flash)}</div>`);
  } else if (selected) {
    const loc = locate(selected);
    const canSplit = work && loc?.zone === 'set' && loc.index > 0;
    parts.push(`<div class="toolbar">
      <span class="note">${work ? 'Tap a spot to move it' : 'Tap a rack spot to move it'}</span>
      ${canSplit ? '<button class="chip" data-act="split">✂ Split here</button>' : ''}
      <button class="chip" data-act="cancel">Cancel</button></div>`);
  } else if (work && !S.hasMelded) {
    const pts = meldPointsFromRack(work.sets, [...work.origRack]);
    const pct = Math.min(100, (pts / INITIAL_MELD_POINTS) * 100);
    parts.push(`<div class="meld"><span>First meld <b>${pts}</b> / ${INITIAL_MELD_POINTS}</span><span class="meter ${pts >= INITIAL_MELD_POINTS ? 'ok' : ''}"><i style="width:${pct}%"></i></span></div>`);
  }
  $('info').innerHTML = parts.join('');
}

function renderTimer() {
  const el = $('timer');
  if (!S || S.phase !== 'playing' || remainingAtReceipt == null) return (el.hidden = true);
  const left = Math.max(0, remainingAtReceipt - (Date.now() - stateAt));
  const s = Math.ceil(left / 1000);
  el.hidden = false;
  el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  el.classList.toggle('low', s <= 10 && isMyTurn());
}
setInterval(renderTimer, 250);

function playersList(extra) {
  return S.players.map((p) => `<li class="${p.id === S.you ? 'me' : ''}"><span class="dot ${S.online?.[p.id] ? 'on' : 'off'}"></span>${escapeHtml(p.name)}<span class="right">${extra(p)}</span></li>`).join('');
}

function renderLobby() {
  work = null;
  prevRack = [];
  show('wait');
  $('waitIcon').className = 'spinner done';
  $('waitTitle').textContent = `You're in, ${nameOf(S.you)}!`;
  const t = S.settings.timer;
  $('waitText').textContent = `Waiting for the table to start the game.${t ? ` Turn timer: ${t / 60} min.` : ''}` +
    (S.settings.strictJokers ? ' Strict joker rule: take a table joker only by swapping in the exact tile.' : ' Jokers on the table can be moved freely.');
  $('waitPlayers').innerHTML = playersList((p) => (p.score ? `${p.score} pts` : ''));
  $('leaveBtn').textContent = 'Leave';
}

function renderOver() {
  work = null;
  prevRack = [];
  show('over');
  const r = S.result;
  const won = r.winnerId === S.you;
  $('overTitle').textContent = won ? 'You won the round! 🎉' : `${nameOf(r.winnerId)} wins the round`;
  const d = r.deltas[S.you] ?? 0;
  $('overText').textContent = `${d > 0 ? '+' : ''}${d} points this round.`;
  $('overScores').innerHTML = playersList((p) => `${p.score} pts`);
}

window.addEventListener('resize', () => render());

// Block pinch-zoom and double-tap zoom (iOS ignores user-scalable=no).
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

initJoin();
