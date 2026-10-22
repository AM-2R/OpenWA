// saveConfig writes the generated env via fs.writeFileSync and reads the existing file
// via fs.existsSync/readFileSync; mock those so tests assert produced content without
// touching the filesystem. existsSync defaults to false (no prior config).
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: jest.fn(),
    // saveConfig now writes the generated env via writeSecretFile, which chmods 0600 — mock it
    // so the secret-hygiene path never touches the real filesystem.
    chmodSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn().mockReturnValue(''),
    createReadStream: jest.fn(() => jest.requireActual<typeof import('stream')>('stream').Readable.from([])),
  };
});

import { InfraStatusController } from './infra-status.controller';
import { recordPinnedEnvKeys } from '../../config/env-precedence';
import { producerConnectWaitMs } from '../queue/redis-connection';
import * as fs from 'fs';
import {
  FALLBACK_BUILT_IN,
  FILE_STATES,
  PIN_STATES,
  SERVICES,
  SERVICE_NAMES,
  fileLines,
  pinnedHost,
  type FileState,
  type PinState,
} from '../../../test/fixtures/builtin-mode-cases';

describe('InfraStatusController.getStatus DB health (active SELECT 1 probe, not just isInitialized)', () => {
  const build = (query: jest.Mock) => {
    // engine.type=baileys skips the wa-web-version registry fetch (no network in unit tests).
    const config = { get: (k: string, def?: unknown) => (k === 'engine.type' ? 'baileys' : def) };
    const ds = { isInitialized: true, query };
    const cache = { isAvailable: jest.fn().mockResolvedValue(false), refreshS3Availability: jest.fn() };
    return new InfraStatusController(
      config as never,
      ds as never,
      ds as never,
      { create: jest.fn() } as never,
      { isDockerAvailable: () => false, getRunningBuiltinServices: jest.fn() } as never,
      cache as never,
      { refreshS3Availability: jest.fn() } as never,
      undefined as never,
    );
  };

  it('reports connected:true when SELECT 1 succeeds', async () => {
    const status = await build(jest.fn().mockResolvedValue([{ '1': 1 }])).getStatus();
    expect(status.database.connected).toBe(true);
  });

  it('reports connected:false when the DB is initialized but SELECT 1 fails (backend died post-init)', async () => {
    const status = await build(jest.fn().mockRejectedValue(new Error('ECONNRESET'))).getStatus();
    expect(status.database.connected).toBe(false);
  });
});

describe('InfraStatusController.getStatus queue job counts', () => {
  function buildStatusController(opts: {
    queueEnabled: boolean;
    queue?: { getJobCounts: jest.Mock; waitUntilReady?: jest.Mock };
  }) {
    const configService = {
      // engine.type=baileys skips the wa-web-version registry fetch (no network in unit tests).
      get: (key: string, def?: unknown) =>
        key === 'queue.enabled' ? opts.queueEnabled : key === 'engine.type' ? 'baileys' : def,
    };
    const dataSource = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) } as unknown;
    const engineFactory = { create: jest.fn() };
    const dockerService = { isDockerAvailable: () => false, getRunningBuiltinServices: jest.fn() };
    const cacheService = { isAvailable: jest.fn().mockResolvedValue(false), refreshS3Availability: jest.fn() };
    const storageService = { refreshS3Availability: jest.fn() };
    return new InfraStatusController(
      configService as never,
      dataSource as never,
      dataSource as never,
      engineFactory as never,
      dockerService as never,
      cacheService as never,
      storageService as never,
      (opts.queue && { waitUntilReady: jest.fn().mockResolvedValue(undefined), ...opts.queue }) as never,
    );
  }

  it('reports live webhook job counts when the queue is enabled (pending = wait+active+delayed)', async () => {
    const getJobCounts = jest.fn().mockResolvedValue({ wait: 2, active: 1, delayed: 3, completed: 10, failed: 1 });
    const controller = buildStatusController({ queueEnabled: true, queue: { getJobCounts } });

    const status = await controller.getStatus();

    expect(getJobCounts).toHaveBeenCalledWith('wait', 'active', 'delayed', 'completed', 'failed');
    expect(status.queue).toEqual({ enabled: true, webhooks: { pending: 6, completed: 10, failed: 1 } });
  });

  // Until the first connect BullMQ holds a queue call for as long as Redis stays unreachable.
  it('reports zeros once the connect timeout passes when Redis has never connected', async () => {
    const getJobCounts = jest.fn();
    const waitUntilReady = jest.fn(() => new Promise<never>(() => {}));
    const controller = buildStatusController({ queueEnabled: true, queue: { getJobCounts, waitUntilReady } });
    let status: Awaited<ReturnType<InfraStatusController['getStatus']>> | undefined;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      void controller.getStatus().then(s => (status = s));
      await jest.advanceTimersByTimeAsync(producerConnectWaitMs());
    } finally {
      jest.useRealTimers();
    }

    expect(getJobCounts).not.toHaveBeenCalled();
    expect(status?.queue).toEqual({ enabled: true, webhooks: { pending: 0, completed: 0, failed: 0 } });
  });

  it('reports zeros (and does not touch the queue) when the queue is disabled', async () => {
    const getJobCounts = jest.fn();
    const controller = buildStatusController({ queueEnabled: false, queue: { getJobCounts } });

    const status = await controller.getStatus();

    expect(getJobCounts).not.toHaveBeenCalled();
    expect(status.queue).toEqual({ enabled: false, webhooks: { pending: 0, completed: 0, failed: 0 } });
  });
});

describe('InfraStatusController.getStatus engine (reads the real engine.puppeteer.* keys)', () => {
  // Pin the WA-Web version so getStatus does not fire the wa-version registry fetch (no network in tests).
  const savedWebVer = process.env.WWEBJS_WEB_VERSION;
  beforeAll(() => (process.env.WWEBJS_WEB_VERSION = 'off'));
  afterAll(() => {
    if (savedWebVer === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVer;
  });

  it('reports the saved headless/browserArgs instead of stale defaults from non-existent flat keys', async () => {
    const map: Record<string, unknown> = {
      'engine.type': 'whatsapp-web.js',
      'engine.puppeteer.headless': false,
      'engine.puppeteer.args': ['--foo', '--bar'],
      'engine.sessionDataPath': './sess',
    };
    const config = { get: (key: string, def?: unknown) => (key in map ? map[key] : def) };
    const cache = { isAvailable: () => Promise.resolve(false) };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    const controller = new InfraStatusController(
      config as never,
      ds as never,
      ds as never,
      {} as never, // engineFactory
      { isDockerAvailable: () => false } as never, // dockerService — no Docker in unit tests
      cache as never,
      { refreshS3Availability: () => Promise.resolve(false) } as never, // storageService
    );

    const status = await controller.getStatus();
    expect(status.engine.headless).toBe(false);
    expect(status.engine.browserArgs).toBe('--foo --bar');
    expect(status.engine.sessionDataPath).toBe('./sess');
  });

  it('reports the default Chromium flags when no args are configured', async () => {
    const config = { get: (key: string, def?: unknown) => (key === 'engine.type' ? 'whatsapp-web.js' : def) };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    const controller = new InfraStatusController(
      config as never,
      ds as never,
      ds as never,
      {} as never,
      { isDockerAvailable: () => false } as never,
      { isAvailable: () => Promise.resolve(false) } as never,
      { refreshS3Availability: () => Promise.resolve(false) } as never,
    );

    const status = await controller.getStatus();
    expect(status.engine.browserArgs).toBe(
      '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu',
    );
  });
});

describe('InfraStatusController.getStatus storage (reads the real storage.localPath key)', () => {
  // Pin the WA-Web version so getStatus does not fire the wa-version registry fetch (no network in tests).
  const savedWebVer = process.env.WWEBJS_WEB_VERSION;
  beforeAll(() => (process.env.WWEBJS_WEB_VERSION = 'off'));
  afterAll(() => {
    if (savedWebVer === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVer;
  });

  const buildController = (map: Record<string, unknown>) => {
    const config = { get: (key: string, def?: unknown) => (key in map ? map[key] : def) };
    const cache = { isAvailable: () => Promise.resolve(false) };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    return new InfraStatusController(
      config as never,
      ds as never,
      ds as never,
      {} as never, // engineFactory
      { isDockerAvailable: () => false } as never, // dockerService — no Docker in unit tests
      cache as never,
      { refreshS3Availability: () => Promise.resolve(false) } as never, // storageService
    );
  };

  it('reports the configured storage.localPath, not the ./uploads fallback', async () => {
    // The bug: status read the non-existent `storage.path` key, so it always reported the
    // `./uploads` fallback instead of the real path StorageService uses (`storage.localPath`).
    const status = await buildController({
      'storage.type': 'local',
      'storage.localPath': '/srv/openwa/media',
    }).getStatus();
    expect(status.storage.path).toBe('/srv/openwa/media');
  });

  it('falls back to ./data/media (matching StorageService) when storage.localPath is unset', async () => {
    const status = await buildController({ 'storage.type': 'local' }).getStatus();
    expect(status.storage.path).toBe('./data/media');
  });

  it('reports the bucket in S3 mode so the active backend is visible', async () => {
    const status = await buildController({ 'storage.type': 's3', 'storage.s3.bucket': 'my-openwa-bucket' }).getStatus();
    expect(status.storage.type).toBe('s3');
    expect(status.storage.bucket).toBe('my-openwa-bucket');
  });

  it('omits bucket in local mode (no fabricated field)', async () => {
    const status = await buildController({ 'storage.type': 'local' }).getStatus();
    expect(status.storage.bucket).toBeUndefined();
  });
});

// #1082: the Infrastructure page used to INFER an environment pin from "running != saved", which also
// describes a save that has not been restarted yet. getStatus now reports the real thing.
describe('InfraStatusController.getStatus envPinned', () => {
  const savedWebVer = process.env.WWEBJS_WEB_VERSION;
  beforeAll(() => (process.env.WWEBJS_WEB_VERSION = 'off'));
  afterAll(() => {
    if (savedWebVer === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVer;
  });

  const buildController = () => {
    const config = { get: (_key: string, def?: unknown) => def };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    return new InfraStatusController(
      config as never,
      ds as never,
      ds as never,
      {} as never,
      { isDockerAvailable: () => false } as never,
      { isAvailable: () => Promise.resolve(false) } as never,
      { refreshS3Availability: () => Promise.resolve(false) } as never,
    );
  };

  it('reports only the editable selection keys a shadowing layer supplies', async () => {
    // Snapshot as load-env does: ENGINE_TYPE comes from the host/.env, REDIS_ENABLED from the file.
    recordPinnedEnvKeys({ ENGINE_TYPE: 'whatsapp-web.js', PATH: '/usr/bin' });

    const status = await buildController().getStatus();

    expect(status.envPinned).toEqual(['ENGINE_TYPE']);
    // PATH is shadowing too but has no control on the page — naming it would be noise.
    expect(status.envPinned).not.toContain('PATH');
  });

  it('reports the storage path and engine launch options the Quick Start stack pins', async () => {
    // docker-compose.dev.yml forwards these four with non-empty defaults, so a dashboard edit reverts.
    recordPinnedEnvKeys({
      SESSION_DATA_PATH: '/app/data/sessions',
      PUPPETEER_HEADLESS: 'true',
      PUPPETEER_ARGS: '--no-sandbox',
      STORAGE_LOCAL_PATH: '/app/data/media',
      PATH: '/usr/bin',
    });

    const status = await buildController().getStatus();

    expect(status.envPinned).toEqual([
      'STORAGE_LOCAL_PATH',
      'PUPPETEER_HEADLESS',
      'SESSION_DATA_PATH',
      'PUPPETEER_ARGS',
    ]);
  });

  // A pinned host decides the Use Built-in mode of its service whatever the page saves.
  it('reports the three datastore hosts when a shadowing layer supplies them', async () => {
    recordPinnedEnvKeys({
      DATABASE_HOST: 'db.example',
      REDIS_HOST: 'cache.example',
      S3_ENDPOINT: 'https://s3.example',
    });

    expect((await buildController().getStatus()).envPinned).toEqual(['DATABASE_HOST', 'REDIS_HOST', 'S3_ENDPOINT']);
  });

  it('reports an empty list when nothing above data/.env.generated supplies a selection key', async () => {
    recordPinnedEnvKeys({});

    expect((await buildController().getStatus()).envPinned).toEqual([]);
  });
});

// With Docker unreachable the status falls back to the saved flag, the environment's first. A host name proves
// nothing without a container to see (an external server may be called postgres), so a pinned bundled host must not
// read as built-in there: it would replace the stored external credentials with the bundled defaults on a save.
describe('InfraStatusController.getStatus built-in fallback reads the flag only when Docker is unreachable', () => {
  const build = () => {
    const config = { get: (k: string, def?: unknown) => (k === 'engine.type' ? 'baileys' : def) };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    return new InfraStatusController(
      config as never,
      ds as never,
      ds as never,
      { create: jest.fn() } as never,
      { isDockerAvailable: () => false, getRunningBuiltinServices: jest.fn() } as never,
      { isAvailable: jest.fn().mockResolvedValue(false) } as never,
      { refreshS3Availability: jest.fn() } as never,
      undefined as never,
    );
  };
  const otherState = (state: FileState): FileState => (state === 'stored-true' ? 'stored-false' : 'stored-true');
  const otherPin = (pin: PinState): PinState => (pin === 'external' ? 'bundled' : 'external');
  let pinnedKeys: string[] = [];

  afterEach(() => {
    for (const key of pinnedKeys) delete process.env[key];
    pinnedKeys = [];
    recordPinnedEnvKeys({});
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
  });

  for (const service of SERVICE_NAMES) {
    for (const state of FILE_STATES) {
      for (const pin of PIN_STATES) {
        it(`${service}: a ${state} file with ${pin === 'none' ? 'no host pin' : `the host pinned ${pin}`}`, async () => {
          const lines: string[] = [];
          const pins: Record<string, string> = {};
          for (const name of SERVICE_NAMES) {
            const own = name === service;
            lines.push(...fileLines(name, own ? state : otherState(state)));
            const host = pinnedHost(name, own ? pin : otherPin(pin));
            if (host !== undefined) pins[SERVICES[name].host] = host;
          }
          recordPinnedEnvKeys(pins);
          for (const [key, value] of Object.entries(pins)) process.env[key] = value;
          pinnedKeys = Object.keys(pins);
          (fs.existsSync as jest.Mock).mockReturnValue(true);
          (fs.readFileSync as jest.Mock).mockReturnValue(`${lines.join('\n')}\n`);

          const status = await build().getStatus();

          expect(status[service].builtIn).toBe(FALLBACK_BUILT_IN[state]);
        });
      }
    }
  }

  it('a flag pinned by the environment wins over the file, and a pinned host still proves nothing', async () => {
    const pins = {
      POSTGRES_BUILTIN: 'true',
      REDIS_BUILTIN: 'false',
      DATABASE_HOST: 'postgres',
      REDIS_HOST: 'redis',
      S3_ENDPOINT: 'http://minio:9000',
    };
    recordPinnedEnvKeys(pins);
    Object.assign(process.env, pins);
    pinnedKeys = Object.keys(pins);
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('POSTGRES_BUILTIN=false\nREDIS_BUILTIN=true\nMINIO_BUILTIN=false\n');

    const status = await build().getStatus();

    expect([status.database.builtIn, status.redis.builtIn, status.storage.builtIn]).toEqual([true, false, false]);
  });
});
