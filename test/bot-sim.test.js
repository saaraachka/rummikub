// Headless all-bot games. Every bot move goes through commitTurn, exactly as
// on the table, so this doubles as a fuzz test of the rule engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, addPlayer, setStrictJokers, startRound, commitTurn, drawTile, currentPlayerId, strictJokersOn } from '../js/game/engine.js';
import { findMove } from '../js/bot/search.js';
import { makeDeck } from '../js/game/tiles.js';

const GAMES = Number(process.env.BOT_SIM_GAMES || 300);
const DECK = [...makeDeck()].sort().join(',');

function assertConserved(s, where) {
  const all = [...s.pool, ...Object.values(s.racks).flat(), ...s.board.flatMap((b) => b.tiles)];
  assert.equal(all.length, 106, `${where}: ${all.length} tiles`);
  assert.equal([...all].sort().join(','), DECK, `${where}: tile set changed`);
}

test(`${GAMES} seeded all-bot games: valid commits, 106 tiles always, every game ends`, () => {
  let commits = 0;
  let draws = 0;
  for (let seed = 1; seed <= GAMES; seed++) {
    let s = createGame();
    const n = 2 + (seed % 3);
    for (let i = 0; i < n; i++) s = addPlayer(s, { id: `b${i}`, name: `Bot ${i}`, bot: (seed + i) % 2 ? 'normal' : 'easy' });
    s = setStrictJokers(s, seed % 2 === 0);
    s = startRound(s, seed);
    assertConserved(s, `seed ${seed} deal`);
    let turns = 0;
    while (s.phase === 'playing') {
      assert.ok(++turns < 2000, `seed ${seed} did not end`);
      const pid = currentPlayerId(s);
      const move = findMove({
        board: s.board.map((b) => b.tiles),
        rack: s.racks[pid],
        hasMelded: s.melded[pid],
        strictJokers: strictJokersOn(s),
        level: s.players.find((p) => p.id === pid).bot,
        budgetMs: 1e9, // deterministic: bounded by search node caps, not the clock
      });
      if (move) {
        const r = commitTurn(s, pid, move.sets);
        assert.equal(r.ok, true, `seed ${seed} turn ${turns}: ${JSON.stringify(r.errors)}`);
        s = r.state;
        commits++;
      } else {
        s = drawTile(s, pid).state;
        draws++;
      }
      assertConserved(s, `seed ${seed} turn ${turns}`);
    }
    assert.equal(s.phase, 'roundOver');
    assert.ok(s.result.winnerId);
  }
  assert.ok(commits > GAMES * 10, `bots should actually play (${commits} commits, ${draws} draws)`);
});
