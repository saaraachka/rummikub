# Tile Rummy

A tile-rummy game for playing in person. One shared screen is the **table** (an iPad in Safari, AirPlayed to a TV, or any laptop), and each player uses their **phone** as a private controller for their rack. It is a fully static site: plain HTML, CSS and JavaScript with no build step, no backend you run, and no accounts.

The game uses the standard 106-tile rummy rules (numbers 1–13 in four colors, two of each, plus two jokers). It ships under the generic name "Tile Rummy" with its own visual design; to call it something else, change `APP_NAME` in `js/config.js` and the `<title>`/heading text in the HTML files.

## How a game goes

1. Open `/table/` on the iPad. It shows a 4-letter room code and a QR code.
2. Everyone scans the QR code (or opens `/play/` and types the code) and enters a name.
3. Pick a turn timer (off, 1 minute or 2 minutes) and tap **Start game** on the table.
4. On your turn your phone turns yellow. Drag tiles (or tap a tile, then tap where it should go) from your rack onto the board, rearrange existing sets, then tap **Commit**. **Reset** puts everything back the way it was at the start of your turn. **Draw** takes a tile and ends your turn.
5. The table validates the move. If something is wrong your phone explains why ("Run 4-5-7 (red) isn't consecutive", "Your first meld totals 24 points; it needs at least 30") and you keep editing. The table also shows the message so everyone knows what happened.
6. The first player to empty their rack wins the round. The table shows the scores and a **Next round** button; scores carry over until someone taps **Back to lobby**.

The table never shows anyone's tiles, only how many each player holds.

### Rules as implemented

- **Sets.** A group is 3–4 tiles of one number in different colors. A run is 3+ consecutive numbers in one color; 1 does not follow 13.
- **Jokers** stand in for any tile. In a run, where you place a joker decides what it stands for: `J 4 5` makes the joker a 3, `4 5 J` makes it a 6. If the tiles aren't laid out in order, the game sorts them, fills gaps with jokers first, and puts leftover jokers on the high end (or the low end if the run already reaches 13). When a set like `7 J J` could be read as either a group or a run, it takes whichever reading scores more.
- **Initial meld.** Your first play must be worth at least 30 points using only tiles from your rack, and you can't touch the sets already on the table in that turn. Jokers count as the tile they represent.
- **After melding** you can rearrange anything on the table, as long as every set is valid when you commit and you've added at least one tile from your rack. Tiles that were on the table can't go back to your rack. Jokers on the table can be moved like any other tile under that same rule (this is slightly looser than the official joker-retrieval rule, which most home games play anyway).
- **Drawing.** If you can't or won't play, draw one tile and your turn ends. If the timer runs out, you draw one tile and any unfinished changes are discarded.
- **Empty pool.** Once there's nothing left to draw, "Draw" becomes "Pass". If every player passes in a row, the round ends and the lowest rack value wins.
- **Scoring.** Each loser subtracts the value of the tiles left in their rack (joker = 30). The winner gains the sum of those amounts.
- **Absent players.** If the current player's phone is disconnected, the table shows a **Skip turn** button on their card (they draw a tile, as if they had drawn).

## Deploying to GitHub Pages

The repository root is the site, so there is nothing to build.

1. Push this repository to GitHub.
2. On GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch", choose your branch (for example `main`) and the `/ (root)` folder, and save.
4. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`. The table is at `…/table/` and phones join at `…/play/` (the QR code on the table links there automatically, with the room code filled in).

All paths are relative, so it works under any repository name or a custom domain. The empty `.nojekyll` file tells Pages to serve the files as-is.

## Testing locally

You need Node.js 18 or newer. There are no dependencies to install.

```sh
npm test            # rule and engine unit tests (node:test)
npm run serve       # static server on http://localhost:8080 (any port: node scripts/serve.js 3000)
```

### One-page test bench (no network needed)

Open **http://localhost:8080/dev.html**. It shows the table and 2–4 phones side by side, already joined, using the room code `TEST`. Instead of WebRTC they talk over `BroadcastChannel`, which only works between tabs of the same browser, so you can play a whole game offline. "Restart everything" clears all saved state.

### Several browser tabs as phones

Any page accepts `?net=local` to use the same offline channel, and `slot=N` to give each tab its own identity (tabs of one browser otherwise share localStorage and would all be the same player):

- Table: `http://localhost:8080/table/?net=local`
- Phone 1: `http://localhost:8080/play/?net=local&room=CODE&slot=1`
- Phone 2: `http://localhost:8080/play/?net=local&room=CODE&slot=2`

Drop `net=local` to test the real PeerJS path between tabs (internet required). Keep `slot` for each phone tab.

### Real phones on your Wi-Fi

`npm run serve` listens on all interfaces and prints your LAN address. Open `http://<that-address>:8080/table/` on the iPad and scan the QR code with the phones. This uses the real PeerJS broker, so the devices need internet access as well as the shared Wi-Fi.

### Other checks

- `test/browser/peer-mock.html` (open it through the dev server) runs the networking module over the PeerJS transport against an in-memory fake of PeerJS and prints PASS/FAIL lines. It checks join, messaging both ways, rejoin with the same id, rejection, and that a room code in use isn't stolen.
- Useful URL flags on the table: `fresh=1` ignores the saved game, `code=ABCD` asks for a specific room code.

## How it works

```
index.html            landing page
table/  play/         the two entry points
dev.html              offline test bench
js/config.js          game name and app id (namespaces PeerJS ids and storage)
js/game/tiles.js      tile ids, deck, shuffle, sorting           (pure)
js/game/rules.js      set analysis, joker handling, turn check   (pure)
js/game/engine.js     state machine: deal, commit, draw, score   (pure)
js/net/room.js        reusable host/client room layer
js/net/transports.js  PeerJS transport and offline BroadcastChannel transport
js/table/main.js      host controller and table rendering
js/play/main.js       phone controller: rack, working board, drag and tap
js/ui/tile-view.js    tile markup shared by both screens
vendor/               PeerJS 1.5.5 and qrcode-generator 2.0.4 (both MIT)
test/                 unit tests and the browser check page
```

**The table is the authority.** It holds the whole game state, runs every move through the pure engine, and after each change sends every phone a full snapshot: the public view (board, tile counts, whose turn, timer) plus that phone's own rack. Phones never receive anyone else's tiles. During your turn the phone edits a private working copy of the board and validates it live with the same rule code, which is how it can outline invalid sets in red before you commit; the table re-checks everything on commit.

**Tiles are short string ids** (`r7a` is the first red 7, `Jb` the second joker), so state is plain JSON and easy to inspect, save and send.

**Persistence.** The table saves the game to localStorage after every change. If the iPad reloads, it reclaims the same room code and the phones reconnect on their own. Each phone stores a random client token per room, so a refresh, a locked screen or a dropped Wi-Fi connection brings it back to the same seat with the same rack.

### Reusing the networking layer

`js/net/room.js` knows nothing about tile rummy. For another TV-plus-phones game:

```js
import { hostRoom, joinRoom } from './net/room.js';

// On the big screen
const room = await hostRoom({
  appId: 'my-quiz',                       // keeps rooms of different games apart
  accept: (clientId, hello) => true,      // or return a string to refuse with that reason
});
room.code;                                // "KXQT"
room.on('join', (clientId, hello, { rejoin }) => {});
room.on('leave', (clientId) => {});       // link lost; the client may come back
room.on('message', (clientId, msg) => {});
room.send(clientId, msg);
room.broadcast(msg);
room.isConnected(clientId);

// On a phone
const conn = joinRoom({ appId: 'my-quiz', code: 'KXQT', hello: { name: 'Ana' } });
conn.on('status', (s, detail) => {});     // connecting | connected | reconnecting | not-found | rejected
conn.on('message', (msg) => {});
conn.send(msg);
```

Clients reconnect with backoff, immediately when the page becomes visible again, and whenever the host goes quiet for 10 seconds; both sides heartbeat every 3 seconds, which is what lets the table show a player as offline promptly. Pass `transport: localTransport()` for offline development, or `transport: peerTransport({ host, port, config: { iceServers } })` to use your own PeerJS server or TURN servers.

## Troubleshooting

- **Phones can't connect even though the code is right.** WebRTC between devices on the same Wi-Fi almost always works, but some guest or corporate networks block peer-to-peer traffic. Try a home network or a phone hotspot. If you need to get through strict networks, add a TURN server via `peerTransport({ config: { iceServers: [...] } })` in `js/net/transports.js`.
- **"Couldn't open the room".** The table needs to reach the free public PeerJS broker (`0.peerjs.com`) to register the room code. Check the iPad's internet connection. Once everyone has joined, play continues over the direct connections even if the broker hiccups.
- **The iPad goes to sleep.** The table asks for a screen wake lock when the game starts (Safari 16.4+). If your iPad still dims, set Settings → Display & Brightness → Auto-Lock to Never while you play.
- **Someone's phone died.** Their seat and rack are kept. They can rejoin by opening the join link again in the same browser on the same phone; on a different device they would be a new player, so use **Skip turn** on the table until the round ends.
