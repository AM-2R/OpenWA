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
      r.selectors.includes('.infrastructure-page .infra-sections') && decl(r.body, 'grid-template-columns') === '1fr',
  );
  assert.equal(stacked.length, 1, 'expected one rule that stacks the cards');
  const width = Number(/max-width: (\d+)px/.exec(stacked[0].media)?.[1]);
  assert.ok(width >= 1200, `the cards stack at ${stacked[0].media || 'every width'}`);
});
