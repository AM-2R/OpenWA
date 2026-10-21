import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

const rules = readRules(new URL('./Plugins.css', import.meta.url));

// The Upload/Catalog pill in the install modal header. Centred with absolute positioning it took no part in
// flex-wrap, so on a phone it was drawn over the title ("Insta" and a tab), and it took no part in sizing the
// title either, so a long translated title (Telugu) ran under it at every width. From 700px the header is three
// tracks with the pill in the middle one, so the title is cut inside its own track; below that the pill takes a
// row of its own.
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

test('below that the install tabs wrap to a row of their own', () => {
  const base = rules.find(r => r.selectors.includes(PILL) && !r.media);
  assert.ok(base, 'no base rule for the pill');
  assert.equal(decl(base.body, 'position'), undefined);
  assert.equal(decl(base.body, 'width'), '100%');
  assert.equal(decl(base.body, 'order'), '3');
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
