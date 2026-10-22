// The sidebar theme button cycles light, dark and "follow the system". The choice is stored, so a button
// that only flipped light and dark lost "System" for good after the first click.
import '../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let rtl: typeof import('@testing-library/react');
let Layout: (typeof import('./Layout.tsx'))['Layout'];
let MemoryRouter: (typeof import('react-router-dom'))['MemoryRouter'];
let RoleContext: (typeof import('../hooks/useRole.tsx'))['RoleContext'];
// Every URL the layout asked for.
const requested: string[] = [];

/** The layout for a key of `userRole` (admin by default), restricted to selected sessions when `scoped` is set. */
function renderLayout(
  scoped = false,
  userRole: 'admin' | 'operator' | 'viewer' = 'admin',
): ReturnType<typeof import('@testing-library/react').render> {
  const role = {
    role: 'admin' as const,
    setRole: () => undefined,
    isAdmin: true,
    isOperator: true,
    isViewer: false,
    canWrite: true,
    engineType: 'whatsapp-web.js',
    setEngineType: () => undefined,
    scoped,
    setScoped: () => undefined,
  };
  return rtl.render(
    createElement(
      RoleContext.Provider,
      { value: role },
      createElement(MemoryRouter, null, createElement(Layout, { onLogout: () => undefined, userRole })),
    ),
  );
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  // jsdom has no matchMedia; the theme hook reads it for the system preference.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    requested.push(String(input));
    return Promise.resolve(new Response(JSON.stringify({ message: 'unstubbed' }), { status: 404 }));
  }) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ Layout } = await import('./Layout.tsx'));
  ({ RoleContext } = await import('../hooks/useRole.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  requested.length = 0;
});

after(() => rtl.cleanup());

test('the theme button can return to following the system', () => {
  localStorage.removeItem('openwa_theme');
  const { container } = renderLayout();
  const button = container.querySelector<HTMLButtonElement>('.appearance-menu .theme-toggle-btn')!;
  const seen = [button.textContent];
  for (let i = 0; i < 3; i++) {
    const announced = button.getAttribute('aria-label');
    rtl.fireEvent.click(button);
    seen.push(button.textContent);
    // The label names the state the click selects.
    assert.equal(announced, `Switch to ${button.textContent}`);
  }
  assert.deepEqual(seen, ['System', 'Light', 'Dark', 'System']);
  assert.equal(localStorage.getItem('openwa_theme'), 'system');
});

// Collapsing is a desktop preference: the phone drawer has no collapse control, so a flag left over from a wider
// window must not strip its labels, and the window widening again must find the preference where it was left.
test('a collapsed sidebar shows its labels in the phone drawer and collapses again on desktop', () => {
  const width = window.innerWidth;
  try {
    const { container } = renderLayout();
    const sidebar = container.querySelector('aside.sidebar')!;
    rtl.fireEvent.click(container.querySelector('.collapse-toggle')!);
    assert.ok(sidebar.classList.contains('collapsed'));
    assert.equal(container.querySelectorAll('.nav-item span').length, 0, 'the collapsed desktop sidebar shows labels');

    window.innerWidth = 500;
    rtl.fireEvent(window, new window.Event('resize'));
    assert.ok(sidebar.classList.contains('mobile'));
    assert.ok(!sidebar.classList.contains('collapsed'), 'the phone drawer kept the collapsed class');
    const labels = Array.from(container.querySelectorAll('.nav-item')).map(item => item.textContent);
    assert.ok(labels.length > 0 && labels.every(label => label), `the drawer entries read ${JSON.stringify(labels)}`);
    assert.ok(container.querySelector('.sidebar-brand'), 'the drawer has no brand');
    assert.equal(container.querySelector('.logout-btn')!.textContent, 'Logout');
    assert.ok(!container.querySelector('main')!.classList.contains('expanded'));

    window.innerWidth = width;
    rtl.fireEvent(window, new window.Event('resize'));
    assert.ok(sidebar.classList.contains('collapsed'), 'the desktop preference was lost');
  } finally {
    window.innerWidth = width;
  }
});

// The phone drawer is opened and closed with the header menu button. The button said "Expand" in both states and did
// not expose whether the drawer was open, and Escape (the one way a keyboard or switch user dismisses an overlay) did
// nothing.
test('the phone menu button names its state and Escape closes the drawer and returns focus to it', () => {
  const width = window.innerWidth;
  try {
    window.innerWidth = 390;
    const { container } = renderLayout();
    const sidebar = container.querySelector('aside.sidebar')!;
    const button = container.querySelector<HTMLButtonElement>('.mobile-menu-btn')!;
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.getAttribute('aria-label'), 'Expand');

    rtl.fireEvent.click(button);
    assert.ok(sidebar.classList.contains('open'));
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(button.getAttribute('aria-label'), 'Close');
    assert.ok(rtl.screen.getByRole('button', { name: 'Close' }) === button);

    rtl.fireEvent.click(button);
    assert.ok(!sidebar.classList.contains('open'));
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.getAttribute('aria-label'), 'Expand');

    // Escape from inside the drawer: it closes, and focus lands on the button rather than on a link now off screen.
    rtl.fireEvent.click(button);
    rtl.screen.getByRole('link', { name: 'Sessions' }).focus();
    rtl.fireEvent.keyDown(document, { key: 'Escape' });
    assert.ok(!sidebar.classList.contains('open'), 'Escape left the drawer open');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.ok(document.activeElement === button, `focus is on ${document.activeElement?.className}`);

    // Closed, Escape is not listened for: it must not pull focus to the button.
    rtl.screen.getByRole('link', { name: 'Sessions' }).focus();
    rtl.fireEvent.keyDown(document, { key: 'Escape' });
    assert.ok(document.activeElement !== button, 'Escape moved focus while the drawer was closed');
  } finally {
    window.innerWidth = width;
  }
});

// Closed, the phone drawer is only moved off screen: its links stayed in the tab order, so a keyboard user stepped
// through a dozen invisible stops after the menu button. Inert takes them out until the drawer opens.
test('the closed phone drawer is inert, the open one and the desktop sidebar are not', () => {
  const width = window.innerWidth;
  try {
    window.innerWidth = 390;
    const phone = renderLayout();
    const drawer = phone.container.querySelector('aside.sidebar')!;
    assert.ok(drawer.hasAttribute('inert'), 'the closed drawer is still focusable');
    rtl.fireEvent.click(phone.container.querySelector('.mobile-menu-btn')!);
    assert.ok(!drawer.hasAttribute('inert'), 'the open drawer is inert');
    rtl.fireEvent.click(phone.container.querySelector('.mobile-menu-btn')!);
    assert.ok(drawer.hasAttribute('inert'), 'the drawer is focusable again after closing');
    phone.unmount();

    window.innerWidth = 1024;
    const desktop = renderLayout();
    assert.ok(!desktop.container.querySelector('aside.sidebar')!.hasAttribute('inert'), 'the desktop sidebar is inert');
  } finally {
    window.innerWidth = width;
  }
});

// The language menu lives in the drawer footer; Escape dismisses the innermost overlay first.
test('Escape closes the open language menu before the phone drawer', () => {
  const width = window.innerWidth;
  try {
    window.innerWidth = 390;
    const { container } = renderLayout();
    const sidebar = container.querySelector('aside.sidebar')!;
    rtl.fireEvent.click(container.querySelector('.mobile-menu-btn')!);
    rtl.fireEvent.click(container.querySelector('.language-menu .theme-toggle-btn')!);
    assert.ok(container.querySelector('.language-menu-list'));

    rtl.fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(container.querySelector('.language-menu-list'), null, 'Escape left the language menu open');
    assert.ok(sidebar.classList.contains('open'), 'the same Escape also closed the drawer');

    rtl.fireEvent.keyDown(document, { key: 'Escape' });
    assert.ok(!sidebar.classList.contains('open'), 'a second Escape left the drawer open');
  } finally {
    window.innerWidth = width;
  }
});

// The key management, infrastructure and plugin routes refuse a key restricted to selected sessions, whatever
// its role, and every refusal lands in the audit log as a failed attempt.
test('an admin key scoped to sessions is not offered the pages that refuse it', async () => {
  renderLayout(true);
  const { screen } = rtl;
  assert.equal(screen.queryByRole('link', { name: 'API Keys' }) === null, true);
  assert.equal(screen.queryByRole('link', { name: 'Infrastructure' }) === null, true);
  assert.equal(screen.queryByRole('link', { name: 'Plugins' }) === null, true);
  // The audit read is filtered to the key's sessions, not refused.
  assert.ok(screen.getByRole('link', { name: 'Logs' }));
  await rtl.waitFor(() => assert.ok(requested.some(url => url.includes('/health'))));
  assert.equal(
    requested.some(url => url.includes('/infra/update-check')),
    false,
  );
});

test('an unscoped admin key still checks for a newer release', async () => {
  renderLayout();
  assert.ok(rtl.screen.getByRole('link', { name: 'Plugins' }));
  await rtl.waitFor(() => assert.ok(requested.some(url => url.includes('/infra/update-check'))));
});

// The sidebar offers the Number Checker to every role; a viewer key gets the page with its Check buttons disabled.
for (const userRole of ['admin', 'operator', 'viewer'] as const) {
  test(`the Number Checker is offered to ${userRole} keys`, () => {
    renderLayout(false, userRole);
    assert.equal(rtl.screen.getByRole('link', { name: 'Number Checker' }).getAttribute('href'), '/number-checker');
  });
}
