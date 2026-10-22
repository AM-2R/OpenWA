// The saved built-in mode GET /infra/config answers with, for every state of the saved file and of what the
// environment pins for the service's host key. One table for both halves of the Infrastructure page: the
// controller specs assert the answer, the dashboard page tests render the form from it.
//
// The rule, per service (database, redis, storage):
//  1. A host pinned by the environment decides: pinned to the bundled host is built-in, anything else is not,
//     and the saved flag says nothing (builtInSet false).
//  2. Otherwise the saved flag counts (builtInSet true) only when the file also selects the service. The first
//     boot writes every flag as false next to a service that is not selected, which is a default, not a choice.
//  3. Otherwise nothing is saved (builtInSet false) and the page follows what runs.

export type FileState = 'absent' | 'template' | 'stored-false' | 'stored-true' | 'unselected-true';
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
  }
}

/** The host the environment pins for a service, or undefined when it pins none. */
export function pinnedHost(service: ServiceName, pin: PinState): string | undefined {
  const spec = SERVICES[service];
  return pin === 'none' ? undefined : pin === 'bundled' ? spec.bundledHost : spec.externalHost;
}
