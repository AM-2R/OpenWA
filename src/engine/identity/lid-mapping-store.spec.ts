import { randomUUID } from 'crypto';
import { DataSource, FindOperator, In, Repository } from 'typeorm';
import { LidMappingStoreService } from './lid-mapping-store.service';
import { LidMapping } from './lid-mapping.entity';
import { Session } from '../../modules/session/entities/session.entity';

/** A where-clause value: a literal, or a TypeORM `In([...])` FindOperator. */
type Cond = string | FindOperator<unknown>;

function matches(value: string | null, cond: Cond | undefined): boolean {
  if (cond === undefined) return true;
  if (cond instanceof FindOperator) {
    if (cond.type !== 'in') throw new Error(`fake repo does not support ${cond.type}`);
    return (cond.value as unknown[]).includes(value);
  }
  return value === cond;
}

/** Minimal in-memory stand-in for the TypeORM repo: just the find()/findOne()/upsert() the store uses. */
function makeFakeRepo(seed: Partial<LidMapping>[] = []) {
  const rows: LidMapping[] = seed.map(r => ({ lid: '', phone: null, sessionId: null, updatedAt: new Date(0), ...r }));
  return {
    rows,
    find: jest
      .fn()
      .mockImplementation((options?: { where?: { lid?: Cond; phone?: Cond } }) =>
        Promise.resolve(
          rows
            .filter(r => matches(r.lid, options?.where?.lid) && matches(r.phone, options?.where?.phone))
            .map(r => ({ ...r })),
        ),
      ),
    findOne: jest
      .fn()
      .mockImplementation((options: { where: { lid: string } }) =>
        Promise.resolve(rows.find(r => r.lid === options.where.lid) ?? null),
      ),
    upsert: jest.fn().mockImplementation((values: Partial<LidMapping>) => {
      const i = rows.findIndex(r => r.lid === values.lid);
      if (i >= 0) rows[i] = { ...rows[i], ...values };
      else rows.push(values as LidMapping);
      return Promise.resolve({});
    }),
  };
}

async function newStore(repo: ReturnType<typeof makeFakeRepo>): Promise<LidMappingStoreService> {
  const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
  await store.onModuleInit();
  return store;
}

describe('LidMappingStoreService', () => {
  it('loads the persisted table into the cache on boot (forward + reverse)', async () => {
    const store = await newStore(makeFakeRepo([{ lid: '111', phone: '628999' }]));
    expect(store.getCached('111')).toBe('628999');
    expect(store.lidsForPhone('628999')).toEqual(['111']);
  });

  it('returns undefined for an unseen lid', async () => {
    const store = await newStore(makeFakeRepo());
    expect(store.getCached('nope')).toBeUndefined();
    expect(store.lidsForPhone('628999')).toEqual([]);
  });

  it('writes a learned mapping through to cache and persistence', async () => {
    const repo = makeFakeRepo();
    const store = await newStore(repo);
    await store.remember('222', '628888', 'sess-1');
    expect(store.getCached('222')).toBe('628888');
    expect(store.lidsForPhone('628888')).toEqual(['222']);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ lid: '222', phone: '628888', sessionId: 'sess-1' }),
      ['lid'],
    );
  });

  it('a phone is last-write-wins and reindexes the reverse map on a phone change', async () => {
    const store = await newStore(makeFakeRepo([{ lid: '111', phone: '628999' }]));
    await store.remember('111', '628000');
    expect(store.getCached('111')).toBe('628000');
    expect(store.lidsForPhone('628999')).toEqual([]); // stale reverse entry dropped
    expect(store.lidsForPhone('628000')).toEqual(['111']);
  });

  it('skips a redundant write when the mapping is unchanged', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628999' }]);
    const store = await newStore(repo);
    repo.upsert.mockClear();
    await store.remember('111', '628999');
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('survives a restart: a fresh store over the same table reloads the mapping', async () => {
    const repo = makeFakeRepo();
    const first = await newStore(repo);
    await first.remember('111', '628999', 'sess-1');

    const second = await newStore(repo); // simulate process restart against the persisted rows
    expect(second.getCached('111')).toBe('628999');
    expect(second.lidsForPhone('628999')).toEqual(['111']);
  });

  it('does not throw when the table is unavailable on boot', async () => {
    const repo = makeFakeRepo();
    repo.find.mockRejectedValueOnce(new Error('no such table: lid_mappings'));
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await expect(store.onModuleInit()).resolves.toBeUndefined();
    expect(store.getCached('111')).toBeUndefined();
  });
});

describe('LidMappingStoreService — LRU cap', () => {
  const prevMax = process.env.LID_MAPPING_CACHE_MAX;
  afterEach(() => {
    if (prevMax === undefined) delete process.env.LID_MAPPING_CACHE_MAX;
    else process.env.LID_MAPPING_CACHE_MAX = prevMax;
  });

  it('evicts the least-recently-used forward entry when the cap is exceeded (no unbounded growth)', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '3';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();

    await store.remember('lid-a', '620001');
    await store.remember('lid-b', '620002');
    await store.remember('lid-c', '620003');
    // Touch lid-a so it is the most-recently-used; lid-b becomes the LRU candidate.
    expect(store.getCached('lid-a')).toBe('620001');
    // Inserting a fourth evicts the LRU (lid-b, not lid-a).
    await store.remember('lid-d', '620004');

    expect(store.getCached('lid-b')).toBeUndefined(); // evicted
    expect(store.getCached('lid-a')).toBe('620001'); // touched, survived
    expect(store.getCached('lid-c')).toBe('620003');
    expect(store.getCached('lid-d')).toBe('620004');
  });

  it('finds a lid by phone from the table once it has left the cache', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();

    await store.remember('lid-a', '620001');
    await store.remember('lid-b', '620002'); // evicts lid-a; its row stays persisted
    expect(store.lidsForPhone('620001')).toEqual([]);
    expect(await store.findLidsForPhone('620001')).toEqual(['lid-a']);
    expect(await store.findLidsForPhone('620002')).toEqual(['lid-b']);
    expect(store.getCached('lid-b')).toBe('620002'); // the table read did not evict the resident entry
  });

  it('skips a table row this process has since re-mapped, and falls back to the cache on a read error', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628999' }]);
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    repo.upsert.mockRejectedValueOnce(new Error('connection lost')); // the re-map has not reached the table
    await store.remember('111', '628000');
    expect(await store.findLidsForPhone('628999')).toEqual([]);

    repo.find.mockRejectedValueOnce(new Error('connection lost'));
    expect(await store.findLidsForPhone('628000')).toEqual(['111']);
  });

  it('finds a phone by lid from the table on a cache miss, without indexing the row', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();

    await store.remember('lid-a', '620001');
    await store.remember('lid-b', '620002'); // evicts lid-a; its row stays persisted
    expect(await store.findPhoneForLid('lid-a')).toBe('620001');
    expect(await store.findPhoneForLid('lid-b')).toBe('620002');
    expect(await store.findPhoneForLid('lid-x')).toBeNull();
    expect(store.lidsForPhone('620002')).toEqual(['lid-b']); // the table read did not evict it

    repo.findOne.mockRejectedValueOnce(new Error('connection lost'));
    expect(await store.findPhoneForLid('lid-a')).toBeNull();
  });

  it('reconciles the reverse map on eviction (no orphan phoneToLids entries)', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '2';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();

    await store.remember('lid-a', '620001');
    await store.remember('lid-b', '620001');
    expect(store.lidsForPhone('620001')).toEqual(expect.arrayContaining(['lid-a', 'lid-b']));
    // A third entry evicts lid-a (the LRU); the reverse set must drop it.
    await store.remember('lid-c', '620002');
    expect(store.lidsForPhone('620001')).toEqual(['lid-b']);
    expect(store.lidsForPhone('620002')).toEqual(['lid-c']);
  });

  it('drops a phone key from the reverse map once its last lid is evicted or re-mapped', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '2';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();
    const phoneToLids = (store as unknown as { phoneToLids: Map<string, Set<string>> }).phoneToLids;

    await store.remember('lid-a', '620001');
    await store.remember('lid-b', '620002');
    await store.remember('lid-c', '620003'); // evicts lid-a, the only lid under 620001
    expect(phoneToLids.has('620001')).toBe(false);

    await store.remember('lid-c', '620004'); // re-maps lid-c away from 620003
    expect(phoneToLids.has('620003')).toBe(false);
    expect([...phoneToLids.keys()].sort()).toEqual(['620002', '620004']);
  });

  it('drops who reported a phone along with the evicted entry', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '2';
    const store = await newStore(makeFakeRepo());
    const seenBy = (store as unknown as { seenBy: Map<string, Set<string>> }).seenBy;

    await store.remember('lid-a', '620001', 's1');
    await store.remember('lid-b', '620002', 's1');
    await store.remember('lid-c', '620003', 's1'); // evicts lid-a

    expect([...seenBy.keys()].sort()).toEqual(['lid-b', 'lid-c']);
  });

  it('holds back a failed write only while its entry is cached', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '2';
    const repo = makeFakeRepo();
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    repo.upsert.mockRejectedValue(new Error('connection lost'));
    for (const lid of ['lid-a', 'lid-b', 'lid-c']) await store.remember(lid, '620001', 's1');
    repo.upsert.mockClear();

    await store.remember('lid-c', '620001', 's1');
    expect(repo.upsert).not.toHaveBeenCalled();
    await store.remember('lid-a', '620001', 's1');
    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed write along with the evicted entry', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo([{ lid: 'lid-a', phone: '620001' }]);
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('lid-a', '620002'); // fails; the table keeps 620001
    await store.remember('lid-b', '620003'); // evicts lid-a
    store.getCached('lid-a'); // warms lid-a back from its row
    for (let i = 0; i < 20 && store.getCached('lid-a') === undefined; i++) await new Promise(r => setImmediate(r));
    expect(store.getCached('lid-a')).toBe('620001');

    repo.rows[0].phone = '620009'; // another node re-maps it
    expect(await store.findPhoneForLid('lid-a@lid')).toBe('620009');
  });

  it('LID_MAPPING_CACHE_MAX=0 disables the cap (legacy unbounded behaviour)', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '0';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();

    for (let i = 0; i < 10; i++) {
      await store.remember(`lid-${i}`, `62000${i}`);
    }
    // Nothing evicted — all 10 stay resident.
    for (let i = 0; i < 10; i++) {
      expect(store.getCached(`lid-${i}`)).toBe(`62000${i}`);
    }
  });

  it('falls back to the default cap on a non-numeric env value', () => {
    process.env.LID_MAPPING_CACHE_MAX = 'not-a-number';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    // The constructor must not throw, and must apply the default (5000) rather than NaN/0.
    expect((store as unknown as { maxCachedLids: number }).maxCachedLids).toBe(5000);
  });

  it('treats a blank env value as unset, not as 0 (unbounded)', () => {
    process.env.LID_MAPPING_CACHE_MAX = '';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    expect((store as unknown as { maxCachedLids: number }).maxCachedLids).toBe(5000);
  });
});

describe('LidMappingStoreService — deterministic preload + repository fallback', () => {
  const prevMax = process.env.LID_MAPPING_CACHE_MAX;
  afterEach(() => {
    if (prevMax === undefined) delete process.env.LID_MAPPING_CACHE_MAX;
    else process.env.LID_MAPPING_CACHE_MAX = prevMax;
  });

  it('preloads deterministically: last-write-first, capped at the LRU limit', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '3';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();
    expect(repo.find).toHaveBeenCalledWith({ order: { updatedAt: 'DESC' }, take: 3 });
  });

  // The query answers newest first; indexed in that order the newest row sat at the LRU's eviction
  // end, so the first mapping learned after boot evicted the most recently written one.
  it('keeps the newest preloaded row when a new mapping evicts', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '2';
    const repo = makeFakeRepo();
    repo.find.mockResolvedValueOnce([
      { lid: 'lid-new', phone: '620002', sessionId: null, updatedAt: new Date(2000) },
      { lid: 'lid-old', phone: '620001', sessionId: null, updatedAt: new Date(1000) },
    ]);
    const store = await newStore(repo);

    await store.remember('lid-fresh', '620003');

    expect(store.getCached('lid-new')).toBe('620002');
    expect(store.getCached('lid-fresh')).toBe('620003');
    expect(store.getCached('lid-old')).toBeUndefined();
  });

  it('preloads without a take when the cap is disabled (0)', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '0';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();
    expect(repo.find).toHaveBeenCalledWith({ order: { updatedAt: 'DESC' }, take: undefined });
  });

  it('warms an evicted-but-persisted mapping from the repository on a cache miss', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();
    await store.remember('lid-a', '620001');
    await store.remember('lid-b', '620002'); // evicts lid-a (cap 1); its row stays persisted

    expect(store.getCached('lid-a')).toBeUndefined(); // the miss itself stays a miss (sync contract)
    await new Promise(resolve => setImmediate(resolve)); // let the fallback lookup settle

    expect(repo.findOne).toHaveBeenCalledWith({ where: { lid: 'lid-a' } });
    expect(store.getCached('lid-a')).toBe('620001'); // the NEXT lookup hits the warmed cache
  });

  it('runs at most one fallback query per lid while a lookup is in flight', async () => {
    const repo = makeFakeRepo([{ lid: 'lid-a', phone: '620001' }]);
    // No onModuleInit: the cache starts empty even though the row is persisted.
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    let resolveFind: (row: LidMapping | null) => void = () => undefined;
    repo.findOne.mockImplementationOnce(
      () =>
        new Promise<LidMapping | null>(resolve => {
          resolveFind = resolve;
        }),
    );

    expect(store.getCached('lid-a')).toBeUndefined();
    expect(store.getCached('lid-a')).toBeUndefined();
    expect(repo.findOne).toHaveBeenCalledTimes(1);

    resolveFind({ lid: 'lid-a', phone: '620001' } as LidMapping);
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-a')).toBe('620001');
  });

  it('stops re-querying the table for a lid it has no row for', async () => {
    // The callers are hot: a webhook filter resolves the event's actor AND each of its own rule
    // values on every dispatch. pendingLookups collapses the lookups that overlap a query still in
    // flight, which within one dispatch is all of them, so an unmapped lid used to cost one query
    // per dispatch rather than one per webhook.
    const repo = makeFakeRepo(); // empty table: every lookup misses
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    expect(store.getCached('lid-absent')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(repo.findOne).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      expect(store.getCached('lid-absent')).toBeUndefined();
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(repo.findOne).toHaveBeenCalledTimes(1);
  });

  it('a recorded absence never shadows a mapping learned afterwards, even once it is evicted', async () => {
    // The forward map answers a learned mapping directly, so the absence only matters after the
    // entry is evicted: a stale one would block the warm-back and make the row unresolvable for
    // the life of the process, although it is still in the table.
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();

    expect(store.getCached('lid-late')).toBeUndefined(); // records the absence
    await new Promise(resolve => setImmediate(resolve));

    await store.remember('lid-late', '620009');
    await store.remember('lid-other', '620010'); // evicts lid-late (cap 1); its row stays persisted

    expect(store.getCached('lid-late')).toBeUndefined(); // the miss itself stays a miss
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-late')).toBe('620009'); // warmed back rather than blocked
  });

  it('records no absence for a lid learned while its table read was in flight', async () => {
    // The read and the write race on every busy session: a filter looks the lid up, and the next
    // message from that person teaches it. The read was issued first, so it answers "no row" about a
    // row that now exists. Recording that as an absence poisons the lid: the forward entry hides it
    // until the LRU evicts, and from then on the warm-back is blocked and the persisted row is
    // unreachable until something teaches the same lid again.
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    let answer: (row: LidMapping | null) => void = () => undefined;
    repo.findOne.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)));
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    expect(store.getCached('lid-raced')).toBeUndefined(); // the query is now in flight
    await store.remember('lid-raced', '620001'); // learned and persisted inside that window
    answer(null); // the query had already run, so it answers about the table as it was
    await new Promise(resolve => setImmediate(resolve));

    await store.remember('lid-other', '620002'); // cap 1: evicts lid-raced, the row stays persisted
    expect(store.getCached('lid-raced')).toBeUndefined(); // the read itself is still a miss
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-raced')).toBe('620001'); // warmed back rather than blocked
  });

  it('records no absence for a lid whose own write has not reached the table yet', async () => {
    // remember() indexes synchronously and writes afterwards, and its callers fire it without
    // awaiting (one per mapping in a history batch). A lookup issued inside that window reads a
    // table that does not carry the row yet, and the LRU can evict the forward entry in the same
    // window, so "did this process learn it" answers no. An absence recorded there shadows a row
    // that then commits.
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    let commit: () => void = () => undefined;
    repo.upsert.mockImplementationOnce(
      (values: Partial<LidMapping>) =>
        new Promise(resolve => {
          commit = () => {
            repo.rows.push(values as LidMapping);
            resolve({});
          };
        }),
    );
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    const writing = store.remember('lid-writing', '620001'); // indexed; its upsert is held open
    await store.remember('lid-other', '620002'); // cap 1: evicts lid-writing from the forward map

    expect(store.getCached('lid-writing')).toBeUndefined(); // issues the query, which finds no row
    await new Promise(resolve => setImmediate(resolve));

    commit(); // the write lands: the row is in the table from here on
    await writing;

    expect(store.getCached('lid-writing')).toBeUndefined(); // the read itself is still a miss
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-writing')).toBe('620001'); // warmed back rather than blocked
  });

  /** Hold the next upsert open until the returned commit() applies it, as the fake repo would. */
  function holdNextUpsert(repo: ReturnType<typeof makeFakeRepo>): () => void {
    const apply = repo.upsert.getMockImplementation() as (values: Partial<LidMapping>) => Promise<object>;
    let commit: () => void = () => undefined;
    repo.upsert.mockImplementationOnce(
      (values: Partial<LidMapping>) => new Promise(resolve => (commit = () => resolve(apply(values)))),
    );
    return () => commit();
  }

  // The same window from the other side: the table still holds the OLD phone, so the read returns a
  // row, and indexing it would leave the stale phone served as a cache hit after the write commits.
  it('does not index a table row read while a newer write for that lid is in flight', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo([{ lid: 'lid-moved', phone: '620001' }]);
    const commit = holdNextUpsert(repo);
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    const writing = store.remember('lid-moved', '620009'); // indexed; its upsert is held open
    await store.remember('lid-other', '620002'); // cap 1: evicts lid-moved from the forward map

    expect(store.getCached('lid-moved')).toBeUndefined(); // the query reads the uncommitted table
    await new Promise(resolve => setImmediate(resolve));
    commit();
    await writing;

    expect(store.getCached('lid-moved')).not.toBe('620001');
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-moved')).toBe('620009');
  });

  it('does not index a table row read before a write that settled while the read was in flight', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo([{ lid: 'lid-moved', phone: '620001' }]);
    let answer: (row: LidMapping | null) => void = () => undefined;
    repo.findOne.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)));
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    expect(store.getCached('lid-moved')).toBeUndefined(); // the query is now in flight
    const before = { ...repo.rows[0] };
    await store.remember('lid-moved', '620009'); // re-mapped and committed inside that window
    await store.remember('lid-other', '620002'); // cap 1: evicts lid-moved from the forward map
    answer(before); // the query had already run, so it answers with the old row
    await new Promise(resolve => setImmediate(resolve));

    expect(store.getCached('lid-moved')).not.toBe('620001');
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-moved')).toBe('620009');
  });

  it('keeps a lid unsettled until the last of two overlapping writes commits', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    const commitFirst = holdNextUpsert(repo);
    const commitSecond = holdNextUpsert(repo);
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    const first = store.remember('lid-busy', '620001');
    const second = store.remember('lid-busy', '620009');
    commitFirst();
    await first; // the second write is still open
    await store.remember('lid-other', '620002'); // cap 1: evicts lid-busy from the forward map

    expect(store.getCached('lid-busy')).toBeUndefined(); // reads the first write's row
    await new Promise(resolve => setImmediate(resolve));
    commitSecond();
    await second;

    expect(store.getCached('lid-busy')).not.toBe('620001');
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-busy')).toBe('620009');
  });

  it('records no absence at all when the cap is disabled', async () => {
    // LID_MAPPING_CACHE_MAX=0 is documented as the legacy unbounded cache. An absence set that grows
    // on every lookup would be a new unbounded map the operator never asked for, and unlike the
    // forward map it grows on caller-supplied ids rather than on mappings the account really has.
    process.env.LID_MAPPING_CACHE_MAX = '0';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    for (let i = 0; i < 3; i++) {
      expect(store.getCached('lid-absent')).toBeUndefined();
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(repo.findOne).toHaveBeenCalledTimes(3); // re-queried, as the legacy behaviour did
  });

  it('bounds the recorded absences by the same cap as the forward map', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '2';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    for (const lid of ['a', 'b', 'c']) {
      expect(store.getCached(lid)).toBeUndefined();
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(repo.findOne).toHaveBeenCalledTimes(3);

    // 'a' is the oldest absence and was dropped when 'c' was recorded, so it asks again; 'c' does not.
    expect(store.getCached('a')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(repo.findOne).toHaveBeenCalledTimes(4);
    expect(store.getCached('c')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(repo.findOne).toHaveBeenCalledTimes(4);
  });

  it('forgets every recorded absence when the table is reloaded', async () => {
    // An import or a restore rewrites the table underneath the process, so every answer it recorded
    // about that table is a stale one. Re-indexing the reloaded rows is not enough on its own: the
    // preload takes only the newest `cap` rows, so an imported mapping past that cap is never
    // indexed, and its recorded absence would go on blocking the warm-back that would find it.
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    // The real query is `order: { updatedAt: 'DESC' }, take: cap`; the shared fake ignores both.
    repo.find.mockImplementation((options: { take?: number }) =>
      Promise.resolve(
        [...repo.rows]
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(0, options?.take ?? repo.rows.length)
          .map(r => ({ ...r })),
      ),
    );
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    expect(store.getCached('lid-imported')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(repo.findOne).toHaveBeenCalledTimes(1);

    repo.rows.push({ lid: 'lid-imported', phone: '620003', sessionId: null, updatedAt: new Date(1000) });
    repo.rows.push({ lid: 'lid-newer', phone: '620004', sessionId: null, updatedAt: new Date(2000) });
    await store.reload(); // cap 1: only lid-newer is preloaded, so lid-imported is never re-indexed

    expect(store.getCached('lid-imported')).toBeUndefined(); // the read itself is still a miss
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-imported')).toBe('620003'); // asked the table again rather than blocked
  });

  it('forgets every recorded absence even when the reload cannot read the table', async () => {
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    expect(store.getCached('lid-restored')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(repo.findOne).toHaveBeenCalledTimes(1); // 'lid-restored' is now known to have no row

    // A restore brings the row back, then the post-commit reload fails.
    repo.rows.push({ lid: 'lid-restored', phone: '620005', sessionId: null, updatedAt: new Date() });
    repo.find.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    await expect(store.reload()).resolves.toBeUndefined();

    expect(store.getCached('lid-restored')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-restored')).toBe('620005');
  });

  it('swallows a fallback read error (table unavailable) — the miss stays a miss and never throws', async () => {
    const repo = makeFakeRepo();
    repo.findOne.mockRejectedValueOnce(new Error('no such table: lid_mappings'));
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    expect(store.getCached('lid-a')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    // A read error is not recorded as an absence: the table said nothing, so there is nothing to
    // remember, and the next lookup must ask again rather than treat the outage as "no such row".
    expect(store.getCached('lid-a')).toBeUndefined();
  });
});

describe('LidMappingStoreService — deterministic persisted lookups (authorization path)', () => {
  it('findPhoneForLid falls back to the cache when the table has no row', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628999' }]);
    const store = await newStore(repo);
    repo.rows.splice(0, 1); // the preload cached 111; the table no longer holds it
    expect(await store.findPhoneForLid('111@lid')).toBe('628999');
    expect(repo.findOne).toHaveBeenCalledWith({ where: { lid: '111' } });
  });

  it('findPhoneForLid answers from the cache when the table read fails', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628999' }]);
    const store = await newStore(repo);
    repo.findOne.mockRejectedValueOnce(new Error('connection lost'));
    expect(await store.findPhoneForLid('111@lid')).toBe('628999');
  });

  it('findPhoneForLid reads the table for a lid evicted from the LRU cache', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    try {
      // Preload keeps one row; the other is persisted but not cached, so the table must answer.
      const repo = makeFakeRepo([
        { lid: '111', phone: '628999' },
        { lid: '222', phone: '628888' },
      ]);
      const store = await newStore(repo);
      expect(await store.findPhoneForLid('111@lid')).toBe('628999');
      expect(await store.findPhoneForLid('222@lid')).toBe('628888');
    } finally {
      delete process.env.LID_MAPPING_CACHE_MAX;
    }
  });

  it('a stale cached negative never shadows a mapping the table has', async () => {
    const repo = makeFakeRepo([{ lid: '222', phone: null }]);
    const store = await newStore(repo); // this node cached a negative
    expect(store.getCached('222')).toBeNull();
    repo.rows[0].phone = '628888'; // another node has since mapped it in the table
    expect(await store.findPhoneForLid('222@lid')).toBe('628888');
    expect(await store.phonesForLidsPersisted(['222'])).toEqual({ 222: '628888' });
    expect(await store.findLidsForPhone('628888')).toEqual(['222']);
    expect(await store.lidsForPhonesPersisted(['628888'])).toEqual({ 628888: ['222'] });
  });

  it('a cached mapping another node has re-mapped answers the table row, not the cache', async () => {
    const repo = makeFakeRepo();
    const store = await newStore(repo);
    await store.remember('333', '628111'); // this node cached 333 -> 628111
    repo.rows[0].phone = '628222'; // another node has since re-mapped it in the shared table
    expect(store.getCached('333')).toBe('628111');
    expect(await store.findPhoneForLid('333@lid')).toBe('628222');
  });

  it('findPhoneForLid returns null for a lid with no persisted row', async () => {
    const repo = makeFakeRepo();
    const store = await newStore(repo);
    expect(await store.findPhoneForLid('999@lid')).toBeNull();
    expect(repo.findOne).toHaveBeenCalledWith({ where: { lid: '999' } });
  });

  it('findPhoneForLid fails soft (null) when the table read throws', async () => {
    const repo = makeFakeRepo();
    const store = await newStore(repo);
    repo.findOne.mockRejectedValueOnce(new Error('no such table'));
    expect(await store.findPhoneForLid('555@lid')).toBeNull();
  });

  it('findLidsForPhone reads the table for a lid evicted from the LRU cache', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    try {
      // Preload keeps one of the two lids; the reverse map then holds only that one, so the second
      // can only come from the table.
      const repo = makeFakeRepo([
        { lid: '111', phone: '628999' },
        { lid: '222', phone: '628999' },
      ]);
      const store = await newStore(repo);
      expect((await store.findLidsForPhone('628999')).sort()).toEqual(['111', '222']);
    } finally {
      delete process.env.LID_MAPPING_CACHE_MAX;
    }
  });

  it('findLidsForPhone unions the cache with the persisted table', async () => {
    const repo = makeFakeRepo([
      { lid: '111', phone: '628999' },
      { lid: '222', phone: '628999' },
    ]);
    const store = await newStore(repo);
    expect((await store.findLidsForPhone('628999')).sort()).toEqual(['111', '222']);
  });

  it('phonesForLidsPersisted reads the table for a lid evicted from the LRU cache', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    try {
      const repo = makeFakeRepo([
        { lid: '111', phone: '628999' },
        { lid: '222', phone: '628888' },
      ]);
      const store = await newStore(repo);
      expect(await store.phonesForLidsPersisted(['111', '222'])).toEqual({ 111: '628999', 222: '628888' });
    } finally {
      delete process.env.LID_MAPPING_CACHE_MAX;
    }
  });

  it('lidsForPhonesPersisted reads the table for a lid evicted from the LRU cache', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    try {
      const repo = makeFakeRepo([
        { lid: '111', phone: '628999' },
        { lid: '222', phone: '628999' },
      ]);
      const store = await newStore(repo);
      expect((await store.lidsForPhonesPersisted(['628999']))['628999'].sort()).toEqual(['111', '222']);
    } finally {
      delete process.env.LID_MAPPING_CACHE_MAX;
    }
  });

  it('batched lookups query only the requested keys', async () => {
    const repo = makeFakeRepo([
      { lid: '111', phone: '628999' },
      { lid: '222', phone: '628888' },
    ]);
    const store = await newStore(repo);
    repo.find.mockClear();
    expect(await store.phonesForLidsPersisted(['111'])).toEqual({ 111: '628999' });
    expect(repo.find).toHaveBeenCalledWith({ where: { lid: In(['111']) } });
    expect(await store.lidsForPhonesPersisted(['628888'])).toEqual({ 628888: ['222'] });
    expect(repo.find).toHaveBeenCalledWith({ where: { phone: In(['628888']) } });
  });

  // An allowlist of N lids that the mirror has not seen used to cost N single-row reads ahead of the one
  // batched query, because the mirror was read through getCached, which warms every miss.
  it('phonesForLidsPersisted answers a batch of lids the mirror lacks with one query and no per-lid reads', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    try {
      const lids = Array.from({ length: 300 }, (_, i) => `9${i}`);
      const repo = makeFakeRepo(lids.map(lid => ({ lid, phone: `62${lid}` })));
      const store = await newStore(repo); // the cap keeps one of the 300 resident
      repo.find.mockClear();
      repo.findOne.mockClear();

      const answer = await store.phonesForLidsPersisted(lids);

      expect(Object.keys(answer)).toHaveLength(300);
      expect(answer['9299']).toBe('629299');
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(repo.find).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.LID_MAPPING_CACHE_MAX;
    }
  });

  it('batched lookups handle an empty input, a null-phone row, and a read error', async () => {
    const repo = makeFakeRepo([
      { lid: '111', phone: '628999' },
      { lid: '333', phone: null },
    ]);
    const store = await newStore(repo);
    expect(await store.phonesForLidsPersisted([])).toEqual({});
    expect(await store.lidsForPhonesPersisted([])).toEqual({});
    // The null-phone row is skipped rather than indexed under a null key.
    expect((await store.lidsForPhonesPersisted(['628999']))['628999']).toEqual(['111']);
    // A read error falls back to the cache, which the preload filled.
    repo.find.mockRejectedValueOnce(new Error('no such table'));
    expect(await store.phonesForLidsPersisted(['111'])).toEqual({ 111: '628999' });
    repo.find.mockRejectedValueOnce(new Error('no such table'));
    expect(await store.lidsForPhonesPersisted(['628999'])).toEqual({ 628999: ['111'] });
  });

  it('drops a cached lid that another node has re-mapped to a different phone', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628999' }]);
    const store = await newStore(repo);
    repo.rows[0].phone = '628000'; // another node re-mapped 111; this node's cache still says 628999
    expect(store.lidsForPhone('628999')).toEqual(['111']);
    expect(await store.findLidsForPhone('628999')).toEqual([]);
    expect(await store.lidsForPhonesPersisted(['628999'])).toEqual({ 628999: [] });
    // A cached lid with no row yet (its write still in flight) still answers.
    await store.remember('222', '628999');
    repo.rows.splice(
      repo.rows.findIndex(r => r.lid === '222'),
      1,
    );
    expect(await store.findLidsForPhone('628999')).toEqual(['222']);
  });

  it('answers the row of a lid another node has re-mapped, in every lookup', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628111' }]);
    const store = await newStore(repo);
    repo.rows[0].phone = '628222'; // another node re-mapped 111; this node's cache still says 628111

    expect(await store.findPhoneForLid('111@lid')).toBe('628222');
    expect(await store.phonesForLidsPersisted(['111'])).toEqual({ 111: '628222' });
    expect(await store.findLidsForPhone('628222')).toEqual(['111']);
    expect(await store.lidsForPhonesPersisted(['628222', '628111'])).toEqual({ 628222: ['111'], 628111: [] });
  });

  it('answers no phone for a lid whose phone write has not reached the table, in every lookup', async () => {
    const repo = makeFakeRepo([
      { lid: '111', phone: '628111' },
      { lid: '444', phone: '628444' },
    ]);
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    const none = async (lid: string, phones: string[]) => {
      expect(await store.findPhoneForLid(`${lid}@lid`)).toBeNull();
      expect(await store.phonesForLidsPersisted([lid])).toEqual({ [lid]: null });
      for (const phone of phones) expect(await store.findLidsForPhone(phone)).toEqual([]);
      expect(await store.lidsForPhonesPersisted(phones)).toEqual(Object.fromEntries(phones.map(p => [p, []])));
    };

    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', '628222'); // a re-map: the table still names the old phone
    await none('111', ['628111', '628222']);
    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('333', '628333'); // a first write: the table has no row
    await none('333', ['628333']);

    let land!: () => void;
    repo.upsert.mockImplementationOnce(
      (values: Partial<LidMapping>) =>
        new Promise(resolve => {
          land = () => {
            repo.rows[1] = { ...repo.rows[1], ...values };
            resolve({});
          };
        }),
    );
    const writing = store.remember('444', '628555', 'sess-1');
    await none('444', ['628444', '628555']); // still in flight
    land();
    await writing;
    await store.remember('111', '628222', 'sess-1'); // the failed re-map lands on its next report

    expect(await store.findPhoneForLid('444@lid')).toBe('628555');
    expect(await store.phonesForLidsPersisted(['111', '444'])).toEqual({ 111: '628222', 444: '628555' });
    expect(await store.lidsForPhonesPersisted(['628222', '628111'])).toEqual({ 628222: ['111'], 628111: [] });
  });

  it('answers a cached phone the table has no row for yet while its first write is in flight', async () => {
    const repo = makeFakeRepo();
    const store = await newStore(repo);
    let land!: () => void;
    repo.upsert.mockImplementationOnce(
      (values: Partial<LidMapping>) =>
        new Promise(resolve => {
          land = () => {
            repo.rows.push(values as LidMapping);
            resolve({});
          };
        }),
    );
    const writing = store.remember('111', '628111', 'sess-1');

    expect(await store.findPhoneForLid('111@lid')).toBe('628111');
    expect(await store.phonesForLidsPersisted(['111'])).toEqual({ 111: '628111' });
    expect(await store.findLidsForPhone('628111')).toEqual(['111']);
    expect(await store.lidsForPhonesPersisted(['628111'])).toEqual({ 628111: ['111'] });
    land();
    await writing;
  });

  it('keeps answering a phone the table holds when only another session failed to take it', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628111' }]);
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', '628111', 'sess-2');

    expect(await store.findPhoneForLid('111@lid')).toBe('628111');
    expect(await store.phonesForLidsPersisted(['111'])).toEqual({ 111: '628111' });
    expect(await store.lidsForPhonesPersisted(['628111'])).toEqual({ 628111: ['111'] });
  });

  it('settles two overlapping writes for a lid by the phone the cache holds', async () => {
    const repo = makeFakeRepo([
      { lid: '111', phone: '628111' },
      { lid: '222', phone: '628222' },
    ]);
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    /** Holds the next upsert until settle(true) applies it to row i, or settle(false) fails it. */
    const held = (i: number) => {
      let settle!: (ok: boolean) => void;
      repo.upsert.mockImplementationOnce(
        (values: Partial<LidMapping>) =>
          new Promise((resolve, reject) => {
            settle = ok => {
              if (!ok) return reject(new Error('connection lost'));
              repo.rows[i] = { ...repo.rows[i], ...values };
              resolve({});
            };
          }),
      );
      return (ok: boolean) => settle(ok);
    };

    const older = held(0);
    const first = store.remember('111', '628000', 'sess-1');
    await store.remember('111', '628001', 'sess-1'); // the newer one lands first
    older(false);
    await first;
    repo.rows[0].phone = '628999'; // another node re-maps it: nothing of this node's is pending
    expect(await store.findPhoneForLid('111@lid')).toBe('628999');

    const older2 = held(1);
    const second = store.remember('222', '628000', 'sess-1');
    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('222', '628001', 'sess-1'); // the newer one fails
    older2(true);
    await second;
    expect(await store.findPhoneForLid('222@lid')).toBeNull(); // the cached 628001 is still not stored
  });

  it('answers the table again once a failed write has landed, or the table was reloaded', async () => {
    const repo = makeFakeRepo([
      { lid: '111', phone: '628111' },
      { lid: '222', phone: '628222' },
    ]);
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});

    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', '628000', 'sess-1');
    await store.remember('111', '628000', 'sess-1'); // lands
    repo.rows[0].phone = '628999'; // another node re-maps it
    expect(await store.findPhoneForLid('111@lid')).toBe('628999');

    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('222', '628000', 'sess-1');
    await store.reload();
    repo.rows[1].phone = '628999';
    expect(await store.findPhoneForLid('222@lid')).toBe('628999');
  });

  it('findLidsForPhone falls back to the cache when the table read throws', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628999' }]);
    const store = await newStore(repo);
    repo.find.mockRejectedValueOnce(new Error('no such table'));
    expect(await store.findLidsForPhone('628999')).toEqual(['111']);
  });
});

describe('LidMappingStoreService: a negative result on the shared table', () => {
  // Linked sessions in `sessions` (each carries its account's phone); `gone` names one that was deleted.
  const [s1, s2, s3, s9] = ['1', '2', '3', '9'].map(n => `0000000${n}-0000-4000-8000-000000000000`);
  const gone = '0000000d-0000-4000-8000-000000000000';
  let ds: DataSource;
  let repo: Repository<LidMapping>;
  let store: LidMappingStoreService;
  let warn: jest.SpyInstance;
  let clock = 0;
  const row = (lid: string) => repo.findOne({ where: { lid } });
  /** Moves the store's clock on, past or short of the hold after a failed write. */
  const later = (ms: number) => (clock += ms);

  /** Holds the next call of a repository method until `release` is called; `reached` settles on entry. */
  function hold(method: 'upsert' | 'update') {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const reached = new Promise<void>(resolve => (entered = resolve));
    const real = repo[method].bind(repo) as (...args: unknown[]) => Promise<unknown>;
    jest.spyOn(repo, method).mockImplementationOnce((async (...args: unknown[]) => {
      entered();
      await gate;
      return real(...args);
    }) as never);
    return { release, reached };
  }

  // SQLite in memory; on PostgreSQL (DATABASE_TYPE=postgres, the test-postgres job) a schema of its own, on
  // the search_path as the app sets it, since the statements differ by dialect.
  const pg = process.env.DATABASE_TYPE === 'postgres';
  const server = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
    database: process.env.DATABASE_NAME || 'openwa',
  };
  let schema = '';
  const onServer = async (sql: string): Promise<void> => {
    const admin = await new DataSource(server).initialize();
    await admin.query(sql).finally(() => admin.destroy());
  };

  beforeEach(async () => {
    const entities = [LidMapping, Session];
    if (pg) {
      schema = `lid_store_${randomUUID().replace(/-/g, '')}`;
      await onServer(`CREATE SCHEMA "${schema}"`);
    }
    ds = await new DataSource(
      pg
        ? { ...server, schema, extra: { options: `-c search_path=${schema},public` }, entities, synchronize: true }
        : { type: 'better-sqlite3', database: ':memory:', entities, synchronize: true },
    ).initialize();
    await ds.getRepository(Session).insert([s1, s2, s3, s9].map(id => ({ id, name: id, phone: `6290000000${id[7]}` })));
    repo = ds.getRepository(LidMapping);
    store = new LidMappingStoreService(repo);
    clock = 0;
    (store as unknown as { now: () => number }).now = () => clock;
    // A statement that fails is only logged, which would let a case pass on a write that never ran.
    warn = jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn');
    await store.onModuleInit();
  });

  afterEach(async () => {
    await ds.destroy();
    if (pg) await onServer(`DROP SCHEMA "${schema}" CASCADE`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('records a negative for a lid with no row', async () => {
    await store.remember('333', null, s1);

    expect(await row('333')).toMatchObject({ phone: null, sessionId: s1 });
    expect(await store.findPhoneForLid('333@lid')).toBeNull();
  });

  it('leaves the phone another session stored, in the table and in the cache', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
    expect(store.getCached('111')).toBe('628111');
    expect(await store.lidsForPhonesPersisted(['628111'])).toEqual({ 628111: ['111'] });
  });

  it('clears the phone when the session that stored it answers no phone (#1058)', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('111', null, s1);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s1 });
    expect(store.lidsForPhone('628111')).toEqual([]);
    expect(store.getCached('111')).not.toBe('628111');
    expect(await store.findPhoneForLid('111@lid')).toBeNull();
  });

  it('clears a phone that no session owns', async () => {
    await repo.save({ lid: '111', phone: '628111', sessionId: null });
    await store.reload();

    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
  });

  it('clears a phone stored by a session that no longer exists', async () => {
    await repo.save({ lid: '111', phone: '628111', sessionId: gone });
    await store.reload();

    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
    expect(store.lidsForPhone('628111')).toEqual([]);
    expect(await store.findPhoneForLid('111@lid')).toBeNull();
  });

  it('clears a phone stored by a session that has since logged out', async () => {
    await store.remember('111', '628111', s1);
    await ds.getRepository(Session).update({ id: s1 }, { phone: null }); // logout, or WhatsApp unlinked it

    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
    expect(await store.findPhoneForLid('111@lid')).toBeNull();
  });

  it('keeps it again once that session is linked again', async () => {
    await store.remember('111', '628111', s1);
    await ds.getRepository(Session).update({ id: s1 }, { phone: null });
    await ds.getRepository(Session).update({ id: s1 }, { phone: '629000000001' });

    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
  });

  it('touches no other lid, whichever branch would let the negative replace that row', async () => {
    const stamp = new Date('2020-01-01T00:00:00.000Z');
    const others = [
      { lid: '222', phone: '628222', sessionId: null }, // no owner
      { lid: '444', phone: null, sessionId: s3 }, // holds no phone
      { lid: '555', phone: '628555', sessionId: gone }, // owned by a deleted session
      { lid: '777', phone: '628777', sessionId: s9 }, // owned by a session that logged out
      { lid: '666', phone: '628666', sessionId: s2 }, // owned by the session answering
    ];
    await repo.insert([
      { lid: '111', phone: '628111', sessionId: s2, updatedAt: stamp },
      ...others.map(o => ({ ...o, updatedAt: stamp })),
    ]);
    await ds.getRepository(Session).update({ id: s9 }, { phone: null });
    await store.reload();

    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
    for (const other of others) expect(await row(other.lid)).toEqual({ ...other, updatedAt: stamp });
  });

  it('drops a phone cached here once the table holds none, whichever session cleared it', async () => {
    await store.remember('111', '628111', s1);
    await repo.update({ lid: '111' }, { phone: null }); // s1 answered no phone on another node

    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
    expect(store.lidsForPhone('628111')).toEqual([]);
  });

  it('lets a later session clear a phone once the session that stored it is released', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('222', '628222', s9);
    const stamp = new Date('2020-01-01T00:00:00.000Z');
    await repo.update({ lid: '111' }, { updatedAt: stamp });

    await store.releaseSession(s1);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: null, updatedAt: stamp });
    expect(await row('222')).toMatchObject({ phone: '628222', sessionId: s9 });
    await store.remember('111', null, s2);
    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
  });

  it('releaseSession never throws', async () => {
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));

    await expect(store.releaseSession(s1)).resolves.toBeUndefined();
    warn.mockClear();
  });

  it('gives a released row back to a session that reported its phone before, on its next report', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('111', '628111', s2);
    await ds.getRepository(Session).delete({ id: s2 });
    await store.releaseSession(s2);

    await store.remember('111', '628111', s1);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
    await store.remember('111', null, s3);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
    expect(await store.findPhoneForLid('111@lid')).toBe('628111');
    expect(await store.lidsForPhonesPersisted(['628111'])).toEqual({ 628111: ['111'] });
  });

  it('does so when the release could not write the table as well', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('111', '628111', s2);
    await ds.getRepository(Session).delete({ id: s2 });
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    await store.releaseSession(s2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();

    await store.remember('111', '628111', s1);
    await store.remember('111', null, s3);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
  });

  it('a phone from any session still replaces the row', async () => {
    await store.remember('111', null, s1);
    await store.remember('111', '628111', s2);
    await store.remember('111', '628222', s3);

    expect(await row('111')).toMatchObject({ phone: '628222', sessionId: s3 });
  });

  it('gives the row to a second session that reports the same phone, so the first one no longer clears it', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('111', '628111', s2);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });

    await store.remember('111', null, s1);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
    expect(store.getCached('111')).toBe('628111');

    await store.remember('111', null, s2);
    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
  });

  it('writes a phone each session keeps reporting once, not once per report', async () => {
    const upsert = jest.spyOn(repo, 'upsert');
    for (let i = 0; i < 50; i++) {
      await store.remember('111', '628111', s1);
      await store.remember('111', '628111', s2);
    }

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
  });

  it('forgets who reported a phone once the phone changes or is cleared', async () => {
    const seenBy = (store as unknown as { seenBy: Map<string, Set<string>> }).seenBy;
    await store.remember('111', '628111', s1);
    await store.remember('111', '628111', s2);
    await store.remember('111', '628222', s3);
    await store.remember('111', '628222', s1); // s1 reported the old phone, not this one

    expect(await row('111')).toMatchObject({ phone: '628222', sessionId: s1 });
    await store.remember('111', null, s1);
    expect(seenBy.has('111')).toBe(false);
  });

  it('knows the owner of a row it loaded, so only another session reporting the phone writes', async () => {
    await repo.insert({ lid: '111', phone: '628111', sessionId: s1 });
    await store.reload();
    const upsert = jest.spyOn(repo, 'upsert');

    await store.remember('111', '628111', s1);
    expect(upsert).not.toHaveBeenCalled();
    await store.remember('111', '628111', s2);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
  });

  it('knows the owner of a row it warms on a miss as well', async () => {
    await repo.insert({ lid: '111', phone: '628111', sessionId: s1 }); // stored after this node loaded the table
    for (let i = 0; i < 100 && store.getCached('111') === undefined; i++) await new Promise(r => setTimeout(r, 5));
    const upsert = jest.spyOn(repo, 'upsert');

    await store.remember('111', '628111', s1);
    expect(upsert).not.toHaveBeenCalled();
    await store.remember('111', '628111', s2);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('takes the row on the next report when taking it failed to write', async () => {
    await store.remember('111', '628111', s1);
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.remember('111', '628111', s2)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });

    later(60_000);
    await store.remember('111', '628111', s2);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
    await store.remember('111', null, s1);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
  });

  it('writes a new phone on the next report when its first write failed', async () => {
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', '628111', s1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    expect(await row('111')).toBeNull();

    later(60_000);
    await store.remember('111', '628111', s1);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
  });

  it('writes a phone at most once a minute while its writes keep failing, from any session', async () => {
    const upsert = jest.spyOn(repo, 'upsert').mockRejectedValue(new Error('database or disk is full'));
    for (let i = 0; i < 1000; i++) await store.remember('111', '628111', i % 2 ? s1 : s2);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    later(59_999);
    await expect(store.remember('111', '628111', s1)).resolves.toBe(false);
    expect(upsert).toHaveBeenCalledTimes(1);
    later(1);
    await expect(store.remember('111', '628111', s1)).resolves.toBe(false);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockClear();

    upsert.mockRestore(); // the database takes writes again
    later(60_000);
    await expect(store.remember('111', '628111', s1)).resolves.toBe(true);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
    await expect(store.remember('111', '628111', s1)).resolves.toBe(true); // already counted: nothing to write
    await store.remember('111', '628111', s2);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
  });

  it('holds back only the phone whose write failed, and only until a negative clears the row', async () => {
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', '628111', s1);
    warn.mockClear();
    await store.remember('111', '628222', s1);
    expect(await row('111')).toMatchObject({ phone: '628222', sessionId: s1 });

    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('222', '628111', s1);
    warn.mockClear();
    await store.remember('222', null, s1);
    await store.remember('222', '628111', s1);
    expect(await row('222')).toMatchObject({ phone: '628111', sessionId: s1 });
  });

  it('writes a phone change on every report until the table takes it, warning once a minute', async () => {
    await store.remember('111', '628111', s1);
    const upsert = jest.spyOn(repo, 'upsert').mockRejectedValue(new Error('connection lost'));
    for (let i = 0; i < 5; i++) await store.remember('111', '628222', s1);
    expect(upsert).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledTimes(1);

    later(60_000);
    await store.remember('111', '628222', s1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('(4 more failed since the last warning)'));
    warn.mockClear();

    upsert.mockRestore();
    await store.remember('111', '628222', s1);
    expect(await row('111')).toMatchObject({ phone: '628222', sessionId: s1 });

    // Once it lands, a failed write of that phone waits again.
    const retake = jest.spyOn(repo, 'upsert').mockRejectedValue(new Error('connection lost'));
    await store.remember('111', '628222', s2);
    await store.remember('111', '628222', s2);
    expect(retake).toHaveBeenCalledTimes(1);
    warn.mockClear();
  });

  it('writes a negative again when its first attempt failed', async () => {
    await store.remember('111', '628111', s1);
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.remember('111', null, s1)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });

    await expect(store.remember('111', null, s1)).resolves.toBe(true);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s1 });
    expect(await store.findPhoneForLid('111@lid')).toBeNull();
  });

  it('takes the row on the next report of a session whose negative failed to write', async () => {
    await store.remember('111', '628111', s2);
    await store.remember('111', '628111', s1);
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', null, s2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });

    await store.remember('111', '628111', s2);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
  });

  it('answers the table again once a negative clears the row, and a failed negative changes nothing', async () => {
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', '628111', s1); // a first write that fails: the cache holds an unstored phone
    await store.remember('111', null, s1); // the negative lands and clears the row
    await store.remember('222', '628222', s1);
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('222', null, s1); // fails
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockClear();
    expect(store.getCached('111')).toBeUndefined(); // warms the cleared row back
    for (let i = 0; i < 100 && store.getCached('111') === undefined; i++) await new Promise(r => setTimeout(r, 5));

    await repo.update({ lid: In(['111', '222']) }, { phone: '628999' }); // another node stores a phone for both
    expect(await store.phonesForLidsPersisted(['111', '222'])).toEqual({ 111: '628999', 222: '628999' });
  });

  it('keeps a phone stored while the negative of another session is being written', async () => {
    const update = hold('update');
    const negative = store.remember('111', null, s2);
    await update.reached; // the row exists (holding no phone); the conditional update has not run
    await store.remember('111', '628111', s1);
    update.release();
    await negative;

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
    expect(store.getCached('111')).toBe('628111');
  });

  it('does not cache a negative over a phone still being written', async () => {
    const upsert = hold('upsert');
    const phone = store.remember('111', '628111', s1);
    await upsert.reached;
    await store.remember('111', null, s2); // lands first: there is no row yet
    upsert.release();
    await phone;

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
    expect(store.getCached('111')).not.toBeNull();
    expect(await store.lidsForPhonesPersisted(['628111'])).toEqual({ 628111: ['111'] });
  });
});
