import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

// The global select rule reserves 2.5rem at the end for its chevron. The webhook filter row has two selects of a
// fixed width, so that reservation took 32px of text from each: in French "Type de discussion" and in Turkish
// "eşit değildir" ended mid-letter under the arrow. The row asks for the chevron's room and no more, and its bases
// leave the text box the labels of the shipped locales need.
const filter = readRules(new URL('./FilterBuilder.css', import.meta.url));
const global = readRules(new URL('../index.css', import.meta.url));
const body = (rules: ReturnType<typeof readRules>, selector: string, media = ''): string =>
  rules.find(r => r.media === media && r.selectors.includes(selector))?.body ?? '';

const REM = 16;
const px = (value: string | undefined): number => {
  assert.ok(value, 'a length is missing');
  const m = /^(-?[\d.]+)(rem|px)\b/.exec(value);
  assert.ok(m, `not a length: ${value}`);
  return m[2] === 'rem' ? Number(m[1]) * REM : Number(m[1]);
};

// Where the chevron ends: its offset from the edge plus its own width, read from the global rule.
const chevronEnd = (): number => {
  const select = body(global, 'select');
  const offset = /right\s+([\d.]+rem)/.exec(decl(select, 'background-position') ?? '')?.[1];
  return px(offset) + px(decl(select, 'background-size'));
};

test('the filter row selects keep the room the chevron takes, and no more', () => {
  const end = px(decl(body(filter, '.filter-row select'), 'padding-inline-end')?.replace(/\s*!important$/, ''));
  assert.match(decl(body(filter, '.filter-row select'), 'padding-inline-end') ?? '', /!important$/);
  assert.ok(end >= chevronEnd(), `${end}px under the chevron, which ends ${chevronEnd()}px from the edge`);
  assert.ok(end < px(decl(body(global, 'select'), 'padding-inline-end')?.replace(/\s*!important$/, '')));
});

test('a label the filter row cannot show whole ends in an ellipsis', () => {
  assert.equal(decl(body(filter, '.filter-row select'), 'text-overflow'), 'ellipsis');
});

// Widest option, in px at 13px text, across the 15 shipped locales, measured in a browser: 134 for the field
// (Italian "Corpo del messaggio" is 133; French and Turkish have one label over 170px that ends in an ellipsis)
// and 83 for the operator (Indonesian and Korean).
test('the field and the operator selects leave room for the labels of the shipped locales', () => {
  const row = body(filter, '.filter-row select');
  const chrome =
    px(decl(row, 'padding')?.split(/\s+/)[1]) + px(decl(row, 'padding-inline-end')?.replace(/\s*!important$/, '')) + 2;
  const text = (selector: string): number => px(decl(body(filter, selector), 'flex')?.split(/\s+/)[2]) - chrome;
  assert.ok(text('.filter-field') >= 133, `${text('.filter-field')}px of text in the field select`);
  assert.ok(text('.filter-operator') >= 83, `${text('.filter-operator')}px of text in the operator select`);
});

test('a 320px phone gives the field select a row of its own', () => {
  assert.equal(decl(body(filter, '.filter-field', '@media (max-width: 340px)'), 'flex-basis'), '100%');
});
