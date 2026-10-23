import { DataSource, Repository } from 'typeorm';
import { SessionLidResolver } from './session-lid-resolver.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { Session } from './entities/session.entity';
import { ChatScopeService } from '../auth/chat-scope.service';
import { LidNotMappedError } from '../../common/errors/lid-not-mapped.error';

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

describe('SessionLidResolver', () => {
  let engines: EngineRegistry;
  let resolveContactPhone: jest.Mock;
  let remember: jest.Mock;
  let resolver: SessionLidResolver;

  beforeEach(() => {
    engines = new EngineRegistry();
    resolveContactPhone = jest.fn().mockResolvedValue('628111222333');
    engines.set('s1', { resolveContactPhone } as unknown as IWhatsAppEngine);
    remember = jest.fn().mockResolvedValue(undefined);
    resolver = new SessionLidResolver(engines, { remember } as unknown as LidMappingStoreService);
  });

  it('resolves a phone through the engine', async () => {
    await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBe('628111222333');
    expect(resolveContactPhone).toHaveBeenCalledWith('111@lid');
  });

  it('caches a hit so a chatty sender is queried once', async () => {
    await resolver.resolveSenderPhone('s1', '111@lid');
    await resolver.resolveSenderPhone('s1', '111@lid');

    expect(resolveContactPhone).toHaveBeenCalledTimes(1);
  });

  it('caches a miss too, so an unmapped sender does not re-query every message', async () => {
    resolveContactPhone.mockResolvedValue(null);

    await expect(resolver.resolveSenderPhone('s1', '404@lid')).resolves.toBeNull();
    await expect(resolver.resolveSenderPhone('s1', '404@lid')).resolves.toBeNull();

    expect(resolveContactPhone).toHaveBeenCalledTimes(1);
  });

  it('keys the cache per session, so two sessions resolve independently', async () => {
    engines.set('s2', { resolveContactPhone } as unknown as IWhatsAppEngine);

    await resolver.resolveSenderPhone('s1', '111@lid');
    await resolver.resolveSenderPhone('s2', '111@lid');

    expect(resolveContactPhone).toHaveBeenCalledTimes(2);
  });

  it('returns null (never throws) when the engine rejects', async () => {
    resolveContactPhone.mockRejectedValue(new Error('socket closed'));

    await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBeNull();
  });

  describe('a rejected lookup', () => {
    let now: jest.SpyInstance<number, []>;
    beforeEach(() => {
      now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    });
    afterEach(() => now.mockRestore());

    it('does not cache a transient failure, so the sender resolves once the engine answers', async () => {
      resolveContactPhone.mockRejectedValueOnce(new Error('Evaluation failed')).mockResolvedValueOnce('628111');

      await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBeNull();
      await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBe('628111');
      expect(resolveContactPhone).toHaveBeenCalledTimes(2);
    });

    it('retries an unmapped lid once the hold expires', async () => {
      resolveContactPhone.mockRejectedValueOnce(new LidNotMappedError('111@lid')).mockResolvedValueOnce('628111');

      await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBeNull();
      now.mockReturnValue(1_000_000 + 60_001);
      await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBe('628111');
      expect(resolveContactPhone).toHaveBeenCalledTimes(2);
    });

    it('does not retry an unmapped lid on every message from the same sender, and writes nothing', async () => {
      resolveContactPhone.mockRejectedValue(new LidNotMappedError('404@lid'));

      await expect(resolver.resolveSenderPhone('s1', '404@lid')).resolves.toBeNull();
      now.mockReturnValue(1_000_000 + 59_000);
      await expect(resolver.resolveSenderPhone('s1', '404@lid')).resolves.toBeNull();

      expect(resolveContactPhone).toHaveBeenCalledTimes(1);
      expect(remember).not.toHaveBeenCalled();
    });
  });

  describe('messages that arrive together from one sender', () => {
    // The engine answers only after the whole burst is in, as it does when a reconnect delivers the
    // buffered messages of a busy group at once.
    const burstWith = async (answer: () => Promise<string | null>, size = 50) => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve));
      resolveContactPhone.mockImplementation(async () => {
        await gate;
        return answer();
      });
      const burst = Array.from({ length: size }, () => resolver.resolveSenderPhone('s1', '404@lid'));
      release();
      return Promise.all(burst);
    };

    it.each([
      ['a phone', () => Promise.resolve('628111'), '628111', 1],
      ['a definitive null', () => Promise.resolve(null), null, 1],
      ['an unmapped lid', () => Promise.reject(new LidNotMappedError('404@lid')), null, 0],
    ])('share one engine lookup and one write for %s', async (_label, answer, phone, writes) => {
      await expect(burstWith(answer)).resolves.toEqual(Array.from({ length: 50 }, () => phone));
      expect(resolveContactPhone).toHaveBeenCalledTimes(1);
      expect(remember).toHaveBeenCalledTimes(writes);
    });

    it('do not hold up a later message once the lookup failed, which is looked up again', async () => {
      await burstWith(() => Promise.reject(new Error('Evaluation failed')), 5);
      resolveContactPhone.mockResolvedValue('628111');

      await expect(resolver.resolveSenderPhone('s1', '404@lid')).resolves.toBe('628111');
      expect(resolveContactPhone).toHaveBeenCalledTimes(2);
    });

    it('keep other senders and other sessions apart', async () => {
      engines.set('s2', { resolveContactPhone } as unknown as IWhatsAppEngine);
      resolveContactPhone.mockImplementation(lid => Promise.resolve(`phone-of-${String(lid)}`));

      await expect(
        Promise.all([
          resolver.resolveSenderPhone('s1', '1@lid'),
          resolver.resolveSenderPhone('s1', '1@lid'),
          resolver.resolveSenderPhone('s1', '2@lid'),
          resolver.resolveSenderPhone('s2', '1@lid'),
        ]),
      ).resolves.toEqual(['phone-of-1@lid', 'phone-of-1@lid', 'phone-of-2@lid', 'phone-of-1@lid']);
      expect(resolveContactPhone).toHaveBeenCalledTimes(3);
    });
  });

  it('returns null when the session has no live engine', async () => {
    await expect(resolver.resolveSenderPhone('not-started', '111@lid')).resolves.toBeNull();
  });

  it('persists a real resolution to the shared lid mapping store', async () => {
    await resolver.resolveSenderPhone('s1', '111@lid');

    expect(remember).toHaveBeenCalledWith('111', '628111222333', 's1');
  });

  it('persists a definitive null resolution so a stale mapping converges (#1058)', async () => {
    resolveContactPhone.mockResolvedValue(null);

    await resolver.resolveSenderPhone('s1', '404@lid');

    expect(remember).toHaveBeenCalledWith('404', null, 's1');
  });

  it('does not persist a transient failure (engine rejects) as a null mapping', async () => {
    resolveContactPhone.mockRejectedValue(new Error('socket closed'));

    await resolver.resolveSenderPhone('s1', '111@lid');

    expect(remember).not.toHaveBeenCalled();
  });

  // The wwjs adapter used to swallow every lookup failure into null, so this guard was dead on
  // that engine: a dead page or rate-limit read as "no mapping" and clobbered a valid stored
  // row. The adapter now rejects on failure (the HTTP boundary nulls instead), which is what
  // makes the guard above real; this case pins that the persisted-negative path still fires for
  // a DEFINITIVE null (the engine answered: no mapping).
  it('persists a definitive null (the engine answered no-mapping) even on wwjs', async () => {
    resolveContactPhone.mockResolvedValue(null);

    await resolver.resolveSenderPhone('s1', '222@lid');

    expect(remember).toHaveBeenCalledWith('222', null, 's1');
  });

  it('does not persist when there is no live engine (transient, not definitive)', async () => {
    await resolver.resolveSenderPhone('not-started', '111@lid');

    expect(remember).not.toHaveBeenCalled();
  });

  describe('an answer the lid table did not take', () => {
    it.each([
      ['a definitive null', null],
      ['a phone', '628111'],
    ])('is looked up again for %s on the next message, and that answer is reported', async (_label, phone) => {
      resolveContactPhone.mockResolvedValue(phone);
      remember.mockResolvedValueOnce(false);

      await expect(resolver.resolveSenderPhone('s1', '404@lid')).resolves.toBe(phone);
      await settle();
      await expect(resolver.resolveSenderPhone('s1', '404@lid')).resolves.toBe(phone);
      await settle();
      for (let i = 0; i < 100; i++) await expect(resolver.resolveSenderPhone('s1', '404@lid')).resolves.toBe(phone);
      await settle();

      expect(resolveContactPhone).toHaveBeenCalledTimes(2);
      expect(remember).toHaveBeenCalledTimes(2);
      expect(remember).toHaveBeenLastCalledWith('404', phone, 's1');
    });
  });

  it('never rejects when the mapping store write fails (fire-and-forget)', async () => {
    remember.mockRejectedValue(new Error('db down'));

    await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBe('628111222333');
  });

  it('works without a mapping store at all (optional dependency)', async () => {
    const bare = new SessionLidResolver(engines);

    await expect(bare.resolveSenderPhone('s1', '111@lid')).resolves.toBe('628111222333');
  });

  it('evicts the oldest entry once the cache is full, bounding memory', async () => {
    const max = 5000;
    // Fill past the cap; the first key inserted must be the one evicted (FIFO).
    for (let i = 0; i < max; i++) {
      resolveContactPhone.mockResolvedValue(`phone-${i}`);
      await resolver.resolveSenderPhone('s1', `${i}@lid`);
    }
    expect(resolveContactPhone).toHaveBeenCalledTimes(max);

    // One more insert evicts the oldest ('0@lid').
    resolveContactPhone.mockResolvedValue('phone-new');
    await resolver.resolveSenderPhone('s1', 'new@lid');

    // The evicted key must be re-queried; a still-cached one must not be.
    resolveContactPhone.mockClear();
    await resolver.resolveSenderPhone('s1', '0@lid');
    expect(resolveContactPhone).toHaveBeenCalledTimes(1);

    resolveContactPhone.mockClear();
    await resolver.resolveSenderPhone('s1', `${max - 1}@lid`);
    expect(resolveContactPhone).not.toHaveBeenCalled();
  });
});

describe('SessionLidResolver over the shared lid table', () => {
  const [s1, s2] = ['00000001-0000-4000-8000-000000000000', '00000002-0000-4000-8000-000000000000'];
  const [P, Q] = ['628111', '628222'];
  /** The wall clock when each case starts. */
  const T = Date.parse('2026-10-01T00:00:00Z');
  let ds: DataSource;
  let repo: Repository<LidMapping>;
  let store: LidMappingStoreService;
  let resolver: SessionLidResolver;
  let warn: jest.SpyInstance;
  let wallClock: jest.SpyInstance<number, []>;
  /** What each session's engine answers for the contact's lid. */
  const answers: Record<string, string | null> = {};
  const row = () => repo.findOne({ where: { lid: '111' } });
  const admitted = async (phone: string) => {
    const fence = new ChatScopeService(store);
    const key = { allowedChats: [`${phone}@c.us`] };
    return [await fence.allows(key, '111@lid'), (await fence.scopeForFilter(key))!.allowed.has('111@lid')];
  };
  /** A message from the contact to a session. */
  const message = async (session: string) => {
    await resolver.resolveSenderPhone(session, '111@lid');
    await settle();
  };

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [LidMapping, Session],
      synchronize: true,
    }).initialize();
    await ds.getRepository(Session).insert([s1, s2].map(id => ({ id, name: id, phone: `6290000000${id[7]}` })));
    repo = ds.getRepository(LidMapping);
    store = new LidMappingStoreService(repo);
    warn = jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn');
    await store.onModuleInit();
    const engines = new EngineRegistry();
    for (const session of [s1, s2]) {
      answers[session] = P;
      engines.set(session, {
        resolveContactPhone: () => Promise.resolve(answers[session]),
      } as unknown as IWhatsAppEngine);
    }
    resolver = new SessionLidResolver(engines, store);
    wallClock = jest.spyOn(Date, 'now').mockReturnValue(T);
  });

  afterEach(async () => {
    wallClock.mockRestore();
    await ds.destroy();
  });

  it('clears a number the contact hid on a later message when the first negative did not reach the table, whatever the wall clock does', async () => {
    await store.remember('111', P, s1); // s1 stored the phone earlier
    answers[s1] = null; // the contact hid the number: s1 answers none
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    await message(s1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await admitted(P)).toEqual([true, true]);

    wallClock.mockReturnValue(T - 3_600_000 + 60_000); // set back an hour, then a minute on
    await message(s1);

    expect(await row()).toMatchObject({ phone: null, sessionId: s1 });
    expect(await admitted(P)).toEqual([false, false]);
  });

  it('reports what the engine answers on the next message, not an answer whose write failed', async () => {
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await message(s1); // s1 resolves P; the write fails
    warn.mockClear();
    await store.remember('111', Q, s1); // the contact's new number reaches the table from another report
    answers[s1] = Q;
    answers[s2] = Q;

    wallClock.mockReturnValue(T + 61_000);
    await message(s1);

    expect(await row()).toMatchObject({ phone: Q, sessionId: s1 });
    expect(await admitted(P)).toEqual([false, false]);
    expect(await admitted(Q)).toEqual([true, true]);
    expect(warn).not.toHaveBeenCalled();
  });
});
