import { isEnvPinned } from '../../config/env-precedence';

/**
 * The built-in (bundled container) mode the saved configuration states for each datastore, shared by
 * GET /infra/config and the Docker-unreachable fallback of GET /infra/status so the two cannot disagree.
 *
 * `flag` is what the dashboard saves, `host` is what the next boot connects to, and `selection` is the
 * file's own record that the service is in use at all.
 */
const SERVICES = {
  database: {
    flag: 'POSTGRES_BUILTIN',
    host: 'DATABASE_HOST',
    bundledHost: 'postgres',
    selection: 'DATABASE_TYPE',
    selected: 'postgres',
  },
  redis: {
    flag: 'REDIS_BUILTIN',
    host: 'REDIS_HOST',
    bundledHost: 'redis',
    selection: 'REDIS_ENABLED',
    selected: 'true',
  },
  storage: {
    flag: 'MINIO_BUILTIN',
    host: 'S3_ENDPOINT',
    bundledHost: 'http://minio:9000',
    selection: 'STORAGE_TYPE',
    selected: 's3',
  },
} as const;

export type BuiltInService = keyof typeof SERVICES;

export interface SavedBuiltInMode {
  /** The mode the saved configuration implies: bundled container or not. */
  builtIn: boolean;
  /**
   * Whether that mode is a saved choice. False when a host pin decides it, when the file does not select the
   * service (the first boot writes every flag false next to a service that is not in use), and when nothing
   * says anything at all: a reader then follows what runs.
   */
  builtInSet: boolean;
}

/**
 * Rules, in order:
 *  1. A host pinned by the environment (or the project .env) decides, as it does at boot and in
 *     requestRestart: the bundled host is built-in, any other is not, and no saved flag can be a pending
 *     switch because the pin outranks it.
 *  2. Otherwise the flag counts as saved when the environment pins it, or when the file stores it for a
 *     service the file also selects.
 *  3. Otherwise there is nothing saved.
 */
export function savedBuiltInMode(service: BuiltInService, saved: Record<string, string>): SavedBuiltInMode {
  const spec = SERVICES[service];
  if (isEnvPinned(spec.host)) {
    return { builtIn: process.env[spec.host] === spec.bundledHost, builtInSet: false };
  }
  const flagPinned = isEnvPinned(spec.flag);
  const flag = (flagPinned ? process.env[spec.flag] : undefined) ?? saved[spec.flag];
  const selectedInFile = saved[spec.selection] === spec.selected;
  return { builtIn: flag === 'true', builtInSet: flag !== undefined && (flagPinned || selectedInFile) };
}
