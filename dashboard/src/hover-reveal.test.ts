import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// A control that is invisible until :hover is never seen on a touch screen, which has no hover: on a phone the
// per-row chat menu (pin, mute, archive, delete) could not be found from the list. Where there is no hover the
// trigger stays visible.

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pages/Chats.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

// The body of the first @media block whose condition is `query`, found by matching braces.
function mediaBody(query: string): string {
  const at = css.indexOf(`@media ${query}`);
  assert.notEqual(at, -1, `Chats.css has no @media ${query}`);
  const open = css.indexOf('{', at);
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(open + 1, i - 1);
}

test('the chat row menu trigger stays visible where there is no hover', () => {
  assert.match(
    css,
    /\.chats-page \.chat-row-menu-trigger\s*\{[^}]*opacity:\s*0\s*;/,
    'the trigger is no longer hidden by default',
  );
  const rule = /\.chats-page \.chat-row-menu-trigger\s*\{([^}]*)\}/.exec(mediaBody('(hover: none)'));
  assert.ok(rule, 'no trigger rule under (hover: none)');
  assert.match(rule[1], /opacity:\s*1/);
});
