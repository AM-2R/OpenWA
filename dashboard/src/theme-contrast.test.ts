import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Error text in dark mode lands on the card surface and on the 10 to 20 percent error tints that
// pills and danger buttons paint over it, so it has to clear WCAG AA (4.5:1) on the darkest of those.

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'App.css'), 'utf8');

const rgb = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (c: number[]): number => {
  const [r, g, b] = c.map(v => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const token = (block: string, name: string): string => {
  const value = block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  assert.ok(value, `${name} is not a hex colour in the block`);
  return value;
};
const blockAfter = (anchor: string): string => {
  const from = CSS.indexOf(anchor);
  assert.notEqual(from, -1, `App.css no longer contains "${anchor}"`);
  return CSS.slice(from, CSS.indexOf('}', from));
};

test('dark --error-text clears AA on every error tint it lands on, in both dark blocks', () => {
  const error = rgb(token(blockAfter(':root {'), '--error'));
  for (const anchor of ["[data-theme='dark'] {", ":root:not([data-theme='light']) {"]) {
    const block = blockAfter(anchor);
    const text = rgb(token(block, '--error-text'));
    const surface = rgb(token(block, '--bg-white'));
    for (const alpha of [0, 0.1, 0.12, 0.15, 0.18, 0.2]) {
      const bg = error.map((c, i) => c * alpha + surface[i] * (1 - alpha));
      const ratio = contrast(text, bg);
      assert.ok(ratio >= 4.5, `${anchor} --error-text is ${ratio.toFixed(2)}:1 on a ${alpha * 100}% error tint`);
    }
  }
});

// The pairs below are the ones the stylesheets build from these tokens and from two literal bubble greens.
const PAGES = join(dirname(fileURLToPath(import.meta.url)), 'pages');
const read = (file: string): string => readFileSync(join(PAGES, file), 'utf8');
const LIGHT = ':root {';
const DARK = "[data-theme='dark'] {";
// A visitor on a dark OS with no stored theme has no data-theme at all (every first visit, and the signed-out
// Login page): they get this block, not DARK, so every dark ratio is checked against both.
const DARK_MEDIA = ":root:not([data-theme='light']) {";
const DARKS = [DARK, DARK_MEDIA];
const valueOf = (block: string, name: string): string => {
  const raw = block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
  assert.ok(raw, `${name} is not set in the block`);
  const alias = /^var\((--[\w-]+)\)$/.exec(raw);
  return alias ? valueOf(blockAfter(LIGHT), alias[1]) : raw;
};
const hexOf = (block: string, name: string): string => {
  const value = valueOf(block, name);
  assert.match(value, /^#[0-9a-f]{6}$/i, `${name} is ${value}`);
  return value;
};
const mix = (over: number[], alpha: number, under: number[]): number[] =>
  over.map((c, i) => c * alpha + under[i] * (1 - alpha));

test('--text-muted placeholders clear AA on every input surface in both themes', () => {
  assert.match(
    CSS,
    /input::placeholder,\s*textarea::placeholder\s*\{[^}]*color:\s*var\(--text-muted\)[^}]*opacity:\s*1/,
  );
  for (const anchor of [LIGHT, ...DARKS]) {
    const block = blockAfter(anchor);
    const text = rgb(hexOf(block, '--text-muted'));
    for (const surface of ['--bg-white', '--bg-light']) {
      const ratio = contrast(text, rgb(hexOf(block, surface)));
      assert.ok(ratio >= 4.5, `${anchor} --text-muted on ${surface} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('time stamps and read ticks on the outgoing bubble clear their ratios in both themes', () => {
  const chats = read('Chats.css');
  const light = rgb(/\.chats-page \.message-bubble\.outgoing \{\s*background:\s*(#[0-9a-f]{6})/i.exec(chats)![1]);
  assert.match(chats, /\.message-bubble\.outgoing \.message-time\s*\{\s*color:\s*var\(--text-secondary\)/);
  const secondaryLight = contrast(rgb(hexOf(blockAfter(LIGHT), '--text-secondary')), light);
  assert.ok(secondaryLight >= 4.5, `light time stamp ${secondaryLight.toFixed(2)}:1`);
  // The dark bubble and its read tick are written twice: once under [data-theme='dark'], once for the system theme.
  const escape = (text: string): string => text.replace(/[[\]().]/g, '\\$&');
  for (const [anchor, prefix] of [
    [DARK, "[data-theme='dark'] "],
    [DARK_MEDIA, ":root:not([data-theme='light']) "],
  ]) {
    const bubble = new RegExp(
      `${escape(prefix)}\\.chats-page \\.message-bubble\\.outgoing \\{\\s*background:\\s*(#[0-9a-f]{6})`,
      'i',
    ).exec(chats);
    assert.ok(bubble, `Chats.css has no outgoing bubble rule under ${prefix}`);
    assert.match(
      chats,
      new RegExp(`${escape(prefix)}\\.chats-page \\.message-status-icon\\.read\\s*\\{\\s*color:\\s*var\\(--info\\)`),
      `Chats.css has no read tick rule under ${prefix}`,
    );
    const dark = rgb(bubble[1]);
    const secondary = contrast(rgb(hexOf(blockAfter(anchor), '--text-secondary')), dark);
    assert.ok(secondary >= 4.5, `${anchor} time stamp ${secondary.toFixed(2)}:1`);
    const tick = contrast(rgb(hexOf(blockAfter(anchor), '--info')), dark);
    assert.ok(tick >= 3, `${anchor} read tick ${tick.toFixed(2)}:1 (a status glyph needs 3:1)`);
  }
});

test('the action required pill clears 4.5:1 on its tint in the dark theme, with one tint on both pages', () => {
  const tints = [
    ['Sessions.css', '.sessions-page .status-pill.action_required'],
    ['Dashboard.css', '.dashboard .status-pill.action_required'],
  ].map(([file, selector]) => {
    const rule = new RegExp(
      `${selector.replace(/[.]/g, '\\.')}[^{]*\\{[^}]*background:\\s*rgba\\(245,\\s*158,\\s*11,\\s*([\\d.]+)\\)`,
    ).exec(read(file));
    assert.ok(rule, `${file} has no amber tint for ${selector}`);
    return Number(rule[1]);
  });
  assert.equal(tints[0], tints[1], 'the same status is tinted differently on the two pages');
  // The tint is the base amber (--warning) over the card; the text is --warning-text, which keeps the base value in dark.
  for (const anchor of DARKS) {
    const block = blockAfter(anchor);
    const tint = mix(rgb(hexOf(blockAfter(LIGHT), '--warning')), tints[0], rgb(hexOf(block, '--bg-white')));
    const ratio = contrast(rgb(hexOf(block, '--warning-text')), tint);
    assert.ok(ratio >= 4.5, `${anchor} amber text on a ${tints[0]} tint is ${ratio.toFixed(2)}:1`);
  }
});

test('the search match and the Number Checker highlight pill clear AA in both themes', () => {
  const search = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/GlobalSearch.css'), 'utf8');
  const mark =
    /\.global-search-hit-snippet mark\s*\{[^}]*background:\s*var\((--[\w-]+)\);[^}]*?color:\s*(#[0-9a-f]{6})/i.exec(
      search,
    );
  assert.ok(mark, 'GlobalSearch.css no longer styles the match with a hex colour on a token fill');
  const pill =
    /\.nc-format-pill\.highlight\s*\{[^}]*background:\s*rgba\(37,\s*211,\s*102,\s*([\d.]+)\)[^}]*?color:\s*var\((--[\w-]+)\)/.exec(
      read('NumberChecker.css'),
    );
  assert.ok(pill, 'NumberChecker.css no longer styles the highlight pill with a token colour');
  for (const anchor of [LIGHT, ...DARKS]) {
    const block = blockAfter(anchor);
    // The amber fill is the same in both themes, so the dark text on it must hold in both.
    const onAmber = contrast(rgb(mark[2]), rgb(hexOf(blockAfter(LIGHT), mark[1])));
    assert.ok(onAmber >= 4.5, `${anchor} match text on the amber is ${onAmber.toFixed(2)}:1`);
    const tint = mix(rgb(hexOf(blockAfter(LIGHT), '--primary')), Number(pill[1]), rgb(hexOf(block, '--bg-white')));
    const onTint = contrast(rgb(hexOf(block, pill[2])), tint);
    assert.ok(onTint >= 4.5, `${anchor} pill text on the green tint is ${onTint.toFixed(2)}:1`);
  }
});

// Opacity over --text-muted is a second fade on a colour that already sits at 4.5:1: at 0.7 it is 2.72:1.
test('text that uses --text-muted is not faded again with opacity', () => {
  const components = join(dirname(fileURLToPath(import.meta.url)), 'components');
  const sources: [string, string, string][] = [
    ['Layout.css', readFileSync(join(components, 'Layout.css'), 'utf8'), '.brand-version'],
    ['Chats.css', read('Chats.css'), '.chats-page .room-contact-jid'],
    ['Chats.css', read('Chats.css'), '.chats-page .chat-item-snippet .no-message'],
    ['Infrastructure.css', read('Infrastructure.css'), '.infrastructure-page .form-group small'],
    ['Infrastructure.css', read('Infrastructure.css'), '.infrastructure-page .toggle-info small'],
  ];
  for (const [file, css, selector] of sources) {
    const rule = new RegExp(`(?:^|})\\s*${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(
      css.replace(/\/\*[\s\S]*?\*\//g, ''),
    );
    assert.ok(rule, `${file} has no ${selector} rule`);
    assert.doesNotMatch(rule[1], /opacity:/, `${file} ${selector} fades its text`);
  }
});

test('muted text on a tinted row uses --text-secondary, which clears AA on the tint in both themes', () => {
  // [stylesheet, selector, tint alpha in light, tint alpha in dark, surface under the tint]
  const rules: [string, string, number, number, string][] = [
    ['Chats.css', '.chats-page .chat-item-card.active .chat-item-time', 0.08, 0.08, '--bg-white'],
    ['Chats.css', '.chats-page .chat-item-card.active .chat-item-snippet', 0.08, 0.08, '--bg-white'],
    // The selected template row is --primary-soft: 12 percent in light, 18 percent in dark.
    ['Templates.css', '.templates-page .template-list-item.selected .template-list-meta', 0.12, 0.18, '--bg-light'],
  ];
  for (const [file, selector, light, dark, surface] of rules) {
    const rule = new RegExp(`${selector.replace(/[.]/g, '\\.')}[^{]*\\{[^}]*color:\\s*var\\((--[\\w-]+)\\)`).exec(
      read(file),
    );
    assert.ok(rule, `${file} has no colour for ${selector}`);
    assert.equal(rule[1], '--text-secondary', `${file} ${selector}`);
    for (const [anchor, alpha] of [
      [LIGHT, light],
      [DARK, dark],
      [DARK_MEDIA, dark],
    ] as const) {
      const block = blockAfter(anchor);
      const tint = mix(rgb(hexOf(blockAfter(LIGHT), '--primary')), alpha, rgb(hexOf(block, surface)));
      const ratio = contrast(rgb(hexOf(block, '--text-secondary')), tint);
      assert.ok(ratio >= 4.5, `${anchor} ${selector} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('the batch badge uses --info, which clears the twins range on its tint in both themes', () => {
  const rule = /\.batch-badge\.pending,\s*\.message-tester \.batch-badge\.processing\s*\{[^}]*color:\s*([^;]+);/.exec(
    read('MessageTester.css'),
  );
  assert.ok(rule, 'MessageTester.css no longer styles the pending badge');
  assert.equal(rule[1].trim(), 'var(--info)');
  for (const anchor of [LIGHT, ...DARKS]) {
    const block = blockAfter(anchor);
    // The batch panel is --bg-light; the badge paints 12 percent of the blue over it.
    const tint = mix([59, 130, 246], 0.12, rgb(hexOf(block, '--bg-light')));
    const ratio = contrast(rgb(hexOf(block, '--info')), tint);
    assert.ok(ratio >= 4.29, `${anchor} --info on the batch badge is ${ratio.toFixed(2)}:1 (the raw blue was 3.08:1)`);
  }
});
