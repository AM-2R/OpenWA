import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Toast.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const body = (selector: string): string => {
  const rule = new RegExp(`(?:^|})\\s*${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(rule, `Toast.css has no ${selector} rule`);
  return rule[1];
};

test('the toast close button resets the global button padding', () => {
  // The global button rule pads 0.6em 1.2em; on a 24px box that leaves the 16px icon no width and it collapses.
  assert.match(body('.toast-close'), /(?:^|;)\s*padding:\s*0\s*;/);
});
