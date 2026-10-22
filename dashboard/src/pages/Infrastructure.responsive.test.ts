import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

// The two columns of cards need 1035px of viewport with the sidebar open (the widest card holds a form row that is
// 378px wide at its narrowest) and 1190px in German, whose labels are wider. Down to 900px the page spilled past
// the window (41px at 960px), and the right-hand card lost its edge and its badge. Below 1200px the cards stack.
const rules = readRules(new URL('./Infrastructure.css', import.meta.url));

test('the infrastructure cards stack before the columns overflow', () => {
  const stacked = rules.filter(
    r =>
      r.selectors.includes('.infrastructure-page .infra-sections') &&
      decl(r.body, 'grid-template-columns') === 'minmax(0, 1fr)',
  );
  assert.equal(stacked.length, 1, 'expected one rule that stacks the cards in a track that can shrink');
  const width = Number(/max-width: (\d+)px/.exec(stacked[0].media)?.[1]);
  assert.ok(width >= 1200, `the cards stack at ${stacked[0].media || 'every width'}`);
});

// A plain 1fr track never shrinks below the widest content in it, and the three queue counters are a nowrap row: in
// German on a phone they widened the single card track to 392px, so every card ran past the right edge of a 390px
// window (84px of page overflow at 320px). The track may shrink, and the counters wrap onto a second line.
test('the queue counters wrap on a phone', () => {
  const wrap = rules.filter(
    r => r.selectors.includes('.infrastructure-page .stat-values') && decl(r.body, 'flex-wrap'),
  );
  assert.equal(wrap.length, 1, 'expected one rule that lets the counters wrap');
  assert.equal(decl(wrap[0].body, 'flex-wrap'), 'wrap');
});

test('the data export and import buttons wrap in a card that is too narrow for both', () => {
  const actions = rules.find(r => !r.media && r.selectors.includes('.infrastructure-page .data-migration-actions'));
  assert.ok(actions, 'no .data-migration-actions rule');
  assert.equal(decl(actions.body, 'flex-wrap'), 'wrap');
});
