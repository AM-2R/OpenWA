import type { GroupMetadata } from '@whiskeysockets/baileys';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

/** How long a group's participant list is reused before Baileys reads it again; 0 switches the cache off. */
const DEFAULT_GROUP_METADATA_CACHE_TTL_MS = 5 * 60_000;

/** BAILEYS_GROUP_METADATA_CACHE_TTL_MS, read per session so a restart picks up a change. */
export function groupMetadataCacheTtlMs(): number {
  return resolveNonNegativeIntEnv(process.env.BAILEYS_GROUP_METADATA_CACHE_TTL_MS, DEFAULT_GROUP_METADATA_CACHE_TTL_MS);
}

/** The cached copy of one group's metadata and when it was read. */
interface CachedGroup {
  metadata: GroupMetadata;
  storedAt: number;
}

/**
 * The cache behind Baileys' `cachedGroupMetadata` option, one per session.
 *
 * Without it every group send makes its own query for the group's participant list, which for a busy
 * account is one extra round trip (and one more chance at a throttle) per message, each parsing the
 * whole member list. With it the list is reused for up to `ttlMs`.
 *
 * A stale list costs a delay, not a message: a member added since is left out of the sender-key
 * distribution until its client asks for a retry, which Baileys answers. The entry is dropped on the
 * events that change membership or group settings, the whole cache on every connection change (the
 * events missed while offline never arrive), and it expires on its own after `ttlMs`.
 */
export class GroupMetadataCache {
  private readonly entries = new Map<string, CachedGroup>();
  /** Reads under way, so concurrent sends to one group share a single query. */
  private readonly inFlight = new Map<string, Promise<GroupMetadata>>();
  /** In-flight reads that an invalidation overtook: their answer is returned but not kept. */
  private readonly overtaken = new Set<string>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 256,
    private readonly now: () => number = Date.now,
  ) {}

  /** A TTL of 0 switches the cache off: Baileys then queries on its own, as it does without one. */
  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The group's metadata if it was read within the TTL; a hit is marked most recently used. */
  peek(jid: string): GroupMetadata | undefined {
    const cached = this.entries.get(jid);
    if (!cached) return undefined;
    if (this.now() - cached.storedAt >= this.ttlMs) {
      this.entries.delete(jid);
      return undefined;
    }
    this.entries.delete(jid);
    this.entries.set(jid, cached);
    return cached.metadata;
  }

  /**
   * The group's metadata from the cache, or from `fetch` (the query Baileys would have made) when it
   * holds none, remembering the answer. Undefined when the cache is off.
   */
  read(jid: string, fetch: () => Promise<GroupMetadata>): Promise<GroupMetadata | undefined> {
    if (!this.enabled) return Promise.resolve(undefined);
    const hit = this.peek(jid);
    if (hit) return Promise.resolve(hit);
    const joined = this.inFlight.get(jid);
    if (joined) return joined;
    const pending = (async (): Promise<GroupMetadata> => {
      try {
        const metadata = await fetch();
        if (!this.overtaken.has(jid)) this.store(jid, metadata);
        return metadata;
      } finally {
        this.overtaken.delete(jid);
        this.inFlight.delete(jid);
      }
    })();
    this.inFlight.set(jid, pending);
    return pending;
  }

  /**
   * Replace the copy of a group that is already cached with metadata that arrived whole. A group nobody
   * has sent to is not added: the cache holds what sends use, not every group the account is in.
   */
  refresh(metadata: GroupMetadata): void {
    if (this.enabled && metadata.id && this.entries.has(metadata.id)) this.store(metadata.id, metadata);
  }

  /** Forget one group: its membership or settings changed, so the next send reads it again. */
  invalidate(jid: string | undefined): void {
    if (!jid) return;
    this.entries.delete(jid);
    if (this.inFlight.has(jid)) this.overtaken.add(jid);
  }

  /** Forget everything, for a connection change or a teardown. */
  clear(): void {
    this.entries.clear();
    for (const jid of this.inFlight.keys()) this.overtaken.add(jid);
  }

  /**
   * Apply a `groups.update` batch. A whole-metadata entry (the result of a full group fetch, which
   * Baileys also emits through this event) refreshes the cached copy; a partial one is a real change to
   * some field, so the group is read again on the next send.
   */
  applyUpdates(updates: ReadonlyArray<Partial<GroupMetadata>> | undefined): void {
    for (const update of updates ?? []) {
      if (!update?.id) continue;
      if (Array.isArray(update.participants)) this.refresh(update as GroupMetadata);
      else this.invalidate(update.id);
    }
  }

  private store(jid: string, metadata: GroupMetadata): void {
    this.entries.delete(jid);
    this.entries.set(jid, { metadata, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const [oldest] = this.entries.keys();
      this.entries.delete(oldest);
    }
  }
}
