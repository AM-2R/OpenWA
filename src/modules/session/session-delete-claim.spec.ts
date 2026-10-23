import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { postgresUtcExtra } from '../../database/postgres-utc';
import { SessionService } from './session.service';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { PresenceStore } from './presence-store.service';
import { SessionOwnershipService } from './session-ownership.service';
import { SessionLifecycleFences } from './session-lifecycle-fences';
import { SessionStoppedException } from './session-engine-controls';
import { Session, SessionStatus } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { MessageBatch } from '../message/entities/message-batch.entity';
import { SendIdempotencyKey } from '../message/entities/send-idempotency-key.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { EngineFactory } from '../../engine/engine.factory';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { SessionLidResolver } from './session-lid-resolver.service';
import { SessionLivenessWatchdog } from './session-liveness-watchdog.service';
import { MessageProjector } from './message-projector.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionTakeoverService } from '../takeover/session-takeover.service';

const entities = [
  Session,
  Message,
  MessageBatch,
  SendIdempotencyKey,
  Webhook,
  WebhookOutboxEvent,
  WebhookDeliveryFailure,
  IntegrationDeliveryFailure,
  Template,
  BaileysStoredMessage,
  ChatState,
  StatusUpdate,
];

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(res => (resolve = res));
  return { promise, resolve };
};

const makeEngine = () => ({
  initialize: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
  forceDestroy: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  logout: jest.fn().mockResolvedValue(undefined),
  getQRCode: jest.fn().mockReturnValue(null),
});
type FakeEngine = ReturnType<typeof makeEngine>;

interface Node {
  db: DataSource;
  service: SessionService;
  lifecycle: SessionEngineLifecycle;
  ownership: SessionOwnershipService;
  /** Every engine this node launched. */
  engines: FakeEngine[];
  hooks: { execute: jest.Mock };
  purge: jest.Mock;
}

const lapsed = (): Date => new Date(Date.now() - 1_000);

const inbound: IncomingMessage = {
  id: 'inbound-after-delete',
  from: '10000000001@c.us',
  to: '628111111111@c.us',
  chatId: '10000000001@c.us',
  body: 'hello',
  type: 'text',
  timestamp: Math.floor(Date.now() / 1000),
  fromMe: false,
  isGroup: false,
  kind: 'individual',
};

/**
 * Two nodes sharing one database, each on its own connection with the real SessionService, lifecycle and
 * ownership service; engines, gateway and webhook sender are fakes. SQLite runs on a file, PostgreSQL in a
 * schema of its own (DATABASE_TYPE=postgres). Node A's delete is held at the session:deleted hook: its
 * engine is gone and the rows it removes are still there.
 */
describe('A session deleted on one node while a peer shares the database', () => {
  const pg = process.env.DATABASE_TYPE === 'postgres';
  let options: DataSourceOptions;
  let dir: string | undefined;
  let a: Node;
  let b: Node;
  let deletion: Promise<void> | undefined;
  let finish: (() => void) | undefined;

  async function bootNode(nodeId: string): Promise<Node> {
    const db = await new DataSource(options).initialize();
    const engines: FakeEngine[] = [];
    const purge = jest.fn().mockResolvedValue(undefined);
    const hooks = { execute: jest.fn((_event: string, data: unknown) => Promise.resolve({ continue: true, data })) };
    const values: Record<string, unknown> = {
      'session.nodeId': nodeId,
      'session.leaseTtlMs': 60_000,
      'session.leaseHeartbeatMs': 20_000,
    };
    const module = await Test.createTestingModule({
      providers: [
        SessionService,
        SessionEngineLifecycle,
        SessionErrorStore,
        SessionRestrictionStore,
        PresenceStore,
        SessionOwnershipService,
        { provide: getRepositoryToken(Session, 'data'), useValue: db.getRepository(Session) },
        { provide: getRepositoryToken(Message, 'data'), useValue: db.getRepository(Message) },
        { provide: getDataSourceToken('data'), useValue: db },
        {
          provide: EngineFactory,
          useValue: {
            create: jest.fn(() => {
              const engine = makeEngine();
              engines.push(engine);
              return engine;
            }),
            purgeSessionData: purge,
          },
        },
        EngineRegistry,
        SessionLidResolver,
        SessionLivenessWatchdog,
        MessageProjector,
        {
          provide: EventsGateway,
          useValue: {
            emitSessionStatus: jest.fn(),
            emitSessionDisconnected: jest.fn(),
            emitQRCode: jest.fn(),
            emitSessionAuthenticated: jest.fn(),
            emitMessage: jest.fn(),
          },
        },
        { provide: WebhookService, useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
        { provide: HookManager, useValue: hooks },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(<T>(key: string, def?: T): T => (key in values ? (values[key] as T) : (def as T))) },
        },
        { provide: LidMappingStoreService, useValue: { remember: jest.fn() } },
        { provide: StatusStoreService, useValue: { ingest: jest.fn(), captureWrites: jest.fn() } },
      ],
    }).compile();
    const lifecycle = module.get(SessionEngineLifecycle);
    const ownership = module.get(SessionOwnershipService);
    // What SessionService wires at bootstrap, without the interval: renew() asks whether anything still runs.
    ownership.setEngineLiveness(id => lifecycle.isEngineActive(id));
    ownership.onLeaseLoss(async ids => {
      await lifecycle.stopOrphanEngines(ids);
    });
    return { db, service: module.get(SessionService), lifecycle, ownership, engines, hooks, purge };
  }

  beforeEach(async () => {
    if (pg) {
      options = {
        type: 'postgres',
        host: process.env.DATABASE_HOST || 'localhost',
        port: Number(process.env.DATABASE_PORT || 5432),
        username: process.env.DATABASE_USERNAME || 'openwa',
        password: process.env.DATABASE_PASSWORD || 'openwa',
        database: process.env.DATABASE_NAME || 'openwa',
        schema: `session_delete_claim_${randomUUID().replace(/-/g, '')}`,
        entities,
        extra: postgresUtcExtra(),
      };
      const setup = await new DataSource(options).initialize();
      await setup.query(`CREATE SCHEMA "${options.schema}"`);
      await setup.synchronize();
      await setup.destroy();
    } else {
      dir = mkdtempSync(join(tmpdir(), 'openwa-delete-claim-'));
      options = { type: 'better-sqlite3', database: join(dir, 'data.sqlite'), entities };
      await (await new DataSource({ ...options, synchronize: true }).initialize()).destroy();
    }
    a = await bootNode('node-a');
    b = await bootNode('node-b');
  });

  afterEach(async () => {
    finish?.();
    await deletion?.catch(() => undefined);
    deletion = finish = undefined;
    jest.restoreAllMocks();
    for (const node of [a, b]) {
      await node.service.onModuleDestroy();
      if (pg && node === b) await node.db.query(`DROP SCHEMA "${(options as { schema: string }).schema}" CASCADE`);
      await node.db.destroy();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** A session with one stored message, written the way node A sees it. */
  async function seed(fields: Partial<Session>): Promise<string> {
    const row = await a.db
      .getRepository(Session)
      .save({ name: `s-${randomUUID().slice(0, 8)}`, config: {}, phone: '628111111111', ...fields });
    await a.db
      .getRepository(Message)
      .insert({ sessionId: row.id, chatId: '10000000001@c.us', from: 'me', to: '10000000001@c.us', body: 'm' });
    return row.id;
  }

  /** Start node A's delete of `id` and hold it once its engine is gone, before any row is removed. */
  async function startHeldDelete(id: string): Promise<void> {
    const reached = deferred();
    const release = deferred();
    a.hooks.execute.mockImplementation(async (event: string, data: unknown) => {
      if (event === 'session:deleted') {
        reached.resolve();
        await release.promise;
      }
      return { continue: true, data };
    });
    finish = release.resolve;
    deletion = a.service.delete(id);
    await reached.promise;
  }

  /** Whatever the peer launched receives a message after the delete, as a live engine would. */
  async function peerReceivesAMessage(): Promise<void> {
    for (const engine of b.engines) {
      const callbacks = (
        engine.initialize.mock.calls as Array<[{ onMessage?: (m: IncomingMessage) => unknown }]>
      )[0][0];
      const receipt = callbacks.onMessage?.({ ...inbound }) as { settled?: Promise<unknown> } | undefined;
      await receipt?.settled;
    }
    // The projector's writes are detached; let them land before counting.
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  async function rowsOf(id: string): Promise<Record<string, number>> {
    return {
      sessions: await a.db.getRepository(Session).countBy({ id }),
      messages: await a.db.getRepository(Message).countBy({ sessionId: id }),
      outbox: await a.db.getRepository(WebhookOutboxEvent).countBy({ sessionId: id }),
      deliveryFailures: await a.db.getRepository(WebhookDeliveryFailure).countBy({ sessionId: id }),
    };
  }

  /** The request bookkeeping a refused delete must not leave behind. */
  function leftovers(id: string): { stopMark: boolean; stopCount: boolean } {
    return {
      stopMark: (a.lifecycle as unknown as { stoppingSessions: { has(id: string): boolean } }).stoppingSessions.has(id),
      stopCount: (a.service as unknown as { stopRequests: Map<string, unknown> }).stopRequests.has(id),
    };
  }

  it.each([
    ['before the start clears its stop', 'clear-before', 'stopped'],
    ['after the start clears its stop', 'clear-after', 'stopped'],
    ['before launch', 'hook', null],
    ['during launch', 'initialize', null],
    ['after the start returns', 'returned', null],
    ['before a retried launch', 'retry', null],
  ] as const)('refuses a stale peer stop %s once a live owner has claimed', async (_case, phase, desiredState) => {
    const id = await seed({ status: SessionStatus.DISCONNECTED, desiredState });
    const claiming = deferred();
    const claimGo = deferred();
    const checked = deferred();
    const stopGo = deferred();
    const reached = deferred();
    const go = deferred();
    const claim = a.ownership.claim.bind(a.ownership);
    jest.spyOn(a.ownership, 'claim').mockImplementationOnce(async next => {
      claiming.resolve();
      await claimGo.promise;
      return claim(next);
    });
    const held = b.ownership.isHeldByOtherNode.bind(b.ownership);
    jest.spyOn(b.ownership, 'isHeldByOtherNode').mockImplementationOnce(async next => {
      const answer = await held(next);
      checked.resolve();
      await stopGo.promise;
      return answer;
    });
    const sessions = a.db.getRepository(Session);
    if (phase.startsWith('clear')) {
      const update = sessions.update.bind(sessions);
      jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
        if (patch.desiredState !== null) return update(where, patch);
        if (phase === 'clear-before') {
          reached.resolve();
          await go.promise;
        }
        const result = await update(where, patch);
        if (phase === 'clear-after') {
          reached.resolve();
          await go.promise;
        }
        return result;
      });
    } else if (phase === 'initialize') {
      const engines = (a.lifecycle as unknown as { engines: EngineRegistry }).engines;
      const register = engines.set.bind(engines);
      jest.spyOn(engines, 'set').mockImplementation((next, engine) => {
        (engine as unknown as FakeEngine).initialize.mockImplementation(async () => {
          reached.resolve();
          await go.promise;
        });
        return register(next, engine);
      });
    } else if (phase !== 'returned') {
      a.hooks.execute.mockImplementation(async (event: string, data: unknown) => {
        if (event === 'session:starting') {
          reached.resolve();
          await go.promise;
        }
        return { continue: true, data };
      });
      if (phase === 'retry') {
        jest.spyOn(sessions, 'findOne').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
      }
    }
    const starting = a.service.start(id, { explicit: true }).catch((error: unknown) => error);
    let stopping: Promise<unknown> | undefined;
    try {
      await claiming.promise;
      stopping = b.service.stop(id).catch((error: unknown) => error);
      await checked.promise;
      claimGo.resolve();
      if (phase === 'returned') await starting;
      else await reached.promise;
      stopGo.resolve();

      expect(await stopping).toBeInstanceOf(ConflictException);
      go.resolve();
      expect(await starting).not.toBeInstanceOf(Error);
      expect(a.service.getEngine(id)).toBe(a.engines[0]);
      expect(await sessions.findOneByOrFail({ id })).toMatchObject({ nodeId: 'node-a', desiredState: null });
      expect((b.service as unknown as { stopRequests: Map<string, unknown> }).stopRequests.has(id)).toBe(false);
      expect((b.lifecycle as unknown as { stoppingSessions: Set<string> }).stoppingSessions.has(id)).toBe(false);
      expect(b.ownership.ownedIds()).toEqual([]);
    } finally {
      claimGo.resolve();
      stopGo.resolve();
      go.resolve();
      await Promise.allSettled([starting, stopping]);
    }
  });

  it.each(['final read', 'conditional clear'])(
    'yields before launch when a peer replaces a deleting record before the %s',
    async when => {
      const id = await seed({ status: SessionStatus.DISCONNECTED, desiredState: 'deleting' });
      const claiming = deferred();
      const claimGo = deferred();
      const checked = deferred();
      const stopGo = deferred();
      const clearing = deferred();
      const clearGo = deferred();
      const claim = a.ownership.claim.bind(a.ownership);
      jest.spyOn(a.ownership, 'claim').mockImplementationOnce(async next => {
        claiming.resolve();
        await claimGo.promise;
        return claim(next);
      });
      const held = b.ownership.isHeldByOtherNode.bind(b.ownership);
      jest.spyOn(b.ownership, 'isHeldByOtherNode').mockImplementationOnce(async next => {
        const answer = await held(next);
        checked.resolve();
        await stopGo.promise;
        return answer;
      });
      const sessions = a.db.getRepository(Session);
      const update = sessions.update.bind(sessions);
      if (when === 'final read') {
        jest.spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
          clearing.resolve();
          await clearGo.promise;
        });
      } else {
        jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
          if (patch.desiredState === null) {
            clearing.resolve();
            await clearGo.promise;
          }
          return update(where, patch);
        });
      }
      const starting = a.service.start(id, { explicit: true }).catch((error: unknown) => error);
      let stopping: Promise<unknown> | undefined;
      try {
        await claiming.promise;
        stopping = b.service.stop(id);
        await checked.promise;
        claimGo.resolve();
        await clearing.promise;
        stopGo.resolve();
        await stopping;
        expect(await sessions.findOneByOrFail({ id })).toMatchObject({ nodeId: 'node-a', desiredState: 'stopped' });
        clearGo.resolve();

        expect(await starting).toBeInstanceOf(SessionStoppedException);
        expect(a.engines).toHaveLength(0);
        expect(a.hooks.execute.mock.calls.some(([event]: [string]) => event === 'session:starting')).toBe(false);
        expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('stopped');
        expect(a.ownership.ownedIds()).toEqual([]);
        expect(leftovers(id).stopCount).toBe(false);
      } finally {
        claimGo.resolve();
        stopGo.resolve();
        clearGo.resolve();
        await Promise.allSettled([starting, stopping]);
      }
    },
  );

  it.each(['before', 'after'])('keeps a stop on the same owner sent %s the start clears its record', async when => {
    const id = await seed({ status: SessionStatus.DISCONNECTED, desiredState: 'stopped' });
    const reached = deferred();
    const go = deferred();
    const sessions = a.db.getRepository(Session);
    const update = sessions.update.bind(sessions);
    jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
      if (patch.desiredState !== null) return update(where, patch);
      if (when === 'before') {
        reached.resolve();
        await go.promise;
      }
      const result = await update(where, patch);
      if (when === 'after') {
        reached.resolve();
        await go.promise;
      }
      return result;
    });
    const starting = a.service.start(id, { explicit: true }).catch((error: unknown) => error);
    try {
      await reached.promise;
      await a.service.stop(id);
      go.resolve();
      await starting;
      expect(a.service.getEngine(id)).toBeUndefined();
      expect(await sessions.findOneByOrFail({ id })).toMatchObject({ desiredState: 'stopped', nodeId: null });
      expect(leftovers(id).stopCount).toBe(false);
    } finally {
      go.resolve();
      await starting;
    }
  });

  it('answers not found before launch if the session is removed during the conditional clear', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED, desiredState: 'stopped' });
    const clearing = deferred();
    const go = deferred();
    const sessions = a.db.getRepository(Session);
    const update = sessions.update.bind(sessions);
    jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
      if (patch.desiredState === null) {
        clearing.resolve();
        await go.promise;
      }
      return update(where, patch);
    });
    const starting = a.service.start(id, { explicit: true }).catch((error: unknown) => error);
    try {
      await clearing.promise;
      await a.service.delete(id);
      go.resolve();
      expect(await starting).toBeInstanceOf(NotFoundException);
      expect(a.engines).toHaveLength(0);
      expect(a.hooks.execute.mock.calls.some(([event]: [string]) => event === 'session:starting')).toBe(false);
      expect(a.ownership.ownedIds()).toEqual([]);
      expect(leftovers(id).stopCount).toBe(false);
    } finally {
      go.resolve();
      await starting;
    }
  });

  it.each([
    ['unclaimed with a retained lease', { nodeId: null, leaseExpiresAt: new Date(Date.now() + 60_000) }, null],
    ['expired', { nodeId: 'departed', leaseExpiresAt: lapsed() }, null],
    ['without a lease', { nodeId: 'departed', leaseExpiresAt: null }, null],
  ] as const)('records a stop when the previous owner is %s', async (_case, fields, nodeId) => {
    const id = await seed({ status: SessionStatus.DISCONNECTED, ...fields });
    await b.service.stop(id);
    expect(await a.db.getRepository(Session).findOneByOrFail({ id })).toMatchObject({
      desiredState: 'stopped',
      nodeId,
    });
    expect((b.service as unknown as { stopRequests: Map<string, unknown> }).stopRequests.has(id)).toBe(false);
  });

  it('records a stop after the former owner logged out and released its claim', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    await a.service.start(id, { explicit: true });
    await a.service.logout(id);
    await b.service.stop(id);
    expect(await a.db.getRepository(Session).findOneByOrFail({ id })).toMatchObject({
      desiredState: 'stopped',
      nodeId: null,
    });
    expect(a.service.getEngine(id)).toBeUndefined();
  });

  it('answers not found when a session disappears while its stop reads it', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const sessions = b.db.getRepository(Session);
    const findOne = sessions.findOne.bind(sessions);
    jest.spyOn(sessions, 'findOne').mockImplementationOnce(async options => {
      const row = await findOne(options);
      await a.service.delete(id);
      return row;
    });
    await expect(b.service.stop(id)).rejects.toBeInstanceOf(NotFoundException);
    expect((b.service as unknown as { stopRequests: Map<string, unknown> }).stopRequests.has(id)).toBe(false);
    expect((b.lifecycle as unknown as { stoppingSessions: Set<string> }).stoppingSessions.has(id)).toBe(false);
  });

  it('kills a stale local engine without recording a stop over its new live owner', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    await b.service.start(id, { explicit: true });
    await a.db.getRepository(Session).update(id, { leaseExpiresAt: lapsed() });
    await a.service.start(id, { explicit: true });

    await b.service.forceKill(id);

    expect(b.service.getEngine(id)).toBeUndefined();
    expect(a.service.getEngine(id)).toBe(a.engines[0]);
    expect(await a.db.getRepository(Session).findOneByOrFail({ id })).toMatchObject({
      desiredState: null,
      nodeId: 'node-a',
    });
    expect((b.service as unknown as { stopRequests: Map<string, unknown> }).stopRequests.has(id)).toBe(false);
  });

  it.each([
    ['expired', 'before'],
    ['expired', 'after'],
    ['no lease', 'before'],
    ['no lease', 'after'],
    ['expired', 'initialize'],
    ['no lease', 'initialize'],
  ])('honors an accepted peer stop when the start lease is %s %s its clear', async (lease, when) => {
    const id = await seed({ status: SessionStatus.DISCONNECTED, desiredState: 'stopped' });
    const claimReached = deferred(),
      claimGo = deferred();
    const peerReached = deferred(),
      peerGo = deferred();
    const clearReached = deferred(),
      clearGo = deferred();
    const claim = a.ownership.claim.bind(a.ownership);
    jest.spyOn(a.ownership, 'claim').mockImplementationOnce(async next => {
      claimReached.resolve();
      await claimGo.promise;
      return claim(next);
    });
    const peerCheck = b.ownership.isHeldByOtherNode.bind(b.ownership);
    jest.spyOn(b.ownership, 'isHeldByOtherNode').mockImplementationOnce(async next => {
      const held = await peerCheck(next);
      peerReached.resolve();
      await peerGo.promise;
      return held;
    });
    const repo = a.db.getRepository(Session);
    const update = repo.update.bind(repo);
    if (when === 'initialize') {
      const engines = (a.lifecycle as unknown as { engines: EngineRegistry }).engines;
      const register = engines.set.bind(engines);
      jest.spyOn(engines, 'set').mockImplementation((next, engine) => {
        (engine as unknown as FakeEngine).initialize.mockImplementation(async () => {
          clearReached.resolve();
          await clearGo.promise;
        });
        return register(next, engine);
      });
    } else {
      jest.spyOn(repo, 'update').mockImplementation(async (where, patch) => {
        if (patch.desiredState !== null) return update(where, patch);
        if (when === 'before') {
          clearReached.resolve();
          await clearGo.promise;
        }
        const result = await update(where, patch);
        if (when === 'after') {
          clearReached.resolve();
          await clearGo.promise;
        }
        return result;
      });
    }
    const starting = a.service.start(id, { explicit: true }).catch((error: unknown) => error);
    await claimReached.promise;
    const stopping = b.service.stop(id);
    try {
      await peerReached.promise;
      claimGo.resolve();
      await clearReached.promise;
      await repo.update(id, { leaseExpiresAt: lease === 'expired' ? lapsed() : null });
      peerGo.resolve();
      await stopping;
      clearGo.resolve();
      await starting;
      const row = await repo.findOneByOrFail({ id });
      expect(a.service.getEngine(id)).toBeUndefined();
      expect(row.desiredState).toBe('stopped');
      if (when !== 'initialize') expect(a.engines).toHaveLength(0);
    } finally {
      claimGo.resolve();
      peerGo.resolve();
      clearGo.resolve();
      await Promise.allSettled([starting, stopping]);
    }
  });

  it('does not create an engine for a session deleted by a peer during its start hook without ownership', async () => {
    Object.assign(a.service, { ownership: undefined });
    Object.assign(a.lifecycle, { ownership: undefined });
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    a.hooks.execute.mockImplementation(async (event: string, data: unknown) => {
      if (event === 'session:starting') await b.service.delete(id);
      return { continue: true, data };
    });

    await expect(a.service.start(id, { explicit: true })).rejects.toBeInstanceOf(NotFoundException);
    expect(a.engines).toHaveLength(0);
    expect(leftovers(id).stopCount).toBe(false);
  });

  it.each(['before', 'after'])(
    'returns the inactive session when a local stop arrives %s the final admission write',
    async when => {
      const id = await seed({ status: SessionStatus.DISCONNECTED });
      const reached = deferred();
      const go = deferred();
      const sessions = a.db.getRepository(Session);
      const update = sessions.update.bind(sessions);
      let admissions = 0;
      jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
        if (patch.desiredState !== null || ++admissions !== 2) return update(where, patch);
        if (when === 'before') {
          reached.resolve();
          await go.promise;
        }
        const result = await update(where, patch);
        if (when === 'after') {
          reached.resolve();
          await go.promise;
        }
        return result;
      });
      const starting = a.service.start(id, { explicit: true }).catch((error: unknown) => error);
      try {
        await reached.promise;
        await a.service.stop(id);
        go.resolve();
        expect(await starting).toMatchObject({ id, status: SessionStatus.DISCONNECTED, desiredState: 'stopped' });
        expect(a.engines).toHaveLength(0);
        expect(leftovers(id).stopCount).toBe(false);
      } finally {
        go.resolve();
        await starting;
      }
    },
  );

  it.each(['first write', 'final write', 'final return'])(
    'preserves an accepted stop when the lease expires during the %s',
    async phase => {
      Object.assign(a.ownership, {
        configService: { get: (key: string) => ({ 'session.nodeId': 'node-a', 'session.leaseTtlMs': 200 })[key] },
      });
      const id = await seed({ status: SessionStatus.DISCONNECTED, desiredState: 'stopped' });
      const reached = deferred();
      const go = deferred();
      const recorded = deferred();
      const releaseGo = deferred();
      const release = b.ownership.release.bind(b.ownership);
      jest.spyOn(b.ownership, 'release').mockImplementationOnce(async next => {
        recorded.resolve();
        await releaseGo.promise;
        return release(next);
      });
      const sessions = a.db.getRepository(Session);
      const update = sessions.update.bind(sessions);
      let admissions = 0;
      let expires = new Date();
      jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
        if (patch.desiredState === null && ++admissions === (phase === 'first write' ? 1 : 2)) {
          const result = phase === 'final return' ? await update(where, patch) : undefined;
          expires = (await sessions.findOneByOrFail({ id })).leaseExpiresAt!;
          reached.resolve();
          await go.promise;
          if (result) return result;
        }
        return update(where, patch);
      });
      const starting = a.service.start(id, { explicit: true }).catch((error: unknown) => error);
      let stopping: Promise<unknown> | undefined;
      try {
        await reached.promise;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, expires.getTime() - Date.now()) + 25));
        stopping = b.service.stop(id);
        await recorded.promise;
        go.resolve();
        await starting;
        expect(a.engines).toHaveLength(0);
        expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('stopped');
      } finally {
        go.resolve();
        releaseGo.resolve();
        await Promise.allSettled([starting, stopping]);
      }
    },
  );

  it.each([
    ['live owner', 'node-a', 'live', 'stopped', true],
    ['live owner without a stop', 'node-a', 'live', null, true],
    ['changed stop record', 'node-a', 'live', 'deleting', false],
    ['foreign owner', 'node-b', 'live', 'stopped', false],
    ['released owner', null, 'live', 'stopped', false],
    ['expired owner', 'node-a', 'expired', 'stopped', false],
    ['owner without a lease', 'node-a', 'missing', 'stopped', false],
  ] as const)('admits only the recorded state of the %s', async (_case, nodeId, lease, desiredState, admitted) => {
    const leaseExpiresAt = lease === 'missing' ? null : new Date(Date.now() + (lease === 'live' ? 5_000 : -1_000));
    const id = await seed({ status: SessionStatus.DISCONNECTED, nodeId, leaseExpiresAt, desiredState });

    expect(await a.ownership.prepareStart(id, desiredState === null ? null : 'stopped')).toBe(admitted);

    const row = await a.db.getRepository(Session).findOneByOrFail({ id });
    expect(row.desiredState).toBe(admitted ? null : desiredState);
    expect(row.nodeId).toBe(nodeId);
    if (admitted) expect(row.leaseExpiresAt!.getTime()).toBeGreaterThan(leaseExpiresAt!.getTime());
    else expect(row.leaseExpiresAt).toEqual(leaseExpiresAt);
  });

  it.each(['foreign', 'expired', 'missing'] as const)(
    'retires an initializing engine whose ownership becomes %s without a stop',
    async loss => {
      const id = await seed({ status: SessionStatus.DISCONNECTED });
      const reached = deferred();
      const go = deferred();
      const engines = (a.lifecycle as unknown as { engines: EngineRegistry }).engines;
      const register = engines.set.bind(engines);
      jest.spyOn(engines, 'set').mockImplementation((next, engine) => {
        (engine as unknown as FakeEngine).initialize.mockImplementation(async () => {
          reached.resolve();
          await go.promise;
        });
        return register(next, engine);
      });
      const starting = a.service.start(id, { explicit: true });
      try {
        await reached.promise;
        await b.db.getRepository(Session).update(id, {
          nodeId: loss === 'foreign' ? 'node-b' : 'node-a',
          leaseExpiresAt: loss === 'foreign' ? new Date(Date.now() + 60_000) : loss === 'expired' ? lapsed() : null,
        });
        go.resolve();
        await starting;
        expect(a.service.getEngine(id)).toBeUndefined();
        expect(a.engines[0].destroy).toHaveBeenCalled();
        expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
      } finally {
        go.resolve();
        await starting;
      }
    },
  );

  it.each([
    ['initializing', 'expired'],
    ['started', 'expired'],
    ['initializing', 'missing'],
    ['started', 'missing'],
  ])('retires a %s engine whose lease is %s after a peer stop before renewal', async (phase, lease) => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const reached = deferred();
    const go = deferred();
    const recorded = deferred();
    const releaseGo = deferred();
    const engines = (a.lifecycle as unknown as { engines: EngineRegistry }).engines;
    const register = engines.set.bind(engines);
    jest.spyOn(engines, 'set').mockImplementation((next, engine) => {
      (engine as unknown as FakeEngine).initialize.mockImplementation(async () => {
        reached.resolve();
        if (phase === 'initializing') await go.promise;
      });
      return register(next, engine);
    });
    const release = b.ownership.release.bind(b.ownership);
    jest.spyOn(b.ownership, 'release').mockImplementationOnce(async next => {
      recorded.resolve();
      await releaseGo.promise;
      return release(next);
    });
    const starting = a.service.start(id, { explicit: true });
    let stopping: Promise<unknown> | undefined;
    try {
      if (phase === 'started') await starting;
      else await reached.promise;
      await a.db.getRepository(Session).update(id, { leaseExpiresAt: lease === 'expired' ? lapsed() : null });
      stopping = b.service.stop(id);
      await recorded.promise;
      await a.ownership.renew();
      releaseGo.resolve();
      await stopping;
      go.resolve();
      await starting;
      expect(a.service.getEngine(id)).toBeUndefined();
      expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBe('stopped');
    } finally {
      go.resolve();
      releaseGo.resolve();
      await Promise.allSettled([starting, stopping]);
    }
  });

  it('refuses an expired-owner stop when a heartbeat renews before the conditional release', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    await a.service.start(id, { explicit: true });
    await a.db.getRepository(Session).update(id, { leaseExpiresAt: lapsed() });
    const reached = deferred();
    const go = deferred();
    const sessions = b.db.getRepository(Session);
    const update = sessions.update.bind(sessions);
    jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
      if (patch.desiredState === 'stopped' && patch.nodeId === null) {
        reached.resolve();
        await go.promise;
      }
      return update(where, patch);
    });
    const stopping = b.service.stop(id).catch((error: unknown) => error);
    try {
      await reached.promise;
      await a.ownership.renew();
      go.resolve();
      expect(await stopping).toBeInstanceOf(ConflictException);
      expect(a.service.getEngine(id)).toBe(a.engines[0]);
      expect(await sessions.findOneByOrFail({ id })).toMatchObject({ nodeId: 'node-a', desiredState: null });
      expect((b.service as unknown as { stopRequests: Map<string, unknown> }).stopRequests.has(id)).toBe(false);
      expect((b.lifecycle as unknown as { stoppingSessions: Set<string> }).stoppingSessions.has(id)).toBe(false);
    } finally {
      go.resolve();
      await stopping;
    }
  });

  (pg ? it : it.skip).each(['stop', 'claim'])(
    'yields admission after an accepted peer %s commits while it waits for a row lock',
    async action => {
      const expires = new Date(Date.now() + 500);
      const id = await seed({
        status: SessionStatus.DISCONNECTED,
        desiredState: 'stopped',
        nodeId: 'node-a',
        leaseExpiresAt: expires,
      });
      const [{ pid }] = await a.db.query<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
      const lock = b.db.createQueryRunner();
      const sessions = b.db.getRepository(Session);
      const manager = sessions.manager;
      await lock.connect();
      await lock.startTransaction();
      await lock.manager.getRepository(Session).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      const preparing = a.ownership.prepareStart(id, 'stopped');
      try {
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const [activity] = await b.db.query<Array<{ wait_event_type: string | null }>>(
            'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',
            [pid],
          );
          if (activity?.wait_event_type === 'Lock') {
            waiting = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, expires.getTime() - Date.now()) + 25));
        // Run the real peer operation on the connection holding the row. Its commit changes the
        // tuple the waiting UPDATE must recheck, rather than merely releasing an unchanged lock.
        Object.assign(sessions, { manager: lock.manager });
        if (action === 'stop') await b.service.stop(id);
        else expect(await b.ownership.claim(id)).toBe(true);
        await lock.commitTransaction();

        expect(await preparing).toBe(false);
        expect(await a.db.getRepository(Session).findOneByOrFail({ id })).toMatchObject({
          nodeId: action === 'stop' ? null : 'node-b',
          desiredState: 'stopped',
        });
        expect((b.service as unknown as { stopRequests: Map<string, unknown> }).stopRequests.has(id)).toBe(false);
      } finally {
        Object.assign(sessions, { manager });
        if (lock.isTransactionActive) await lock.rollbackTransaction();
        await lock.release();
        await preparing;
      }
    },
  );

  it('settles abandoned work when an accepted stop clears an expired foreign claim', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED, nodeId: 'departed', leaseExpiresAt: lapsed() });
    const settled = jest.fn().mockResolvedValue(undefined);
    b.ownership.onAdoption(settled);

    await b.service.stop(id);
    await new Promise(resolve => setImmediate(resolve));

    expect(settled).toHaveBeenCalledWith(id);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(await b.db.getRepository(Session).findOneByOrFail({ id })).toMatchObject({
      desiredState: 'stopped',
      nodeId: null,
    });
  });

  it.each(['released', 'same owner'])('does not settle a %s claim as abandoned foreign work', async owner => {
    const id = await seed({
      status: SessionStatus.DISCONNECTED,
      nodeId: owner === 'released' ? null : 'node-b',
      leaseExpiresAt: lapsed(),
    });
    const settled = jest.fn().mockResolvedValue(undefined);
    b.ownership.onAdoption(settled);

    expect(await b.ownership.stopExpiredForeignClaim(id)).toBe(false);
    await new Promise(resolve => setImmediate(resolve));

    expect(settled).not.toHaveBeenCalled();
    expect((await b.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
  });

  const gone = { sessions: 0, messages: 0, outbox: 0, deliveryFailures: 0 };

  it.each([
    ['a stopped session nobody holds', { status: SessionStatus.DISCONNECTED, desiredState: 'stopped' as const }],
    [
      'a session whose holder let its lease lapse',
      { status: SessionStatus.READY, nodeId: 'node-c', leaseExpiresAt: lapsed() },
    ],
  ])('refuses a peer start of %s while the delete runs', async (_case, fields) => {
    const id = await seed(fields);
    await startHeldDelete(id);

    await expect(b.service.start(id, { explicit: true })).rejects.toBeInstanceOf(ConflictException);
    expect(b.engines).toHaveLength(0);

    finish!();
    await deletion;
    await peerReceivesAMessage();

    expect(await rowsOf(id)).toEqual(gone);
    expect(a.ownership.ownedIds()).toEqual([]);
    expect(b.ownership.ownedIds()).toEqual([]);
  });

  it('keeps its claim when a stop on the same node ends while the delete reads the session', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const sessions = a.db.getRepository(Session);
    const findOne = sessions.findOne.bind(sessions);
    const reading = deferred();
    const read = deferred();
    // The delete's first row read, which comes after its claim.
    jest.spyOn(sessions, 'findOne').mockImplementationOnce(async (...args: Parameters<typeof findOne>) => {
      reading.resolve();
      await read.promise;
      return findOne(...args);
    });
    const reached = deferred();
    const release = deferred();
    a.hooks.execute.mockImplementation(async (event: string, data: unknown) => {
      if (event === 'session:deleted') {
        reached.resolve();
        await release.promise;
      }
      return { continue: true, data };
    });
    finish = release.resolve;
    deletion = a.service.delete(id);
    await reading.promise;

    await a.service.stop(id);
    expect((await findOne({ where: { id } }))?.nodeId).toBe('node-a');
    read.resolve();
    await reached.promise;
    await expect(b.service.start(id, { explicit: true })).rejects.toBeInstanceOf(ConflictException);
    expect(b.engines).toHaveLength(0);

    release.resolve();
    await deletion;
    await peerReceivesAMessage();

    expect(await rowsOf(id)).toEqual(gone);
    expect(a.ownership.ownedIds()).toEqual([]);
    expect(b.ownership.ownedIds()).toEqual([]);
  });

  it('leaves a lapsed session to the deleting node when a peer looks for sessions to adopt', async () => {
    const id = await seed({ status: SessionStatus.READY, nodeId: 'node-c', leaseExpiresAt: lapsed() });
    await startHeldDelete(id);
    // Stands in for batches that outlast the lease TTL: the deleting node's heartbeat carries the claim on.
    await a.db.getRepository(Session).update(id, { leaseExpiresAt: lapsed() });
    await a.ownership.renew();

    const takeover = new SessionTakeoverService(
      b.service,
      b.ownership,
      new ConfigService({ features: { autoStartSessions: true } }),
    );
    await takeover.sweep();
    expect(b.engines).toHaveLength(0);

    finish!();
    await deletion;
    await peerReceivesAMessage();

    expect(await rowsOf(id)).toEqual(gone);
    expect(b.ownership.ownedIds()).toEqual([]);
  });

  // A process that dies while its delete runs never hands the claim back, and the claim lapses. The session it
  // was removing must stay down, wherever it is picked up next.
  it('leaves a session whose deleting node died part-way for no peer to adopt', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    await startHeldDelete(id);
    // Node A dies here: nothing resumes its delete or renews its claim.
    await a.db.getRepository(Session).update(id, { leaseExpiresAt: lapsed() });

    const takeover = new SessionTakeoverService(
      b.service,
      b.ownership,
      new ConfigService({ features: { autoStartSessions: true } }),
    );
    await takeover.sweep();

    expect(b.engines).toHaveLength(0);
    expect(await a.db.getRepository(Session).findOneByOrFail({ id })).toMatchObject({
      nodeId: 'node-a',
      desiredState: 'deleting',
    });
  });

  it('keeps a session a failed delete left down until an explicit start', async () => {
    const id = await seed({
      status: SessionStatus.DISCONNECTED,
      desiredState: 'deleting',
      nodeId: 'node-c',
      leaseExpiresAt: lapsed(),
    });
    const takeover = new SessionTakeoverService(
      b.service,
      b.ownership,
      new ConfigService({ features: { autoStartSessions: true } }),
    );

    await takeover.sweep();
    expect(b.engines).toHaveLength(0);
    // Refused on the record, before the teardown fence would refuse it for another reason.
    const fence = jest
      .spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown')
      .mockRejectedValue(new ConflictException('a logout teardown is running'));
    await expect(b.service.start(id)).rejects.toBeInstanceOf(SessionStoppedException);
    fence.mockRestore();
    expect(b.engines).toHaveLength(0);

    await b.service.start(id, { explicit: true });
    expect(b.service.getEngine(id)).toBe(b.engines[0]);
    expect((await b.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
  });

  it('keeps the record of a delete that lands while an explicit start reads the session again', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const sessions = a.db.getRepository(Session);
    const findOne = sessions.findOne.bind(sessions);
    const reading = deferred();
    const read = deferred();
    // The start's second row read, past its teardown fence, is held while the delete records itself.
    jest
      .spyOn(sessions, 'findOne')
      .mockImplementationOnce(findOne)
      .mockImplementationOnce(async (...args: Parameters<typeof findOne>) => {
        reading.resolve();
        await read.promise;
        return findOne(...args);
      });
    const starting = a.service.start(id, { explicit: true });
    await reading.promise;
    await startHeldDelete(id);
    read.resolve();

    await expect(starting).rejects.toBeInstanceOf(SessionStoppedException);

    expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('deleting');
    finish!();
    await deletion;
    expect(await rowsOf(id)).toEqual(gone);
  });

  // A delete records itself as a stop on the row, so the crash above leaves the session down; one that fails
  // before it removes anything takes that record back.
  it.each([
    ['its first teardown fence refuses', 'fence-1'],
    ['its second teardown fence refuses', 'fence-2'],
    ['its row read fails', 'read'],
  ])('leaves the session as it found it when %s', async (_case, failure) => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    await a.service.start(id, { explicit: true });
    const fence = jest.spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown');
    if (failure === 'fence-1') fence.mockRejectedValueOnce(new ConflictException('a logout teardown is running'));
    if (failure === 'fence-2') {
      fence.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ConflictException('a logout is running'));
    }
    if (failure === 'read') {
      jest.spyOn(a.db.getRepository(Session), 'findOne').mockRejectedValueOnce(new Error('connection reset'));
    }

    await expect(a.service.delete(id)).rejects.toThrow();

    const row = await a.db.getRepository(Session).findOneByOrFail({ id });
    expect(row.desiredState).toBeNull();
    // The second fence refuses after the engine is gone, and the claim goes with it.
    expect(row.nodeId).toBe(failure === 'fence-2' ? null : 'node-a');
    expect(await rowsOf(id)).toEqual({ sessions: 1, messages: 1, outbox: 0, deliveryFailures: 0 });
    expect(leftovers(id).stopCount).toBe(false);
  });

  it('leaves the session as it found it when a retried delete is refused at the first fence again', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    jest
      .spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown')
      .mockRejectedValueOnce(new ConflictException('a logout teardown is running'))
      .mockRejectedValueOnce(new ConflictException('a logout teardown is running'));

    await expect(a.service.delete(id)).rejects.toBeInstanceOf(ConflictException);
    await expect(a.service.delete(id)).rejects.toBeInstanceOf(ConflictException);

    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
  });

  it('refuses the delete and takes nothing down when it cannot record the stop', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    await a.service.start(id, { explicit: true });
    jest.spyOn(a.db.getRepository(Session), 'update').mockRejectedValueOnce(new Error('connection reset'));

    await expect(a.service.delete(id)).rejects.toThrow('connection reset');

    expect(a.service.getEngine(id)).toBe(a.engines[0]);
    expect(a.engines[0].forceDestroy).not.toHaveBeenCalled();
    expect(leftovers(id)).toEqual({ stopMark: false, stopCount: false });
    expect(await a.db.getRepository(Session).findOneByOrFail({ id })).toMatchObject({
      nodeId: 'node-a',
      desiredState: null,
    });
  });

  it('keeps the stop and answers the delete error when it cannot take the stop back', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    jest
      .spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown')
      .mockRejectedValueOnce(new ConflictException('a logout teardown is running'));
    const sessions = a.db.getRepository(Session);
    const update = sessions.update.bind(sessions);
    // The stop is recorded; taking it back fails.
    jest.spyOn(sessions, 'update').mockImplementationOnce(update).mockRejectedValueOnce(new Error('connection reset'));

    await expect(a.service.delete(id)).rejects.toBeInstanceOf(ConflictException);

    expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('deleting');
  });

  it('keeps a stop the session already had when its delete fails before removing anything', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED, desiredState: 'stopped' });
    jest
      .spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown')
      .mockRejectedValueOnce(new ConflictException('a logout teardown is running'));

    await expect(a.service.delete(id)).rejects.toBeInstanceOf(ConflictException);

    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBe('stopped');
  });

  it.each([['stop'], ['force-kill']])(
    'keeps a %s that began before its delete and is recorded after it, when the delete fails before removing',
    async how => {
      const id = await seed({ status: SessionStatus.DISCONNECTED });
      await a.service.start(id, { explicit: true });
      const sessions = a.db.getRepository(Session);
      const findOne = sessions.findOne.bind(sessions);
      const update = sessions.update.bind(sessions);
      const recording = deferred();
      const recorded = deferred();
      const reading = deferred();
      const read = deferred();
      // The stop's record is held until the delete has written its own; the delete's row read then fails.
      jest.spyOn(sessions, 'update').mockImplementationOnce(async (...args: Parameters<typeof update>) => {
        recording.resolve();
        await recorded.promise;
        return update(...args);
      });
      jest
        .spyOn(sessions, 'findOne')
        .mockImplementationOnce(findOne)
        .mockImplementationOnce(async () => {
          reading.resolve();
          await read.promise;
          throw new Error('connection reset');
        });
      const stopping = how === 'stop' ? a.service.stop(id) : a.service.forceKill(id);
      await recording.promise;
      const deleting = a.service.delete(id);
      await reading.promise;
      recorded.resolve();
      await stopping;
      read.resolve();

      await expect(deleting).rejects.toThrow('connection reset');

      expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('stopped');
    },
  );

  it('keeps a stop that lands while its delete runs when the delete then fails before removing anything', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const sessions = a.db.getRepository(Session);
    const reading = deferred();
    const read = deferred();
    // The delete's first row read, which comes after its claim, fails once the stop has finished.
    jest.spyOn(sessions, 'findOne').mockImplementationOnce(async () => {
      reading.resolve();
      await read.promise;
      throw new Error('connection reset');
    });
    const deleting = a.service.delete(id);
    await reading.promise;
    await a.service.stop(id);
    read.resolve();

    await expect(deleting).rejects.toThrow('connection reset');

    expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('stopped');
  });

  it('keeps a stop whose record has landed but not yet returned when its delete fails', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const sessions = a.db.getRepository(Session);
    const update = sessions.update.bind(sessions);
    const reading = deferred();
    const read = deferred();
    jest.spyOn(sessions, 'findOne').mockImplementationOnce(async () => {
      reading.resolve();
      await read.promise;
      throw new Error('connection reset');
    });
    const deleting = a.service.delete(id);
    await reading.promise;
    const landed = deferred();
    const answer = deferred();
    // The stop's record is on the row; its answer is held until the delete has failed.
    jest.spyOn(sessions, 'update').mockImplementationOnce(async (...args: Parameters<typeof update>) => {
      const result = await update(...args);
      landed.resolve();
      await answer.promise;
      return result;
    });
    const stopping = a.service.stop(id);
    await landed.promise;
    read.resolve();

    await expect(deleting).rejects.toThrow('connection reset');
    answer.resolve();
    await stopping;

    expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('stopped');
  });

  it('takes its stop back when another delete of it is refused at the first fence too', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    await a.service.start(id, { explicit: true });
    jest
      .spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown')
      .mockRejectedValueOnce(new ConflictException('a logout teardown is running'))
      .mockRejectedValueOnce(new ConflictException('a logout teardown is running'));

    const outcomes = await Promise.allSettled([a.service.delete(id), a.service.delete(id)]);

    expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(a.service.getEngine(id)).toBe(a.engines[0]);
    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
    expect(leftovers(id).stopCount).toBe(false);
  });

  // Each of these begins before the delete and ends, having recorded no stop, before the delete fails.
  it.each([
    ['a force-kill with no engine to kill', 'kill-refused', 'BadRequestException'],
    ['a force-kill that cannot record its stop', 'kill-write', 'ok'],
    ['a stop whose row read fails', 'stop-read', 'Error'],
    ['a stop that cannot record itself', 'stop-write', 'Error'],
  ])('takes its stop back when %s overlaps it', async (_case, other, answer) => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    if (other === 'kill-write') await a.service.start(id, { explicit: true });
    const sessions = a.db.getRepository(Session);
    const findOne = sessions.findOne.bind(sessions);
    const reached = deferred();
    const go = deferred();
    // The other request is held at its row read or at its stop record until the delete has begun.
    const hold = async (): Promise<void> => {
      reached.resolve();
      await go.promise;
    };
    if (other === 'kill-refused') {
      jest.spyOn(sessions, 'findOne').mockImplementationOnce(async (...args: Parameters<typeof findOne>) => {
        await hold();
        return findOne(...args);
      });
    } else if (other === 'stop-read') {
      jest.spyOn(sessions, 'findOne').mockImplementationOnce(async () => {
        await hold();
        throw new Error('connection reset');
      });
    } else {
      jest.spyOn(sessions, 'update').mockImplementationOnce(async () => {
        await hold();
        throw new Error('connection reset');
      });
    }
    // The delete waits at its first fence until the other request has answered, and is refused there.
    const fenced = deferred();
    const refuse = deferred();
    jest.spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
      fenced.resolve();
      await refuse.promise;
      throw new ConflictException('a logout teardown is running');
    });
    const request = other.startsWith('kill') ? a.service.forceKill(id) : a.service.stop(id);
    const answered = request.then(
      () => 'ok',
      (error: unknown) => (error as Error).constructor.name,
    );
    await reached.promise;
    const deleting = a.service.delete(id);
    await fenced.promise;
    go.resolve();
    expect(await answered).toBe(answer);
    refuse.resolve();

    await expect(deleting).rejects.toBeInstanceOf(ConflictException);

    expect((await sessions.findOneByOrFail({ id })).desiredState).toBeNull();
    expect(leftovers(id).stopCount).toBe(false);
  });

  it.each([
    ['records it', 'stopped'],
    ['fails to read the session', null],
  ])('leaves the session to a stop still reading it when its delete fails, which then %s', async (_case, after) => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const sessions = a.db.getRepository(Session);
    const findOne = sessions.findOne.bind(sessions);
    const reading = deferred();
    const read = deferred();
    jest.spyOn(sessions, 'findOne').mockImplementationOnce(async (...args: Parameters<typeof findOne>) => {
      reading.resolve();
      await read.promise;
      if (after === null) throw new Error('connection reset');
      return findOne(...args);
    });
    jest
      .spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown')
      .mockRejectedValueOnce(new ConflictException('a logout teardown is running'));
    const stopping = a.service.stop(id).catch((error: unknown) => error);
    await reading.promise;

    await expect(a.service.delete(id)).rejects.toBeInstanceOf(ConflictException);
    read.resolve();
    await stopping;

    expect((await sessions.findOneByOrFail({ id })).desiredState).toBe(after);
  });

  // Two deletes of one session share the stop the first of them recorded; the last one out decides.
  it('keeps the session down for a delete still running when another delete of it is refused', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const sessions = a.db.getRepository(Session);
    const findOne = sessions.findOne.bind(sessions);
    const reading = deferred();
    const read = deferred();
    // The first delete's row read, which comes after its stop record, is held.
    jest.spyOn(sessions, 'findOne').mockImplementationOnce(async (...args: Parameters<typeof findOne>) => {
      reading.resolve();
      await read.promise;
      return findOne(...args);
    });
    const reached = deferred();
    const release = deferred();
    a.hooks.execute.mockImplementation(async (event: string, data: unknown) => {
      if (event === 'session:deleted') {
        reached.resolve();
        await release.promise;
      }
      return { continue: true, data };
    });
    finish = release.resolve;
    deletion = a.service.delete(id);
    await reading.promise;
    jest
      .spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown')
      .mockRejectedValueOnce(new ConflictException('a logout teardown is running'));

    await expect(a.service.delete(id)).rejects.toBeInstanceOf(ConflictException);
    expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('deleting');

    read.resolve();
    await reached.promise;
    // The rows are being removed: a process that died here would leave the session down.
    expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('deleting');
    release.resolve();
    await deletion;

    expect(await rowsOf(id)).toEqual(gone);
  });

  /**
   * A failed delete's take-back is held while `next` runs: until `next` has written a stop record or 200 ms
   * have passed, then let go.
   */
  async function duringTakeBack(
    next: (id: string) => Promise<unknown>,
    { takeBackFails = false, refusals = 1 } = {},
  ): Promise<string> {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const sessions = a.db.getRepository(Session);
    const update = sessions.update.bind(sessions);
    const clearing = deferred();
    const cleared = deferred();
    let held = false;
    let stopsWritten = 0;
    // Only the first take-back is held, and fails with `takeBackFails`; any later one runs at once.
    jest.spyOn(sessions, 'update').mockImplementation(async (...args: Parameters<typeof update>) => {
      if (args[1].desiredState === null && !held) {
        held = true;
        clearing.resolve();
        await cleared.promise;
        if (takeBackFails) throw new Error('connection reset');
      }
      const result = await update(...args);
      if (args[1].desiredState) stopsWritten++;
      return result;
    });
    // The failed delete is refused at its first fence, and so are the next `refusals - 1` deletes.
    const fence = jest.spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown');
    for (let refused = 0; refused < refusals; refused++) {
      fence.mockRejectedValueOnce(new ConflictException('a logout teardown is running'));
    }
    const failing = a.service.delete(id).catch((error: unknown) => error);
    await clearing.promise;
    const written = stopsWritten;
    const running = next(id);
    for (let waited = 0; waited < 200 && stopsWritten === written; waited += 5) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    cleared.resolve();
    expect(await failing).toBeInstanceOf(ConflictException);
    await running;
    return id;
  }

  it('records its own stop when it begins while a failed delete takes its stop back', async () => {
    const reached = deferred();
    const release = deferred();
    a.hooks.execute.mockImplementation(async (event: string, data: unknown) => {
      if (event === 'session:deleted') {
        reached.resolve();
        await release.promise;
      }
      return { continue: true, data };
    });
    finish = release.resolve;
    const id = await duringTakeBack(async next => {
      deletion = a.service.delete(next);
      await reached.promise;
    });

    // The rows are being removed: a process that died here would leave the session down.
    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBe('deleting');
    release.resolve();
    await deletion;
    expect(await rowsOf(id)).toEqual(gone);
  });

  it('keeps a stop sent while a failed delete takes its stop back', async () => {
    const id = await duringTakeBack(next => a.service.stop(next));

    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBe('stopped');
    expect(leftovers(id).stopCount).toBe(false);
  });

  it('leaves the take-back to the failed delete when one begun during it ends before recording its own', async () => {
    const id = await duringTakeBack(async next => {
      jest.spyOn(a.ownership, 'claim').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
      await expect(a.service.delete(next)).rejects.toBeInstanceOf(ServiceUnavailableException);
      await a.service.stop(next);
    });

    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBe('stopped');
  });

  it('takes the stop back after a failed take-back when a delete begun during it fails too', async () => {
    const id = await duringTakeBack(next => expect(a.service.delete(next)).rejects.toBeInstanceOf(ConflictException), {
      takeBackFails: true,
      refusals: 2,
    });

    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
    expect(leftovers(id).stopCount).toBe(false);
  });

  // The peer's stop passes its own ownership check while nobody holds the session, before this node claims it.
  it('keeps a stop another node records while its delete fails before removing anything', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const peerSessions = b.db.getRepository(Session);
    const findOne = peerSessions.findOne.bind(peerSessions);
    const reading = deferred();
    const read = deferred();
    jest.spyOn(peerSessions, 'findOne').mockImplementationOnce(async (...args: Parameters<typeof findOne>) => {
      reading.resolve();
      await read.promise;
      return findOne(...args);
    });
    const stopping = b.service.stop(id);
    await reading.promise;
    // The delete records its stop and waits at its first fence until the peer's stop has answered.
    const fenced = deferred();
    const refuse = deferred();
    jest.spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
      fenced.resolve();
      await refuse.promise;
      throw new ConflictException('a logout teardown is running');
    });
    const deleting = a.service.delete(id);
    await fenced.promise;
    read.resolve();
    await stopping;
    refuse.resolve();

    await expect(deleting).rejects.toBeInstanceOf(ConflictException);

    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBe('stopped');
  });

  // The stop is sent while the start waits at its fence, so the start yields to it, and then fails to read the session.
  it('leaves the session as it found it when a start yields to a stop that then fails to read the session', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const fenced = deferred();
    const go = deferred();
    jest.spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
      fenced.resolve();
      await go.promise;
    });
    const starting = a.service.start(id, { explicit: true });
    await fenced.promise;
    const reading = deferred();
    const read = deferred();
    jest.spyOn(a.db.getRepository(Session), 'findOne').mockImplementationOnce(async () => {
      reading.resolve();
      await read.promise;
      throw new Error('connection reset');
    });
    const stopping = a.service.stop(id).catch((error: unknown) => error);
    await reading.promise;
    go.resolve();
    await expect(starting).rejects.toBeInstanceOf(SessionStoppedException);
    read.resolve();

    expect(await stopping).toBeInstanceOf(Error);
    expect(a.engines).toHaveLength(0);
    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
    expect(leftovers(id).stopCount).toBe(false);
  });

  // A start the operator sends with the delete; neither takes anything down, and nobody stopped the session.
  it('leaves the session as it found it when an explicit start and its delete are both refused at the fence', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const fenced = deferred();
    const go = deferred();
    const fence = jest.spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown');
    // The start is held at its fence until the delete has been refused at its own.
    fence.mockImplementationOnce(async () => {
      fenced.resolve();
      await go.promise;
      throw new ConflictException('a logout teardown is running');
    });
    fence.mockRejectedValueOnce(new ConflictException('a logout teardown is running'));
    const starting = a.service.start(id, { explicit: true });
    await fenced.promise;
    await expect(a.service.delete(id)).rejects.toBeInstanceOf(ConflictException);
    go.resolve();

    await expect(starting).rejects.toBeInstanceOf(ConflictException);

    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
    expect(leftovers(id).stopCount).toBe(false);
  });

  it('leaves the session as it found it when an explicit start yields to a delete that is then refused', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const claim = a.ownership.claim.bind(a.ownership);
    const claiming = deferred();
    const claimed = deferred();
    // The start's claim goes through; the delete's is held until the start has yielded to it.
    jest
      .spyOn(a.ownership, 'claim')
      .mockImplementationOnce(claim)
      .mockImplementationOnce(async (sessionId: string) => {
        claiming.resolve();
        await claimed.promise;
        return claim(sessionId);
      });
    jest
      .spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown')
      .mockRejectedValueOnce(new ConflictException('a logout teardown is running'));
    const starting = a.service.start(id, { explicit: true });
    const deleting = a.service.delete(id);
    await claiming.promise;
    await expect(starting).rejects.toBeInstanceOf(SessionStoppedException);
    claimed.resolve();

    await expect(deleting).rejects.toBeInstanceOf(ConflictException);

    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
  });

  // The start clears the stop the session had and launches; the delete sent meanwhile retires it, then is refused.
  it('leaves the stop cleared when a delete that is then refused retires the explicit start that cleared it', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED, desiredState: 'stopped' });
    const starting = deferred();
    const launch = deferred();
    a.hooks.execute.mockImplementation(async (event: string, data: unknown) => {
      if (event === 'session:starting') {
        starting.resolve();
        await launch.promise;
      }
      return { continue: true, data };
    });
    const started = a.service.start(id, { explicit: true });
    await starting.promise;
    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
    const fenced = deferred();
    const refuse = deferred();
    jest.spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
      fenced.resolve();
      await refuse.promise;
      throw new ConflictException('a logout teardown is running');
    });
    const deleting = a.service.delete(id);
    await fenced.promise;
    launch.resolve();
    await started;
    expect(a.service.getEngine(id)).toBeUndefined();
    refuse.resolve();

    await expect(deleting).rejects.toBeInstanceOf(ConflictException);

    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
    expect(leftovers(id).stopCount).toBe(false);
  });

  it('lets a start retry its launch when a delete refused at the first fence lands during the retry pause', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const failed = deferred();
    // The start's first row read fails as a dropped connection does, and the start pauses before its one retry.
    jest.spyOn(a.db.getRepository(Session), 'findOne').mockImplementationOnce(() => {
      failed.resolve();
      return Promise.reject(new Error('Connection terminated unexpectedly'));
    });
    const starting = a.service.start(id, { explicit: true });
    await failed.promise;
    jest
      .spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown')
      .mockRejectedValueOnce(new ConflictException('a logout teardown is running'));
    await expect(a.service.delete(id)).rejects.toBeInstanceOf(ConflictException);

    await starting;

    expect(a.service.getEngine(id)).toBe(a.engines[0]);
    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
  });

  /** A delete of a fresh session that waits at its first fence until `refuse` is called, then is refused there. */
  async function deleteHeldAtFirstFence(): Promise<{ id: string; refuse: () => void; deleting: Promise<unknown> }> {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const fenced = deferred();
    const go = deferred();
    jest.spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
      fenced.resolve();
      await go.promise;
      throw new ConflictException('a logout teardown is running');
    });
    const deleting = a.service.delete(id).catch((error: unknown) => error);
    await fenced.promise;
    return { id, refuse: go.resolve, deleting };
  }

  // The mirror of the case above it: the delete is sent first, and the start second.
  it('leaves the session as it found it when a delete and then an explicit start are both refused at the fence', async () => {
    const { id, refuse, deleting } = await deleteHeldAtFirstFence();
    const fenced = deferred();
    const go = deferred();
    jest.spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
      fenced.resolve();
      await go.promise;
      throw new ConflictException('a logout teardown is running');
    });
    const starting = a.service.start(id, { explicit: true });
    await fenced.promise;
    refuse();
    expect(await deleting).toBeInstanceOf(ConflictException);
    go.resolve();

    await expect(starting).rejects.toBeInstanceOf(ConflictException);

    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
    expect(leftovers(id).stopCount).toBe(false);
  });

  it('lets a start sent after a delete retry its launch when that delete is refused during the retry pause', async () => {
    const { id, refuse, deleting } = await deleteHeldAtFirstFence();
    const failed = deferred();
    jest.spyOn(a.db.getRepository(Session), 'findOne').mockImplementationOnce(() => {
      failed.resolve();
      return Promise.reject(new Error('Connection terminated unexpectedly'));
    });
    const starting = a.service.start(id, { explicit: true });
    await failed.promise;
    refuse();
    expect(await deleting).toBeInstanceOf(ConflictException);

    await starting;

    expect(a.service.getEngine(id)).toBe(a.engines[0]);
    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
  });

  it.each([
    ['before', 'stop-first'],
    ['after', 'refusal-first'],
  ])('keeps a stop sent while a start waits to retry %s a delete sent before both is refused', async (_case, order) => {
    const { id, refuse, deleting } = await deleteHeldAtFirstFence();
    const failed = deferred();
    jest.spyOn(a.db.getRepository(Session), 'findOne').mockImplementationOnce(() => {
      failed.resolve();
      return Promise.reject(new Error('Connection terminated unexpectedly'));
    });
    const starting = a.service.start(id, { explicit: true });
    await failed.promise;
    if (order === 'stop-first') await a.service.stop(id);
    refuse();
    expect(await deleting).toBeInstanceOf(ConflictException);
    if (order === 'refusal-first') await a.service.stop(id);

    await expect(starting).rejects.toBeInstanceOf(SessionStoppedException);

    expect(a.engines).toHaveLength(0);
    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBe('stopped');
    expect(leftovers(id).stopCount).toBe(false);
  });

  it('keeps a start from retrying its launch into a session its delete began removing', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    const failed = deferred();
    jest.spyOn(a.db.getRepository(Session), 'findOne').mockImplementationOnce(() => {
      failed.resolve();
      return Promise.reject(new Error('Connection terminated unexpectedly'));
    });
    const starting = a.service.start(id, { explicit: true });
    await failed.promise;
    // The batches run, then the closing transaction fails: the session stays, with fewer rows.
    jest.spyOn(a.db, 'transaction').mockRejectedValueOnce(new Error('transaction timed out'));
    await expect(a.service.delete(id)).rejects.toThrow('transaction timed out');

    await expect(starting).rejects.toBeInstanceOf(SessionStoppedException);

    expect(a.engines).toHaveLength(0);
    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).not.toBeNull();
  });

  // The session was stopped, so the delete's record changes nothing the start could read, and the failed delete
  // has dropped its stop mark by the time the start goes on.
  it('keeps a start from launching into a stopped session that a delete sent after it began removing', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED, desiredState: 'stopped' });
    const fenced = deferred();
    const go = deferred();
    jest.spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
      fenced.resolve();
      await go.promise;
    });
    const starting = a.service.start(id, { explicit: true });
    await fenced.promise;
    jest.spyOn(a.db, 'transaction').mockRejectedValueOnce(new Error('transaction timed out'));
    await expect(a.service.delete(id)).rejects.toThrow('transaction timed out');
    go.resolve();

    await expect(starting).rejects.toBeInstanceOf(SessionStoppedException);

    expect(a.engines).toHaveLength(0);
    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).not.toBeNull();
  });

  it('refuses the delete and removes nothing when the claim cannot be written', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    await a.service.start(id, { explicit: true });
    jest.spyOn(a.ownership, 'claim').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

    await expect(a.service.delete(id)).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(a.service.getEngine(id)).toBe(a.engines[0]);
    expect(a.engines[0].forceDestroy).not.toHaveBeenCalled();
    expect(await rowsOf(id)).toEqual({ sessions: 1, messages: 1, outbox: 0, deliveryFailures: 0 });
    expect(a.hooks.execute).not.toHaveBeenCalledWith('session:deleted', expect.anything(), expect.anything());
    expect(a.purge).not.toHaveBeenCalled();
    expect(leftovers(id)).toEqual({ stopMark: false, stopCount: false });
    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).desiredState).toBeNull();
  });

  it('answers 409 and removes nothing when a peer claims the session just before the delete does', async () => {
    const id = await seed({ status: SessionStatus.DISCONNECTED });
    // The peer's claim lands between the delete's ownership check and its own claim.
    jest.spyOn(a.ownership, 'isHeldByOtherNode').mockImplementationOnce(async () => {
      await b.ownership.claim(id);
      return false;
    });

    await expect(a.service.delete(id)).rejects.toBeInstanceOf(ConflictException);

    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).nodeId).toBe('node-b');
    expect(await rowsOf(id)).toEqual({ sessions: 1, messages: 1, outbox: 0, deliveryFailures: 0 });
    expect(a.ownership.ownedIds()).toEqual([]);
    expect(leftovers(id).stopCount).toBe(false);
  });

  // A claim left on a row the delete did not remove lapses once nothing renews it, and a peer then adopts
  // and starts the session the operator was deleting.
  it('hands the claim back when the delete fails after claiming', async () => {
    const id = await seed({ status: SessionStatus.READY, phone: '628111111111' });
    jest.spyOn(a.db, 'transaction').mockRejectedValueOnce(new Error('transaction timed out'));

    await expect(a.service.delete(id)).rejects.toThrow('transaction timed out');

    // The batches ran before the closing transaction failed, so the session stays down like a crashed delete.
    expect(await a.db.getRepository(Session).findOneByOrFail({ id })).toMatchObject({
      nodeId: null,
      desiredState: 'deleting',
    });
    expect(a.ownership.ownedIds()).toEqual([]);
  });

  it('answers 404 for an id with no session and leaves nothing behind', async () => {
    const id = randomUUID();

    await expect(a.service.delete(id)).rejects.toBeInstanceOf(NotFoundException);

    expect(leftovers(id)).toEqual({ stopMark: false, stopCount: false });
    expect(a.ownership.ownedIds()).toEqual([]);
  });
});
