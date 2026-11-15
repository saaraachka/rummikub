// Change APP_NAME to rename the game everywhere it is shown in script.
// APP_ID namespaces PeerJS ids and localStorage keys; change it if you fork
// this into a different game so rooms never collide.
export const APP_NAME = 'Tile Rummy';
export const APP_ID = 'tilerummy';

// ---------------------------------------------------------------- WebRTC
//
// How phones reach the table. WebRTC first tries a direct connection; STUN
// servers help devices discover their public address, which is all you need
// on most home Wi-Fi. Some networks (guest Wi-Fi with "client isolation",
// corporate or school networks, some mobile carriers) block direct
// peer-to-peer traffic. A TURN server fixes that by relaying the traffic.
// Game messages are tiny, so a free tier is plenty for casual play.
//
// To add your own TURN server:
//   1. Sign up for a free TURN service, for example Metered (metered.ca) or
//      ExpressTURN (expressturn.com). Their dashboard shows one or more
//      "turn:" / "turns:" URLs plus a username and a credential (password).
//   2. Uncomment the MY_TURN block below and paste those values in.
//   3. Commit and push; GitHub Pages picks it up in a minute.
//
// Note: this is a static site, so anything here is visible to anyone who
// opens the page. Use a free/limited account (not one tied to a paid plan
// without a cap), and rotate the credential if you ever see unexpected usage.
//
// To check that your TURN entry really works, open the table and phones with
// ?relay=1 in the URL: that forces every connection through TURN, so if they
// still connect, the relay is set up correctly.

const MY_TURN = [
  // {
  //   urls: ['turn:YOUR-TURN-HOST:80', 'turn:YOUR-TURN-HOST:443', 'turns:YOUR-TURN-HOST:443?transport=tcp'],
  //   username: 'YOUR-USERNAME',
  //   credential: 'YOUR-CREDENTIAL',
  // },
];

export const ICE_SERVERS = [
  // Google's public STUN server (the default; no account needed).
  { urls: 'stun:stun.l.google.com:19302' },
  // Your TURN server(s), if any. WebRTC gathers candidates from every entry
  // and uses whichever path works, so extra servers only add options.
  ...MY_TURN,
  // PeerJS's community TURN servers. This is what PeerJS uses when you don't
  // configure anything; it's best-effort and shared, so keep it only as a
  // fallback behind your own TURN server.
  {
    urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
    username: 'peerjs',
    credential: 'peerjsp',
  },
];

/** Options passed to `new Peer()`. `?relay=1` forces TURN for testing. */
export function peerOptions(search = location.search) {
  const relayOnly = new URLSearchParams(search).get('relay') === '1';
  return {
    config: {
      iceServers: ICE_SERVERS,
      ...(relayOnly ? { iceTransportPolicy: 'relay' } : {}),
    },
  };
}

// ---------------------------------------------------------------- Sounds
//
// Every sound the game makes. To use your own sample, drop a file into
// /sounds and point the slot's `file` at it (mp3, m4a/aac, wav and ogg all
// work in modern browsers; Safari can't decode ogg, so prefer mp3, m4a or wav).
// Two slots can share one file. `volume` is 0–1, applied before the master volume.
// If a file is missing or can't be decoded, the game falls back to a built-in
// synthesized placeholder (js/audio/synth.js) for that slot, so nothing breaks.
// Keep samples short and trimmed tight at the start: they're played the
// instant the event happens. The README describes the intended feel of each slot.
//
// `where` says which screen plays it: 'table' (iPad/TV) or 'phone' (only the
// player it concerns).

/** Sound file paths above are relative to the site root (the folder holding index.html). */
export const SITE_ROOT = new URL('../', import.meta.url).href;

export const SOUNDS = {
  // Table
  gameStart:    { where: 'table', file: 'sounds/game-start.mp3',    volume: 0.8 },
  turnStart:    { where: 'table', file: 'sounds/turn-start.mp3',    volume: 0.7 },
  place:        { where: 'table', file: 'sounds/place.mp3',         volume: 0.9 },
  draw:         { where: 'table', file: 'sounds/draw.mp3',          volume: 0.7 },
  invalid:      { where: 'table', file: 'sounds/invalid.mp3',       volume: 0.7 },
  roundWon:     { where: 'table', file: 'sounds/round-won.mp3',     volume: 0.9 },
  playerOut:    { where: 'table', file: 'sounds/player-out.mp3',    volume: 0.85 },
  timerWarning: { where: 'table', file: 'sounds/timer-warning.mp3', volume: 0.7 },
  playerJoin:   { where: 'table', file: 'sounds/player-join.mp3',   volume: 0.6 },
  playerLeave:  { where: 'table', file: 'sounds/player-leave.mp3',  volume: 0.5 },
  // Phone
  yourTurn:     { where: 'phone', file: 'sounds/your-turn.mp3',     volume: 1.0 },
  pickup:       { where: 'phone', file: 'sounds/pickup.mp3',        volume: 0.5 },
  drop:         { where: 'phone', file: 'sounds/drop.mp3',          volume: 0.6 },
  snap:         { where: 'phone', file: 'sounds/snap.mp3',          volume: 0.7 },
  setInvalid:   { where: 'phone', file: 'sounds/set-invalid.mp3',   volume: 0.4 },
  commitOk:     { where: 'phone', file: 'sounds/commit-ok.mp3',     volume: 0.8 },
  commitError:  { where: 'phone', file: 'sounds/commit-error.mp3',  volume: 0.7 },
  drew:         { where: 'phone', file: 'sounds/drew.mp3',          volume: 0.6 },
  won:          { where: 'phone', file: 'sounds/won.mp3',           volume: 0.9 },
  roundOver:    { where: 'phone', file: 'sounds/round-over.mp3',    volume: 0.7 },
};
