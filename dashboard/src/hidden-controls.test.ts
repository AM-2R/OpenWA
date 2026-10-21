import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// A radio or checkbox that is drawn as something else (a card, a switch) still has to take keyboard
// focus and show where it is. `display: none` removes the input from the tab order and from the
// accessibility tree; hiding it with zero opacity keeps it focusable, but then the visible stand-in
// has to carry the focus ring.

const SRC = dirname(fileURLToPath(import.meta.url));

interface Rule {
  selectors: string[];
  body: string;
}

// Flat style rules; a rule inside an @media block is listed like any other.
function rules(file: string): Rule[] {
  const css = readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
    selectors: m[1].split(',').map(s => s.trim()),
    body: m[2],
  }));
}

test('the Infrastructure radio inputs stay focusable and the card shows the focus ring', () => {
  const all = rules('pages/Infrastructure.css');
  const inputs = all.filter(r => r.selectors.some(s => /\.radio-option input$/.test(s)));
  assert.ok(inputs.length > 0, 'no rule styles the radio inputs');
  for (const r of inputs) assert.doesNotMatch(r.body, /display:\s*none/, `${r.selectors.join(', ')} removes the radio`);
  const ring = all.find(r => r.selectors.some(s => /\.radio-option:has\(input:focus-visible\)$/.test(s)));
  assert.ok(ring, 'no focus ring for the focused radio card');
  assert.match(ring.body, /outline:\s*2px solid var\(--primary\)/);
});
