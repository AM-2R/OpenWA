import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

const rules = readRules(new URL('./Plugins.css', import.meta.url));

// The Upload/Catalog pill in the install modal header. Centred with absolute positioning it took no part in
// flex-wrap, so on a phone it was drawn over the title ("Insta" and a tab), and it took no part in sizing the
// title either, so a long translated title (Telugu) ran under it at every width. From 700px the header is three
// tracks with the pill in the middle one, so the title is cut inside its own track; below that the title has a row
// of its own and the pill shares the next one with the close button.
const HEADER = '.plugins-page .install-modal .modal-header';
const PILL = `${HEADER} .install-tabs`;

test('from 700px the install header is a grid with the tabs in the middle track', () => {
  const grids = rules.filter(r => r.selectors.includes(HEADER) && decl(r.body, 'display') === 'grid');
  assert.equal(grids.length, 1, 'expected one rule that makes the header a grid');
  assert.equal(grids[0].media, '@media (min-width: 700px)');
  assert.equal(decl(grids[0].body, 'grid-template-columns'), 'minmax(0, 1fr) auto minmax(0, 1fr)');
});

test('the install tabs are not positioned out of the header', () => {
  for (const rule of rules.filter(r => r.selectors.includes(PILL))) {
    assert.equal(decl(rule.body, 'position'), undefined, `${rule.media || 'base'} positions the pill`);
  }
});

test('the close button stays in the end track and the title is cut inside its own', () => {
  const close = rules.filter(
    r => r.selectors.includes(`${HEADER} .btn-icon`) && decl(r.body, 'justify-self') === 'end',
  );
  assert.equal(close.length, 1, 'no rule keeps the close button at the end of the header');
  assert.equal(close[0].media, '@media (min-width: 700px)');
  const title = rules.find(r => !r.media && r.selectors.includes(`${HEADER} h2`));
  assert.ok(title, 'no title rule');
  assert.equal(decl(title.body, 'min-width'), '0');
  assert.equal(decl(title.body, 'text-overflow'), 'ellipsis');
});

// Keyboard focus follows the DOM order (title, tabs, close button), so no rule may draw the header in another order:
// an order, a reversed flex direction or an explicit grid placement would put the close button, or a tab, where focus
// does not go next.
test('no rule draws the install header in a different order than its markup', () => {
  const placed = rules.filter(
    r =>
      r.selectors.some(s => s === HEADER || s.startsWith(`${HEADER} `)) &&
      ['order', 'grid-area', 'grid-row', 'grid-column', 'grid-template-areas'].some(p => decl(r.body, p) !== undefined),
  );
  assert.deepEqual(
    placed.map(r => `${r.media || 'base'}: ${r.selectors.join(', ')}`),
    [],
  );
  const flow = rules.filter(r => r.selectors.includes(HEADER) && /reverse/.test(decl(r.body, 'flex-direction') ?? ''));
  assert.deepEqual(flow, []);
});

test('below 700px the title has a row of its own and the tabs share the next one with the close button', () => {
  const title = rules.find(r => !r.media && r.selectors.includes(`${HEADER} h2`));
  assert.ok(title, 'no title rule');
  assert.equal(decl(title.body, 'flex'), '1 1 100%');
  const base = rules.find(r => r.selectors.includes(PILL) && !r.media);
  assert.ok(base, 'no base rule for the pill');
  assert.equal(decl(base.body, 'width'), undefined, 'a full-width pill would push the close button to another row');
  assert.equal(decl(base.body, 'flex'), '1 1 0');
  // Only on a phone: in the grid a zero minimum would let the middle track shrink below the tabs.
  assert.equal(decl(base.body, 'min-width'), undefined);
  const phone = rules.find(r => r.media === '@media (max-width: 699.98px)' && r.selectors.includes(PILL));
  assert.ok(phone, 'no phone rule for the pill');
  assert.equal(decl(phone.body, 'min-width'), '0');
});

// Each tab keeps 128px from 700px, where the header has room. On a phone the pill shares its row with the close
// button, which at 320px leaves 244px minus the button: two 128px tabs overflowed the pill by 12px before the button
// was counted, so the tabs shrink and their labels wrap.
test('the tabs lose their 128px minimum below 700px', () => {
  const tab = rules.find(
    r => !r.media && r.selectors.includes('.plugins-page .install-tab') && decl(r.body, 'min-width'),
  );
  assert.ok(tab, 'no base rule for the tab');
  assert.equal(decl(tab.body, 'min-width'), '128px');
  const phone = rules.filter(
    r => r.media === '@media (max-width: 699.98px)' && r.selectors.includes('.plugins-page .install-tab'),
  );
  assert.equal(phone.length, 1, 'expected one phone rule for the tab');
  assert.equal(decl(phone[0].body, 'min-width'), '0');
});

// Beside the 280px status rail the card grid keeps a 320px minimum track. With the sidebar open that needs 948px
// of viewport; from 861px up to there the cards were wider than their column and lost their right edge and their
// action buttons. Below that the rail stacks above the cards.
test('the status rail stacks above the cards before the card column gets too narrow', () => {
  const stacked = rules.filter(
    r => r.selectors.includes('.plugins-page .plugins-layout') && decl(r.body, 'flex-direction') === 'column',
  );
  assert.equal(stacked.length, 1, 'expected one rule that stacks the rail');
  const width = Number(/max-width: (\d+)px/.exec(stacked[0].media)?.[1]);
  assert.ok(width >= 950, `the rail stacks at ${stacked[0].media || 'every width'}`);
});

// The side-by-side rail is pinned with position: sticky. A rail taller than the window (about 17 enabled plugins in a
// 650px window) stayed pinned with its lower entries below the fold at every scroll position, so it is bounded by the
// window and scrolls inside itself; stacked above the cards it flows with the page again.
const RAIL = '.plugins-page .plugins-rail';

test('the pinned status rail is bounded by the window and scrolls inside itself', () => {
  const rail = rules.find(r => !r.media && r.selectors.includes(RAIL));
  assert.ok(rail, 'no base rail rule');
  const heights = [...rail.body.matchAll(/max-height\s*:\s*([^;]+)/g)].map(m => m[1].trim());
  assert.deepEqual(heights, ['calc(100vh - 3rem)', 'calc(100dvh - 3rem)']);
  assert.equal(decl(rail.body, 'overflow-y'), 'auto');
});

test('the stacked rail is not bounded', () => {
  const stacked = rules.find(r => r.media === '@media (max-width: 950px)' && r.selectors.includes(RAIL));
  assert.ok(stacked, 'no stacked rail rule');
  assert.equal(decl(stacked.body, 'max-height'), 'none');
  assert.equal(decl(stacked.body, 'overflow-y'), 'visible');
});
