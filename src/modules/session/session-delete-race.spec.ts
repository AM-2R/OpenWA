import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SessionService } from './session.service';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionStoppedException } from './session-engine-controls';
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
import { SessionLidResolver } from './session-lid-resolver.service';
import { SessionLivenessWatchdog } from './session-liveness-watchdog.service';
import { MessageProjector } from './message-projector.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { StatusStoreService } from '../status-store/status-store.service';

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

/**
 * The real SessionService, lifecycle and ownership service on a real SQLite database; the engine, the
 * gateway and the webhook sender are fakes. The delete is held where a session with a long history spends
 * its time, in the batches that remove its messages, after its engine is gone.
 */
describe('A session being deleted', () => {
  let db: DataSource;
  let module: TestingModule;
  let service: SessionService;
  let ownership: SessionOwnershipService;
  let engineFactory: { create: jest.Mock; purgeSessionData: jest.Mock };
  let sessionId: string;
  let reachedBatch: ReturnType<typeof deferred>;
  let finishBatch: ReturnType<typeof deferred>;
  let deletion: Promise<void>;

  beforeEach(async () => {
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities, synchronize: true });
    await db.initialize();
    engineFactory = {
      create: jest.fn().mockImplementation(makeEngine),
      purgeSessionData: jest.fn().mockResolvedValue(undefined),
    };
    const values: Record<string, unknown> = {
      'session.nodeId': 'node-a',
      'session.leaseTtlMs': 60_000,
      'session.leaseHeartbeatMs': 20_000,
    };
    module = await Test.createTestingModule({
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
        { provide: EngineFactory, useValue: engineFactory },
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
          },
        },
        { provide: WebhookService, useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
        { provide: HookManager, useValue: { execute: jest.fn().mockResolvedValue({ continue: true, data: {} }) } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(<T>(key: string, def?: T): T => (key in values ? (values[key] as T) : (def as T))) },
        },
        { provide: LidMappingStoreService, useValue: { remember: jest.fn() } },
        { provide: StatusStoreService, useValue: { ingest: jest.fn(), captureWrites: jest.fn() } },
      ],
    }).compile();
    service = module.get(SessionService);
    ownership = module.get(SessionOwnershipService);

    const row = await db.getRepository(Session).save({
      name: 'big-session',
      config: {},
      phone: '628111111111',
      status: SessionStatus.READY,
    });
    sessionId = row.id;
    await service.start(sessionId, { explicit: true });
    expect(service.getEngine(sessionId)).toBeDefined();

    // One stored message is enough: the delete removes it in a batch, and that batch is the one held.
    const messages = db.getRepository(Message);
    await messages.insert({ sessionId, chatId: '10000000001@c.us', from: 'me', to: '10000000001@c.us', body: 'm' });
    const removeBatch = messages.delete.bind(messages);
    reachedBatch = deferred();
    finishBatch = deferred();
    jest.spyOn(messages, 'delete').mockImplementation(async criteria => {
      reachedBatch.resolve();
      await finishBatch.promise;
      return removeBatch(criteria);
    });

    deletion = service.delete(sessionId);
    await reachedBatch.promise;
  });

  afterEach(async () => {
    finishBatch.resolve();
    await deletion.catch(() => undefined);
    jest.restoreAllMocks();
    await service.onModuleDestroy();
    await db.destroy();
  });

  it('refuses a start and leaves no engine running once the rows are gone', async () => {
    // The engine is gone and the row is still there: the window a start used to slip through.
    expect(service.getEngine(sessionId)).toBeUndefined();
    expect(await db.getRepository(Session).countBy({ id: sessionId })).toBe(1);

    await expect(service.start(sessionId, { explicit: true })).rejects.toBeInstanceOf(SessionStoppedException);
    expect(service.getEngine(sessionId)).toBeUndefined();
    expect(engineFactory.create).toHaveBeenCalledTimes(1);

    finishBatch.resolve();
    await deletion;

    expect(await db.getRepository(Session).countBy({ id: sessionId })).toBe(0);
    expect(service.getEngine(sessionId)).toBeUndefined();
    expect(service.getActiveSessionIds()).toEqual([]);
    expect(ownership.ownedIds()).toEqual([]);
    // The stop of a session that no longer exists answers 404, which it could not if an engine lingered.
    await expect(service.stop(sessionId)).rejects.toThrow('not found');
  });
});
