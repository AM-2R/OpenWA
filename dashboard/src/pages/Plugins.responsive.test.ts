import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

const rules = readRules(new URL('./Plugins.css', import.meta.url));

// The Upload/Catalog pill in the install modal header. Centred with absolute positioning it takes no part in
// flex-wrap, so on a phone it was drawn over the title ("Insta" and a tab). It is centred only where the header
// has room beside the longest translated title, and takes a row of its own below that.
const PILL = '.plugins-page .install-modal .modal-header .install-tabs';

test('the install tabs are centred over the header only on wide screens', () => {
  const centred = rules.filter(r => r.selectors.includes(PILL) && decl(r.body, 'position') === 'absolute');
  assert.equal(centred.length, 1, 'expected one rule that pins the pill');
  assert.equal(centred[0].media, '@media (min-width: 700px)');
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
