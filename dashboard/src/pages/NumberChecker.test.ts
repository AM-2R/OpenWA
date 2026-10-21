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

function renderComponent(role = 'operator') {
  sessionStorage.setItem('openwa_user_role', role);
  const queryClient = createTestQueryClient();
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
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Bulk/i }));
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
  const bulkTab = getByRole('button', { name: /Bulk/i });
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
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Bulk/i }));
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
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Bulk/i }));
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
    const bulkTab = rtl.screen.getByRole('button', { name: /Bulk/i });
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
  const bulkTab = rtl.screen.getByRole('button', { name: /Bulk/i });
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
  409: /The session is not connected \(HTTP 409\)/,
  429: /The gateway rate limit was reached \(HTTP 429\)/,
  503: /WhatsApp did not answer a lookup \(HTTP 503\)/,
};

for (const status of [409, 429, 503]) {
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
