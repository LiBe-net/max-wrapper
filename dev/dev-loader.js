/**
 * Dev loader for Maximize Wrapper Card – not part of the released card.
 *
 * Loads the unminified max-wrapper.js from this repository under separate
 * tags, so a development version runs side by side with the release
 * installed from HACS on the same Home Assistant instance:
 *
 *   custom:maximize-wrapper-card       → installed release
 *   custom:maximize-wrapper-card-dev   → this working copy
 *
 * The source is fetched without cache on every page load, so after editing
 * max-wrapper.js a browser reload is enough (no ?v= bump, no build).
 *
 * The tags are string literals in max-wrapper.js (verify-build.mjs checks
 * them), so the source itself is not changed. Instead every occurrence below
 * is rewritten here; if a pattern is missing or ambiguous the loader throws
 * instead of registering a half-renamed card.
 *
 * Setup: clone the repository below <config>/www, then add this file as a
 * dashboard resource of type "JavaScript module", e.g.
 *   /local/dev/max-wrapper/dev/dev-loader.js
 * and use `type: custom:maximize-wrapper-card-dev` in a test card.
 */

const CARD_TAG       = 'maximize-wrapper-card';
const EDITOR_TAG     = 'maximize-wrapper-card-editor';
const CARD_NAME      = 'Maximize Wrapper';
const DEV_CARD_TAG   = 'maximize-wrapper-card-dev';
const DEV_EDITOR_TAG = 'maximize-wrapper-card-dev-editor';
const DEV_CARD_NAME  = 'Maximize Wrapper (DEV)';

const sourceUrl = new URL('../max-wrapper.js', import.meta.url);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// [label, code before the string literal, old value, new value, code after]
const rewrites = [
  ['card define',          'customElements\\.define\\(\\s*', CARD_TAG,   DEV_CARD_TAG,   '\\s*,'],
  ['editor define',        'customElements\\.define\\(\\s*', EDITOR_TAG, DEV_EDITOR_TAG, '\\s*,'],
  ['getConfigElement tag', 'document\\.createElement\\(\\s*', EDITOR_TAG, DEV_EDITOR_TAG, '\\s*\\)'],
  ['customCards type',     '\\btype:\\s*',                   CARD_TAG,   DEV_CARD_TAG,   '\\s*,'],
  ['customCards name',     '\\bname:\\s*',                   CARD_NAME,  DEV_CARD_NAME,  '\\s*,'],
];

function rewriteExactlyOnce(text, [label, before, from, to, after]) {
  // String literal in "…" or '…', the same quote on both ends.
  const pattern = new RegExp(`(${before})(["'])${esc(from)}\\2(?=${after})`, 'g');
  const count = (text.match(pattern) || []).length;
  if (count !== 1) {
    throw new Error(`[max-wrapper dev-loader] ${label}: expected exactly 1 match, found ${count}: ${pattern}`);
  }
  return text.replace(pattern, (_, pre, q) => `${pre}${q}${to}${q}`);
}

const response = await fetch(sourceUrl, { cache: 'no-store' });
if (!response.ok) {
  throw new Error(`[max-wrapper dev-loader] ${sourceUrl} → HTTP ${response.status}`);
}

let source = await response.text();
for (const rewrite of rewrites) {
  source = rewriteExactlyOnce(source, rewrite);
}
source += `\n//# sourceURL=${new URL('max-wrapper.dev.js', sourceUrl).href}\n`;

const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
try {
  await import(blobUrl);
} finally {
  URL.revokeObjectURL(blobUrl);
}
