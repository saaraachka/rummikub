// Tile model. A tile is identified by a short string id:
//   "<color><number><copy>"  e.g. "r7a", "k13b"   (copy is a or b)
//   "Ja", "Jb"                for the two jokers
// Everything else (color, number, value) is derived from the id, so game
// state is just arrays of strings and is trivial to serialize.

export const COLORS = ['black', 'red', 'blue', 'orange'];
const CODE_TO_COLOR = { k: 'black', r: 'red', b: 'blue', o: 'orange' };
const COLOR_TO_CODE = { black: 'k', red: 'r', blue: 'b', orange: 'o' };
export const JOKER_VALUE = 30;
export const MIN_NUMBER = 1;
export const MAX_NUMBER = 13;

const TILE_RE = /^(?:([krbo])(1[0-3]|[1-9])([ab])|J([ab]))$/;

export function isTileId(id) {
  return typeof id === 'string' && TILE_RE.test(id);
}

export function parseTile(id) {
  const m = TILE_RE.exec(id);
  if (!m) throw new Error(`Bad tile id: ${id}`);
  if (m[4]) return { id, joker: true, color: null, num: null };
  return { id, joker: false, color: CODE_TO_COLOR[m[1]], num: Number(m[2]) };
}

export function isJoker(id) {
  return id[0] === 'J';
}

export function tileId(color, num, copy = 'a') {
  return `${COLOR_TO_CODE[color]}${num}${copy}`;
}

/** Points a tile costs when left in a rack. */
export function tileValue(id) {
  const t = parseTile(id);
  return t.joker ? JOKER_VALUE : t.num;
}

export function rackValue(ids) {
  return ids.reduce((s, id) => s + tileValue(id), 0);
}

/** Human label used in error messages, e.g. "red 7" or "joker". */
export function tileLabel(id) {
  const t = parseTile(id);
  return t.joker ? 'joker' : `${t.color} ${t.num}`;
}

/** All 106 tiles, unshuffled. */
export function makeDeck() {
  const ids = [];
  for (const copy of ['a', 'b']) {
    for (const color of COLORS) {
      for (let n = MIN_NUMBER; n <= MAX_NUMBER; n++) ids.push(tileId(color, n, copy));
    }
    ids.push(`J${copy}`);
  }
  return ids;
}

/** Small seedable PRNG so games and tests can be deterministic. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const colorRank = (t) => (t.joker ? 99 : COLORS.indexOf(t.color));
const numRank = (t) => (t.joker ? 99 : t.num);

/** Sort by color, then number. Jokers last. */
export function sortByColor(ids) {
  return ids
    .map(parseTile)
    .sort((a, b) => colorRank(a) - colorRank(b) || numRank(a) - numRank(b) || a.id.localeCompare(b.id))
    .map((t) => t.id);
}

/** Sort by number, then color. Jokers last. */
export function sortByNumber(ids) {
  return ids
    .map(parseTile)
    .sort((a, b) => numRank(a) - numRank(b) || colorRank(a) - colorRank(b) || a.id.localeCompare(b.id))
    .map((t) => t.id);
}
