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

// A field that switches its outline off shows focus as a border instead. In the brand fill (#25d366) that border is
// 1.98:1 on white, under the 3:1 of SC 1.4.11, which is what the rings were before they took the token.
const focusState = (s: string): boolean => /:focus(?:-visible|-within)?\b/.test(s.replace(/:not\([^)]*\)/g, ''));

test('every border a focus state paints is drawn in the --focus-ring token', () => {
  const painted = all
    .filter(r => r.selectors.some(focusState))
    .flatMap(r =>
      [...r.body.matchAll(/(?:^|;)\s*(border(?:-(?:top|right|bottom|left))?(?:-color)?)\s*:\s*([^;]+)/g)].map(m => ({
        at: `${r.file}: ${r.selectors.join(', ')}`,
        prop: m[1],
        value: m[2].trim(),
      })),
    )
    .filter(({ prop, value }) => prop.endsWith('-color') || /var\(|#|rgb|hsl/.test(value));
  assert.ok(painted.length >= 20, `only ${painted.length} focus borders seen`);
  assert.deepEqual(
    painted.filter(({ value }) => !/\bvar\(--focus-ring\)/.test(value)).map(({ at, value }) => `${at} => ${value}`),
    [],
  );
});

// The element a selector styles, its focus state and attribute filters aside: `input[type='text']:focus` and
// `input:focus` style the same field.
const element = (s: string): string =>
  s
    .replace(/:not\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/:focus(?:-visible|-within)?/g, '')
    .trim();

// `outline: none` takes away the indicator the browser would draw, so something has to draw one in its place: the
// same element in a focus state, or the box around it in :focus-within (a search box around its input).
test('every outline switched off leaves a keyboard focus cue in the --focus-ring token', () => {
  const cues = all.filter(r => /\bvar\(--focus-ring\)/.test(r.body)).flatMap(r => r.selectors.filter(focusState));
  const offenders = all
    .filter(r => /(?:^|;)\s*outline\s*:\s*(?:none|0)\b/.test(r.body))
    .flatMap(r =>
      r.selectors.filter(s => !/:not\(:focus-visible\)/.test(s)).map(s => ({ at: `${r.file}: ${s}`, el: element(s) })),
    )
    .filter(
      ({ el }) =>
        !cues.some(cue => element(cue) === el || (/:focus-within/.test(cue) && el.startsWith(`${element(cue)} `))),
    );
  assert.deepEqual(
    offenders.map(({ at }) => at),
    [],
  );
});

// These fields repaint their own border after the shared `select:focus` and `.modal-body input:focus` rules, which
// switch the outline off, so without a focus rule of their own a focused one looked like any other. A native checkbox
// or radio shows no border at all, so the text field rules that reach it leave it only the ring.
test('filter builder fields and native checkboxes draw their own focus cue', () => {
  for (const [selector, cue] of [
    ['.filter-row select:focus', /border-color:\s*var\(--focus-ring\)/],
    [".filter-text input[type='text']:focus", /border-color:\s*var\(--focus-ring\)/],
    ['.chips-row .chips-text:focus', /border-color:\s*var\(--focus-ring\)/],
    ["input[type='checkbox']:not(.toggle-switch input):focus-visible", /outline:\s*2px solid var\(--focus-ring\)/],
    ["input[type='radio']:not(.toggle-switch input):focus-visible", /outline:\s*2px solid var\(--focus-ring\)/],
  ] as const) {
    const rule = all.find(r => r.selectors.includes(selector));
    assert.ok(rule, `no rule for ${selector}`);
    assert.match(rule.body, cue, selector);
  }
});
