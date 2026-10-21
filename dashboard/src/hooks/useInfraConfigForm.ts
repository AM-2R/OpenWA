import { useEffect, useRef, useState } from 'react';
import type { InfraStatus, SavedConfig, SaveConfigPayload } from '../services/api';

export interface DatabaseConfig {
  type: 'sqlite' | 'postgres';
  builtIn: boolean;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  schema: string;
  poolSize: number;
  sslEnabled: boolean;
  sslRejectUnauthorized: boolean;
}

export interface RedisConfig {
  builtIn: boolean;
  host: string;
  port: string;
  password: string;
  connected: boolean;
}

export interface StorageConfig {
  type: 'local' | 's3';
  builtIn: boolean;
  localPath: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Endpoint: string;
}

export interface EngineConfig {
  type: string;
  headless: boolean;
  sessionDataPath: string;
  browserArgs: string;
}

export interface InfraConfigForm {
  dbConfig: DatabaseConfig;
  redisConfig: RedisConfig;
  storageConfig: StorageConfig;
  engineConfig: EngineConfig;
  redisEnabled: boolean;
  queueEnabled: boolean;
  setRedisEnabled: (enabled: boolean) => void;
  setQueueEnabled: (enabled: boolean) => void;
  /** For the LIVE redis.connected indicator only — not an editable form field. See Infrastructure.tsx. */
  setRedisConnected: (connected: boolean) => void;
  updateDbConfig: (key: keyof DatabaseConfig, value: string | number | boolean) => void;
  updateRedisConfig: (key: keyof RedisConfig, value: string | boolean) => void;
  updateStorageConfig: (key: keyof StorageConfig, value: string | boolean) => void;
  updateEngineConfig: (key: keyof EngineConfig, value: string | boolean) => void;
  buildSavePayload: () => SaveConfigPayload;
}

/**
 * Owns the editable infrastructure form: dbConfig/redisConfig/storageConfig/engineConfig, the
 * redis-enabled/queue-enabled toggles, and the hydration that seeds them from the two server
 * sources (live /status + saved /config). Takes those two query results as arguments rather than
 * calling the query hooks itself — the page already holds them for its own loading/error early
 * returns, and passing them in keeps this hook testable without a QueryClientProvider.
 *
 * `redisConfig.connected` and the page's `queueStats` are LIVE indicators, not editable form state —
 * they are seeded by a separate effect that lives in the page (every refetch, not just once), and
 * `setRedisConnected` is the narrow write-path that effect uses into this hook's redisConfig.
 */
export function useInfraConfigForm(
  infraStatus: InfraStatus | undefined,
  savedConfig: SavedConfig | undefined,
): InfraConfigForm {
  const [dbConfig, setDbConfig] = useState<DatabaseConfig>({
    type: 'sqlite',
    builtIn: false,
    host: 'localhost',
    port: '5432',
    username: 'postgres',
    password: '',
    database: 'openwa',
    schema: 'public',
    poolSize: 10,
    sslEnabled: false,
    sslRejectUnauthorized: true,
  });

  const [redisConfig, setRedisConfig] = useState<RedisConfig>({
    builtIn: false,
    host: 'localhost',
    port: '6379',
    password: '',
    connected: false,
  });

  const [storageConfig, setStorageConfig] = useState<StorageConfig>({
    type: 'local',
    builtIn: false,
    localPath: './data/media',
    s3Bucket: '',
    s3Region: 'ap-southeast-1',
    s3AccessKey: '',
    s3SecretKey: '',
    s3Endpoint: '',
  });

  const [engineConfig, setEngineConfig] = useState<EngineConfig>({
    type: 'whatsapp-web.js',
    headless: true,
    sessionDataPath: './data/sessions',
    browserArgs: '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu',
  });

  const [redisEnabled, setRedisEnabledState] = useState(false);
  const [queueEnabled, setQueueEnabled] = useState(false);

  // Whether the editable form has been seeded from the server once. After that, a background refetch
  // (react-query refetchOnWindowFocus) must NOT re-seed the editable fields or it would wipe the
  // operator's in-progress, unsaved edits. A successful save restarts → full page reload, re-arming it.
  const formHydrated = useRef(false);

  // The built-in flags are seeded from what is RUNNING, so until the operator flips one it is an
  // observation, not a choice. A save then carries the stored flag instead (see builtInToSave).
  const builtInTouched = useRef({ database: false, redis: false, storage: false });

  // The engine radio seeds ONCE from the saved file (see the effect below), then is never re-stamped by
  // a background refetch. `engineTouched` additionally wins over a late first resolution: if the
  // operator clicked a different engine before the seed resolved, the delayed seed must not revert
  // their selection (#735).
  const engineHydrated = useRef(false);
  const engineTouched = useRef(false);

  /** Whether engineConfig.type reflects a real value (seeded from the saved config or user-picked)
   * rather than the useState default — the save payload omits `type` when it doesn't. */
  const engineTypeKnown = (): boolean => engineHydrated.current || engineTouched.current;

  // Seed the editable form ONCE, when both reads are in. The saved config (data/.env.generated) is the
  // operator's intent, so it supplies every selection and detail field: the running process is stale from
  // the moment a change is saved until the server restarts, and a form seeded from it writes that stale
  // value back over the saved one on the next save of ANY field, deleting the stored settings of the
  // service it switched away from (the engine radio below learned the same, #1082). Only what the saved
  // config cannot say comes from the live /status: whether a bundled container is actually running (#488),
  // and a host, port or path nothing has saved. One effect once both exist also keeps the result from
  // depending on which read settled last. Secrets are never returned, so their inputs stay empty; an empty
  // submit preserves the stored secret on the backend (#226).
  useEffect(() => {
    if (!infraStatus || !savedConfig || formHydrated.current) return;
    formHydrated.current = true;
    const { database, redis, queue, storage, engine } = savedConfig;
    setDbConfig(prev => ({
      ...prev,
      type: database.type,
      host: database.host || infraStatus.database.host || 'localhost',
      port: database.port || prev.port,
      username: database.username || prev.username,
      database: database.database || prev.database,
      schema: database.schema || prev.schema,
      poolSize: database.poolSize,
      sslEnabled: database.sslEnabled,
      sslRejectUnauthorized: database.sslRejectUnauthorized,
      // builtIn reflects whether OpenWA's bundled container is actually running (live), not saved intent.
      builtIn: infraStatus.database.builtIn,
    }));
    setRedisConfig(prev => ({
      ...prev,
      host: redis.host || infraStatus.redis.host,
      port: redis.port || String(infraStatus.redis.port),
      builtIn: infraStatus.redis.builtIn,
    }));
    setRedisEnabledState(redis.enabled);
    setQueueEnabled(queue.enabled);
    setStorageConfig(prev => ({
      ...prev,
      type: storage.type,
      localPath: storage.localPath || infraStatus.storage.path || './uploads',
      s3Bucket: storage.s3Bucket || prev.s3Bucket,
      s3Region: storage.s3Region || prev.s3Region,
      s3Endpoint: storage.s3Endpoint || prev.s3Endpoint,
      builtIn: infraStatus.storage.builtIn,
    }));
    setEngineConfig(prev => ({
      ...prev,
      headless: engine.headless,
      sessionDataPath: engine.sessionDataPath || prev.sessionDataPath,
      browserArgs: engine.browserArgs || prev.browserArgs,
    }));
  }, [infraStatus, savedConfig]);

  // Seed the radio once from /config, and never after the operator has touched it (#735).
  //
  // /config reports the EFFECTIVE engine: the saved file value while nothing pins ENGINE_TYPE, the
  // pinned value outright when an environment variable supplies one (#1313). Either way the seeded
  // value may be one nobody chose here — the running one is stale from the moment a change is saved
  // until the server restarts — so the seed is display-only: buildSavePayload omits `type` for an
  // untouched seed under a pin, and only an operator click (engineTouched) persists a selection. What
  // is actually running is reported by the card badge and, when the two differ, named by the card's
  // own notice.
  useEffect(() => {
    const seed = savedConfig?.engine.type;
    if (!seed || engineHydrated.current || engineTouched.current) return;
    engineHydrated.current = true;
    setEngineConfig(prev => (prev.type === seed ? prev : { ...prev, type: seed }));
  }, [savedConfig]);

  const updateDbConfig = (key: keyof DatabaseConfig, value: string | number | boolean) => {
    if (key === 'builtIn') builtInTouched.current.database = true;
    setDbConfig(prev => ({ ...prev, [key]: value }));
  };
  const updateRedisConfig = (key: keyof RedisConfig, value: string | boolean) => {
    if (key === 'builtIn') builtInTouched.current.redis = true;
    setRedisConfig(prev => ({ ...prev, [key]: value }));
  };
  const updateStorageConfig = (key: keyof StorageConfig, value: string | boolean) => {
    if (key === 'builtIn') builtInTouched.current.storage = true;
    setStorageConfig(prev => ({ ...prev, [key]: value }));
  };
  const updateEngineConfig = (key: keyof EngineConfig, value: string | boolean) => {
    if (key === 'type') engineTouched.current = true;
    setEngineConfig(prev => ({ ...prev, [key]: value }));
  };

  // Disabling Redis also disables the queue, since queue processing depends on it.
  const setRedisEnabled = (enabled: boolean) => {
    setRedisEnabledState(enabled);
    if (!enabled) setQueueEnabled(false);
  };

  const setRedisConnected = (connected: boolean) => setRedisConfig(prev => ({ ...prev, connected }));

  // The flag a save carries: the operator's flip, else the stored one. Until it is flipped, the flag shown
  // is what runs, and writing that back would turn a bundled service into an external one (or the reverse)
  // that was saved and is waiting for a restart, along with the credentials that service owns. It is always
  // sent, never left out: the backend builds the Docker profile list from it.
  const builtInToSave = (section: 'database' | 'redis' | 'storage', shown: boolean): boolean =>
    builtInTouched.current[section] ? shown : (savedConfig?.[section].builtIn ?? shown);

  const buildSavePayload = (): SaveConfigPayload => ({
    // A bundled container never receives a typed password (the field is hidden once built-in is on,
    // but a value typed before the toggle survives in state). '' means "unchanged" on the backend.
    database: builtInToSave('database', dbConfig.builtIn)
      ? { ...dbConfig, builtIn: true, password: '' }
      : { ...dbConfig, builtIn: false },
    // `connected` is runtime-only status, not persisted configuration. Keep it out of the
    // whitelisted backend DTO so a valid dashboard save cannot be rejected as an unknown field.
    redis: {
      enabled: redisEnabled,
      builtIn: builtInToSave('redis', redisConfig.builtIn),
      host: redisConfig.host,
      port: redisConfig.port,
      password: builtInToSave('redis', redisConfig.builtIn) ? '' : redisConfig.password,
    },
    queue: { enabled: queueEnabled },
    storage: { ...storageConfig, builtIn: builtInToSave('storage', storageConfig.builtIn) },
    // Only send `type` once we actually know it — either the radio seeded from /config or the
    // operator picked one. If /config never resolved, engineConfig.type still holds its useState
    // default, and sending that would persist ENGINE_TYPE and silently flip the engine on the next
    // restart. The backend treats an absent `type` as "leave ENGINE_TYPE alone".
    //
    // An untouched seed under a PINNED ENGINE_TYPE counts as unknown too: /config reports the
    // effective (pinned) engine, so the seeded value is the pin, not a choice made here — sending
    // it would bake the pin into data/.env.generated over the operator's stored choice, which
    // unsetting the variable was supposed to reveal (#1082). Pin-ness is read HERE, at save time,
    // not at seed time: the two queries settle independently and the save click always sees the
    // latest /status. An operator click (engineTouched) is a deliberate choice and always sends.
    engine:
      engineTypeKnown() &&
      !(engineHydrated.current && !engineTouched.current && infraStatus?.envPinned?.includes('ENGINE_TYPE'))
        ? { ...engineConfig }
        : { ...engineConfig, type: undefined },
  });

  return {
    dbConfig,
    redisConfig,
    storageConfig,
    engineConfig,
    redisEnabled,
    queueEnabled,
    setRedisEnabled,
    setQueueEnabled,
    setRedisConnected,
    updateDbConfig,
    updateRedisConfig,
    updateStorageConfig,
    updateEngineConfig,
    buildSavePayload,
  };
}
