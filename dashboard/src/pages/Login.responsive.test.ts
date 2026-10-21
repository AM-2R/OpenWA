import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

// The login screen is position: fixed, so it never extends the page. On a window shorter than the card (a phone
// in landscape, a page zoomed to 200 percent) the logo and the footer link were cut off with nothing to scroll.
// Centring with justify-content cuts both ends of an overflowing column equally, and scrolling cannot reach the
// part above the top edge, so the card and the footer centre themselves with auto margins instead.
const rules = readRules(new URL('./Login.css', import.meta.url));
const body = (selector: string): string => rules.find(r => !r.media && r.selectors.includes(selector))?.body ?? '';

test('the login container scrolls when the window is shorter than its content', () => {
  assert.equal(decl(body('.login-container'), 'overflow-y'), 'auto');
});

test('the login content centres with auto margins, which give way to scrolling', () => {
  assert.equal(decl(body('.login-container'), 'justify-content'), undefined);
  assert.equal(decl(body('.login-container .login-card'), 'margin-top'), 'auto');
  assert.equal(decl(body('.login-container .login-footer'), 'margin-bottom'), 'auto');
});
