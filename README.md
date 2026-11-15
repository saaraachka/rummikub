# Tile Rummy

A tile-rummy game for playing in person. One shared screen is the **table** (an iPad in Safari, AirPlayed to a TV, or any laptop), and each player uses their **phone** as a private controller for their rack. It is a fully static site: plain HTML, CSS and JavaScript with no build step, no backend you run, and no accounts.

The game uses the standard 106-tile rummy rules (numbers 1–13 in four colors, two of each, plus two jokers). It ships under the generic name "Tile Rummy" with its own visual design; to call it something else, change `APP_NAME` in `js/config.js` and the `<title>`/heading text in the HTML files.

## How a game goes

1. Open `/table/` on the iPad. It shows a 4-letter room code and a QR code.
2. Everyone scans the QR code (or opens `/play/` and types the code) and enters a name.
   While the phone connects, a status line under the Join button says what's happening: "Connecting to room ABCD…", "Connected", or what to fix if it can't get through (wrong code, no internet, or "Couldn't reach the table — try joining the same Wi-Fi as the table").
3. Short on people? Tap **＋ Add bot** on the table for a computer player (see [Bots](#bots)). A game can start with one person and bots.
4. Pick a turn timer (off, 1 minute or 2 minutes), choose whether the **strict joker rule** is on (it is by default), and tap **Start game** on the table.
5. On your turn your phone turns yellow. Drag tiles (or tap a tile, then tap where it should go) from your rack onto the board, rearrange existing sets, then tap **Commit**. **Reset** puts everything back the way it was at the start of your turn. **Draw** takes a tile and ends your turn.
6. The table validates the move. If something is wrong your phone explains why ("Run 4-5-7 (red) isn't consecutive", "Your first meld totals 24 points; it needs at least 30") and you keep editing. The table also shows the message so everyone knows what happened.
7. The first player to empty their rack wins the round. The table shows the scores and a **Next round** button; scores carry over until someone taps **Back to lobby**.

The table never shows anyone's tiles, only how many each player holds.

### Rules as implemented

- **Sets.** A group is 3–4 tiles of one number in different colors. A run is 3+ consecutive numbers in one color; 1 does not follow 13.
- **Jokers** stand in for any tile. In a run, where you place a joker decides what it stands for: `J 4 5` makes the joker a 3, `4 5 J` makes it a 6. If the tiles aren't laid out in order, the game sorts them, fills gaps with jokers first, and puts leftover jokers on the high end (or the low end if the run already reaches 13). When a set like `7 J J` could be read as either a group or a run, it takes whichever reading scores more.
- **Initial meld.** Your first play must be worth at least 30 points using only tiles from your rack, and you can't touch the sets already on the table in that turn. Jokers count as the tile they represent.
- **After melding** you can rearrange anything on the table, as long as every set is valid when you commit and you've added at least one tile from your rack. Tiles that were on the table can't go back to your rack.
- **Taking a joker from the table (strict joker rule, on by default).** You can only take a joker that's already on the table by playing, from your rack, the exact tile it stands for. If the joker is in a group of 3, either of the two missing colors will do; in a group of 4 it's the one missing color. The joker you take must be played in a new or existing set in the same turn (it can never go into your rack), and you can't take jokers at all before your initial meld. A joker that keeps standing for the same tile can still move, so splitting a run or adding to a set that contains a joker is fine. The table checks all of this when you commit and explains what's wrong, for example "To take the joker that stands for black 6, you must play a black 6 from your rack in its place" or "The joker you took from the table must be played in a set this turn".
- **Loose joker rule (lobby toggle off).** Jokers on the table can be moved like any other tile, as long as every set is valid at the end of the turn. Many home games play this way.
- **Drawing.** If you can't or won't play, draw one tile and your turn ends. If the timer runs out, you draw one tile and any unfinished changes are discarded.
- **Empty pool.** Once there's nothing left to draw, "Draw" becomes "Pass". If every player passes in a row, the round ends and the lowest rack value wins.
- **Scoring.** Each loser subtracts the value of the tiles left in their rack (joker = 30). The winner gains the sum of those amounts.
- **Absent players.** If the current player's phone is disconnected, the table shows a **Skip turn** button on their card (they draw a tile, as if they had drawn).

## Bots

Computer players fill empty seats so you can play, or test, with fewer than four people.

- **Adding them.** In the table lobby, tap **＋ Add bot**. Each bot takes a seat like a person does (2–4 seats in total, people and bots combined), so one person plus one to three bots is a full game. Each bot row has an **Easy / Normal** switch and an **✕** to remove it. Bots are called "Robo Ada", "Robo Bix" and so on, with a robot icon in place of the connection dot everywhere they appear (table, phones, score table), so nobody mistakes a bot for a person whose phone has disconnected.
- **Easy** makes its first meld from rack-only sets worth 30+. After that it plays new sets from its rack and adds single tiles to the ends of runs or into groups. It never rearranges the table, and draws when it can't play.
- **Normal** does everything Easy does, and also rearranges the table. It splits a run to insert a tile (3-4-5-6-7 plus a 5 becomes 3-4-5 and 5-6-7). It also takes a tile off a group of four, the end of a run, or the middle of a long run, to complete a new set with tiles from its rack. Among the moves it finds, it plays the one that gets rid of the most points from its rack. In 300 seeded head-to-head games Normal beat Easy 281 times.
- **Jokers.** Bots play jokers from their own rack, but never take jokers off the table, whichever joker rule is active. A joker that's already on the table keeps standing for the same tile.
- **Same rules as everyone.** Bots run on the table, not on phones. A bot's move goes through exactly the same commit and validation code as a phone's move, so bots never get a shortcut, and an invalid bot move would show up as the usual red "move didn't work" banner. Bots also obey the turn timer and the empty-pool ending.
- **Thinking.** The move search runs in a Web Worker, so the table never freezes. It stops after 1.5 seconds and plays the best move it found so far, or draws. If the worker doesn't answer within about 2.2 seconds, the table restarts it and the bot draws. The table shows "Robo Ada is thinking…" for a second or two before each bot move, then animates the move like a person's.

### Watch mode (all bots)

Open the table with `?bots=N` (N = 2–4), for example `…/table/?bots=4`, to watch an all-bot game play out. The game starts at once and a new round begins automatically six seconds after each one ends. Watch mode doesn't open a room or touch the saved game, so it works offline and won't disturb a real game on the same iPad. Extra flags:

- `level=easy` or `level=normal` (default: alternating Normal and Easy)
- `think=300` sets the pause before each bot move in milliseconds (default: 1–2 seconds)
- `jokers=loose` turns the strict joker rule off

`think=…` also works on a normal table, for example to make bots snappier while you test with one phone.

## Sound and haptics

The table plays sounds through the iPad (and so the TV over AirPlay). Each phone plays only the sounds that concern its player, plus haptics.

- **Turning sound on.** Browsers, iOS especially, keep audio locked until someone taps. On the table, the first tap anywhere enables sound (Start game counts), and the bottom-right corner shows **Tap to enable sound** until then. On phones, the Join button enables it, and after a refresh any first tap does. On Safari versions that support it, the game asks to be treated as media playback (`navigator.audioSession.type = "playback"`), so sounds play even with the iPhone's silent switch on.
- **Controls.** The table has a mute button and a volume slider in the bottom-right corner. Phones have sound and vibration toggles in the top bar and in the lobby. All of these are remembered on each device.
- **Haptics.** Android uses `navigator.vibrate()`. On iPhone (Safari 17.4+) the game uses the hidden `<input type="checkbox" switch>` trick, which fires the system haptic tick. iOS may only allow that during a tap, so the "your turn" buzz is a bonus there. The game doesn't rely on it: the phone also plays the turn sound, flashes the whole screen yellow, and shows a big "Your turn" banner, which works even when muted. Devices with neither just skip haptics silently.
  - Picking up or dropping a tile: a short tick
  - Commit accepted: a double pulse
  - Commit rejected: a triple pulse
  - Your turn: a longer pattern

### Using your own samples

Every sound is a separate short file in `/sounds`, listed once in the `SOUNDS` manifest in `js/config.js`. To swap one, replace the file, or drop in a new file and point the slot's `file` at it. Each slot also has a `volume` (0–1, applied before the table's master volume), and two slots can share one file. mp3, m4a/AAC and wav all work everywhere; avoid ogg, which Safari can't decode. Trim the start tight, since sounds fire the instant the event happens.

If a file is missing or can't be decoded, that slot quietly falls back to a built-in synthesized placeholder (`js/audio/synth.js`), so a typo never silences the game. The files currently in `/sounds` were rendered from those same recipes by `npm run sounds`. That command only fills in missing files; `node scripts/make-sounds.js --force` re-renders all of them, and would overwrite your samples. To check that your files are being used rather than the fallback, tap to enable sound on the table, then run `__sounds.sources()` in the browser console; it lists `file` or `synth` for each table slot.

| Slot | File | Where | Plays when | Intended feel |
|---|---|---|---|---|
| `gameStart` | `game-start.mp3` | table | a round is dealt | Short, bright "let's go" flourish, under a second |
| `turnStart` | `turn-start.mp3` | table | a new turn begins (human or bot) | Friendly two-note chime, clearly different from everything else; you'll hear it every turn, so keep it gentle |
| `place` | `place.mp3` | table | a turn is committed (tiles placed) | Tactile clack of tiles on a table; short and satisfying |
| `draw` | `draw.mp3` | table | a player draws (or times out and draws) | Soft slide/swish of a tile off the pile |
| `invalid` | `invalid.mp3` | table | the table rejects a move | Gentle "nope", two descending notes; noticeable, not harsh |
| `roundWon` | `round-won.mp3` | table | someone goes out / wins the round | Celebratory, 1–1.5 s, the biggest sound in the game |
| `timerWarning` | `timer-warning.mp3` | table | 10 seconds left on the turn timer | Two quick ticks, urgent but not alarming |
| `playerJoin` | `player-join.mp3` | table | someone (or a bot) joins the lobby | Quick upward blip |
| `playerLeave` | `player-leave.mp3` | table | someone leaves the lobby | Quick downward blip, softer than join |
| `yourTurn` | `your-turn.mp3` | phone | it becomes your turn | The most important sound: bright, distinct, audible from a pocket; under a second |
| `pickup` | `pickup.mp3` | phone | you pick up or select a tile | Tiny, high, almost subliminal tick |
| `drop` | `drop.mp3` | phone | you drop a tile somewhere | Soft low click |
| `snap` | `snap.mp3` | phone | a drop completes a valid set | Click plus a short pleasant tone: "that fits" |
| `setInvalid` | `set-invalid.mp3` | phone | a drop breaks a valid set | Subtle low thud; a hint, not a scold |
| `commitOk` | `commit-ok.mp3` | phone | the table accepts your turn | Upbeat two-note confirmation |
| `commitError` | `commit-error.mp3` | phone | the table rejects your turn | Low two-note buzz, clearly "try again" |
| `drew` | `drew.mp3` | phone | you drew a tile | Soft swish with a little sparkle |
| `won` | `won.mp3` | phone | you won the round | Celebration; can share a file with `roundWon` |
| `roundOver` | `round-over.mp3` | phone | someone else won the round | Gentle descending "that's the round" |

Which event triggers which sound is decided in `js/audio/cues.js` (pure, unit-tested). Bots trigger exactly the same table sounds as people.

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
npm test            # rules, engine, bot, sound/haptics and connection tests, plus a 300-game bot simulation (~30 s)
npm run sounds      # render any missing files in /sounds from the built-in placeholder recipes
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

- `test/browser/peer-mock.html` (open it through the dev server) runs the networking module over the PeerJS transport against an in-memory fake of PeerJS and prints PASS/FAIL lines. It checks join, messaging both ways, rejoin with the same id, rejection, that a room code in use isn't stolen, that the STUN/TURN list from `js/config.js` reaches PeerJS, and that failures are classified correctly for the phone's status line.
- Useful URL flags on the table: `fresh=1` ignores the saved game, `code=ABCD` asks for a specific room code, and `bots=4` starts watch mode (see [Bots](#bots)). On any page, `relay=1` forces all traffic through TURN (see below).
- `test/bot-sim.test.js` plays several hundred seeded all-bot games headlessly through the real engine. It asserts that every bot commit passes validation, that all 106 tiles are accounted for after every turn, and that every game ends. Set `BOT_SIM_GAMES=2000 npm test` for a longer soak.

## How it works

```
index.html            landing page
table/  play/         the two entry points
dev.html              offline test bench
js/config.js          game name, app id, WebRTC STUN/TURN servers, and the sound manifest
js/game/tiles.js      tile ids, deck, shuffle, sorting           (pure)
js/game/rules.js      set analysis, joker handling, turn check   (pure)
js/game/engine.js     state machine: deal, commit, draw, score   (pure)
js/net/room.js        reusable host/client room layer
js/net/transports.js  PeerJS transport and offline BroadcastChannel transport
js/table/main.js      host controller and table rendering
js/play/main.js       phone controller: rack, working board, drag and tap
js/play/diagnose.js   connection status -> the message on the phone's join screen (pure)
js/bot/search.js      bot move search: set packing, table moves, Easy/Normal (pure)
js/bot/worker.js      Web Worker wrapper for the search
js/bot/runner.js      table-side runner with the hard time limit
js/audio/cues.js      which event plays which sound / haptic, table vs phone (pure)
js/audio/player.js    Web Audio playback: preloaded buffers, mute/volume, iOS unlock, synth fallback
js/audio/synth.js     placeholder sound recipes (also used to render /sounds)
js/ui/haptics.js      vibrate() / iOS switch haptics, feature-detected
sounds/               one short file per sound slot (see "Sound and haptics")
scripts/make-sounds.js  renders missing sound files from the synth recipes
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

Clients reconnect with backoff, immediately when the page becomes visible again, and whenever the host goes quiet for 10 seconds; both sides heartbeat every 3 seconds, which is what lets the table show a player as offline promptly. Pass `transport: localTransport()` for offline development, or `transport: peerTransport({ host, port, config: { iceServers } })` to use your own PeerJS server or TURN servers (this game builds those options with `peerOptions()` from `js/config.js`). Status changes after a failure carry `{ error, attempt }`, where `error` is one of `not-found`, `broker-unreachable`, `p2p-failed`, `lost`, `no-welcome` or `unsupported`; `js/play/diagnose.js` shows one way to turn that into a message for players.

## Connection reliability: STUN and TURN

Phones talk to the table directly over WebRTC. To find each other, devices ask a STUN server for their public address; the default is Google's free public STUN server (`stun.l.google.com:19302`), and on ordinary home Wi-Fi that's all you need.

Some networks block direct device-to-device traffic: guest Wi-Fi with "client isolation", many office and school networks, and some mobile carriers if a phone is on cellular data. A **TURN** server fixes this by relaying the traffic. The app already lists PeerJS's shared community TURN servers as a best-effort fallback, but for reliable play on tricky networks add your own:

1. Sign up for a free TURN service, for example [Metered](https://www.metered.ca/) or [ExpressTURN](https://www.expressturn.com/). Game messages are tiny, so a free tier is plenty.
2. Open `js/config.js`, uncomment the `MY_TURN` entry, and paste in the `turn:`/`turns:` URLs, username and credential from the provider's dashboard.
3. Commit and push. GitHub Pages serves the update within a minute or so.
4. To confirm it works, open the table with `?relay=1` (for example `…/table/?relay=1`). The QR code carries the flag to the phones, and every connection is forced through TURN, so if the phones still connect your relay is set up correctly. Drop the flag for normal play.

Because this is a static site, anything in `js/config.js` is visible to anyone who opens the page. Use a free or capped account rather than one billed per gigabyte, and rotate the credential if you ever see usage you don't recognize.

When a phone can't get through, its join screen tells the player why instead of spinning forever: no table with that code, no internet connection, the table turned it away (the game already started or the table is full), or "Couldn't reach the table — try joining the same Wi-Fi as the table" when the direct connection fails. If the link drops mid-game, the same message replaces the "Reconnecting…" banner once it's clear something is wrong.

## Troubleshooting

- **"Couldn't reach the table — try joining the same Wi-Fi as the table".** The phone found the room but couldn't open a direct connection. Put the phone on the same Wi-Fi as the iPad (not cellular data). If everyone already is, the network probably isolates devices from each other; try a home network or a phone hotspot, or add a TURN server (see above).
- **"No table found for room …".** The code is wrong, or the table page isn't open (or was reloaded and got a new code). Check the code on the TV.
- **"Can't reach the internet".** The phone can't reach the PeerJS connection server. Check its Wi-Fi or mobile data.
- **"Couldn't open the room".** The table needs to reach the free public PeerJS broker (`0.peerjs.com`) to register the room code. Check the iPad's internet connection. Once everyone has joined, play continues over the direct connections even if the broker hiccups.
- **The iPad goes to sleep.** The table asks for a screen wake lock when the game starts (Safari 16.4+). If your iPad still dims, set Settings → Display & Brightness → Auto-Lock to Never while you play.
- **Someone's phone died.** Their seat and rack are kept. They can rejoin by opening the join link again in the same browser on the same phone; on a different device they would be a new player, so use **Skip turn** on the table until the round ends.
