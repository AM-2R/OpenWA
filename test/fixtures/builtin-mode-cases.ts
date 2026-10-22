// The saved built-in mode GET /infra/config answers with, for every state of the saved file and of what the
// environment pins for the service's host key. One table for both halves of the Infrastructure page: the
// controller specs assert the answer, the dashboard page tests render the form from it.
//
// The rule, per service (database, redis, storage):
//  1. A host pinned by the environment decides: pinned to the bundled host is built-in, anything else is not,
//     and the saved flag says nothing (builtInSet false).
//  2. Otherwise the saved flag counts (builtInSet true) only when the file also selects the service. The first
//     boot writes every flag as false next to a service that is not selected, which is a default, not a choice.
//     A flag that is not true beside the bundled host name in the file is no choice of an external service either:
//     the next boot dials the container (builtIn true, builtInSet false).
//  3. Otherwise nothing is saved (builtInSet false) and the page follows what runs.

export type FileState =
  'absent' | 'template' | 'stored-false' | 'stored-true' | 'unselected-true' | 'bundled-host' | 'saved-bundled';
export type PinState = 'none' | 'bundled' | 'external';
export type ServiceName = 'database' | 'redis' | 'storage';

export interface SavedMode {
  builtIn: boolean;
  builtInSet: boolean;
}

export const FILE_STATES: readonly FileState[] = [
  'absent',
  'template',
  'stored-false',
  'stored-true',
  'unselected-true',
  'bundled-host',
  'saved-bundled',
];
export const PIN_STATES: readonly PinState[] = ['none', 'bundled', 'external'];
export const SERVICE_NAMES: readonly ServiceName[] = ['database', 'redis', 'storage'];

export const SERVICES: Record<
  ServiceName,
  {
    flag: string;
    host: string;
    bundledHost: string;
    externalHost: string;
    selection: string;
    selected: string;
    unselected: string;
  }
> = {
  database: {
    flag: 'POSTGRES_BUILTIN',
    host: 'DATABASE_HOST',
    bundledHost: 'postgres',
    externalHost: 'db.external.example',
    selection: 'DATABASE_TYPE',
    selected: 'postgres',
    unselected: 'sqlite',
  },
  redis: {
    flag: 'REDIS_BUILTIN',
    host: 'REDIS_HOST',
    bundledHost: 'redis',
    externalHost: 'cache.external.example',
    selection: 'REDIS_ENABLED',
    selected: 'true',
    unselected: 'false',
  },
  storage: {
    flag: 'MINIO_BUILTIN',
    host: 'S3_ENDPOINT',
    bundledHost: 'http://minio:9000',
    externalHost: 'https://s3.external.example',
    selection: 'STORAGE_TYPE',
    selected: 's3',
    unselected: 'local',
  },
};

const PINNED_BUNDLED: SavedMode = { builtIn: true, builtInSet: false };
const PINNED_EXTERNAL: SavedMode = { builtIn: false, builtInSet: false };

export const EXPECTED_MODE: Record<FileState, Record<PinState, SavedMode>> = {
  // Nothing in the file about the service.
  absent: {
    none: { builtIn: false, builtInSet: false },
    bundled: PINNED_BUNDLED,
    external: PINNED_EXTERNAL,
  },
  // What the first boot writes: the flag false, the service not selected.
  template: {
    none: { builtIn: false, builtInSet: false },
    bundled: PINNED_BUNDLED,
    external: PINNED_EXTERNAL,
  },
  // Saved from the dashboard with the service selected.
  'stored-false': {
    none: { builtIn: false, builtInSet: true },
    bundled: PINNED_BUNDLED,
    external: PINNED_EXTERNAL,
  },
  'stored-true': {
    none: { builtIn: true, builtInSet: true },
    bundled: PINNED_BUNDLED,
    external: PINNED_EXTERNAL,
  },
  // A flag left true beside a service the file does not select.
  'unselected-true': {
    none: { builtIn: true, builtInSet: false },
    bundled: PINNED_BUNDLED,
    external: PINNED_EXTERNAL,
  },
  // The service selected, the flag false and the bundled host name typed in the file (a compose name).
  'bundled-host': {
    none: { builtIn: true, builtInSet: false },
    bundled: PINNED_BUNDLED,
    external: PINNED_EXTERNAL,
  },
  // What the dashboard writes for a saved built-in choice: the service selected, the flag true, the bundled host.
  'saved-bundled': {
    none: { builtIn: true, builtInSet: true },
    bundled: PINNED_BUNDLED,
    external: PINNED_EXTERNAL,
  },
};

/**
 * What GET /infra/status answers with Docker unreachable, where there is no container to see. A host name proves
 * nothing there (an external server may be called postgres), so only the flag counts: the environment's, else the
 * file's, whatever the host pins say.
 */
export const FALLBACK_BUILT_IN: Record<FileState, boolean> = {
  absent: false,
  template: false,
  'stored-false': false,
  'stored-true': true,
  'unselected-true': true,
  'bundled-host': false,
  'saved-bundled': true,
};

/** The lines a saved file holds about one service in a given state. */
export function fileLines(service: ServiceName, state: FileState): string[] {
  const spec = SERVICES[service];
  switch (state) {
    case 'absent':
      return [];
    case 'template':
      return [`${spec.selection}=${spec.unselected}`, `${spec.flag}=false`];
    case 'stored-false':
      return [`${spec.selection}=${spec.selected}`, `${spec.flag}=false`];
    case 'stored-true':
      return [`${spec.selection}=${spec.selected}`, `${spec.flag}=true`];
    case 'unselected-true':
      return [`${spec.selection}=${spec.unselected}`, `${spec.flag}=true`];
    case 'bundled-host':
      return [`${spec.selection}=${spec.selected}`, `${spec.flag}=false`, `${spec.host}=${spec.bundledHost}`];
    case 'saved-bundled':
      return [`${spec.selection}=${spec.selected}`, `${spec.flag}=true`, `${spec.host}=${spec.bundledHost}`];
  }
}

/** The host the environment pins for a service, or undefined when it pins none. */
export function pinnedHost(service: ServiceName, pin: PinState): string | undefined {
  const spec = SERVICES[service];
  return pin === 'none' ? undefined : pin === 'bundled' ? spec.bundledHost : spec.externalHost;
}

/**
 * Host spellings for each service. `reach` names the bundled container all the same: Docker's DNS answers to its
 * network alias and its container name, in any letter case and as an absolute name with a trailing dot (for storage,
 * the host of the endpoint URL). `elsewhere` names another server. Every decision that asks whether a host is the
 * bundled container (start, stop, stored credentials, the built-in mode, the page's notes and restart list) must
 * answer the same for each.
 */
export const HOST_SPELLINGS: Record<ServiceName, { reach: string[]; elsewhere: string[] }> = {
  database: {
    reach: ['postgres', 'Postgres', 'postgres.', 'openwa-postgres', ' OPENWA-POSTGRES. '],
    elsewhere: ['localhost', 'postgres-replica', 'postgres.example.com', 'openwa-postgres-2', ''],
  },
  redis: {
    reach: ['redis', 'REDIS', 'redis.', 'openwa-redis'],
    elsewhere: ['localhost', 'redis-master', 'myredis', ''],
  },
  storage: {
    reach: [
      'http://minio:9000',
      'http://MINIO:9000',
      'http://minio:9000/',
      'http://openwa-minio:9000',
      'https://minio.:9000',
    ],
    elsewhere: ['http://localhost:9000', 'http://minio.example.com:9000', 'minio:9000', 'not a url', ''],
  },
};
