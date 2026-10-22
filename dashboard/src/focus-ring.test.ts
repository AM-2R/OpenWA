import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Keyboard focus has to stay visible. A menu entry or search hit that answers :focus-visible with only
// a one-step background change (1.05:1 on white) gives no cue where focus is, so the rule has to draw
// a ring; `outline: none` there removes the only indicator the browser would have drawn.

const SRC = dirname(fileURLToPath(import.meta.url));

interface Rule {
  file: string;
  selectors: string[];
  body: string;
}

function cssFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.name.endsWith('.css') ? [full.slice(SRC.length + 1)] : [];
  });
}

function rules(file: string): Rule[] {
  const css = readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
    file,
    selectors: m[1].split(',').map(s => s.trim()),
    body: m[2],
  }));
}

const all = cssFiles().flatMap(rules);
// :not(:focus-visible) is the opposite state: a mouse click may drop the outline there.
const focusVisible = (s: string): boolean => /:focus-visible/.test(s.replace(/:not\([^)]*\)/g, ''));

test('no :focus-visible rule switches the outline off', () => {
  const offenders = all
    .filter(r => r.selectors.some(focusVisible) && /outline:\s*(?:none|0)\b/.test(r.body))
    .map(r => `${r.file}: ${r.selectors.join(', ')}`);
  assert.deepEqual(offenders, []);
});

test('chat menu entries and search hits draw a ring on keyboard focus', () => {
  for (const selector of [
    '.chats-page .chat-row-menu-popover button:focus-visible',
    '.chats-page .room-menu-popover button:focus-visible',
    '.global-search-hit:focus-visible',
  ]) {
    const rule = all.find(r => r.selectors.includes(selector));
    assert.ok(rule, `no rule for ${selector}`);
    assert.match(rule.body, /outline:\s*2px solid var\(--focus-ring\)/, selector);
  }
});

// The brand fill (#25d366) is 1.98:1 on white, under the 3:1 WCAG 2.2 SC 1.4.11 asks of a focus indicator. Every ring
// is drawn in the --focus-ring token (App.css, where its contrast is checked), so one value moves them all.
test('every keyboard focus ring is drawn in the --focus-ring token', () => {
  const drawn = all.flatMap(r =>
    [...r.body.matchAll(/(?:^|;)\s*outline(?:-color)?\s*:\s*([^;]+)/g)]
      .map(m => ({ at: `${r.file}: ${r.selectors.join(', ')}`, value: m[1].trim() }))
      .filter(({ value }) => !/^(?:none|0)$/.test(value)),
  );
  assert.ok(
    drawn.some(({ at }) => at.startsWith('index.css')),
    'the global ring is not seen',
  );
  assert.deepEqual(
    drawn.filter(({ value }) => !/\bvar\(--focus-ring\)/.test(value)).map(({ at, value }) => `${at} => ${value}`),
    [],
  );
});

// The soft brand fill a focused hit paints is a tint: the muted meta line (the chat id and the time) measures 4.35:1
// on it in the light theme and 3.98:1 in the dark one, where the plain hover fill it replaced gave 4.55:1 and 6.96:1.
test('the meta line of a keyboard-focused search hit takes the secondary text colour', () => {
  const rule = all.find(r => r.selectors.includes('.global-search-hit:focus-visible .global-search-hit-meta'));
  assert.ok(rule, 'a focused hit leaves its meta line muted on the brand tint');
  assert.match(rule.body, /(?:^|;)\s*color:\s*var\(--text-secondary\)/);
});
