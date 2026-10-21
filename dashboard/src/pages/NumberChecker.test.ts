import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let NumberChecker: typeof import('./NumberChecker.tsx').NumberChecker;
let NUMBER_CHECK_BATCH_MAX: typeof import('./NumberChecker.tsx').NUMBER_CHECK_BATCH_MAX;
let ToastProvider: typeof import('../components/Toast.tsx').ToastProvider;
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;
let RoleProvider: typeof import('../components/RoleProvider.tsx').RoleProvider;
let defaultFetch: typeof fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function renderComponent(role = 'operator', queryClient = createTestQueryClient()) {
  sessionStorage.setItem('openwa_user_role', role);
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        RoleProvider,
        null,
        createElement(ToastProvider, null, createElement(MemoryRouter, null, createElement(NumberChecker))),
      ),
    ),
  );
}

// Answers every number lookup with `answer(number)` and returns the numbers looked up, in order.
function stubLookups(answer: (number: string) => Response): string[] {
  const lookups: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/contacts/check/')) {
      const number = url.split('/contacts/check/')[1];
      lookups.push(number);
      return Promise.resolve(answer(number));
    }
    return defaultFetch(input);
  }) as typeof fetch;
  return lookups;
}

const registered = (number: string) => jsonResponse({ number, exists: true, whatsappId: `${number}@c.us` });

async function openBulkTab(): Promise<HTMLTextAreaElement> {
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: /Bulk/i }));
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  return rtl.screen.getByPlaceholderText(/9612345678/i) as HTMLTextAreaElement;
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  defaultFetch = (() =>
    Promise.resolve(
      jsonResponse([
        {
          id: 'test-session-1',
          name: 'Primary Session',
          status: 'ready',
          phone: '919876543210',
        },
      ]),
    )) as typeof fetch;
  globalThis.fetch = defaultFetch;

  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ NumberChecker, NUMBER_CHECK_BATCH_MAX } = await import('./NumberChecker.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  globalThis.fetch = defaultFetch;
  sessionStorage.clear();
});

test('NumberChecker: renders single check form and tabs', () => {
  const { getByText, getByPlaceholderText } = renderComponent();
  assert.ok(getByText('Check Single Account'));
  assert.ok(getByPlaceholderText('e.g. 919876543210 or 6281234567890 (with country code)'));
});

test('NumberChecker: switches to bulk / batch tab when clicked', () => {
  const { getByRole, getAllByText } = renderComponent();
  const bulkTab = getByRole('tab', { name: /Bulk/i });
  rtl.fireEvent.click(bulkTab);
  const headings = getAllByText('Bulk Number Checker');
  assert.ok(headings.length >= 1);
});

// The +91 rewrite is opt-in: `autoPrefix` is whether the box is ticked before the number is checked.
for (const [raw, autoPrefix, expected] of [
  ['+65 8123 4567', true, '6581234567'],
  ['0065 8123 4567', true, '6581234567'],
  ['+65 8123 4567', false, '6581234567'],
  ['0065 8123 4567', false, '6581234567'],
  ['08123456789', false, '08123456789'],
  ['4155552671', false, '4155552671'],
  ['9876543210', false, '9876543210'],
  ['09876543210', false, '09876543210'],
  ['9109876543210', false, '9109876543210'],
  ['9876543210', true, '919876543210'],
  ['09876543210', true, '919876543210'],
  ['08123456789', true, '918123456789'],
] as const) {
  test(`NumberChecker: checks ${raw} as ${expected} with auto-prefix ${autoPrefix}`, async () => {
    const lookups: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/contacts/check/')) {
        const number = url.split('/contacts/check/')[1];
        lookups.push(number);
        return Promise.resolve(jsonResponse({ number, exists: false, whatsappId: null }));
      }
      return defaultFetch(input);
    }) as typeof fetch;

    const { container } = renderComponent();
    await rtl.screen.findByRole('option', { name: /Primary Session/ });
    if (autoPrefix) rtl.fireEvent.click(rtl.screen.getByRole('checkbox'));
    assert.equal((rtl.screen.getByRole('checkbox') as HTMLInputElement).checked, autoPrefix);
    rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9876543210/), { target: { value: raw } });
    if (raw.startsWith('+') || raw.startsWith('00')) {
      assert.ok(!container.querySelector('.nc-format-preview')?.textContent?.includes('auto-prefixed'));
    }
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Check' }));
    await rtl.screen.findByText('Not Registered', { selector: '.nc-status-badge' });
    assert.deepEqual(lookups, [expected]);
  });
}

// The preview describes the number that will be looked up, not the digits that were typed.
for (const [typed, autoPrefix, expected] of [
  ['0065 8123 4567', false, 'Will check as: +6581234567 (10 digits)'],
  ['+65 8123 4567', true, 'Will check as: +6581234567 (10 digits)'],
  ['916581234567', false, 'Will check as: +916581234567 (12 digits \u2192 kept as-is)'],
  ['9876543210', true, 'Will check as: +919876543210 (10 digits \u2192 auto-prefixed with 91)'],
] as const) {
  test(`NumberChecker: the preview for ${typed} with auto-prefix ${autoPrefix} reads ${expected}`, async () => {
    const { container } = renderComponent();
    await rtl.screen.findByRole('option', { name: /Primary Session/ });
    if (autoPrefix) rtl.fireEvent.click(rtl.screen.getByRole('checkbox'));
    rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9876543210/), { target: { value: typed } });
    assert.equal(container.querySelector('.nc-format-preview')?.textContent, expected);
  });
}

test('NumberChecker: bulk parsing deduplicates explicit international numbers without adding +91', async () => {
  const lookups: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/contacts/check/')) {
      const number = url.split('/contacts/check/')[1];
      lookups.push(number);
      return Promise.resolve(jsonResponse({ number, exists: false, whatsappId: null }));
    }
    return defaultFetch(input);
  }) as typeof fetch;

  renderComponent();
  const textarea = await openBulkTab();
  rtl.fireEvent.click(rtl.screen.getByRole('checkbox'));
  rtl.fireEvent.change(textarea, { target: { value: '+65 8123 4567\n0065 8123 4567' } });
  assert.match(rtl.screen.getByText(/ten-digit/).textContent ?? '', /0 ten-digit/);
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));
  await rtl.screen.findByText('+6581234567');
  assert.deepEqual(lookups, ['6581234567']);
});

// A number typed or pasted with another script's decimal digits is the same number: it reaches the gateway in ASCII.
const toDigits = (ascii: string, zero: number) => [...ascii].map(d => String.fromCharCode(zero + Number(d))).join('');
const DIGIT_SCRIPTS = [
  ['Arabic-Indic', 0x0660],
  ['Persian', 0x06f0],
  ['Devanagari', 0x0966],
  ['Telugu', 0x0c66],
  ['full-width', 0xff10],
] as const;

for (const [script, zero] of DIGIT_SCRIPTS) {
  test(`NumberChecker: ${script} digits are previewed and looked up as ASCII digits`, async () => {
    const lookups = stubLookups(registered);
    const { container } = renderComponent();
    await rtl.screen.findByRole('option', { name: /Primary Session/ });
    rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9876543210/), {
      target: { value: toDigits('6281234567891', zero) },
    });
    assert.match(container.querySelector('.nc-format-preview')?.textContent ?? '', /\+6281234567891 \(13 digits\)/);
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Check' }));
    await rtl.screen.findByText('Registered', { selector: '.nc-status-badge' });
    assert.deepEqual(lookups, ['6281234567891']);
  });
}

test('NumberChecker: a bulk list in several scripts is parsed and deduplicated as ASCII numbers', async () => {
  const lookups = stubLookups(registered);
  renderComponent();
  const textarea = await openBulkTab();
  const list = [toDigits('6281234567891', 0x0660), toDigits('6281234567892', 0xff10), '6281234567891'].join('\n');
  rtl.fireEvent.change(textarea, { target: { value: list } });
  assert.match(rtl.screen.getByText(/unique numbers parsed/).textContent ?? '', /\b2 unique numbers parsed$/);
  startBatch();
  await rtl.screen.findByText('Completed checking 2 numbers.', {}, { timeout: 3000 });
  assert.deepEqual(lookups, ['6281234567891', '6281234567892']);
});

// A plus sign that arrives behind invisible direction marks, or as a full-width character, still marks an international
// number: with the +91 rule on, losing it would look a foreign 10-digit number up as an Indian one.
const char = (code: number) => String.fromCharCode(code);
const WRAPPED_PLUS = [
  ['direction marks around the number', `${char(0x202a)}+65 8123 4567${char(0x202c)}`],
  ['a right-to-left mark before the plus', `${char(0x200f)}+65 8123 4567`],
  ['a full-width plus', `${char(0xff0b)}65 8123 4567`],
] as const;

for (const [label, typed] of WRAPPED_PLUS) {
  test(`NumberChecker: with +91 on, ${label} still marks an international number`, async () => {
    const lookups = stubLookups(registered);
    renderComponent();
    await rtl.screen.findByRole('option', { name: /Primary Session/ });
    rtl.fireEvent.click(rtl.screen.getByRole('checkbox'));
    rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9876543210/), { target: { value: typed } });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Check' }));
    await rtl.screen.findByText('Registered', { selector: '.nc-status-badge' });
    assert.deepEqual(lookups, ['6581234567']);
  });
}

test('NumberChecker: a bulk list keeps wrapped and full-width plus numbers international with +91 on', async () => {
  const lookups = stubLookups(registered);
  renderComponent();
  const textarea = await openBulkTab();
  rtl.fireEvent.click(rtl.screen.getByRole('checkbox'));
  rtl.fireEvent.change(textarea, {
    target: { value: WRAPPED_PLUS.map(([, typed]) => typed).join('\n') + `\n${char(0x200f)}+65 9123 4567` },
  });
  assert.match(rtl.screen.getByText(/unique numbers parsed/).textContent ?? '', /\b2 unique numbers parsed$/);
  startBatch();
  await rtl.screen.findByText('Completed checking 2 numbers.', {}, { timeout: 3000 });
  assert.deepEqual(lookups, ['6581234567', '6591234567']);
});

test('NumberChecker: bulk parsing also splits on the Arabic comma and semicolon', async () => {
  stubLookups(registered);
  renderComponent();
  const textarea = await openBulkTab();
  const arabicComma = String.fromCharCode(0x060c);
  const arabicSemicolon = String.fromCharCode(0x061b);

  rtl.fireEvent.change(textarea, {
    target: { value: `+6581234567${arabicComma}+6591234567${arabicSemicolon}+6561234567` },
  });

  assert.match(rtl.screen.getByText(/unique numbers parsed/).textContent ?? '', /\b3 unique numbers parsed$/);
});

test('NumberChecker: numbers and ids are isolated as left-to-right, so a right-to-left page keeps them in order', async () => {
  stubLookups(registered);
  const { container } = renderComponent();
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9876543210/), { target: { value: '+65 8123 4567' } });
  assert.equal(container.querySelector('.nc-format-pill strong')?.getAttribute('dir'), 'ltr');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Check' }));
  await rtl.screen.findByText('Registered', { selector: '.nc-status-badge' });

  const phone = container.querySelector('.nc-result-phone bdi');
  assert.equal(phone?.getAttribute('dir'), 'ltr');
  assert.equal(phone?.textContent, '+6581234567');
  const jid = container.querySelector('.nc-detail-value bdi');
  assert.equal(jid?.getAttribute('dir'), 'ltr');
  assert.equal(jid?.textContent, '6581234567@c.us');
});

test('NumberChecker: the number field and the bulk list are typed left to right, so a right-to-left page keeps the plus sign in front', async () => {
  const { container } = renderComponent();
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  assert.equal(rtl.screen.getByPlaceholderText(/9876543210/).getAttribute('dir'), 'ltr');

  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: /Bulk/i }));
  assert.equal(container.querySelector('.nc-textarea')?.getAttribute('dir'), 'ltr');
});

test('NumberChecker: both result tables sit in a scroll container, so a narrow card does not clip them', async () => {
  stubLookups(registered);
  const { container } = renderComponent();
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9876543210/), { target: { value: '919876543210' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Check' }));
  await rtl.screen.findByText('Registered', { selector: '.nc-status-badge' });
  assert.equal(container.querySelectorAll('.nc-history-table').length, 1);
  assert.equal(container.querySelector('.nc-history-table')?.parentElement?.className, 'nc-table-wrap');

  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: /Bulk/i }));
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9612345678/i), { target: { value: '911111111111' } });
  startBatch();
  await rtl.screen.findByText('+911111111111');
  assert.equal(container.querySelectorAll('.nc-history-table').length, 1);
  assert.equal(container.querySelector('.nc-history-table')?.parentElement?.className, 'nc-table-wrap');
});

test('NumberChecker: the Message Tester button reads as a plain link, because it passes no number along', async () => {
  stubLookups(registered);
  renderComponent();
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9876543210/), { target: { value: '919876543210' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Check' }));
  await rtl.screen.findByText('Registered', { selector: '.nc-status-badge' });
  assert.ok(rtl.screen.getByRole('button', { name: 'Go to Message Tester' }));
});

test('NumberChecker: every number and id cell of both result tables is isolated as left-to-right', async () => {
  stubLookups(number =>
    number === '916581234567' ? jsonResponse({ number, exists: false, whatsappId: null }) : registered(number),
  );
  const { container } = renderComponent();
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  const phone = rtl.screen.getByPlaceholderText(/9876543210/);
  const check = () => rtl.screen.getByRole('button', { name: 'Check' });
  rtl.fireEvent.change(phone, { target: { value: '+65 8123 4567' } });
  rtl.fireEvent.click(check());
  await rtl.screen.findByText('Registered', { selector: '.nc-status-badge' });
  rtl.fireEvent.change(phone, { target: { value: '916581234567' } });
  rtl.fireEvent.click(check());
  await rtl.screen.findByText('Unregistered', { selector: '.nc-status-badge' });

  // Each row: the dir of the isolating wrapper of its number cell and of its id cell, an id placeholder included.
  const isolation = (columns: [number, number]) =>
    [...container.querySelectorAll('.nc-history-table tbody tr')].map(row =>
      columns.map(column => row.children[column].querySelector('bdi')?.getAttribute('dir')),
    );
  assert.deepEqual(isolation([0, 2]), [
    ['ltr', 'ltr'],
    ['ltr', 'ltr'],
  ]);

  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: /Bulk/i }));
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9612345678/i), { target: { value: '911111111111' } });
  startBatch();
  await rtl.screen.findByText('+911111111111');
  assert.deepEqual(isolation([1, 3]), [['ltr', 'ltr']]);
});

test('NumberChecker: the mode tabs are a tablist that reports the selected tab', () => {
  renderComponent();
  assert.ok(rtl.screen.getByRole('tablist'));
  const tabs = rtl.screen.getAllByRole('tab');
  assert.deepEqual(
    tabs.map(tab => tab.getAttribute('aria-selected')),
    ['true', 'false'],
  );
  rtl.fireEvent.click(tabs[1]);
  assert.deepEqual(
    tabs.map(tab => tab.getAttribute('aria-selected')),
    ['false', 'true'],
  );
});

test('NumberChecker: the result filters report which one is pressed', async () => {
  stubLookups(number =>
    number === '911111111111' ? jsonResponse({ message: 'engine hiccup' }, 500) : registered(number),
  );
  renderComponent();
  const textarea = await openBulkTab();
  rtl.fireEvent.change(textarea, { target: { value: '911111111111\n912222222222' } });
  startBatch();
  await rtl.screen.findByText('Completed checking 2 numbers.', {}, { timeout: 3000 });

  const pressed = () => rtl.screen.getAllByRole('button', { pressed: true }).map(button => button.textContent);
  assert.deepEqual(pressed(), ['All (2)']);
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /^Failed \(1\)/ }));
  assert.deepEqual(pressed(), ['Failed (1)']);
});

test('NumberChecker: the number field and the bulk list are named by their labels, not their placeholders', async () => {
  const { container } = renderComponent();
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  assert.equal(rtl.screen.getByLabelText('Phone Number').tagName, 'INPUT');

  rtl.fireEvent.click(container.querySelectorAll('.nc-tab')[1]);
  assert.equal(rtl.screen.getByLabelText(/Numbers to Check/).tagName, 'TEXTAREA');
});

test('NumberChecker: the run progress bar is a progressbar that reports how many numbers were checked', async () => {
  // The first lookup answers, the next ones never do, so the run stays at one of three.
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes('/contacts/check/')) return defaultFetch(input);
    return url.endsWith('/911111111111')
      ? Promise.resolve(registered('911111111111'))
      : new Promise<Response>(() => {});
  }) as typeof fetch;
  const { container } = renderComponent();
  rtl.fireEvent.click(container.querySelectorAll('.nc-tab')[1]);
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  rtl.fireEvent.change(container.querySelector('.nc-textarea')!, { target: { value: THREE_NUMBERS } });
  startBatch();

  const bar = await rtl.screen.findByRole('progressbar');
  assert.equal(bar.getAttribute('aria-valuemin'), '0');
  assert.equal(bar.getAttribute('aria-valuemax'), '3');
  await rtl.waitFor(() => assert.equal(bar.getAttribute('aria-valuenow'), '1'));
});

test('NumberChecker: a finished single check is announced through a status region that exists beforehand', async () => {
  stubLookups(registered);
  const { container } = renderComponent();
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  const region = container.querySelector('[role="status"]');
  assert.ok(region, 'there is no status region before the check');

  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9876543210/), { target: { value: '+65 8123 4567' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Check' }));
  await rtl.screen.findByText('Registered on WhatsApp');
  assert.equal(container.querySelector('[role="status"]') === region, true);
  assert.match(region.textContent ?? '', /\+6581234567.*Registered on WhatsApp/);
});

test('NumberChecker: viewers cannot start single or bulk lookups, including with Enter', async () => {
  const lookups: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/contacts/check/')) {
      lookups.push(url);
      return Promise.resolve(jsonResponse({ number: '919876543210', exists: false, whatsappId: null }));
    }
    return defaultFetch(input);
  }) as typeof fetch;

  renderComponent('viewer');
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  const input = rtl.screen.getByPlaceholderText(/9876543210/);
  rtl.fireEvent.change(input, { target: { value: '9876543210' } });
  assert.equal((rtl.screen.getByRole('button', { name: 'Check' }) as HTMLButtonElement).disabled, true);
  await rtl.act(async () => rtl.fireEvent.keyDown(input, { key: 'Enter' }));
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: /Bulk/i }));
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9612345678/i), { target: { value: '9876543210' } });
  assert.equal((rtl.screen.getByRole('button', { name: /Start Batch Check/i }) as HTMLButtonElement).disabled, true);
  assert.deepEqual(lookups, []);
});

test('NumberChecker: CSV export neutralizes error formulas and releases its object URL', async t => {
  const downloads: Blob[] = [];
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => {
    downloads.push(blob);
    return 'blob:number-checker-csv';
  });
  const revoke = t.mock.method(URL, 'revokeObjectURL');
  t.mock.method(HTMLAnchorElement.prototype, 'click', () => {});
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (String(input).includes('/contacts/check/')) {
      return Promise.resolve(jsonResponse({ message: '=HYPERLINK("https://example.com","lookup")' }, 500));
    }
    return defaultFetch(input);
  }) as typeof fetch;

  renderComponent();
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: /Bulk/i }));
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9612345678/i), { target: { value: '919999999999' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));
  await rtl.screen.findByText('Failed', { selector: '.nc-status-badge' });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Export Results/i }));

  assert.equal(downloads.length, 1);
  assert.ok((await downloads[0].text()).includes(`"'=HYPERLINK(""https://example.com"",""lookup"")"`));
  assert.equal(revoke.mock.callCount(), 1);
  assert.deepEqual(revoke.mock.calls[0].arguments, ['blob:number-checker-csv']);
  assert.equal(document.querySelector('a[download]'), null);
});

test('NumberChecker: the CSV carries each check as an ISO instant while the table shows the time of day', async t => {
  const downloads: Blob[] = [];
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => {
    downloads.push(blob);
    return 'blob:number-checker-csv';
  });
  t.mock.method(URL, 'revokeObjectURL');
  t.mock.method(HTMLAnchorElement.prototype, 'click', () => {});
  stubLookups(registered);

  const { container } = renderComponent();
  const textarea = await openBulkTab();
  rtl.fireEvent.change(textarea, { target: { value: '919999999999' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));
  await rtl.screen.findByText('+919999999999');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Export Results/i }));

  const [, row] = (await downloads[0].text()).split('\n');
  const checkedAt = row.split(',').at(-1) ?? '';
  assert.match(checkedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(Number.isNaN(Date.parse(checkedAt)), false);
  const shown = container.querySelector('.nc-history-table tbody td:last-child')?.textContent;
  assert.equal(shown, new Date(checkedAt).toLocaleTimeString());
});

test('NumberChecker: a rejected lookup is recorded as failed with error status, not as unregistered', async t => {
  t.mock.method(HTMLAnchorElement.prototype, 'click', () => {});
  const recordedDownloads: Blob[] = [];
  const realCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    recordedDownloads.push(blob);
    return 'blob:mock-csv';
  };

  try {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/contacts/check/919999999999')) {
        return Promise.resolve(jsonResponse({ message: 'Rate limit exceeded (HTTP 429)' }, 429));
      }
      return Promise.resolve(
        jsonResponse([
          {
            id: 'test-session-1',
            name: 'Primary Session',
            status: 'ready',
            phone: '919876543210',
          },
        ]),
      );
    }) as typeof fetch;

    renderComponent();

    // Switch to bulk tab
    const bulkTab = rtl.screen.getByRole('tab', { name: /Bulk/i });
    rtl.fireEvent.click(bulkTab);

    // Wait for session to be selected
    await rtl.screen.findByRole('option', { name: /Primary Session/ });

    // Enter phone number
    const textarea = rtl.screen.getByPlaceholderText(/9612345678/i);
    rtl.fireEvent.change(textarea, { target: { value: '919999999999' } });

    // Start batch
    const startBtn = rtl.screen.getByRole('button', { name: /Start Batch Check/i });
    rtl.fireEvent.click(startBtn);

    // Verify row displays Failed status and the error message
    const failedBadge = await rtl.screen.findByText('Failed', { selector: '.nc-status-badge' });
    assert.ok(failedBadge);
    assert.ok(rtl.screen.getByText('Rate limit exceeded (HTTP 429)'));

    // Verify "Not Registered" count is 0 and "Failed" count is 1
    const notRegBox = rtl.screen.getByText('Not Registered').parentElement;
    assert.ok(notRegBox?.textContent?.includes('0'));

    const failedBox = rtl.screen.getByText('Failed', { selector: '.nc-stat-label' }).parentElement;
    assert.ok(failedBox?.textContent?.includes('1'));

    // Export CSV and verify Error status is retained
    const exportBtn = rtl.screen.getByRole('button', { name: /Export Results/i });
    rtl.fireEvent.click(exportBtn);

    assert.equal(recordedDownloads.length, 1);
    const csvContent = await recordedDownloads[0].text();
    assert.ok(csvContent.includes('919999999999,Error,,Rate limit exceeded (HTTP 429),'));
    assert.ok(!csvContent.includes('919999999999,No,'));
  } finally {
    URL.createObjectURL = realCreateObjectURL;
  }
});

test('NumberChecker: Stop followed by Start while lookup is pending cancels earlier run and prevents overwriting', async () => {
  let resolveFirstLookup!: (res: Response) => void;
  const firstLookupPromise = new Promise<Response>(resolve => {
    resolveFirstLookup = resolve;
  });

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/contacts/check/911111111111')) {
      return firstLookupPromise;
    }
    if (url.includes('/contacts/check/912222222222')) {
      return Promise.resolve(jsonResponse({ number: '912222222222', exists: true, whatsappId: '912222222222@c.us' }));
    }
    return Promise.resolve(
      jsonResponse([
        {
          id: 'test-session-1',
          name: 'Primary Session',
          status: 'ready',
          phone: '919876543210',
        },
      ]),
    );
  }) as typeof fetch;

  renderComponent();

  // Switch to bulk tab
  const bulkTab = rtl.screen.getByRole('tab', { name: /Bulk/i });
  rtl.fireEvent.click(bulkTab);

  await rtl.screen.findByRole('option', { name: /Primary Session/ });

  const textarea = rtl.screen.getByPlaceholderText(/9612345678/i);

  // Run 1: Start checking 911111111111
  rtl.fireEvent.change(textarea, { target: { value: '911111111111' } });
  const startBtn = rtl.screen.getByRole('button', { name: /Start Batch Check/i });
  rtl.fireEvent.click(startBtn);

  // Stop while lookup 1 is pending
  const stopBtn = await rtl.screen.findByRole('button', { name: /Stop Checking/i });
  rtl.fireEvent.click(stopBtn);

  // Run 2: Start checking 912222222222
  rtl.fireEvent.change(textarea, { target: { value: '912222222222' } });
  const startBtnAgain = await rtl.screen.findByRole('button', { name: /Start Batch Check/i });
  rtl.fireEvent.click(startBtnAgain);

  // Late resolution of Run 1's pending lookup
  resolveFirstLookup(jsonResponse({ number: '911111111111', exists: false, whatsappId: null }));

  // Wait for Run 2 to finish
  const registeredRow = await rtl.screen.findByText('+912222222222');
  assert.ok(registeredRow);

  // Ensure Run 1's late resolution did NOT overwrite or get appended to Run 2's results
  assert.equal(rtl.screen.queryByText('+911111111111'), null);

  const checkedBox = rtl.screen.getByText('Checked', { selector: '.nc-stat-label' }).parentElement;
  assert.ok(checkedBox?.textContent?.includes('1'));

  const regBox = rtl.screen.getByText('Registered', { selector: '.nc-stat-label' }).parentElement;
  assert.ok(regBox?.textContent?.includes('1'));
});

const THREE_NUMBERS = '911111111111\n912222222222\n913333333333';
const startBatch = () => rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));
// Past the one-second pacing delay, which is when a run that went on would send its next lookup.
const pastPacing = () => new Promise(resolve => setTimeout(resolve, 1_200));

test('NumberChecker: leaving the page ends a running batch', async () => {
  const lookups = stubLookups(registered);
  const { unmount } = renderComponent();
  rtl.fireEvent.change(await openBulkTab(), { target: { value: THREE_NUMBERS } });
  startBatch();
  await rtl.waitFor(() => assert.equal(lookups.length, 1));

  unmount();
  await pastPacing();
  assert.deepEqual(lookups, ['911111111111']);
});

test('NumberChecker: Stop ends the run, so no further lookup is sent', async () => {
  const lookups = stubLookups(registered);
  renderComponent();
  rtl.fireEvent.change(await openBulkTab(), { target: { value: THREE_NUMBERS } });
  startBatch();
  await rtl.waitFor(() => assert.equal(lookups.length, 1));

  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /Stop Checking/i }));
  await pastPacing();
  assert.deepEqual(lookups, ['911111111111']);
  assert.ok(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));
});

test('NumberChecker: a lookup of an abandoned run that fails late adds no row to the next run', async () => {
  let failFirst!: () => void;
  const firstLookup = new Promise<Response>((_, reject) => {
    failFirst = () => reject(new TypeError('Failed to fetch'));
  });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/contacts/check/911111111111')) return firstLookup;
    if (url.includes('/contacts/check/')) return Promise.resolve(registered(url.split('/contacts/check/')[1]));
    return defaultFetch(input);
  }) as typeof fetch;
  renderComponent();
  const textarea = await openBulkTab();
  rtl.fireEvent.change(textarea, { target: { value: '911111111111' } });
  startBatch();
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /Stop Checking/i }));
  rtl.fireEvent.change(textarea, { target: { value: '912222222222' } });
  startBatch();
  await rtl.screen.findByText('+912222222222');

  failFirst();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(rtl.screen.queryByText('Failed', { selector: '.nc-status-badge' }) === null, true);
  assert.ok(rtl.screen.getByText('+912222222222'));
  assert.equal(statValue('Checked'), '1');
});

test('NumberChecker: the +91 rule is off by default in both tabs and the hints say numbers are checked as typed', async () => {
  renderComponent();
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  assert.equal((rtl.screen.getByRole('checkbox') as HTMLInputElement).checked, false);
  assert.ok(rtl.screen.getByText(/checked as typed/));

  const textarea = await openBulkTab();
  const box = rtl.screen.getByRole('checkbox') as HTMLInputElement;
  assert.equal(box.checked, false);
  assert.ok(rtl.screen.getByText(/checked as typed/));
  rtl.fireEvent.change(textarea, { target: { value: '08123456789\n4155552671' } });
  assert.equal(rtl.screen.queryByText(/ten-digit/), null);

  rtl.fireEvent.click(box);
  assert.match(rtl.screen.getByText(/ten-digit/).textContent ?? '', /2 ten-digit/);
  assert.equal(rtl.screen.queryByText(/checked as typed/), null);
});

test('NumberChecker: a bulk run looks numbers up as typed by default', async () => {
  const lookups = stubLookups(number => jsonResponse({ number, exists: false, whatsappId: null }));
  renderComponent();
  const textarea = await openBulkTab();
  rtl.fireEvent.change(textarea, { target: { value: '08123456789\n4155552671' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));
  await rtl.screen.findByText('Completed checking 2 numbers.', {}, { timeout: 3000 });
  assert.deepEqual(lookups, ['08123456789', '4155552671']);
});

test('NumberChecker: the pacing delay starts at one second and offers nothing faster', async () => {
  renderComponent();
  await openBulkTab();
  const select = rtl.screen.getByLabelText('Safe Pacing Delay (ms)') as HTMLSelectElement;
  assert.equal(select.value, '1000');
  assert.deepEqual(
    [...select.options].map(option => option.value),
    ['1000', '2000', '3000'],
  );
});

test('NumberChecker: a list over the per-run limit blocks Start and names the limit and the count', async () => {
  stubLookups(registered);
  const { container } = renderComponent();
  const textarea = await openBulkTab();
  const list = (count: number) =>
    Array.from({ length: count }, (_, i) => `628120${String(i).padStart(6, '0')}`).join('\n');
  const start = () => rtl.screen.getByRole('button', { name: /Start Batch Check/i }) as HTMLButtonElement;

  rtl.fireEvent.change(textarea, { target: { value: list(NUMBER_CHECK_BATCH_MAX) } });
  assert.equal(start().disabled, false);
  assert.equal(container.querySelector('.nc-batch-limit'), null);

  rtl.fireEvent.change(textarea, { target: { value: list(NUMBER_CHECK_BATCH_MAX + 1) } });
  assert.equal(start().disabled, true);
  const message = container.querySelector('.nc-batch-limit')?.textContent ?? '';
  assert.match(message, new RegExp(`${NUMBER_CHECK_BATCH_MAX + 1} parsed`));
  assert.match(message, new RegExp(`at most ${NUMBER_CHECK_BATCH_MAX} per run`));

  // Repeats collapse before the limit applies.
  rtl.fireEvent.change(textarea, { target: { value: `${list(NUMBER_CHECK_BATCH_MAX)}\n${list(5)}` } });
  assert.equal(start().disabled, false);
  assert.equal(container.querySelector('.nc-batch-limit'), null);
});

const twoSessions = (betaStatus: string) => [
  { id: 'sess-a', name: 'Alpha', status: 'ready', phone: '111' },
  { id: 'sess-b', name: 'Beta', status: betaStatus, phone: '222' },
];

test('NumberChecker: a chosen session that leaves the ready list is replaced by the one the select then shows', async () => {
  const checked: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/contacts/check/')) {
      checked.push(url);
      return Promise.resolve(jsonResponse({ number: '919876543210', exists: false, whatsappId: null }));
    }
    return Promise.resolve(jsonResponse(twoSessions('ready')));
  }) as typeof fetch;
  const client = createTestQueryClient();
  renderComponent('operator', client);
  await rtl.screen.findByRole('option', { name: /Beta/ });
  const select = rtl.screen.getByRole('combobox', { name: 'WhatsApp Session' }) as HTMLSelectElement;
  rtl.fireEvent.change(select, { target: { value: 'sess-b' } });
  assert.equal(select.value, 'sess-b');

  await rtl.act(async () => client.setQueryData(['sessions'], twoSessions('disconnected')));
  // Only Alpha is left to show, so Alpha is the session the lookup has to use.
  await rtl.waitFor(() => assert.equal(rtl.screen.queryByRole('option', { name: /Beta/ }) === null, true));
  assert.deepEqual(
    [...select.options].map(option => option.value),
    ['sess-a'],
  );
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9876543210/), { target: { value: '919876543210' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Check' }));
  await rtl.screen.findByText('Not Registered', { selector: '.nc-status-badge' });
  assert.equal(checked.length, 1);
  assert.match(checked[0], /\/sessions\/sess-a\/contacts\/check\//);
});

test('NumberChecker: the session cannot be switched from the Single tab while a bulk run is going', async () => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (String(input).includes('/contacts/check/')) return new Promise<Response>(() => {});
    return Promise.resolve(jsonResponse(twoSessions('ready')));
  }) as typeof fetch;
  renderComponent();
  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: /Bulk/i }));
  await rtl.screen.findByRole('option', { name: /Beta/ });
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9612345678/i), { target: { value: THREE_NUMBERS } });
  startBatch();
  await rtl.screen.findByRole('button', { name: /Stop Checking/i });

  rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: /Single Check/i }));
  const select = rtl.screen.getByRole('combobox', { name: 'WhatsApp Session' }) as HTMLSelectElement;
  assert.equal(select.disabled, true);
});

const statValue = (label: string) =>
  rtl.screen.getByText(label, { selector: '.nc-stat-label' }).parentElement?.querySelector('.nc-stat-number')
    ?.textContent;

test('NumberChecker: a gateway refusal stops the batch and the numbers never reached get no rows', async () => {
  const lookups = stubLookups(number =>
    number === '912222222222' ? jsonResponse({ message: 'Rate limit exceeded (HTTP 429)' }, 429) : registered(number),
  );
  const { container } = renderComponent();
  const textarea = await openBulkTab();
  rtl.fireEvent.change(textarea, { target: { value: '911111111111\n912222222222\n913333333333\n914444444444' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));

  await rtl.screen.findByText('Batch stopped', { selector: 'strong' }, { timeout: 3000 });
  const notice = container.querySelector('.nc-batch-stopped')?.textContent ?? '';
  assert.match(notice, /The gateway rate limit was reached \(HTTP 429\)/);
  assert.match(notice, /Stopped at number 2 of 4; 2 numbers were not sent/);

  // The refused lookup is a failed row; the two numbers behind it were never sent, so they have none.
  assert.ok(rtl.screen.getByText('+911111111111'));
  assert.ok(rtl.screen.getByText('Rate limit exceeded (HTTP 429)'));
  assert.equal(rtl.screen.queryByText('+913333333333'), null);
  assert.equal(rtl.screen.queryByText('+914444444444'), null);
  assert.equal(statValue('Checked'), '2');
  assert.equal(statValue('Failed'), '1');
  assert.equal(statValue('Remaining'), '2');
  assert.equal(rtl.screen.queryByText(/Completed checking/), null);
  assert.equal((rtl.screen.getByRole('button', { name: /Start Batch Check/i }) as HTMLButtonElement).disabled, false);

  // Past the pacing delay, which is when a run that went on would have looked up the third number.
  await new Promise(resolve => setTimeout(resolve, 1_200));
  assert.deepEqual(lookups, ['911111111111', '912222222222']);
});

const STOP_REASON: Record<number, RegExp> = {
  400: /The session is not connected \(HTTP 400\)/,
  409: /The session is not connected \(HTTP 409\)/,
  429: /The gateway rate limit was reached \(HTTP 429\)/,
  503: /WhatsApp did not answer a lookup \(HTTP 503\)/,
};

for (const status of [400, 409, 429, 503]) {
  test(`NumberChecker: HTTP ${status} on the first lookup stops the batch before the second`, async () => {
    const lookups = stubLookups(() => jsonResponse({ message: `refused ${status}` }, status));
    const { container } = renderComponent();
    const textarea = await openBulkTab();
    rtl.fireEvent.change(textarea, { target: { value: '911111111111\n912222222222' } });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));

    await rtl.screen.findByText('Batch stopped', { selector: 'strong' });
    const notice = container.querySelector('.nc-batch-stopped')?.textContent ?? '';
    assert.match(notice, STOP_REASON[status]);
    // Number 1 was sent and refused, so only number 2 was never sent.
    assert.match(notice, /Stopped at number 1 of 2; 1 number was not sent/);
    assert.deepEqual(lookups, ['911111111111']);
    assert.equal(rtl.screen.queryByText(/Completed checking/), null);
  });
}

test('NumberChecker: a lookup that gets no answer at all stops the batch before the second', async () => {
  const lookups: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/contacts/check/')) {
      lookups.push(url.split('/contacts/check/')[1]);
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return defaultFetch(input);
  }) as typeof fetch;
  const { container } = renderComponent();
  const textarea = await openBulkTab();
  rtl.fireEvent.change(textarea, { target: { value: '911111111111\n912222222222' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));

  await rtl.screen.findByText('Batch stopped', { selector: 'strong' });
  const notice = container.querySelector('.nc-batch-stopped')?.textContent ?? '';
  assert.match(notice, /The gateway did not answer\. Stopped at number 1 of 2\./);
  assert.deepEqual(lookups, ['911111111111']);
  assert.equal(rtl.screen.queryByText(/Completed checking/), null);
});

test('NumberChecker: a refusal on the last number says so instead of counting numbers left unsent', async () => {
  const lookups = stubLookups(number =>
    number === '912222222222' ? jsonResponse({ message: 'Rate limit exceeded (HTTP 429)' }, 429) : registered(number),
  );
  const { container } = renderComponent();
  const textarea = await openBulkTab();
  rtl.fireEvent.change(textarea, { target: { value: '911111111111\n912222222222' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));

  await rtl.screen.findByText('Batch stopped', { selector: 'strong' }, { timeout: 3000 });
  const notice = container.querySelector('.nc-batch-stopped')?.textContent ?? '';
  assert.match(notice, /The last lookup failed/);
  assert.doesNotMatch(notice, /not sent/);
  assert.deepEqual(lookups, ['911111111111', '912222222222']);
  assert.equal(rtl.screen.queryByText(/Completed checking/), null);
});

test('NumberChecker: a lookup error that is not a gateway refusal fails that number and the run goes on', async () => {
  const lookups = stubLookups(number =>
    number === '911111111111' ? jsonResponse({ message: 'engine hiccup' }, 500) : registered(number),
  );
  const { container } = renderComponent();
  const textarea = await openBulkTab();
  rtl.fireEvent.change(textarea, { target: { value: '911111111111\n912222222222' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));

  await rtl.screen.findByText('Completed checking 2 numbers.', {}, { timeout: 3000 });
  assert.deepEqual(lookups, ['911111111111', '912222222222']);
  assert.ok(rtl.screen.getByText('engine hiccup'));
  assert.ok(rtl.screen.getByText('+912222222222'));
  assert.equal(statValue('Failed'), '1');
  assert.equal(container.querySelector('.nc-batch-stopped'), null);
});

test('NumberChecker: a new run starts on the All filter, so a Failed filter left over does not hide its rows', async () => {
  stubLookups(number =>
    number === '911111111111' ? jsonResponse({ message: 'engine hiccup' }, 500) : registered(number),
  );
  const { container } = renderComponent();
  const textarea = await openBulkTab();
  rtl.fireEvent.change(textarea, { target: { value: '911111111111' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /^Failed \(1\)/ }));

  rtl.fireEvent.change(textarea, { target: { value: '912222222222' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));

  await rtl.screen.findByText('+912222222222');
  assert.match(container.querySelector('.nc-filter-btn.active')?.textContent ?? '', /^All \(1\)/);
});

test('NumberChecker: a run in which every lookup failed is not reported as completed', async () => {
  const lookups = stubLookups(() => jsonResponse({ message: 'engine hiccup' }, 500));
  const { container } = renderComponent();
  const textarea = await openBulkTab();
  rtl.fireEvent.change(textarea, { target: { value: '911111111111\n912222222222' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));

  await rtl.screen.findByText('Check failed', {}, { timeout: 3000 });
  assert.deepEqual(lookups, ['911111111111', '912222222222']);
  assert.equal(statValue('Failed'), '2');
  assert.equal(rtl.screen.queryByText(/Completed checking/), null);
  assert.equal(container.querySelector('.nc-batch-stopped'), null);
});

// The Clipboard API is missing over plain HTTP on a LAN address, where the Copy button used to throw
// before it could report anything. The house helper falls back to the textarea route.
test('NumberChecker: Copy works where navigator.clipboard does not exist', async t => {
  stubLookups(registered);
  const copy = t.mock.fn(() => true);
  const hadExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
  Object.defineProperty(document, 'execCommand', { value: copy, configurable: true, writable: true });
  t.after(() => {
    if (hadExecCommand) Object.defineProperty(document, 'execCommand', hadExecCommand);
    else delete (document as unknown as Record<string, unknown>).execCommand;
  });
  assert.equal(navigator.clipboard, undefined);

  renderComponent();
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9876543210/), { target: { value: '919876543210' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Check' }));
  await rtl.screen.findByText('Registered', { selector: '.nc-status-badge' });

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /^Copy$/ }));

  await rtl.screen.findByRole('button', { name: /Copied/ });
  assert.equal(copy.mock.callCount(), 1);
  assert.deepEqual(copy.mock.calls[0].arguments, ['copy']);
});
