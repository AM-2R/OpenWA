import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The brand green (#25d366) and the amber warning fill are light colours: white on them is 1.98:1 and 2.15:1,
// far under the 4.5:1 AA needs, and the green as text on white is the same 1.98:1. Text and icons on those fills are
// dark (#0f172a, 9.0:1 on the green, as .btn-primary has it), and the brand green as text is --primary-text.

const SRC = dirname(fileURLToPath(import.meta.url));

function filesUnder(dir: string, extensions: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, extensions);
    return extensions.some(ext => entry.name.endsWith(ext)) && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

interface Rule {
  at: string;
  selectors: string;
  decl: Record<string, string>;
}

function rules(): Rule[] {
  return filesUnder(SRC, ['.css']).flatMap(full => {
    const css = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ''));
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
      at: `${full.slice(SRC.length + 1)}:${css.slice(0, m.index + m[1].length).split('\n').length}`,
      selectors: m[1].trim().replace(/\s+/g, ' '),
      decl: Object.fromEntries([...m[2].matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)].map(d => [d[1], d[2].trim()])),
    }));
  });
}

const WHITE = /^(?:#fff|#ffffff|white)$/i;
// Solid fills only: a translucent tint (rgba, color-mix) is a different pair and is checked by its own ratio.
const LIGHT_FILL =
  /^(?:var\(--primary(?:-hover)?(?:,[^)]*)?\)|var\(--warning(?:,[^)]*)?\)|#25d366|#1da851|#16a34a|#f59e0b|#d97706)$/i;

test('no rule sets white text on the brand green or amber fill', () => {
  const offenders = rules()
    .filter(
      r => WHITE.test(r.decl.color ?? '') && LIGHT_FILL.test(r.decl.background ?? r.decl['background-color'] ?? ''),
    )
    .map(r => `${r.at}: ${r.selectors}`);
  assert.deepEqual(offenders, []);
});

test('the brand green is never used as a text colour', () => {
  const css = rules()
    .filter(r => /^(?:var\(--primary(?:,[^)]*)?\)|#25d366)$/i.test(r.decl.color ?? ''))
    .map(r => `${r.at}: ${r.selectors}`);
  const inline = filesUnder(SRC, ['.tsx']).flatMap(full =>
    readFileSync(full, 'utf8')
      .split('\n')
      .map((line, i) => ({ line, at: `${full.slice(SRC.length + 1)}:${i + 1}` }))
      .filter(({ line }) => /(?<![\w-])color:\s*['"](?:var\(--primary\)|#25d366)['"]/.test(line))
      .map(({ at }) => at),
  );
  assert.deepEqual([...css, ...inline], []);
});
