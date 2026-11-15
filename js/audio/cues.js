// Which sound (and, on phones, which haptic) each game event produces.
// Pure functions over the state snapshots the screens already have, so the
// mapping is unit-tested and bots trigger exactly the same cues as people.
//
// A cue is {sound, delay?, haptic?, flash?}. `sound` names a slot in SOUNDS
// (js/config.js); table cues only use 'table' slots and phone cues only
// 'phone' slots.

import { analyzeSet } from '../game/rules.js';

const newEvent = (prev, next) => {
  const ev = next?.lastEvent;
  return ev && ev.seq !== prev?.lastEvent?.seq ? ev : null;
};

/**
 * Table cues from two consecutive public views (see engine publicView).
 * Nothing on the very first view, so reloading the table is silent.
 */
export function tableCues(prev, next) {
  if (!prev || !next) return [];
  const out = [];

  if (prev.phase === 'lobby' && next.phase === 'lobby') {
    const before = new Set(prev.players.map((p) => p.id));
    const after = new Set(next.players.map((p) => p.id));
    if (next.players.some((p) => !before.has(p.id))) out.push({ sound: 'playerJoin' });
    if (prev.players.some((p) => !after.has(p.id))) out.push({ sound: 'playerLeave' });
  }

  const ev = newEvent(prev, next);
  let lead = false; // did an event sound play (so the turn chime should wait a beat)?
  switch (ev?.type) {
    case 'roundStart':
      out.push({ sound: 'gameStart' });
      return out; // the start fanfare stands in for the first turn chime
    case 'commit':
      out.push({ sound: 'place' });
      lead = true;
      break;
    case 'draw':
    case 'timeout':
    case 'skip':
      if (ev.drew) out.push({ sound: 'draw' });
      lead = !!ev.drew;
      break;
    case 'invalid':
      out.push({ sound: 'invalid' });
      break;
    case 'roundOver':
      // The winning commit and the round end arrive together.
      if (ev.reason === 'out') out.push({ sound: 'place' });
      out.push({ sound: 'roundWon', delay: ev.reason === 'out' ? 250 : 0 });
      return out;
  }

  if (next.phase === 'playing' && next.currentPlayerId && next.turnNumber !== prev.turnNumber) {
    out.push({ sound: 'turnStart', delay: lead ? 450 : 0 });
  }
  return out;
}

/** Table: the 10-seconds-left warning, once, as the countdown crosses the line. */
export function timerCue(prevLeftMs, leftMs, thresholdMs = 10000) {
  return prevLeftMs > thresholdMs && leftMs <= thresholdMs && leftMs > 0 ? [{ sound: 'timerWarning' }] : [];
}

/**
 * Phone cues from two consecutive player views (engine playerView). Only
 * things that concern this player: their turn starting, their own draw, and
 * the end of the round. Other players' moves are silent on your phone.
 */
export function phoneCues(prev, next) {
  if (!prev || !next) return [];
  const me = next.you;
  const out = [];
  const ev = newEvent(prev, next);

  if ((ev?.type === 'draw' || ev?.type === 'timeout' || ev?.type === 'skip') && ev.playerId === me && ev.drew) {
    out.push({ sound: 'drew', haptic: 'tick' });
  }
  if (next.phase === 'roundOver' && prev.phase !== 'roundOver') {
    const won = next.result?.winnerId === me;
    out.push(won ? { sound: 'won', haptic: 'double' } : { sound: 'roundOver' });
    return out;
  }
  const myTurnNow = next.phase === 'playing' && next.currentPlayerId === me;
  const myTurnBefore = prev.phase === 'playing' && prev.currentPlayerId === me && prev.turnNumber === next.turnNumber;
  if (myTurnNow && !myTurnBefore) out.push({ sound: 'yourTurn', haptic: 'turn', flash: true, delay: out.length ? 300 : 0 });
  return out;
}

/** Phone: the table's answer to your commit. */
export function commitCue(ok) {
  return ok ? { sound: 'commitOk', haptic: 'double' } : { sound: 'commitError', haptic: 'triple' };
}

/** Phone: you picked up (or selected) a tile. */
export const pickupCue = () => ({ sound: 'pickup', haptic: 'tick' });

/**
 * Phone: you dropped a tile and the working board changed from `before` to
 * `after` (arrays of tile-id arrays). A set that just became valid "snaps";
 * a set that was valid and now isn't gets a subtle warning; otherwise a plain drop.
 */
export function editCue(before, after) {
  const key = (s) => [...s].sort().join(',');
  const validKeys = (sets) => new Set(sets.filter((s) => s.length && analyzeSet(s).valid).map(key));
  const invalidCount = (sets) => sets.filter((s) => s.length && !analyzeSet(s).valid).length;
  const vb = validKeys(before);
  const va = validKeys(after);
  if ([...va].some((k) => !vb.has(k))) return { sound: 'snap', haptic: 'tick' };
  if ([...vb].some((k) => !va.has(k)) && invalidCount(after) > invalidCount(before)) return { sound: 'setInvalid', haptic: 'tick' };
  return { sound: 'drop', haptic: 'tick' };
}
