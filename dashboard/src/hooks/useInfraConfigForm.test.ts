// The Infrastructure form's seeding and the payload a save sends, driven through renderHook so a test decides
// which of the two server reads is in, and when. Infrastructure.test.ts covers the same hook through the page.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { InfraStatus, SavedConfig } from '../services/api';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';
import type { useInfraConfigForm as useInfraConfigFormFn } from './useInfraConfigForm.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let useInfraConfigForm: typeof useInfraConfigFormFn;

before(async () => {
  const { installJsdomGlobals } = (await import('../test-helpers/jsdom.ts')) as {
    installJsdomGlobals: typeof installJsdomGlobalsFn;
  };
  await installJsdomGlobals();
  rtl = await import('@testing-library/react');
  ({ useInfraConfigForm } = await import('./useInfraConfigForm.ts'));
});

afterEach(() => rtl.cleanup());

interface Reads {
  status?: InfraStatus;
  saved?: SavedConfig;
}

function renderForm(initial: Reads) {
  return rtl.renderHook(({ status, saved }: Reads) => useInfraConfigForm(status, saved), { initialProps: initial });
}

// What the gateway process runs: SQLite, local media, no Redis, no queue.
const RUNNING: InfraStatus = {
  database: { connected: true, type: 'sqlite', host: 'localhost', builtIn: false },
  redis: { enabled: false, connected: false, host: 'localhost', port: 6379, builtIn: false },
  queue: { enabled: false, webhooks: { pending: 0, completed: 0, failed: 0 } },
  storage: { type: 'local', path: './data/media', builtIn: false },
  engine: { type: 'whatsapp-web.js', headless: true },
};

// What the operator saved afterwards and has not restarted for: external PostgreSQL, Redis with the queue, S3.
const SAVED: SavedConfig = {
  database: {
    type: 'postgres',
    builtIn: false,
    host: 'pg.internal',
    port: '5433',
    username: 'openwa',
    database: 'openwa_prod',
    schema: 'app',
    poolSize: 20,
    sslEnabled: true,
    sslRejectUnauthorized: false,
    passwordSet: true,
  },
  redis: { enabled: true, builtIn: false, host: 'redis.internal', port: '6380', passwordSet: true },
  queue: { enabled: true },
  storage: {
    type: 's3',
    builtIn: false,
    localPath: '',
    s3Bucket: 'media',
    s3Region: 'eu-west-1',
    s3Endpoint: 'https://s3.internal',
    s3CredentialsSet: true,
  },
  engine: { type: 'whatsapp-web.js', headless: true, sessionDataPath: './data/sessions', browserArgs: '' },
};

test('a save after a reload keeps the selections that were saved and are waiting for a restart', () => {
  const { result } = renderForm({ status: RUNNING, saved: SAVED });

  const { database, redis, queue, storage } = result.current.buildSavePayload();

  assert.deepEqual(
    {
      database: database?.type,
      host: database?.host,
      redis: redis?.enabled,
      queue: queue?.enabled,
      storage: storage?.type,
      bucket: storage?.s3Bucket,
    },
    { database: 'postgres', host: 'pg.internal', redis: true, queue: true, storage: 's3', bucket: 'media' },
  );
});

// A running service that differs from the saved one still drives the live indicators, but the form is
// the saved choice: a save of an unrelated field must not write the running one back over it.
test('the form shows what was saved, not what runs', () => {
  const { result } = renderForm({ status: RUNNING, saved: SAVED });

  assert.equal(result.current.dbConfig.type, 'postgres');
  assert.equal(result.current.redisEnabled, true);
  assert.equal(result.current.queueEnabled, true);
  assert.equal(result.current.storageConfig.type, 's3');
});

const RUNNING_OLD: InfraStatus = {
  ...RUNNING,
  database: { ...RUNNING.database, type: 'postgres', host: 'old-running-db' },
  redis: { ...RUNNING.redis, enabled: true, host: 'old-running-redis', port: 6379 },
  storage: { ...RUNNING.storage, path: '/old/media' },
};
const SAVED_NEW: SavedConfig = {
  ...SAVED,
  database: { ...SAVED.database, host: 'new-saved-db' },
  redis: { ...SAVED.redis, host: 'new-saved-redis', port: '6380' },
  storage: { ...SAVED.storage, type: 'local', localPath: '/new/media' },
};

// /config is a file read and /status probes every backend, so which one settles last is not the page's to choose.
for (const order of ['status first', 'config first', 'together'] as const) {
  test(`the saved host, port and media path win when the reads settle ${order}`, () => {
    const initial: Reads =
      order === 'status first'
        ? { status: RUNNING_OLD }
        : order === 'config first'
          ? { saved: SAVED_NEW }
          : { status: RUNNING_OLD, saved: SAVED_NEW };
    const { result, rerender } = renderForm(initial);
    rerender({ status: RUNNING_OLD, saved: SAVED_NEW });

    const { database, redis, storage } = result.current.buildSavePayload();

    assert.deepEqual(
      { dbHost: database?.host, redisHost: redis?.host, redisPort: redis?.port, localPath: storage?.localPath },
      { dbHost: 'new-saved-db', redisHost: 'new-saved-redis', redisPort: '6380', localPath: '/new/media' },
    );
  });
}

test('a host, port and path nothing has saved are seeded from what runs', () => {
  // GET /config reports '' for a key the file does not hold.
  const unsaved: SavedConfig = {
    ...SAVED_NEW,
    database: { ...SAVED_NEW.database, host: '', port: '' },
    redis: { ...SAVED_NEW.redis, host: '', port: '' },
    storage: { ...SAVED_NEW.storage, localPath: '' },
  };
  const { result } = renderForm({ status: RUNNING_OLD, saved: unsaved });

  const { database, redis, storage } = result.current.buildSavePayload();

  assert.deepEqual(
    {
      dbHost: database?.host,
      dbPort: database?.port,
      redisHost: redis?.host,
      redisPort: redis?.port,
      path: storage?.localPath,
    },
    { dbHost: 'old-running-db', dbPort: '5432', redisHost: 'old-running-redis', redisPort: '6379', path: '/old/media' },
  );
});

// Bundled containers run now; the operator saved external services and has not restarted.
const RUNNING_BUILTIN: InfraStatus = {
  database: { connected: true, type: 'postgres', host: 'postgres', builtIn: true },
  redis: { enabled: true, connected: true, host: 'redis', port: 6379, builtIn: true },
  queue: { enabled: true, webhooks: { pending: 0, completed: 0, failed: 0 } },
  storage: { type: 's3', bucket: 'openwa', builtIn: true },
  engine: { type: 'whatsapp-web.js', headless: true },
};

test('a built-in flag the operator has not touched is saved as it is stored, not as it runs', () => {
  const { result } = renderForm({ status: RUNNING_BUILTIN, saved: SAVED });
  rtl.act(() => result.current.updateDbConfig('password', 'typed-db-secret'));

  const { database, redis, storage } = result.current.buildSavePayload();

  assert.deepEqual([database?.builtIn, redis?.builtIn, storage?.builtIn], [false, false, false]);
  // Still an external database, so what was typed for it is sent.
  assert.equal(database?.password, 'typed-db-secret');
});

test('a stored built-in container is kept when the page runs an external one, and never gets a typed password', () => {
  const storedBuiltIn: SavedConfig = {
    ...SAVED,
    database: { ...SAVED.database, builtIn: true },
    redis: { ...SAVED.redis, builtIn: true },
    storage: { ...SAVED.storage, builtIn: true },
  };
  const { result } = renderForm({ status: RUNNING, saved: storedBuiltIn });
  rtl.act(() => {
    result.current.updateDbConfig('password', 'typed-db-secret');
    result.current.updateRedisConfig('password', 'typed-redis-secret');
  });

  const { database, redis, storage } = result.current.buildSavePayload();

  assert.deepEqual([database?.builtIn, redis?.builtIn, storage?.builtIn], [true, true, true]);
  assert.deepEqual([database?.password, redis?.password], ['', '']);
});

test('a built-in flag the operator flipped is saved as flipped', () => {
  const { result } = renderForm({ status: RUNNING_BUILTIN, saved: SAVED });
  rtl.act(() => {
    result.current.updateDbConfig('builtIn', true);
    result.current.updateRedisConfig('builtIn', true);
    result.current.updateStorageConfig('builtIn', true);
  });

  const { database, redis, storage } = result.current.buildSavePayload();

  assert.deepEqual([database?.builtIn, redis?.builtIn, storage?.builtIn], [true, true, true]);
});

test('a refetch after the form is seeded does not overwrite an edit in progress', () => {
  const { result, rerender } = renderForm({ status: RUNNING, saved: SAVED });
  rtl.act(() => result.current.updateDbConfig('host', 'edited-host'));

  rerender({
    status: { ...RUNNING },
    saved: { ...SAVED, database: { ...SAVED.database, host: 'refetched-host' } },
  });

  assert.equal(result.current.buildSavePayload().database?.host, 'edited-host');
});
