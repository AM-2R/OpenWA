import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// i18n/index.ts sets <html dir="rtl"> for Hebrew and Arabic. A physical left or right side in a
// margin, padding, border, corner radius or text alignment stays put when the layout mirrors, so a
// divider or accent bar lands on the wrong edge and a header detaches from its column.
const PHYSICAL_SIDE =
  /(?:margin|padding|border)-(?:left|right)\b|border-(?:top|bottom)-(?:left|right)-radius|text-align:\s*(?:left|right)/;

function physicalSides(file: string): string[] {
  const css = readFileSync(new URL(file, import.meta.url), 'utf8')
    // Blank out comments but keep their line breaks, so a reported line number matches the file.
    .replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ''));
  return css
    .split('\n')
    .map((line, i) => `${file}:${i + 1}: ${line.trim()}`)
    .filter(line => PHYSICAL_SIDE.test(line));
}

test('the API keys stylesheet uses logical sides only', () => {
  assert.deepEqual(physicalSides('./ApiKeys.css'), []);
});

test('the chats stylesheet uses logical sides only', () => {
  assert.deepEqual(physicalSides('./Chats.css'), []);
});

test('the number checker stylesheet uses logical sides only', () => {
  assert.deepEqual(physicalSides('./NumberChecker.css'), []);
});

// The files above must hold no physical side at all. Everywhere else a physical side is fine only
// when the layout mirrors it: the rule is written for [dir='rtl'] itself, or a [dir='rtl'] rule for the
// same selector sets the other side. Besides the single-side properties this also reads the shorthands,
// where a 4-value margin or padding with unequal left and right, or a border-radius whose left and
// right corners differ, hides a side.
const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SIDE_PROPERTY =
  /^(?:(?:margin|padding)-(?:left|right)|border-(?:left|right)(?:-(?:width|style|color))?|border-(?:top|bottom)-(?:left|right)-radius)$/;

// Whitespace separated values, keeping var(...) and calc(...) whole.
function values(value: string): string[] {
  return value.replace(/\s*!important\s*$/, '').match(/(?:[^\s(]|\([^)]*\))+/g) ?? [];
}

function hidesSide(property: string, value: string): boolean {
  if (SIDE_PROPERTY.test(property)) return true;
  if (property === 'text-align') return /^(?:left|right)$/.test(value.trim());
  const v = values(value);
  if (property === 'margin' || property === 'padding') return v.length === 4 && v[1] !== v[3];
  if (property === 'border-radius') {
    // Corners in order top-left, top-right, bottom-right, bottom-left; a shorter list repeats.
    const [tl, tr = tl, br = tl, bl = tr] = values(value.split('/')[0]);
    return tl !== tr || bl !== br;
  }
  return false;
}

function stylesheets(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(full);
    return entry.name.endsWith('.css') ? [full] : [];
  });
}

function unmirroredSides(full: string): string[] {
  // Blank out comments but keep their line breaks, so a reported line number matches the file.
  const css = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ''));
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
    selectors: m[1].split(',').map(s => s.trim().replace(/\s+/g, ' ').replace(/"/g, "'")),
    body: m[2],
    at: m.index + m[1].length + 1,
  }));
  const known = new Set(rules.flatMap(r => r.selectors));
  const mirrored = (selector: string): boolean =>
    selector.startsWith("[dir='rtl']") || known.has(`[dir='rtl'] ${selector}`);
  const found: string[] = [];
  for (const rule of rules) {
    if (rule.selectors.every(mirrored)) continue;
    let offset = 0;
    for (const declaration of rule.body.split(';')) {
      const [property, ...rest] = declaration.split(':');
      const value = rest.join(':');
      if (property && hidesSide(property.trim(), value)) {
        const line = css.slice(0, rule.at + offset + declaration.search(/\S|$/)).split('\n').length;
        found.push(`${full.slice(SRC.length + 1)}:${line}: ${rule.selectors.join(', ')} { ${declaration.trim()} }`);
      }
      offset += declaration.length + 1;
    }
  }
  return found;
}

test('every stylesheet either mirrors a physical side under RTL or uses logical ones', () => {
  const files = stylesheets();
  assert.ok(files.length >= 20, `only ${files.length} stylesheets found`);
  assert.deepEqual(files.flatMap(unmirroredSides), []);
});

test('the side detector reads single-side properties and shorthands', () => {
  const physical: [string, string][] = [
    ['margin-left', '8px'],
    ['border-right', '1px solid red'],
    ['text-align', 'left'],
    ['margin', '0.25rem 0 0.75rem 1.5rem'],
    ['padding', '0.75rem 3rem 0.75rem 1rem'],
    ['border-radius', '12px 12px 12px 4px'],
    ['border-radius', '12px 4px'],
  ];
  const neutral: [string, string][] = [
    ['margin', '0 auto'],
    ['padding', '1rem 2rem 1rem 2rem'],
    ['text-align', 'start'],
    ['border-radius', '16px 16px 0 0'],
    ['border-top', '1px solid red'],
    ['margin-inline-start', '8px'],
  ];
  for (const [property, value] of physical) assert.ok(hidesSide(property, value), `${property}: ${value}`);
  for (const [property, value] of neutral) assert.ok(!hidesSide(property, value), `${property}: ${value}`);
});
