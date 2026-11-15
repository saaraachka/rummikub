// DOM for a single tile, shared by the table and phone screens.
// Each color has a shape mark so color is never the only cue:
//   black ● circle   red ▲ triangle   blue ■ square   orange ◆ diamond

import { parseTile } from '../game/tiles.js';

const SHAPES = {
  black: '<circle cx="10" cy="10" r="8"/>',
  red: '<path d="M10 1.5 19 18H1z"/>',
  blue: '<rect x="2.5" y="2.5" width="15" height="15" rx="1.5"/>',
  orange: '<path d="M10 0.5 19.5 10 10 19.5 0.5 10z"/>',
};

const JOKER_FACE = `<svg class="joker-face" viewBox="0 0 40 40" aria-hidden="true">
  <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-width="3.5"/>
  <circle cx="14" cy="16" r="2.8" fill="currentColor"/><circle cx="26" cy="16" r="2.8" fill="currentColor"/>
  <path d="M11.5 23.5q8.5 9 17 0" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>
</svg>`;

export function shapeSvg(color) {
  return `<svg class="mark" viewBox="0 0 20 20" aria-hidden="true">${SHAPES[color]}</svg>`;
}

export function tileHtml(id, extraClass = '') {
  const t = parseTile(id);
  if (t.joker) {
    return `<div class="tile joker ${extraClass}" data-id="${id}" aria-label="joker">${JOKER_FACE}</div>`;
  }
  return `<div class="tile c-${t.color} ${extraClass}" data-id="${id}" aria-label="${t.color} ${t.num}">` +
    `<span class="num">${t.num}</span>${shapeSvg(t.color)}</div>`;
}

export function tileEl(id, extraClass = '') {
  const tpl = document.createElement('template');
  tpl.innerHTML = tileHtml(id, extraClass).trim();
  return tpl.content.firstElementChild;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Small robot head used everywhere a bot is named. */
export const BOT_ICON = `<svg class="bot-icon" viewBox="0 0 24 24" aria-label="bot" role="img">
  <rect x="11" y="1.5" width="2" height="4" rx="1" fill="currentColor"/><circle cx="12" cy="2" r="1.8" fill="currentColor"/>
  <rect x="3.5" y="6" width="17" height="14" rx="4" fill="currentColor"/>
  <circle cx="9" cy="12.5" r="2.1" fill="var(--bot-eye, #0f3b3a)"/><circle cx="15" cy="12.5" r="2.1" fill="var(--bot-eye, #0f3b3a)"/>
  <rect x="8.5" y="16" width="7" height="1.6" rx=".8" fill="var(--bot-eye, #0f3b3a)"/>
  <rect x="1" y="10.5" width="2" height="5" rx="1" fill="currentColor"/><rect x="21" y="10.5" width="2" height="5" rx="1" fill="currentColor"/>
</svg>`;
