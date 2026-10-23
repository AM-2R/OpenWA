import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Raw, Repository } from 'typeorm';
import { LidMapping } from './lid-mapping.entity';
import { userPart } from './wa-id';
import { createLogger } from '../../common/services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

// Default cap on the in-memory lid->phone mirror. Every other long-lived map in the engine surface is
// bounded (the per-session lidPhoneCache is 5000); the LID mirror was the lone exception. A miss falls
// back to engine re-resolution (a reverse lookup reads the table), so the cap trades a re-resolution for
// bounded memory, never data loss.
export const LID_MAPPING_CACHE_DEFAULT = 5000;

/**
 * SQLite binds at most 32766 variables in one statement (Postgres 65535), so an `IN (...)` over a
 * large allowlist is chunked. Small enough to stay well inside both, large enough that a realistic
 * allowlist is one round trip.
 */
const LID_QUERY_CHUNK = 500;

/**
 * How long a report waits after the same write failed. A database that is down or full would otherwise take
 * one failed statement, and log one warning, per inbound message from the contact. The same hold the
 * sender resolver gives a lid no store maps.
 */
const LID_WRITE_RETRY_MS = 60_000;

/** A lid's failed phone write, and when a warning about the lid was last logged. */
interface FailedWrite {
  /** When it failed, in ms on the store's monotonic clock. */
  at: number;
  /** It was replacing another phone, which the table may still hold. */
  stale: boolean;
  warnedAt: number;
  /** Failures since that warning that were not logged. */
  unlogged: number;
}

function chunk<T>(items: T[], size = LID_QUERY_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Narrow read/write port over the `lid -> phone` table. The Baileys session store depends on this (sync
 * reads on the resolution hot path + write-through) and the message from-filter depends on the reverse
 * lookup - both on the interface, not the concrete service, so each stays unit-testable with a fake
 * (mirrors {@link BaileysMessageStore}).
 */
export interface LidMappingStore {
  /**
   * Sync read from the in-memory cache: phone digits, `null` = known-unresolved, `undefined` = never
   * seen. A miss is warmed from the persisted table in the background, so a later read can hit.
   */
  getCached(lid: string): string | null | undefined;
  /**
   * Resolve any WA JID through the mirror: the phone digits for its user part, `null` when the lid
   * is known-unresolved or never seen. The webhook filter match, automation-rule match, plugin
   * engine reads, and status contact grouping all resolve through this one method so they agree.
   */
  resolveLid(jid: string): string | null;
  /** Sync reverse lookup: the lids currently mapped to this phone (used by the message from-filter). */
  lidsForPhone(phone: string): string[];
  /** The phone the table holds for a lid JID, read from the database; null when none is stored. */
  findPhoneForLid?(jid: string): Promise<string | null>;
  /** The lids the table maps to these phone digits, read from the database. */
  findLidsForPhone?(phone: string): Promise<string[]>;
  /**
   * Write-through: update the cache + persist. A phone is last-write-wins. A session reporting the phone
   * this node already holds takes the row, unless this node already counted a report of it from that
   * session: after s1, s2, s1 report one phone the owner is s2. A `null` phone records a negative result,
   * and replaces a stored phone only when its owner (or none, or one since deleted or logged out) gives it.
   * Never rejects; resolves false when the report did not reach the table (its write failed, or waits after
   * one that did).
   */
  remember(lid: string, phone: string | null, sessionId?: string): Promise<boolean>;
}

/**
 * Backs lid resolution with the persisted {@link LidMapping} table. Resolution must be synchronous
 * (filters/dispatch can't await a query), so the table is loaded into an in-memory map on boot and kept
 * warm by write-through. A forward map (lid -> phone) serves resolution; a reverse map (phone -> lids)
 * serves the from-filter.
 *
 * The forward map is bounded by an LRU cap (`LID_MAPPING_CACHE_MAX`, default 5000) so a long-running,
 * contact-heavy account does not accumulate one entry per distinct LID ever seen into a slow memory leak.
 * A cache miss is warmed from the table in the background (rows past the preload cap stay resolvable)
 * and otherwise falls back to engine re-resolution (the table remains the source of truth), so eviction
 * only costs a re-resolution, never data loss. The reverse map has no such warm path (nothing looks a
 * lid up by phone), so a phone-keyed filter uses {@link findLidsForPhone}, which reads the table. The
 * reverse map is reconciled on each eviction so it does not retain entries for LIDs no longer in the
 * forward cache.
 */
@Injectable()
export class LidMappingStoreService implements LidMappingStore, OnModuleInit {
  private readonly logger = createLogger('LidMappingStore');
  private readonly lidToPhone = new Map<string, string | null>();
  private readonly phoneToLids = new Map<string, Set<string>>();
  /** Repository fallbacks in flight, one per lid, so a hot miss path can't stack duplicate queries. */
  private readonly pendingLookups = new Set<string>();
  /**
   * Lids the table answered for and had no row for. {@link pendingLookups} collapses only the lookups
   * that overlap a query already in flight, so without this every DISPATCH that names an unmapped lid
   * issued a fresh query for it, and the callers are on hot paths: a webhook filter resolves both the
   * event's actor and each of its own rule values, on every dispatch.
   *
   * Cleared for a lid the moment this process learns a mapping for it ({@link index}), and wholesale
   * when the table is reloaded. An absence is never RECORDED for a lid this process already holds or
   * is still writing ({@link unsettledWrites}), which is what keeps a query that raced a write from
   * shadowing the row it could not see yet.
   *
   * What it does NOT notice is a row ANOTHER process writes: that mapping stays unseen here until
   * this process learns it or reloads, exactly as a phone already cached in {@link lidToPhone} does.
   * Bounded by the same cap as the forward map, oldest-recorded first (the forward map is ordered by
   * recency of USE, this one by when the absence was recorded).
   */
  private readonly absentFromTable = new Set<string>();
  /**
   * Lids whose row this process has indexed but not yet committed. `remember()` updates the in-memory
   * maps synchronously and writes the table afterwards, so between the two a table read answers "no
   * row" about a mapping that is about to exist. The forward map cannot stand in for this: the LRU
   * can evict the entry inside that same window, leaving it indistinguishable from never-learned.
   * Counted per lid, so the first of two overlapping writes settling does not clear the second.
   */
  private readonly unsettledWrites = new Map<string, number>();
  /**
   * Lids a write started for while their table read was in flight. That read may have run before the
   * write committed, so whatever it answers predates the mapping this process now holds.
   */
  private readonly racedLookups = new Set<string>();
  /**
   * Sessions counted as having written or reported the phone a lid holds in {@link lidToPhone} (a loaded
   * row counts its owner). One not counted that reports the same phone takes the row, in one write, and is
   * counted; one already counted writes nothing. So the row names the latest uncounted session to report
   * the phone, not the latest to report it: after s1, s2, s1 report one phone it names s2, and s2's
   * negative clears a phone s1 still sees. Started anew when the phone changes, dropped with the cached
   * entry, on an applied negative and on any release, and a session whose write failed leaves it.
   */
  private readonly seenBy = new Map<string, Set<string>>();
  /**
   * Cached lids whose phone failed to write here (see {@link unstored}). Kept only while the cache holds that
   * phone: dropped with the cached entry, and once a write of it lands or a negative clears the row. The same
   * phone reported again waits {@link LID_WRITE_RETRY_MS} before it writes, from any session, so a failing
   * database takes one statement per lid a minute. A write that was replacing another phone does not wait:
   * until it lands the table may still name the old number, and a restart inside the wait would load it.
   */
  private readonly failedWrites = new Map<string, FailedWrite>();
  /** Monotonic clock in ms (a seam for tests). */
  private readonly now = (): number => performance.now();
  // 0 = unbounded (legacy behaviour). Every other long-lived map in the engine surface is bounded, so
  // the default is finite; the env override exists for operators who explicitly want the old behaviour.
  private readonly maxCachedLids: number;

  constructor(
    @InjectRepository(LidMapping, 'data')
    private readonly repo: Repository<LidMapping>,
  ) {
    this.maxCachedLids = resolveNonNegativeIntEnv(process.env.LID_MAPPING_CACHE_MAX, LID_MAPPING_CACHE_DEFAULT);
  }

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /**
   * (Re)load the in-memory mirror from the table. Called on boot, and by the infra data import after
   * a committed full-replace restore — the mirror is otherwise write-through only, so restored rows
   * would never reach it and entries the restore removed would stay resolvable until the next start.
   * Never throws: a missing table (migration not yet applied) or a read error must not block boot or
   * fail the import — resolution falls back to engine re-resolution until the table is readable.
   */
  async reload(): Promise<void> {
    // Dropped before the read too: a restore may have replaced the table, so if the read fails, a lid
    // not cached must read through rather than trust a stale absence.
    this.absentFromTable.clear();
    try {
      // Deterministic preload: an unordered find() followed by LRU eviction keeps an ARBITRARY
      // subset once the table exceeds the cap. Order by last-write and take at most the cap, so
      // the resident subset is the most-recently-written mappings; older rows stay persisted and
      // are warmed back on the first cache miss (see getCached).
      const rows = await this.repo.find({
        order: { updatedAt: 'DESC' },
        take: this.maxCachedLids > 0 ? this.maxCachedLids : undefined,
      });
      this.lidToPhone.clear();
      this.phoneToLids.clear();
      this.seenBy.clear();
      this.failedWrites.clear();
      // A reload re-reads the table, so every recorded absence is a fresh question again.
      this.absentFromTable.clear();
      // Oldest first, so the newest row ends at the most-recent end of the LRU rather than the first
      // one evicted.
      for (const row of rows.reverse()) {
        this.index(row.lid, row.phone, row.sessionId);
      }
      this.logger.log(
        `Loaded ${rows.length} lid->phone mappings into cache${this.maxCachedLids ? ` (cap ${this.maxCachedLids})` : ''}`,
      );
    } catch (err) {
      this.logger.warn(`Could not preload lid->phone mappings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getCached(lid: string): string | null | undefined {
    // LRU touch: re-insert the entry so iteration order (insertion order for Map) tracks recency.
    // A missed lookup returns undefined without disturbing the order.
    if (this.lidToPhone.has(lid)) {
      const phone = this.lidToPhone.get(lid);
      this.lidToPhone.delete(lid);
      this.lidToPhone.set(lid, phone as string | null);
      return phone;
    }
    this.warmFromTable(lid);
    return undefined;
  }

  resolveLid(jid: string): string | null {
    return this.getCached(userPart(jid)) ?? null;
  }

  lidsForPhone(phone: string): string[] {
    const set = this.phoneToLids.get(phone);
    return set ? [...set] : [];
  }

  /**
   * Reverse lookup that also reads the table. {@link lidsForPhone} only sees lids resident in the
   * forward cache, and nothing phone-keyed ever warms it, so a mapping past the preload cap or
   * evicted by the LRU would stay invisible to a phone filter for good. For callers that can await
   * (the message and status filters, the handover gate, the API-key chat fence). Same rule as
   * {@link lidsForPhonesPersisted}; a read error falls back to the cache alone.
   */
  async findLidsForPhone(phone: string): Promise<string[]> {
    try {
      return (await this.readLidsForPhones([phone]))[phone];
    } catch (err) {
      this.logger.warn(`Could not read lids for a phone: ${err instanceof Error ? err.message : String(err)}`);
      return this.lidsForPhone(phone);
    }
  }

  /**
   * Batched forward lookup for a list filter: lid user-part -> phone digits. Chunked queries for the
   * whole allowlist instead of one per entry, and the TABLE wins over the mirror so a stale cached
   * negative cannot shadow a mapping another node persisted.
   */
  async phonesForLidsPersisted(lids: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    if (lids.length === 0) return out;
    // The mirror is only the fallback for a failed or empty table read, so it is read without getCached:
    // that warms every miss with a findOne of its own, one per lid ahead of the batched query below.
    for (const lid of lids) out[lid] = this.lidToPhone.get(lid) ?? null;
    try {
      for (const batch of chunk(lids)) {
        const rows = await this.repo.find({ where: { lid: In(batch) } });
        for (const lid of batch) if (this.failedWrites.has(lid)) out[lid] = null;
        // The table WINS: a stale cached negative must not shadow a mapping another node persisted.
        for (const row of rows) out[row.lid] = this.rowPhone(row.lid, row.phone);
      }
    } catch {
      // The table may not exist yet (migration pending); the mirror is the best available answer.
    }
    return out;
  }

  /** Batched reverse lookup, companion to {@link phonesForLidsPersisted}: phone digits -> lids. */
  async lidsForPhonesPersisted(phones: string[]): Promise<Record<string, string[]>> {
    try {
      return await this.readLidsForPhones(phones);
    } catch {
      // The table may not exist yet (migration pending); the cache is the best available answer.
      return Object.fromEntries(phones.map(phone => [phone, this.lidsForPhone(phone)]));
    }
  }

  /**
   * A lid answers the phone its row holds ({@link rowPhone}), and a cached reverse entry stands in for a lid
   * the table has no row for (past the cache cap, or its write still in flight), unless that write failed.
   * Throws on a read error.
   */
  private async readLidsForPhones(phones: string[]): Promise<Record<string, string[]>> {
    const out: Record<string, Set<string>> = {};
    for (const phone of phones)
      out[phone] = new Set(this.lidsForPhone(phone).filter(lid => !this.failedWrites.has(lid)));
    const cachedLids = [...new Set(phones.flatMap(phone => [...out[phone]]))];
    for (const batch of chunk(cachedLids)) {
      for (const row of await this.repo.find({ where: { lid: In(batch) } })) {
        for (const phone of phones) if (row.phone !== phone) out[phone].delete(row.lid);
      }
    }
    for (const batch of chunk(phones)) {
      for (const { lid, phone } of await this.repo.find({ where: { phone: In(batch) } })) {
        if (!phone || !out[phone]) continue;
        if (this.rowPhone(lid, phone) === phone) out[phone].add(lid);
      }
    }
    return Object.fromEntries(phones.map(phone => [phone, [...out[phone]]]));
  }

  /** This process has a phone write for the lid that the table does not have: in flight, or failed. */
  private unstored(lid: string): boolean {
    return this.unsettledWrites.has(lid) || this.failedWrites.has(lid);
  }

  /**
   * The phone a lid's row answers. The table is the truth across nodes, but while a phone this process holds
   * for the lid is not stored yet, a row that differs may be the number it replaces: the lid then answers
   * none, so no fence lookup admits either one until the write lands.
   */
  private rowPhone(lid: string, phone: string | null): string | null {
    const cached = this.lidToPhone.get(lid);
    return this.unstored(lid) && cached !== undefined && cached !== phone ? null : phone;
  }

  /**
   * Forward lookup for callers that can await: the API-key chat fence and every chat-bound read
   * behind it (message history and media, the quoted body, status and handover filters). The table
   * answers first, the in-memory mirror only when the read fails or has no row. The mirror alone is
   * not enough: it is LRU-evicted at `LID_MAPPING_CACHE_MAX`, and nothing refreshes it when another
   * node re-maps a lid in the shared table, so a cache-first answer could resolve the same lid to
   * a phone the fence no longer sees, and a read behind the fence would serve that other chat. The
   * row is not indexed into the cache, so a lookup cannot evict hot entries. A row is vetoed while this
   * process has a different phone for the lid in flight or failed ({@link rowPhone}); with no row, a cached
   * phone whose write failed answers none.
   */
  async findPhoneForLid(jid: string): Promise<string | null> {
    const lid = userPart(jid);
    try {
      const row = await this.repo.findOne({ where: { lid } });
      if (row) return this.rowPhone(lid, row.phone);
      if (this.failedWrites.has(lid)) return null;
    } catch (err) {
      this.logger.warn(`Could not read the phone for a lid: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.getCached(lid) ?? null;
  }

  async remember(lid: string, phone: string | null, sessionId?: string): Promise<boolean> {
    if (!lid) return true;
    const cached = this.lidToPhone.get(lid);
    // Unseen-or-changed only, or a phone a session reports here for the first time: a no-op write would
    // just churn updatedAt.
    if (cached === phone && (phone === null || !sessionId || this.seenBy.get(lid)?.has(sessionId))) {
      return true;
    }
    const failed = this.failedWrites.get(lid);
    if (cached === phone && failed && !failed.stale && this.now() - failed.at < LID_WRITE_RETRY_MS) return false;
    // A negative is not cached until the table has taken it: see clear().
    if (phone !== null) this.index(lid, phone, sessionId ?? null);
    this.unsettledWrites.set(lid, (this.unsettledWrites.get(lid) ?? 0) + 1);
    if (this.pendingLookups.has(lid)) this.racedLookups.add(lid);
    try {
      if (phone === null) await this.clear(lid, sessionId ?? null);
      else {
        await this.repo.upsert({ lid, phone, sessionId: sessionId ?? null, updatedAt: new Date() }, ['lid']);
        if (this.lidToPhone.get(lid) === phone) this.failedWrites.delete(lid);
      }
      return true;
    } catch (err) {
      // The table does not have this report, so the session's next one writes again.
      if (sessionId) this.seenBy.get(lid)?.delete(sessionId);
      const message = `Failed to persist lid->phone mapping for ${lid}: ${err instanceof Error ? err.message : String(err)}`;
      if (phone !== null && this.lidToPhone.get(lid) === phone) {
        this.noteFailedWrite(lid, typeof cached === 'string' && cached !== phone, message);
      } else {
        this.logger.warn(message);
      }
      return false;
    } finally {
      const left = (this.unsettledWrites.get(lid) ?? 1) - 1;
      if (left > 0) this.unsettledWrites.set(lid, left);
      else this.unsettledWrites.delete(lid);
    }
  }

  /**
   * Record that a session found no phone for a lid. The row is shared by every session, and one account
   * can see a contact's number while another cannot, so a negative replaces the row only when it holds
   * no phone or the phone was written by this session (or by none, or by one no longer linked: gone from
   * `sessions`, or logged out, which clears its `phone`); another linked session's mapping stays. The check
   * is part of the update, not a read before it, so a phone stored meanwhile is never overwritten. When the
   * row is cleared the cached entry is dropped rather than set: a phone written while the statements ran may
   * be the newer value, and the next read takes whichever the table holds.
   */
  private async clear(lid: string, sessionId: string | null): Promise<void> {
    const updatedAt = new Date();
    // Creates the row when there is none; an existing one is left to the conditional update.
    await this.repo
      .createQueryBuilder()
      .insert()
      .values({ lid, phone: null, sessionId, updatedAt })
      .orIgnore()
      .execute();
    const replaceable = [
      { lid, phone: IsNull() },
      { lid, sessionId: IsNull() },
      // A session deleted without its rows being released (an older release, a crash, a restored backup)
      // owns them no more than a released one does, and neither does one logged out: it reports nothing
      // until it is linked again. CAST: sessions.id is a uuid on PostgreSQL.
      {
        lid,
        sessionId: Raw(
          owner => `${owner} NOT IN (SELECT CAST(s."id" AS TEXT) FROM sessions s WHERE s."phone" IS NOT NULL)`,
        ),
      },
      ...(sessionId ? [{ lid, sessionId }] : []),
    ];
    const { affected } = await this.repo.update(replaceable, { phone: null, sessionId, updatedAt });
    if (!affected) return;
    const cached = this.lidToPhone.get(lid);
    this.lidToPhone.delete(lid);
    this.seenBy.delete(lid);
    this.failedWrites.delete(lid);
    if (cached) this.unindex(lid, cached);
    this.absentFromTable.delete(lid);
  }

  /** Record a failed phone write for {@link failedWrites}, and log it once a lid per hold, counting the rest. */
  private noteFailedWrite(lid: string, replacing: boolean, message: string): void {
    const now = this.now();
    const failed = this.failedWrites.get(lid) ?? { at: now, stale: false, warnedAt: -Infinity, unlogged: 0 };
    Object.assign(failed, { at: now, stale: replacing || failed.stale });
    if (now - failed.warnedAt >= LID_WRITE_RETRY_MS) {
      this.logger.warn(
        failed.unlogged ? `${message} (${failed.unlogged} more failed since the last warning)` : message,
      );
      failed.warnedAt = now;
      failed.unlogged = 0;
    } else {
      failed.unlogged++;
    }
    this.failedWrites.set(lid, failed);
  }

  /**
   * Hand a deleted session's rows to no session. Its id never comes back (a re-created session gets a
   * new one); {@link clear} also treats an owner missing from `sessions` as none, which covers a delete
   * that never got here. The rows stay: the table is shared. Never throws: the session is already gone.
   */
  async releaseSession(sessionId: string): Promise<void> {
    // A session that already reported a lid's phone writes nothing when it reports it again, so a row left
    // without an owner here would stay so. Every set is dropped, even if the update fails, so each live
    // session's next report takes its rows back.
    this.seenBy.clear();
    try {
      // updatedAt is kept: no mapping changed, and the preload ranks rows by it.
      await this.repo.update({ sessionId }, { sessionId: null, updatedAt: () => '"updatedAt"' });
    } catch (err) {
      this.logger.warn(`Could not release lid mappings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Repository fallback for a cache miss. Rows past the preload cap (or evicted by the LRU) are
   * still persisted, so a miss is warmed from the table: THIS lookup still returns undefined —
   * the sync read contract can't await, and callers fall back to engine re-resolution, but the
   * next one hits. A table miss IS remembered, so an unmapped lid stops re-querying on every
   * lookup ({@link absentFromTable}), but only when nothing learned that lid in the meantime;
   * a read error is swallowed (the table may not exist yet), the same posture as reload().
   */
  private warmFromTable(lid: string): void {
    if (!lid || this.pendingLookups.has(lid) || this.absentFromTable.has(lid)) return;
    this.pendingLookups.add(lid);
    // Captured BEFORE the query: a write for this lid that has not reached the table yet means the
    // answer is already stale, whatever it says. The forward-map check below cannot see that case,
    // because `remember()` indexes synchronously and the LRU can evict the entry again before the
    // query answers, at which point the map looks exactly like "never learned".
    const writeInFlight = this.unsettledWrites.has(lid);
    void this.repo
      .findOne({ where: { lid } })
      .then(row => {
        // A write that was unsettled when the query ran, or started while it was in flight, is newer
        // than either answer: a row would be the phone it replaces, served as a hit after the write
        // commits, and an absence would block the warm-back once the LRU evicts the forward entry.
        // Neither is recorded, so the next miss reads the table again.
        if (writeInFlight || this.racedLookups.has(lid)) return;
        // Last-write-wins: a mapping indexed while the lookup was in flight is newer.
        if (row && !this.lidToPhone.has(row.lid)) {
          this.index(row.lid, row.phone, row.sessionId);
          return;
        }
        if (!row && !this.lidToPhone.has(lid)) this.noteAbsent(lid);
      })
      .catch(() => undefined)
      .finally(() => {
        this.pendingLookups.delete(lid);
        this.racedLookups.delete(lid);
      });
  }

  /** Update both in-memory indexes, dropping any stale reverse entry from a previous phone. */
  private index(lid: string, phone: string | null, sessionId: string | null): void {
    const prev = this.lidToPhone.get(lid);
    if (prev && prev !== phone) {
      this.unindex(lid, prev);
    }
    const seen = (prev === phone && this.seenBy.get(lid)) || new Set<string>();
    if (sessionId) seen.add(sessionId);
    if (phone) this.seenBy.set(lid, seen);
    else this.seenBy.delete(lid);
    // Re-insert (delete + set) so the entry moves to the most-recent end of the LRU order even on update.
    this.lidToPhone.delete(lid);
    this.lidToPhone.set(lid, phone);
    if (phone) {
      const set = this.phoneToLids.get(phone) ?? new Set<string>();
      set.add(lid);
      this.phoneToLids.set(phone, set);
    }
    this.absentFromTable.delete(lid);
    this.evictIfOverCap();
  }

  /**
   * Record that the table holds no row for this lid, bounded oldest-recorded first.
   *
   * Skipped entirely when the cap is disabled: that mode is the legacy unbounded cache, and an
   * absence set is the one map here that grows on ids a caller supplies rather than on mappings the
   * account really has, so leaving it unbounded would be a leak an operator never opted into.
   */
  private noteAbsent(lid: string): void {
    if (!this.maxCachedLids) return;
    this.absentFromTable.add(lid);
    while (this.absentFromTable.size > this.maxCachedLids) {
      const oldest = this.absentFromTable.values().next().value;
      if (oldest === undefined) break;
      this.absentFromTable.delete(oldest);
    }
  }

  /** Evict the least-recently-used forward entry (and its reverse index) while over the cap. */
  private evictIfOverCap(): void {
    if (!this.maxCachedLids) return; // unbounded
    while (this.lidToPhone.size > this.maxCachedLids) {
      const oldest = this.lidToPhone.keys().next().value;
      if (oldest === undefined) break;
      const phone = this.lidToPhone.get(oldest);
      this.lidToPhone.delete(oldest);
      this.seenBy.delete(oldest);
      this.failedWrites.delete(oldest);
      if (phone) this.unindex(oldest, phone);
    }
  }

  /** Drop a lid from its phone's reverse entry, and the entry itself once no lid is left under it. */
  private unindex(lid: string, phone: string): void {
    const set = this.phoneToLids.get(phone);
    if (set?.delete(lid) && set.size === 0) this.phoneToLids.delete(phone);
  }
}
