import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { SessionService } from './session.service';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { PresenceStore } from './presence-store.service';
import { SessionOwnershipService } from './session-ownership.service';
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
      stopCount: (a.service as unknown as { stopRequests: Map<string, number> }).stopRequests.has(id),
    };
  }

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

    expect((await a.db.getRepository(Session).findOneByOrFail({ id })).nodeId).toBeNull();
    expect(a.ownership.ownedIds()).toEqual([]);
  });

  it('answers 404 for an id with no session and leaves nothing behind', async () => {
    const id = randomUUID();

    await expect(a.service.delete(id)).rejects.toBeInstanceOf(NotFoundException);

    expect(leftovers(id)).toEqual({ stopMark: false, stopCount: false });
    expect(a.ownership.ownedIds()).toEqual([]);
  });
});
