import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Layout.css under a right-to-left language. The sidebar is position: fixed with no inset, so in an
// RTL flex row it sits at the right edge, and every horizontal rule meant for the left edge has to be
// mirrored for it.

const DIR = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(DIR, 'Layout.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tsx = readFileSync(join(DIR, 'Layout.tsx'), 'utf8');

interface Rule {
  media: string;
  selectors: string[];
  body: string;
}

// Style rules with the @media condition they sit under ('' at the top level).
function rules(text: string, media = ''): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const header = text.slice(i, open).trim();
    let depth = 1;
    let k = open + 1;
    while (k < text.length && depth) {
      if (text[k] === '{') depth++;
      else if (text[k] === '}') depth--;
      k++;
    }
    const body = text.slice(open + 1, k - 1);
    if (header.startsWith('@media')) out.push(...rules(body, header));
    else if (!header.startsWith('@')) out.push({ media, selectors: header.split(',').map(s => s.trim()), body });
    i = k;
  }
  return out;
}

const all = rules(css);
const decl = (body: string, prop: string): string | undefined =>
  new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim();
const find = (selector: string): Rule[] => all.filter(r => r.selectors.includes(selector));

// Layout.tsx switches to the mobile layout below this width.
const mobileBelow = Number(/innerWidth < (\d+)/.exec(tsx)?.[1]);

test('every max-width query in Layout.css switches at the same width as the mobile layout', () => {
  assert.ok(mobileBelow > 0, 'Layout.tsx no longer names its mobile threshold');
  const widths = [...css.matchAll(/max-width:\s*(\d+)px/g)].map(m => Number(m[1]));
  assert.ok(widths.length > 0);
  for (const w of widths)
    assert.equal(w, mobileBelow - 1, `max-width: ${w}px disagrees with innerWidth < ${mobileBelow}`);
});

test('the closed mobile sidebar slides off the right edge under RTL, and opens back in', () => {
  const closed = find("[dir='rtl'] .sidebar.mobile").filter(r => r.media);
  assert.equal(closed.length, 1, 'no RTL transform for the closed mobile sidebar');
  assert.equal(decl(closed[0].body, 'transform'), 'translateX(100%)');
  // Same specificity as the rule above, so the open state has to be scoped to RTL as well.
  const open = find("[dir='rtl'] .sidebar.mobile.open").filter(r => r.media === closed[0].media);
  assert.equal(open.length, 1, 'the RTL closed rule would also hide the open sidebar');
  assert.equal(decl(open[0].body, 'transform'), 'translateX(0)');
  // The shadow falls on the content side, which under RTL is the left.
  assert.match(decl(open[0].body, 'box-shadow') ?? '', /^-2px /);
});

// A shadow on the closed drawer reaches about 20px past its off-screen edge and showed as a grey band along the
// edge of every phone page.
test('the mobile sidebar casts its shadow only while it is open', () => {
  for (const dir of ['', "[dir='rtl'] "]) {
    const closed = find(`${dir}.sidebar.mobile`).filter(r => r.media);
    assert.equal(closed.length, 1, `${dir}.sidebar.mobile`);
    assert.equal(decl(closed[0].body, 'box-shadow'), undefined, `${dir}.sidebar.mobile shadows the screen edge`);
  }
  const open = find('.sidebar.mobile.open').filter(r => r.media);
  assert.equal(open.length, 1, 'no open rule for the mobile sidebar');
  assert.match(decl(open[0].body, 'box-shadow') ?? '', /^2px /);
});

// The language menu opens upward from the sidebar footer with all 15 languages in it, 559px tall. With no bound its
// first entries (English included) ended above the top edge of any window shorter than about 720px, and the sidebar
// is fixed, so nothing scrolled them back into view. The footer and the menu sit lower in the collapsed sidebar.
test('the language menu is bounded by the window and scrolls', () => {
  const menu = find('.language-menu-list').find(r => !r.media);
  assert.ok(menu, 'no base .language-menu-list rule');
  assert.equal(decl(menu.body, 'overflow-y'), 'auto');
  assert.equal(decl(menu.body, 'max-height'), 'calc(100vh - 13rem)');
  const collapsed = find('.sidebar.collapsed .language-menu-list').find(r => !r.media);
  assert.ok(collapsed, 'no collapsed .language-menu-list rule');
  assert.equal(decl(collapsed.body, 'max-height'), 'calc(100vh - 9rem)');
});

// The Plugins page pins its status rail with position: sticky. overflow-x: hidden makes .main-content a scroll
// container (overflow-y computes to auto), the nearest one a sticky box sticks to, and that one never scrolls, so
// the rail scrolled away with the page. clip hides the overflow without that.
test('the main content clips sideways overflow without becoming a scroll container', () => {
  const main = find('.main-content').find(r => !r.media);
  assert.ok(main, 'no base .main-content rule');
  assert.equal(decl(main.body, 'overflow-x'), 'clip');
});

test('the collapse chevron is mirrored once, by the icon Layout.tsx picks', () => {
  assert.match(tsx, /isRtl \? \(\s*<ChevronLeft/, 'Layout.tsx no longer swaps the chevron for RTL');
  for (const r of all.filter(r => r.selectors.some(s => s.includes('.collapse-toggle svg')))) {
    assert.equal(decl(r.body, 'transform'), undefined, `${r.selectors.join(', ')} flips the chevron again`);
  }
});
