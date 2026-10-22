// Render smoke test for the Infrastructure page under the bare `node --test` runner. Mirrors
// Chats.test.ts's harness: same providers, same fetch-stub-with-recorded-calls approach, same
// loader hooks. This page could not be imported by the harness at all before this file existed —
// it imports four SVG icons, and the loader only handled .css/.json/.tsx/.ts (see the `.svg`
// branch added to vite-shim-hooks.mjs alongside this test).
//
// Providers: QueryClientProvider (four GET queries: status/config/engines/current-engine) →
// RoleProvider (harmless here, kept for parity with App.tsx) → ToastProvider (useToast throws
// without it). No Router — the page uses no router hooks.
import '../test-helpers/register-hooks.ts';
import { readFileSync } from 'node:fs';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InfraStatus, SavedConfig, Engine } from '../services/api';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';

// ── Fixtures + fetch stub ────────────────────────────────────────────────────

// The form is seeded from /config, and from /status only for the built-in flags and for a host, port or
// path nothing has saved. database.host is the same in both here, so the stock fixtures do not say which
// one supplied it: username, database name, schema and pool size, which only /config carries, are what
// prove /config hydration.
const INFRA_STATUS: InfraStatus = {
  database: { connected: true, type: 'postgres', host: 'shared-db-host', builtIn: false },
  redis: { enabled: false, connected: false, host: 'localhost', port: 6379, builtIn: false },
  queue: { enabled: false, webhooks: { pending: 0, completed: 0, failed: 0 } },
  storage: { type: 'local', path: './data/media', builtIn: false },
  engine: { type: 'whatsapp-web.js', headless: true },
};

const SAVED_CONFIG: SavedConfig = {
  database: {
    type: 'postgres',
    builtIn: false,
    builtInSet: true,
    host: 'shared-db-host',
    port: '6543',
    username: 'openwa_admin',
    database: 'openwa_prod',
    schema: 'appschema',
    poolSize: 7,
    sslEnabled: false,
    sslRejectUnauthorized: true,
    passwordSet: true,
  },
  redis: { enabled: false, builtIn: false, builtInSet: true, host: 'localhost', port: '6379', passwordSet: false },
  queue: { enabled: false },
  storage: {
    type: 'local',
    builtIn: false,
    builtInSet: true,
    localPath: './data/media',
    s3Bucket: '',
    s3Region: 'ap-southeast-1',
    s3Endpoint: '',
    s3CredentialsSet: false,
  },
  // headless: false deliberately differs from the component's useState default (true) — asserting
  // it reads false is what proves this field came from /config, not from the initial state.
  engine: {
    type: 'whatsapp-web.js',
    headless: false,
    sessionDataPath: '/data/custom-sessions',
    browserArgs: '--headless=new --custom-flag',
  },
};

const ENGINES: Engine[] = [
  {
    id: 'whatsapp-web.js',
    name: 'WhatsApp Web (Puppeteer)',
    enabled: true,
    features: [],
    library: { name: 'whatsapp-web.js', version: '1.34.7' },
  },
  { id: 'baileys', name: 'Baileys', enabled: true, features: [] },
];

const CURRENT_ENGINE = { engineType: 'whatsapp-web.js' };

// Per-test fixture swaps for the three responses whose disagreement the engine-pin tests turn on
// (running engine vs saved engine vs whether ENGINE_TYPE is pinned). Reset in afterEach so the
// smoke tests above keep seeing the stock fixtures.
let overrides: {
  status?: InfraStatus;
  saved?: SavedConfig;
  savedFails?: boolean;
  statusFails?: boolean;
  currentEngine?: { engineType: string };
  restart?: () => Response;
  readyFails?: boolean;
} = {};

// ENGINE_TYPE supplied by the container environment, so the dashboard cannot change it.
const PINNED_STATUS: InfraStatus = { ...INFRA_STATUS, envPinned: ['ENGINE_TYPE'] };

// The operator's saved choice, deliberately DIFFERENT from the running engine — that disagreement is
// the whole subject of these tests, and the stock fixtures agree on whatsapp-web.js.
const SAVED_BAILEYS: SavedConfig = { ...SAVED_CONFIG, engine: { ...SAVED_CONFIG.engine, type: 'baileys' } };

// Saved storage differs from the running one — the "saved, awaiting restart" state, with no pin.
const SAVED_STORAGE_DRIFT: SavedConfig = { ...SAVED_CONFIG, storage: { ...SAVED_CONFIG.storage, type: 's3' } };

const CONFIG_LOAD_ERROR = "Couldn't load the saved configuration, so it can't be edited here. Refresh to try again.";

const PENDING_RESTART_NOTE = 'Saved, but not applied yet — restart the server for this change to take effect.';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchCall {
  method: string;
  path: string;
  body?: unknown;
}

const fetchCalls: FetchCall[] = [];

function resetFetchCalls(): void {
  fetchCalls.length = 0;
}

function findFetchCall(method: string, path: string): FetchCall | undefined {
  return fetchCalls.find(c => c.method === method && c.path === path);
}

// URL router for every endpoint the page can hit. Anything else 404s loudly rather than resolving
// into a confusing downstream failure.
//
// ⚠️ /api/health/ready is NOT under /api/infra — routing it on an /api/infra prefix would 404 it
// and drop checkServerHealth into its up-to-60-attempt, 1s-interval poll. It is stubbed here for
// completeness even though none of the three cases below drive the restart flow far enough to hit it.
function installFetchStub(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');

    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    fetchCalls.push({ method, path, body });

    if (method === 'GET' && path === '/api/infra/status') {
      if (overrides.statusFails) return Promise.resolve(jsonResponse({ message: 'Bad Gateway' }, 502));
      return Promise.resolve(jsonResponse(overrides.status ?? INFRA_STATUS));
    }
    if (method === 'GET' && path === '/api/infra/config') {
      if (overrides.savedFails) return Promise.resolve(jsonResponse({ message: 'boom' }, 500));
      return Promise.resolve(jsonResponse(overrides.saved ?? SAVED_CONFIG));
    }
    if (method === 'GET' && path === '/api/infra/engines') return Promise.resolve(jsonResponse(ENGINES));
    if (method === 'GET' && path === '/api/infra/engines/current')
      return Promise.resolve(jsonResponse(overrides.currentEngine ?? CURRENT_ENGINE));
    if (method === 'PUT' && path === '/api/infra/config') {
      return Promise.resolve(
        jsonResponse({ message: 'Configuration saved', saved: true, envPath: '.env.generated', profiles: [] }),
      );
    }
    if (method === 'POST' && path === '/api/infra/restart') {
      if (overrides.restart) return Promise.resolve(overrides.restart());
      return Promise.resolve(
        jsonResponse({ message: 'restarting', restarting: true, profiles: [], profilesToRemove: [], estimatedTime: 5 }),
      );
    }
    if (method === 'GET' && path === '/api/health/ready') {
      if (overrides.readyFails) return Promise.resolve(jsonResponse({ status: 'error', details: {} }, 503));
      return Promise.resolve(jsonResponse({ status: 'ok', details: {} }));
    }
    if (method === 'GET' && path === '/api/infra/export-data') {
      return Promise.resolve(
        jsonResponse({ exportedAt: new Date(0).toISOString(), dataDbType: 'postgres', tables: {}, counts: {} }),
      );
    }
    if (method === 'POST' && path === '/api/infra/import-data') {
      return Promise.resolve(jsonResponse({ imported: true, counts: {} }));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  };
}

// ── DOM helpers ──────────────────────────────────────────────────────────────
// The page's labels are plain siblings of their inputs (no htmlFor/id, no wrapping) — the DB/Redis/
// Storage/Engine detail fields are NOT reachable via getByLabelText. These walk the same
// .form-group / .toggle-row structure the page renders instead.

function fieldInput(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('.form-group > label')).find(l => l.textContent === labelText);
  if (!label) throw new Error(`no field labeled "${labelText}"`);
  const input = label.parentElement?.querySelector('input');
  if (!input) throw new Error(`no input in the "${labelText}" field`);
  return input as HTMLInputElement;
}

function toggleInput(container: HTMLElement, labelText: string): HTMLInputElement {
  const span = Array.from(container.querySelectorAll('.toggle-info > span')).find(s => s.textContent === labelText);
  if (!span) throw new Error(`no toggle labeled "${labelText}"`);
  const input = span.closest('.toggle-row')?.querySelector('input[type="checkbox"]');
  if (!input) throw new Error(`no checkbox for toggle "${labelText}"`);
  return input as HTMLInputElement;
}

// ── Harness bootstrap ────────────────────────────────────────────────────────

type RTL = typeof import('@testing-library/react');
type InfrastructureModule = typeof import('./Infrastructure.tsx');
type RoleModule = typeof import('../components/RoleProvider.tsx');
type ToastModule = typeof import('../components/Toast.tsx');

let rtl: RTL;
let Infrastructure: InfrastructureModule['Infrastructure'];
let RoleProvider: RoleModule['RoleProvider'];
let ToastProvider: ToastModule['ToastProvider'];
let installJsdomGlobals: typeof installJsdomGlobalsFn;
let queryClient: QueryClient | undefined;

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
  installFetchStub();
  // Awaited, not just imported: catalogues are fetched now, so the import only starts the load and
  // the English copy these tests query by name renders as a raw key until it arrives.
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Infrastructure } = await import('./Infrastructure.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  overrides = {};
});

function renderInfrastructure() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Infrastructure))),
    ),
  );
}

// ── Smoke tests ──────────────────────────────────────────────────────────────

test('Infrastructure renders and the config form hydrates from /status and /config', async () => {
  const { screen, waitFor } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');

  await waitFor(() => {
    // dbConfig.type is seeded from the saved config: sqlite is the useState default, so a checked
    // Postgres radio here proves the form was hydrated.
    const dbRadios = container.querySelectorAll('input[name="dbType"]');
    assert.equal((dbRadios[1] as HTMLInputElement).checked, true, 'expected the Postgres radio to be selected');

    // Only /config carries these fields, so they pin /config hydration specifically.
    assert.equal(fieldInput(container, 'Username').value, 'openwa_admin');
    assert.equal(fieldInput(container, 'Database Name').value, 'openwa_prod');
    assert.equal(fieldInput(container, 'Schema').value, 'appschema');
    assert.equal(fieldInput(container, 'Pool Size').value, '7');

    // Engine detail fields are also /config-only; headless flips the useState default (true) to
    // false, so a false checkbox proves hydration rather than an untouched default.
    assert.equal(toggleInput(container, 'Headless Mode').checked, false);
    assert.equal(fieldInput(container, 'Session Data Path').value, '/data/custom-sessions');
    assert.equal(fieldInput(container, 'Browser Arguments').value, '--headless=new --custom-flag');
  });
});

// An empty field saves the gateway's DEFAULT_PUPPETEER_ARGS, so the placeholder must name that list: an
// operator who copies a shorter one drops flags such as the /dev/shm crash guard.
test('the Browser Arguments placeholder is the default an empty field saves', async () => {
  const source = readFileSync(new URL('../../../src/config/configuration.ts', import.meta.url), 'utf8');
  const list = /DEFAULT_PUPPETEER_ARGS[^=]*=\s*\[([^\]]*)\]/.exec(source)?.[1];
  assert.ok(list, 'DEFAULT_PUPPETEER_ARGS not found');
  const defaults = [...list.matchAll(/'([^']+)'/g)].map(m => m[1]).join(' ');
  const { container } = renderInfrastructure();
  await rtl.screen.findByText('Database Configuration');
  assert.equal(fieldInput(container, 'Browser Arguments').placeholder, defaults);
});

// The detail fields (username, database, schema, bucket, engine options) come only from /config.
// Rendered without it, the form holds its built-in defaults, and a Save would write them over the
// stored external database, S3 and engine settings.
test('a failed /config read offers no Save, so defaults cannot overwrite the stored settings', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = { savedFails: true };
  renderInfrastructure();

  await screen.findByText(CONFIG_LOAD_ERROR);
  assert.ok(!screen.queryByRole('button', { name: 'Save Configuration' }), 'Save offered without the saved config');
});

// The backup only reads the running database, so a missing saved config must not take it away.
test('a failed /config read names the config, and still offers the data backup export and import', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  resetFetchCalls();
  overrides = { savedFails: true };
  const { container } = renderInfrastructure();

  await screen.findByText(CONFIG_LOAD_ERROR);
  assert.ok(
    !screen.queryByText("Couldn't load the current infrastructure status. Refresh to try again."),
    'the status that did load is reported as failed',
  );
  assert.ok(container.querySelector('.data-migration-row input[type="file"]'), 'no backup import offered');
  fireEvent.click(screen.getByRole('button', { name: 'Export data' }));
  await waitFor(() => assert.ok(findFetchCall('GET', '/api/infra/export-data'), 'the backup export was not requested'));
});

test('the storage badge names local storage in the active language', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  renderInfrastructure();

  const card = (await screen.findByText('Storage Configuration')).closest('.infra-card') as HTMLElement;
  assert.equal(card.querySelector('.card-header .status-indicator')?.textContent, '● Local Filesystem');
});

/**
 * Every toggle is a bare checkbox inside a `<label class="toggle-switch">` whose only other child is
 * the decorative slider span, so the wrapping label contributes no text: a screen reader announced
 * anonymous checkboxes on this page. The visible caption lives in a sibling `.toggle-info > span`,
 * which each checkbox now references with aria-labelledby.
 *
 * This proves the reference actually resolves to text in a real DOM. It covers only the four toggles
 * this fixture renders (SSL, built-in Redis and the rest sit behind other toggles); a11y-controls
 * covers the rest of them, and every other page, structurally.
 */
test('every rendered toggle exposes an accessible name from its visible caption', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();
  await screen.findByText('Database Configuration');

  const toggles = Array.from(container.querySelectorAll('label.toggle-switch input[type="checkbox"]'));
  // Guards against a vacuous pass if the page ever stops rendering toggles under this fixture.
  assert.ok(toggles.length >= 4, `expected the open sections to render toggles, found ${toggles.length}`);

  const unnamed = toggles
    .map(input => {
      const id = input.getAttribute('aria-labelledby');
      const name = id ? (container.querySelector(`#${id}`)?.textContent ?? '').trim() : '';
      return { id, name };
    })
    .filter(t => !t.name)
    .map(t => t.id ?? '(no aria-labelledby)');

  // Named, not counted: a failure has to say WHICH toggle lost its caption.
  assert.deepEqual(unnamed, [], `toggles with no accessible name: ${unnamed.join(', ')}`);
});

test('editing a database field and saving PUTs the edited value in the request body', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  // Wait for the postgres detail form (and its Host field) to actually be present before editing it.
  await waitFor(() => assert.equal(fieldInput(container, 'Username').value, 'openwa_admin'));

  const hostInput = fieldInput(container, 'Host');
  fireEvent.change(hostInput, { target: { value: 'edited-host.example.com' } });
  assert.equal(hostInput.value, 'edited-host.example.com');

  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  // The optimistic DOM value alone would pass even if the PUT body were wrong — assert the wire call.
  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as { database?: { host?: string } };
    assert.equal(body.database?.host, 'edited-host.example.com');
  });
});

// Clearing the number input to type a new size leaves NaN, which JSON writes as null, and the gateway
// refuses the whole save for it.
test('a save with the pool size cleared leaves the size out instead of sending null', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  const poolSize = fieldInput(container, 'Pool Size');
  fireEvent.change(poolSize, { target: { value: '' } });
  assert.equal(poolSize.value, '');
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const database = (call!.body as { database: Record<string, unknown> }).database;
    assert.ok(!('poolSize' in database), `poolSize went out as ${JSON.stringify(database.poolSize)}`);
  });
});

test('a pool size typed outside the 1 to 50 the field offers is kept inside it', async () => {
  const { screen, fireEvent } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  const poolSize = fieldInput(container, 'Pool Size');

  fireEvent.change(poolSize, { target: { value: '100' } });
  assert.equal(poolSize.value, '50');
  fireEvent.change(poolSize, { target: { value: '0' } });
  assert.equal(poolSize.value, '1');
  fireEvent.change(poolSize, { target: { value: '25' } });
  assert.equal(poolSize.value, '25');
});

test('a password typed before switching to a built-in container is not saved', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await waitFor(() => assert.equal(fieldInput(container, 'Username').value, 'openwa_admin'));

  // Typed while external, then the field is hidden by the built-in toggle but its state survives.
  fireEvent.change(container.querySelector('#infra-4')!, { target: { value: 'typed-db-secret' } });
  fireEvent.click(toggleInput(container, 'Use Built-in PostgreSQL Container'));

  fireEvent.click(toggleInput(container, 'Enable Redis'));
  fireEvent.change(container.querySelector('#infra-12')!, { target: { value: 'typed-redis-secret' } });
  fireEvent.click(toggleInput(container, 'Use Built-in Redis Container'));

  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  // The bundled containers never receive a typed password, so '' (unchanged) is what must be sent.
  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as {
      database?: { builtIn?: boolean; password?: string };
      redis?: { builtIn?: boolean; password?: string };
    };
    assert.equal(body.database?.builtIn, true);
    assert.equal(body.database?.password, '');
    assert.equal(body.redis?.builtIn, true);
    assert.equal(body.redis?.password, '');
  });
});

test('a successful save opens the restart modal', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  renderInfrastructure();

  await screen.findByText('Database Configuration');
  const saveButton = await screen.findByRole('button', { name: 'Save Configuration' });
  fireEvent.click(saveButton);

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected the save to have PUT /infra/config');
  });

  const dialog = await screen.findByRole('dialog');
  within(dialog).getByText('Configuration saved');
  // The idle restart state offers both actions; the click-through (and its timer cleanup on
  // unmount) is covered by the last test in this file.
  within(dialog).getByRole('button', { name: 'Restart Now' });
  within(dialog).getByRole('button', { name: 'Restart Later' });
});

const DB_SWITCH_WARNING = 'The new database starts empty.';

test('an external Postgres on the default host, port and name does not warn of a switch on save', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  // Nothing saved for the three keys (the environment supplies them, or they are left at the defaults):
  // /config reports '', while the form shows the host from /status and the defaults 5432 and openwa.
  overrides = {
    saved: { ...SAVED_CONFIG, database: { ...SAVED_CONFIG.database, host: '', port: '', database: '' } },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  within(dialog).getByText('Configuration saved');
  assert.ok(!within(dialog).queryByText(DB_SWITCH_WARNING, { exact: false }), 'an unchanged database is no switch');
});

const STATUS_LOAD_ERROR = "Couldn't load the current infrastructure status. Refresh to try again.";

test('a failed first /status read shows the status error card and no form', async () => {
  overrides = { statusFails: true };
  renderInfrastructure();

  await rtl.screen.findByText(STATUS_LOAD_ERROR);
  assert.equal(rtl.screen.queryByRole('button', { name: 'Save Configuration' }) === null, true);
});

test('a failed background /status refetch keeps the form and the restart modal on screen', async () => {
  const { screen, fireEvent } = rtl;
  renderInfrastructure();

  fireEvent.click(await screen.findByRole('button', { name: 'Save Configuration' }));
  await screen.findByRole('dialog');

  // A focus refetch while the gateway is down: the cached status is still there, only the read failed.
  overrides = { statusFails: true };
  await queryClient!.refetchQueries({ queryKey: ['infra', 'status'] });
  assert.equal(queryClient!.getQueryState(['infra', 'status'])?.status, 'error');
  // Let the error state render before looking.
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.ok(screen.queryByRole('dialog'), 'the restart modal must stay open');
  assert.equal(screen.queryByText(STATUS_LOAD_ERROR) === null, true);
  screen.getByRole('button', { name: 'Save Configuration' });
});

// ── The engine radio's seed source (#1082) ───────────────────────────────────
// ENGINES fixture order fixes the radio order: [0] whatsapp-web.js, [1] baileys.

function engineRadios(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[name="engineType"]'));
}

// Waits for the form to be seeded, which happens once both reads are in. Uses a DATABASE field on
// purpose: the engine detail fields render only for whatsapp-web.js, so waiting on one of those would
// vanish the moment a test seeds the radio to baileys.
async function awaitConfigHydrated(container: HTMLElement): Promise<void> {
  await rtl.waitFor(() => assert.equal(fieldInput(container, 'Username').value, 'openwa_admin'));
}

test('the engine radio seeds from the saved engine even when nothing pins ENGINE_TYPE', async () => {
  const { screen, waitFor } = rtl;
  resetFetchCalls();
  // Running and saved disagree with no pin at all — the ordinary "saved but not restarted yet" state.
  // The running engine is stale here (the gateway resolves ENGINE_TYPE once at boot), so seeding from
  // it would show an engine nobody currently wants and write it back on the next save.
  overrides = { saved: SAVED_BAILEYS };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  await waitFor(() =>
    assert.equal(engineRadios(container)[1].checked, true, 'expected the saved engine (baileys) to be selected'),
  );
});

test('saving after an unrestarted engine change does not write the running engine back', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  // No pin anywhere. The operator changed the engine earlier and has not restarted, so /engines/current
  // still reports the old one. Saving an unrelated field must not resurrect it over the saved choice.
  overrides = { saved: SAVED_BAILEYS };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as { engine?: { type?: string } };
    assert.equal(body.engine?.type, 'baileys');
  });
});

test('an operator selection wins over the seed and is what gets saved', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  // Guards the #735 invariant through the seeding rewrite: whatever the seed chose, a click owns the
  // field afterwards and the payload must carry the click.
  fireEvent.click(engineRadios(container)[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as { engine?: { type?: string } };
    assert.equal(body.engine?.type, 'baileys');
  });
});

// ── A switch saved and not restarted for ─────────────────────────────────────
// The operator saved PostgreSQL, Redis with the queue, and S3, chose Restart Later, and reloaded: the
// gateway still runs SQLite, local media and no Redis. The form is the saved choice (a save of anything
// else must not write the running one back over it); the card badges report what runs.

const RUNNING_SQLITE: InfraStatus = {
  ...INFRA_STATUS,
  database: { connected: true, type: 'sqlite', host: 'localhost', builtIn: false },
};
const SAVED_SWITCH: SavedConfig = {
  ...SAVED_CONFIG,
  redis: { enabled: true, builtIn: false, builtInSet: true, host: 'redis.internal', port: '6380', passwordSet: true },
  queue: { enabled: true },
  storage: { ...SAVED_CONFIG.storage, type: 's3', s3Bucket: 'media', s3CredentialsSet: true },
};

// The saved headless flag is false and the useState default is true, so it reads false only once the form is seeded.
async function awaitSeeded(container: HTMLElement): Promise<void> {
  await rtl.waitFor(() => assert.equal(toggleInput(container, 'Headless Mode').checked, false));
}

function cardBadge(container: HTMLElement, heading: string): string | null | undefined {
  const card = Array.from(container.querySelectorAll('.infra-card')).find(
    c => c.querySelector('h2')?.textContent === heading,
  );
  return card?.querySelector('.card-header .status-indicator')?.textContent;
}

test('saving an unrelated field after a reload keeps a switch that was saved and is waiting for a restart', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_SQLITE, saved: SAVED_SWITCH };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  // The stored headless flag is false; flipping it is the only edit.
  fireEvent.click(toggleInput(container, 'Headless Mode'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as {
      database?: { type?: string };
      redis?: { enabled?: boolean };
      queue?: { enabled?: boolean };
      storage?: { type?: string };
      engine?: { headless?: boolean };
    };
    assert.deepEqual(
      {
        database: body.database?.type,
        redis: body.redis?.enabled,
        queue: body.queue?.enabled,
        storage: body.storage?.type,
        headless: body.engine?.headless,
      },
      { database: 'postgres', redis: true, queue: true, storage: 's3', headless: true },
    );
  });
});

test('the card badges report what runs while the form shows what was saved', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_SQLITE, saved: SAVED_SWITCH };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  assert.equal(cardBadge(container, 'Database Configuration'), '● SQLite');
  assert.equal(cardBadge(container, 'Redis'), '● Disabled');
  assert.equal(cardBadge(container, 'Storage Configuration'), '● Local Filesystem');
  const selected = (name: string) =>
    container.querySelector(`input[name="${name}"]:checked`)?.closest('label')?.querySelector('span')?.textContent;
  assert.equal(selected('dbType'), 'PostgreSQL');
  assert.equal(toggleInput(container, 'Enable Redis').checked, true);
  assert.equal(selected('storageType'), 'Amazon S3');
});

test('a queue switch saved and left for a restart shows the pending-restart note', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  // Redis already runs, so the only difference between running and saved is the queue.
  overrides = {
    status: {
      ...INFRA_STATUS,
      redis: { enabled: true, connected: true, host: 'redis.internal', port: 6380, builtIn: false },
    },
    saved: { ...SAVED_CONFIG, redis: { ...SAVED_SWITCH.redis }, queue: { enabled: true } },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  const queueRow = toggleInput(container, 'Enable BullMQ Queue System').closest('.toggle-row');
  assert.equal(queueRow?.nextElementSibling?.textContent?.trim(), PENDING_RESTART_NOTE);
  assert.equal(screen.getAllByText(PENDING_RESTART_NOTE).length, 1, 'the note belongs to the queue alone');
});

// ── A built-in switch saved and not restarted for ────────────────────────────
// Same service, other mode: the type is unchanged, so only the Use Built-in toggle differs from what runs.

const STORAGE_WARNING = 'Existing media files are not moved to the new storage backend';

const RUNNING_EXTERNAL: InfraStatus = {
  ...INFRA_STATUS,
  storage: { type: 's3', bucket: 'media', builtIn: false, s3Available: true },
};
const SAVED_BUNDLED: SavedConfig = {
  ...SAVED_CONFIG,
  database: { ...SAVED_CONFIG.database, builtIn: true },
  storage: { ...SAVED_CONFIG.storage, type: 's3', builtIn: true },
};
const RUNNING_BUNDLED: InfraStatus = {
  ...INFRA_STATUS,
  database: { connected: true, type: 'postgres', host: 'postgres', builtIn: true },
  redis: { enabled: true, connected: true, host: 'redis', port: 6379, builtIn: true },
  storage: { type: 's3', bucket: 'openwa', builtIn: true, s3Available: true },
};
const SAVED_EXTERNAL: SavedConfig = {
  ...SAVED_CONFIG,
  redis: { enabled: true, builtIn: false, builtInSet: true, host: 'redis.internal', port: '6379', passwordSet: false },
  storage: { ...SAVED_CONFIG.storage, type: 's3', builtIn: false },
};

test('the built-in toggles show what was saved, and a later save warns of the switch it applies', async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_EXTERNAL, saved: SAVED_BUNDLED };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  assert.equal(toggleInput(container, 'Use Built-in PostgreSQL Container').checked, true);
  assert.equal(toggleInput(container, 'Use Built-in MinIO Container').checked, true);

  fireEvent.click(toggleInput(container, 'Headless Mode'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  within(dialog).getByText(DB_SWITCH_WARNING, { exact: false });
  within(dialog).getByText(STORAGE_WARNING, { exact: false });
  const body = findFetchCall('PUT', '/api/infra/config')!.body as {
    database?: { builtIn?: boolean };
    storage?: { builtIn?: boolean };
  };
  assert.deepEqual([body.database?.builtIn, body.storage?.builtIn], [true, true]);
});

test('a switch from bundled to external services is warned of and stops the bundled containers', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_BUNDLED, saved: SAVED_EXTERNAL };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);
  assert.equal(toggleInput(container, 'Use Built-in PostgreSQL Container').checked, false);
  assert.equal(toggleInput(container, 'Use Built-in Redis Container').checked, false);
  assert.equal(toggleInput(container, 'Use Built-in MinIO Container').checked, false);

  fireEvent.click(toggleInput(container, 'Headless Mode'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  within(dialog).getByText(DB_SWITCH_WARNING, { exact: false });
  const body = findFetchCall('PUT', '/api/infra/config')!.body as {
    database?: { builtIn?: boolean };
    redis?: { builtIn?: boolean };
    storage?: { builtIn?: boolean };
  };
  assert.deepEqual([body.database?.builtIn, body.redis?.builtIn, body.storage?.builtIn], [false, false, false]);

  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));
  assert.deepEqual(findFetchCall('POST', '/api/infra/restart')!.body, {
    profiles: [],
    profilesToRemove: ['postgres', 'redis', 'minio'],
  });
});

const PENDING_BUILT_IN_NOTE =
  'Saved, but not applied yet: the server runs with an external service now, and a restart switches it to the built-in container.';
const PENDING_EXTERNAL_NOTE =
  'Saved, but not applied yet: the server runs with the built-in container now, and a restart switches it to an external service.';

// The note sits under the toggle it explains and names what runs, since the toggle shows what was saved.
function toggleNote(container: HTMLElement, labelText: string): string | undefined {
  return toggleInput(container, labelText).closest('.toggle-row')?.nextElementSibling?.textContent?.trim();
}

test('a switch to a bundled container waiting for a restart says what runs now, under each toggle', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  // External services run on all three cards, and the bundled containers are what was saved.
  overrides = {
    status: {
      ...RUNNING_EXTERNAL,
      redis: { enabled: true, connected: true, host: 'redis.internal', port: 6379, builtIn: false },
    },
    saved: {
      ...SAVED_BUNDLED,
      redis: { enabled: true, builtIn: true, builtInSet: true, host: 'redis', port: '6379', passwordSet: false },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  assert.equal(toggleNote(container, 'Use Built-in PostgreSQL Container'), PENDING_BUILT_IN_NOTE);
  assert.equal(toggleNote(container, 'Use Built-in Redis Container'), PENDING_BUILT_IN_NOTE);
  assert.equal(toggleNote(container, 'Use Built-in MinIO Container'), PENDING_BUILT_IN_NOTE);
});

test('a switch to external services waiting for a restart says what runs now, under each toggle', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = { status: RUNNING_BUNDLED, saved: SAVED_EXTERNAL };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  assert.equal(toggleNote(container, 'Use Built-in PostgreSQL Container'), PENDING_EXTERNAL_NOTE);
  assert.equal(toggleNote(container, 'Use Built-in Redis Container'), PENDING_EXTERNAL_NOTE);
  assert.equal(toggleNote(container, 'Use Built-in MinIO Container'), PENDING_EXTERNAL_NOTE);
});

test('no built-in note while the toggles agree with what runs', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = {
    status: RUNNING_BUNDLED,
    saved: { ...SAVED_EXTERNAL, database: { ...SAVED_EXTERNAL.database, builtIn: true } },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  // Only PostgreSQL agrees (bundled on both sides); Redis and MinIO still differ.
  assert.equal(screen.queryAllByText(PENDING_EXTERNAL_NOTE).length, 2);
  assert.equal(screen.queryByText(PENDING_BUILT_IN_NOTE) === null, true, 'a note beside a toggle that agrees');
});

// SQLite runs and bundled PostgreSQL is saved: the database note names the type change, and a running
// "external" flag would be a claim about a database that is not running.
test('no built-in note beside a pending database type', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  overrides = {
    status: RUNNING_SQLITE,
    saved: { ...SAVED_CONFIG, database: { ...SAVED_CONFIG.database, builtIn: true } },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitSeeded(container);

  assert.equal(screen.queryByText(PENDING_BUILT_IN_NOTE) === null, true, 'a flag note beside a pending type');
  assert.equal(screen.queryByText(PENDING_EXTERNAL_NOTE) === null, true, 'a flag note beside a pending type');
  screen.getByText(PENDING_RESTART_NOTE);
});

test('the pending-restart note survives a successful save', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  // Storage differs between running and saved: the exact "saved, awaiting restart" state the note
  // describes. It must still be readable AFTER a save — that is the operator who chose Restart Later.
  overrides = { saved: SAVED_STORAGE_DRIFT };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  await screen.findByText(PENDING_RESTART_NOTE);

  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  await waitFor(() => assert.ok(findFetchCall('PUT', '/api/infra/config'), 'expected a PUT to /infra/config'));

  assert.ok(screen.queryByText(PENDING_RESTART_NOTE), 'the pending-restart note must not vanish once a save succeeds');
});

test('a change saved and left for a later restart shows the pending-restart note', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  // Running and saved agree, so no note yet: the drift comes only from this save.
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  assert.ok(!screen.queryByText(PENDING_RESTART_NOTE), 'no note before anything is saved');

  fireEvent.click(container.querySelector<HTMLInputElement>('input[name="dbType"]')!);
  // From here on the gateway reports what the save just wrote.
  overrides = { saved: { ...SAVED_CONFIG, database: { ...SAVED_CONFIG.database, type: 'sqlite' } } };
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Later' }));

  await waitFor(() => assert.ok(screen.queryByText(PENDING_RESTART_NOTE), 'expected the pending-restart note'));
});

test('a second save before the restart still warns of the database switch the first one saved', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  fireEvent.change(fieldInput(container, 'Host'), { target: { value: 'new-db-host' } });
  overrides = { saved: { ...SAVED_CONFIG, database: { ...SAVED_CONFIG.database, host: 'new-db-host' } } };
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  let dialog = await screen.findByRole('dialog');
  within(dialog).getByText(DB_SWITCH_WARNING, { exact: false });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Later' }));
  // The refetched saved config now names the new host; the running database is still the old one.
  await waitFor(() =>
    assert.equal(fetchCalls.filter(c => c.method === 'GET' && c.path === '/api/infra/config').length, 2),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  dialog = await screen.findByRole('dialog');
  within(dialog).getByText(DB_SWITCH_WARNING, { exact: false });
});

/** The pin note rendered inside a text field's form group, or null. */
function fieldPinNote(container: HTMLElement, labelText: string): string | null {
  return fieldInput(container, labelText).closest('.form-group')?.querySelector('.env-pin-note')?.textContent ?? null;
}

test('fields the Quick Start stack pins show the env-pin note naming their variable', async () => {
  const { screen, waitFor } = rtl;
  resetFetchCalls();
  overrides = { status: { ...INFRA_STATUS, envPinned: ['SESSION_DATA_PATH', 'STORAGE_LOCAL_PATH'] } };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  await waitFor(() => {
    assert.match(fieldPinNote(container, 'Session Data Path') ?? '', /SESSION_DATA_PATH/);
    assert.match(fieldPinNote(container, 'Storage Path') ?? '', /STORAGE_LOCAL_PATH/);
  });
  assert.equal(fieldPinNote(container, 'Browser Arguments'), null, 'an unpinned field must carry no note');
  const notes = Array.from(container.querySelectorAll('.env-pin-note')).map(note => note.textContent ?? '');
  assert.ok(!notes.some(note => note.includes('PUPPETEER_ARGS') || note.includes('PUPPETEER_HEADLESS')));
});

test('without a reported pin those fields show no note, even when running and saved values differ', async () => {
  const { screen } = rtl;
  resetFetchCalls();
  // The stock fixtures disagree on headless (running true, saved false): a pin-only note must not
  // read that as a pin or as a pending restart.
  overrides = { status: { ...INFRA_STATUS, envPinned: [] } };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  for (const label of ['Session Data Path', 'Browser Arguments', 'Storage Path']) {
    assert.equal(fieldPinNote(container, label), null, `unexpected note under ${label}`);
  }
  const headlessRow = toggleInput(container, 'Headless Mode').closest('.toggle-row');
  assert.ok(
    !headlessRow?.nextElementSibling?.classList.contains('env-pin-note'),
    'unexpected note under Headless Mode',
  );
});

test('the engine radio seeds from the effective engine when ENGINE_TYPE is pinned', async () => {
  const { screen, waitFor } = rtl;
  resetFetchCalls();
  // Under a pin, /config reports the pinned (effective) engine — the value /status also reports —
  // so the stock fixtures (both whatsapp-web.js) model the honest pinned response. The radio must
  // show what actually runs, with the pin note explaining why a save here cannot change it (#1313).
  overrides = { status: PINNED_STATUS };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  await waitFor(() =>
    assert.equal(
      engineRadios(container)[0].checked,
      true,
      'expected the pinned engine (whatsapp-web.js) to be selected',
    ),
  );
  assert.ok(
    screen.getByText(/Pinned by the environment variable ENGINE_TYPE/, { exact: false }),
    'the pin note must explain why the radio cannot take effect',
  );
});

test('saving while ENGINE_TYPE is pinned omits engine.type so the stored choice survives', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  // The stored ENGINE_TYPE in data/.env.generated is invisible to the dashboard while the pin
  // holds (/config reports the effective engine). The operator never touched the radio here, so
  // the payload must OMIT type: sending the pinned seed would bake the pin over the stored choice,
  // and unsetting the variable later could not restore it (#1082).
  overrides = { status: PINNED_STATUS };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as { engine?: { type?: string } };
    assert.equal(body.engine?.type, undefined, 'an untouched pinned seed must not be persisted');
  });
});

test('an operator engine pick under a pin is deliberate and still saved', async () => {
  const { screen, waitFor, fireEvent } = rtl;
  resetFetchCalls();
  // The pin note says dashboard changes won't APPLY until the variable is unset — it does not say
  // the choice cannot be stored. Clicking a radio is an explicit selection (engineTouched), so it
  // must reach the payload and replace the stored intent for the post-unpin boot.
  overrides = { status: PINNED_STATUS };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);

  fireEvent.click(engineRadios(container)[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  await waitFor(() => {
    const call = findFetchCall('PUT', '/api/infra/config');
    assert.ok(call, 'expected a PUT to /infra/config');
    const body = call!.body as { engine?: { type?: string } };
    assert.equal(body.engine?.type, 'baileys');
  });
});

// The dashboard key is a password a browser may have saved for this origin. These fields hold other secrets
// (an empty one means "keep the stored value"), so the browser must not fill them with it.
test('the database, Redis and S3 secret fields are not offered saved passwords', async () => {
  const { screen, waitFor } = rtl;
  resetFetchCalls();
  overrides = {
    status: {
      ...INFRA_STATUS,
      redis: { enabled: true, connected: true, host: 'redis.example', port: 6379, builtIn: false },
      storage: { type: 's3', bucket: 'media', builtIn: false },
    },
    saved: {
      ...SAVED_CONFIG,
      redis: {
        enabled: true,
        builtIn: false,
        builtInSet: true,
        host: 'redis.example',
        port: '6379',
        passwordSet: true,
      },
      storage: { ...SAVED_CONFIG.storage, type: 's3' },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  await waitFor(() => assert.equal(container.querySelectorAll('input[type="password"]').length, 3));
  for (const field of container.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
    assert.equal(field.getAttribute('autocomplete'), 'new-password', field.id);
  }
});

// ── Built-in containers the restart stops ────────────────────────────────────

test('turning a running built-in Redis off asks the restart to stop its container', async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  // Built-in Redis is running and saved as built-in; the operator switches it to an external Redis.
  overrides = {
    status: { ...INFRA_STATUS, redis: { enabled: true, connected: true, host: 'redis', port: 6379, builtIn: true } },
    saved: {
      ...SAVED_CONFIG,
      redis: { enabled: true, builtIn: true, builtInSet: true, host: 'redis', port: '6379', passwordSet: false },
    },
  };
  const { container } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  await awaitConfigHydrated(container);
  const builtInRedis = toggleInput(container, 'Use Built-in Redis Container');
  await waitFor(() => assert.equal(builtInRedis.checked, true));
  fireEvent.click(builtInRedis);
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));

  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));
  // The page reloads after every restart, so the first save of a page visit is the normal case: the
  // container to stop must come from what is running, not from an earlier save on this page.
  assert.deepEqual(findFetchCall('POST', '/api/infra/restart')!.body, { profiles: [], profilesToRemove: ['redis'] });
});

// ── Restart-flow timer cleanup on unmount ────────────────────────────────────

test('unmounting mid-restart cancels the health poll and countdown timers', { timeout: 10_000 }, async () => {
  const { screen, waitFor, fireEvent, within } = rtl;
  resetFetchCalls();
  const { unmount } = renderInfrastructure();

  await screen.findByText('Database Configuration');
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));

  // The restart POST resolving is what arms the 3s health-poll timeout chain and the 1s countdown
  // interval in useRestartFlow.
  await waitFor(() => assert.ok(findFetchCall('POST', '/api/infra/restart'), 'expected the restart POST'));

  // Unmount, then outwait the first health poll (fires at 3s): a leaked chain would call
  // /api/health/ready here. Real timers only — mixing fake timers in after the flow has armed
  // would leave the pre-armed real handles un-clearable by the mocked clearTimeout.
  unmount();
  resetFetchCalls();
  await new Promise(resolve => setTimeout(resolve, 4000));

  assert.equal(findFetchCall('GET', '/api/health/ready'), undefined);
});

// ── Restart outcomes the server reports ──────────────────────────────────────

test('a refused restart shows the server reason and never polls readiness', { timeout: 10_000 }, async () => {
  const { screen, fireEvent, within } = rtl;
  resetFetchCalls();
  // The old process refused before scheduling a shutdown, so it is still up: a readiness poll would
  // answer 200 and report a restart that never happened.
  overrides = { restart: () => jsonResponse({ message: 'Too many restart requests' }, 429) };
  renderInfrastructure();

  await screen.findByText('Database Configuration');
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));

  await within(dialog).findByText('Restart failed');
  assert.ok(within(dialog).getByText('Too many restart requests'), 'the server reason is not shown');
  // Past the first readiness poll (3s), which a restart assumed to be under way would have sent.
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(findFetchCall('GET', '/api/health/ready'), undefined);
  assert.equal(within(dialog).queryByText('Server ready') === null, true);
});

test(
  'a proxy timeout on the restart request reports an unknown outcome, not a failure',
  { timeout: 12_000 },
  async () => {
    const { screen, fireEvent, within } = rtl;
    resetFetchCalls();
    // The proxy stopped waiting while the gateway was still pulling an image: the restart may yet happen,
    // and the old process still answers readiness, so neither a failure nor a poll tells the truth.
    overrides = {
      restart: () =>
        new Response('<html><body>504 Gateway Time-out</body></html>', {
          status: 504,
          headers: { 'Content-Type': 'text/html' },
        }),
    };
    // jsdom cannot navigate, so a reload reports itself through console.error; count those.
    const navigations: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      const text = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
      if (text.includes('navigation')) navigations.push(text);
      else consoleError(...args);
    };
    try {
      renderInfrastructure();
      await screen.findByText('Database Configuration');
      fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));

      await within(dialog).findByText(
        'The proxy returned an error before the server answered, so it is not known whether the restart is in progress. Reload in a minute to check.',
      );
      assert.equal(within(dialog).queryByText('Restart failed') === null, true);
      assert.equal(within(dialog).queryByText('HTTP 504') === null, true);
      assert.ok(within(dialog).getByText('Please wait…'), 'the unknown outcome has no neutral title');
      assert.ok(within(dialog).getByRole('button', { name: 'Reload Page' }), 'no way to reload by hand');
      // Past the first readiness poll (3s) and the reload a confirmed restart schedules 2s after it.
      await new Promise(resolve => setTimeout(resolve, 5500));
      assert.equal(findFetchCall('GET', '/api/health/ready'), undefined);
      assert.deepEqual(navigations, [], 'the page reloaded on its own');
    } finally {
      console.error = consoleError;
    }
  },
);

async function clickRestartNow() {
  const { screen, fireEvent, within } = rtl;
  renderInfrastructure();
  await screen.findByText('Database Configuration');
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
  return dialog;
}

test('a proxy 502 without a gateway code on the restart request reports an unknown outcome', async () => {
  const { within } = rtl;
  resetFetchCalls();
  overrides = {
    restart: () =>
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
  };
  const dialog = await clickRestartNow();

  await within(dialog).findByText(
    'The proxy returned an error before the server answered, so it is not known whether the restart is in progress. Reload in a minute to check.',
  );
  assert.equal(within(dialog).queryByText('Restart failed') === null, true);
});

test('a 502 the gateway stamped with a code is a refusal, not an unknown outcome', async () => {
  const { within } = rtl;
  resetFetchCalls();
  overrides = { restart: () => jsonResponse({ message: 'Compose rejected the profile', code: 'SOME_CODE' }, 502) };
  const dialog = await clickRestartNow();

  await within(dialog).findByText('Restart failed');
  assert.ok(within(dialog).getByText('Compose rejected the profile'), 'the server reason is not shown');
});

test('the restart progress bar measures the server estimate, not a fixed 30 s', async () => {
  const { within } = rtl;
  resetFetchCalls();
  overrides = {
    readyFails: true,
    restart: () =>
      jsonResponse({ message: 'restarting', restarting: true, profiles: [], profilesToRemove: [], estimatedTime: 35 }),
  };
  const dialog = await clickRestartNow();

  // One second into a 35 s estimate. Against a fixed 30 s total the width would be negative, which
  // the style drops, leaving the bar empty until the countdown fell under 30.
  await within(dialog).findByText('Server restarting... 34s', undefined, { timeout: 2_000 });
  const fill = dialog.querySelector<HTMLElement>('.restart-progress-fill');
  assert.equal(fill?.style.width, `${(1 / 35) * 100}%`);
});

test(
  'services that failed to start are shown after the restart instead of reloading over them',
  { timeout: 15_000 },
  async () => {
    const { screen, fireEvent, within } = rtl;
    resetFetchCalls();
    const failure = 'Failed to start minio: image pull failed';
    overrides = {
      restart: () =>
        jsonResponse({
          message: 'restarting',
          restarting: true,
          profiles: ['minio'],
          profilesToRemove: [],
          estimatedTime: 5,
          orchestration: { success: false, message: 'Some services failed', errors: [failure] },
        }),
    };
    // jsdom cannot navigate, so a reload reports itself through console.error; count those.
    const navigations: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      const text = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
      if (text.includes('navigation')) navigations.push(text);
      else consoleError(...args);
    };
    try {
      renderInfrastructure();
      await screen.findByText('Database Configuration');
      fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));

      await within(dialog).findByText('Server ready', {}, { timeout: 5_000 });
      assert.ok(within(dialog).getByText(failure), 'the orchestration error is not shown');
      assert.ok(within(dialog).getByRole('button', { name: 'Reload Page' }), 'no way to reload after reading');
      assert.equal(
        within(dialog).queryByText('Server is back online! The page will reload automatically.') === null,
        true,
      );
      // Past the 2s after which a clean restart reloads the page.
      await new Promise(resolve => setTimeout(resolve, 2500));
      assert.deepEqual(navigations, [], 'the page reloaded over the warning');
    } finally {
      console.error = consoleError;
    }
  },
);

test(
  'services that failed to start stay on screen when the server never becomes ready',
  { timeout: 15_000 },
  async () => {
    const { screen, fireEvent, within } = rtl;
    const failure = 'Failed to start postgres: image pull failed';
    overrides = {
      readyFails: true,
      restart: () =>
        jsonResponse({
          message: 'restarting',
          restarting: true,
          profiles: ['postgres'],
          profilesToRemove: [],
          estimatedTime: 5,
          orchestration: { success: false, message: 'Some services failed', errors: [failure] },
        }),
    };
    renderInfrastructure();
    await screen.findByText('Database Configuration');
    fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
    const dialog = await screen.findByRole('dialog');
    // The readiness poll gives up after a minute of 1s retries; shorten only those waits. Every
    // lookup below passes its own timeout, since the default 1s one would be shortened too.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
      realSetTimeout(fn, ms === 1000 || ms === 3000 ? 1 : ms, ...rest)) as typeof setTimeout;
    try {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Restart Now' }));
      await within(dialog).findByText('Restart failed', {}, { timeout: 5_000 });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.ok(within(dialog).getByText(failure), 'the failure that explains the restart is not shown');
  },
);
