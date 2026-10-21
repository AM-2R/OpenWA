import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The page sits in a container that clips what sticks out sideways, so on a phone a card or table wider than
// the screen is cut off instead of scrolling. jsdom has no layout; these rules are what keeps it narrow-safe.

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'NumberChecker.css'), 'utf8');

test('the grid tracks can shrink below their content', () => {
  const tracks = [...css.matchAll(/\.nc-grid\s*\{[^}]*grid-template-columns:\s*([^;]+);/g)].map(match => match[1]);
  assert.deepEqual(tracks, ['repeat(2, minmax(0, 1fr))', 'minmax(0, 1fr)']);
});

test('the table container scrolls sideways', () => {
  const rule = /\.number-checker \.nc-table-wrap\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'no rule for the table container');
  assert.match(rule[1], /overflow-x:\s*auto/);
});
