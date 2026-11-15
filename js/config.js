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
