import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Session } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { BatchStatus, MessageBatch } from '../message/entities/message-batch.entity';
import { SendIdempotencyKey } from '../message/entities/send-idempotency-key.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine, MessageResult } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { SESSION_DELETE_BATCH_SIZE, SessionEngineControls, StopMarks } from './session-engine-controls';
import { SessionLifecycleFences } from './session-lifecycle-fences';
import { SessionEngineLeafEvents } from './session-engine-leaf-events';
import { MessageSendService } from '../message/message-send.service';
import { SessionService } from './session.service';
import { TemplateService } from '../template/template.service';
import { SendPacingService } from '../message/send-pacing.service';
import { StatusStoreService } from '../status-store/status-store.service';
import { StorageService } from '../../common/storage/storage.service';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

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

describe('Session content lifetime', () => {
  let db: DataSource;
  let controls: SessionEngineControls;
  let engines: EngineRegistry;
  let hooks: HookManager;
  const config = new ConfigService({});
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  beforeEach(async () => {
    db = new DataSource(
      process.env.DATABASE_TYPE === 'postgres'
        ? {
            type: 'postgres',
            host: process.env.DATABASE_HOST || 'localhost',
            port: Number(process.env.DATABASE_PORT || 5432),
            username: process.env.DATABASE_USERNAME || 'openwa',
            password: process.env.DATABASE_PASSWORD || 'openwa',
            database: process.env.DATABASE_NAME || 'openwa',
            schema: `session_content_${randomUUID().replace(/-/g, '')}`,
            entities,
            synchronize: false,
          }
        : { type: 'better-sqlite3', database: ':memory:', entities, synchronize: true },
    );
    await db.initialize();
    if (db.options.type === 'postgres') {
      await db.query(`CREATE SCHEMA "${db.options.schema}"`);
      await db.synchronize();
    }
    engines = new EngineRegistry();
    hooks = new HookManager();
    const state = { attachTo: <T>(value: T) => value, clear: jest.fn() };
    const fences = new SessionLifecycleFences({
      engines,
      pendingTeardowns: new Map(),
      pendingInitialStatuses: new Map(),
      logger: logger as unknown as ConstructorParameters<typeof SessionLifecycleFences>[0]['logger'],
    });
    controls = new SessionEngineControls({
      sessionRepository: db.getRepository(Session),
      engineFactory: { purgeSessionData: () => Promise.resolve() },
      engines,
      sessionErrors: state,
      sessionRestrictions: state,
      presence: state,
      hookManager: hooks,
      configService: config,
      logger,
      dataSource: () => db,
      fences,
      broadcaster: state,
      cancelReconnect() {},
      isClosed: () => false,
      ownsSession: () => true,
      stoppingSessions: new StopMarks(),
      operatorTeardowns: new Map(),
      reconnectStates: new Map(),
      stuckAuthRecoveryUsed: new Set(),
      initializingSessions: new Set(),
    } as unknown as ConstructorParameters<typeof SessionEngineControls>[0]);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (db.isInitialized) {
      if (db.options.type === 'postgres') await db.query(`DROP SCHEMA "${db.options.schema}" CASCADE`);
      await db.destroy();
    }
  });

  async function createSession() {
    return db.getRepository(Session).save({ name: 'test-session', config: {} });
  }

  function sender(engine: object, sessionId: string) {
    engines.set(sessionId, engine as IWhatsAppEngine);
    return new MessageSendService(
      db.getRepository(Message),
      {
        findOne: (id: string) => db.getRepository(Session).findOneByOrFail({ id }),
      } as unknown as SessionService,
      engines,
      hooks,
      {} as TemplateService,
      new SendPacingService(db.getRepository(Message), db.getRepository(Session), new ConfigService({})),
      new ConfigService({ features: { simulateTyping: false } }),
    );
  }

  it.each(['accepted', 'refused'])('keeps deleted messages absent when an %s engine call settles', async outcome => {
    const session = await createSession();
    const started = deferred();
    const result = deferred<MessageResult>();
    const service = sender(
      {
        sendChatState: () => Promise.resolve(),
        forceDestroy: () => Promise.resolve(),
        sendTextMessage: () => {
          started.resolve();
          return result.promise;
        },
      },
      session.id,
    );
    const oldTyping = process.env.SIMULATE_TYPING;
    process.env.SIMULATE_TYPING = 'false';
    try {
      const send = service.sendText(session.id, { chatId: '10000000001@c.us', text: 'test body' });
      const settled = send.then(
        () => undefined,
        () => undefined,
      );
      await started.promise;
      await controls.delete(session.id);
      expect(await db.getRepository(Message).count()).toBe(0);
      if (outcome === 'accepted') result.resolve({ id: 'sent-id', timestamp: 1700000000 });
      else result.reject(new EngineNotReadyError());
      await settled;
      expect(await db.getRepository(Message).count()).toBe(0);
    } finally {
      if (oldTyping === undefined) delete process.env.SIMULATE_TYPING;
      else process.env.SIMULATE_TYPING = oldTyping;
    }
  });

  it('drains an admitted initial database write before removing its parent', async () => {
    const session = await createSession();
    const service = sender({ forceDestroy: () => Promise.resolve() }, session.id);
    const repo = db.getRepository(Message);
    const save = repo.save.bind(repo);
    const started = deferred();
    const resume = deferred();
    jest.spyOn(repo, 'save').mockImplementationOnce(async value => {
      started.resolve();
      await resume.promise;
      return save(value);
    });
    const write = service.saveOutgoingMessage(session.id, { chatId: '10000000001@c.us', type: 'text', body: 'test' });
    const settled = write.then(
      () => undefined,
      () => undefined,
    );
    await started.promise;
    const deletion = controls.delete(session.id);
    await new Promise<void>(setImmediate);
    resume.resolve();
    await Promise.all([deletion, settled]);
    expect(await db.getRepository(Session).count()).toBe(0);
    expect(await repo.count()).toBe(0);
  });

  it.each(['success', 'failure'])('does not recreate a status after a late media %s', async outcome => {
    const session = await createSession();
    const started = deferred();
    const media = deferred();
    const store = new StatusStoreService(
      db.getRepository(StatusUpdate),
      {
        putFile: () => {
          started.resolve();
          return media.promise;
        },
      } as unknown as StorageService,
      config,
    );
    const ingest = store.ingest(session.id, {
      waStatusId: 'story',
      contactJid: '10000000001@c.us',
      type: 'image',
      caption: 'test story',
      postedAt: Date.now(),
      media: { data: Buffer.from('test').toString('base64'), mimetype: 'image/png' },
    });
    await started.promise;
    await controls.delete(session.id);
    if (outcome === 'success') media.resolve();
    else media.reject(new Error('storage unavailable'));
    await ingest;
    expect(await db.getRepository(StatusUpdate).count()).toBe(0);
    expect(await store.list(session.id)).toEqual([]);
  });

  it.each([false, true])('drops a seed after a deleted parent, including same-id replacement=%s', async recreate => {
    const session = await createSession();
    const id = session.id;
    const started = deferred();
    const poster = deferred<null>();
    const engine = {
      forceDestroy: () => Promise.resolve(),
      getChatHistory: () =>
        Promise.resolve([
          {
            id: 'story',
            isStatusBroadcast: true,
            author: '10000000001@c.us',
            from: 'status@broadcast',
            fromMe: false,
            type: 'text',
            body: 'test story',
            timestamp: Math.floor(Date.now() / 1000),
          },
        ]),
      getContactById: () => {
        started.resolve();
        return poster.promise;
      },
    };
    engines.set(id, engine as unknown as IWhatsAppEngine);
    const store = new StatusStoreService(db.getRepository(StatusUpdate), {} as StorageService, config);
    const leaf = new SessionEngineLeafEvents({
      sessionRepository: db.getRepository(Session),
      statusStore: store,
      configService: config,
      logger,
    } as unknown as ConstructorParameters<typeof SessionEngineLeafEvents>[0]);
    const seed = leaf.seedStatuses(id, engine as unknown as IWhatsAppEngine);
    await started.promise;
    await controls.delete(id);
    if (recreate) await db.getRepository(Session).save({ id, name: 'replacement', config: {} });
    poster.reject(new Error('engine closed'));
    await seed;
    expect(await db.getRepository(StatusUpdate).count()).toBe(0);
  });
  it('refuses a pre-send continuation after the session id was replaced', async () => {
    const session = await createSession();
    const id = session.id;
    const started = deferred();
    const resume = deferred();
    hooks.register('test-plugin', 'message:sending', async context => {
      started.resolve();
      await resume.promise;
      return { continue: true, data: context.data };
    });
    const service = sender({ forceDestroy: () => Promise.resolve() }, id);
    const send = service.sendText(id, { chatId: '10000000001@c.us', text: 'test body' });
    const settled = send.then(
      () => 'sent',
      () => 'refused',
    );
    await started.promise;
    await controls.delete(id);
    await db.getRepository(Session).save({ id, name: 'replacement', config: {} });
    const replacementSend = jest.fn().mockResolvedValue({ id: 'new-message', timestamp: 1700000000 });
    engines.set(id, {
      sendTextMessage: replacementSend,
      sendChatState: () => Promise.resolve(),
    } as unknown as IWhatsAppEngine);
    resume.resolve();
    expect(await settled).toBe('refused');
    expect(replacementSend).not.toHaveBeenCalled();
    expect(await db.getRepository(Message).count()).toBe(0);
  });

  it('removes the messages, outbox events and delivery failures of a session in batches and leaves other sessions alone', async () => {
    const doomed = await createSession();
    const kept = await db.getRepository(Session).save({ name: 'kept-session', config: {} });
    const messages = db.getRepository(Message);
    const outbox = db.getRepository(WebhookOutboxEvent);
    const failures = db.getRepository(WebhookDeliveryFailure);
    const count = SESSION_DELETE_BATCH_SIZE * 2 + 50;
    const seed = async (sessionId: string, rows: number): Promise<void> => {
      for (let from = 0; from < rows; from += 200) {
        const size = Math.min(200, rows - from);
        const range = Array.from({ length: size }, (_, i) => from + i);
        await messages.insert(
          range.map(i => ({
            sessionId,
            chatId: '10000000001@c.us',
            from: 'me',
            to: '10000000001@c.us',
            body: `m${i}`,
          })),
        );
        await outbox.insert(
          range.map(i => ({
            webhookId: 'hook-1',
            sessionId,
            event: 'message.received',
            idempotencyKey: `${sessionId}-${i}`,
            deliveryId: `dlv-${sessionId}-${i}`,
            payload: null,
            state: 'dispatched' as const,
          })),
        );
        await failures.insert(
          range.map(i => ({
            sessionId,
            webhookId: 'hook-1',
            event: 'message.received',
            url: 'https://receiver.example',
            idempotencyKey: `${sessionId}-${i}`,
            attempts: 3,
            lastError: 'HTTP 503',
            payload: {},
          })),
        );
      }
    };
    await seed(doomed.id, count);
    await seed(kept.id, 3);
    const deleteMessages = jest.spyOn(messages, 'delete');
    const deleteOutbox = jest.spyOn(outbox, 'delete');
    const deleteFailures = jest.spyOn(failures, 'delete');

    await controls.delete(doomed.id);

    expect(await messages.countBy({ sessionId: doomed.id })).toBe(0);
    expect(await outbox.countBy({ sessionId: doomed.id })).toBe(0);
    expect(await failures.countBy({ sessionId: doomed.id })).toBe(0);
    expect(await messages.countBy({ sessionId: kept.id })).toBe(3);
    expect(await outbox.countBy({ sessionId: kept.id })).toBe(3);
    expect(await failures.countBy({ sessionId: kept.id })).toBe(3);
    expect(await db.getRepository(Session).findOneBy({ id: doomed.id })).toBeNull();
    // Three statements per table instead of one that holds the table for every row at once.
    expect(deleteMessages.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(deleteOutbox.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(deleteFailures.mock.calls.length).toBeGreaterThanOrEqual(3);
  }, 60000);

  // The write scopes a delete closes stay retired when it fails: a batch running for the session stops at
  // its next item without recording anything. The session is still there, so its row would stay PROCESSING.
  describe('a delete that fails after closing the session writes', () => {
    const seedBatch = (sessionId: string, status: BatchStatus, batchId: string) =>
      db.getRepository(MessageBatch).save({
        batchId,
        sessionId,
        status,
        messages: [
          {
            chatId: '10000000001@c.us',
            type: 'image',
            content: { image: { base64: 'MEDIA-PAYLOAD', mimetype: 'image/png', caption: 'hi' } },
          },
        ],
        options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
        progress: { total: 1, sent: 0, failed: 0, pending: 1, cancelled: 0 },
        results: [],
      });

    const statuses = async (): Promise<Array<[string, string]>> =>
      (await db.getRepository(MessageBatch).find({ order: { batchId: 'ASC' } })).map(row => [row.batchId, row.status]);

    it('fails the unfinished batches of the surviving session and strips their media', async () => {
      const session = await createSession();
      const other = await db.getRepository(Session).save({ name: 'other-session', config: {} });
      await seedBatch(session.id, BatchStatus.PENDING, 'b-pending');
      await seedBatch(session.id, BatchStatus.PROCESSING, 'b-processing');
      await seedBatch(session.id, BatchStatus.COMPLETED, 'b-done');
      await seedBatch(other.id, BatchStatus.PROCESSING, 'b-other');
      jest.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));

      await expect(controls.delete(session.id)).rejects.toThrow('statement timeout');

      expect(await statuses()).toEqual([
        ['b-done', BatchStatus.COMPLETED],
        ['b-other', BatchStatus.PROCESSING],
        ['b-pending', BatchStatus.FAILED],
        ['b-processing', BatchStatus.FAILED],
      ]);
      const failed = await db.getRepository(MessageBatch).find({ where: { status: BatchStatus.FAILED } });
      for (const row of failed) {
        expect(row.completedAt).toBeInstanceOf(Date);
        expect(JSON.stringify(row.messages)).not.toContain('MEDIA-PAYLOAD');
        expect(JSON.stringify(row.messages)).toContain('hi');
      }
      expect(await db.getRepository(Session).countBy({ id: session.id })).toBe(1);
    });

    it('leaves the batches alone when the delete is refused before it closes anything', async () => {
      const session = await createSession();
      await seedBatch(session.id, BatchStatus.PROCESSING, 'b-processing');
      jest
        .spyOn(SessionLifecycleFences.prototype, 'awaitPendingTeardown')
        .mockRejectedValueOnce(new ConflictException('a logout teardown is still running'));

      await expect(controls.delete(session.id)).rejects.toThrow(ConflictException);

      expect(await statuses()).toEqual([['b-processing', BatchStatus.PROCESSING]]);
    });

    it('still reports the delete error when the batches cannot be failed either', async () => {
      const session = await createSession();
      await seedBatch(session.id, BatchStatus.PROCESSING, 'b-processing');
      jest.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
      jest.spyOn(db.getRepository(MessageBatch), 'find').mockRejectedValue(new Error('connection lost'));

      await expect(controls.delete(session.id)).rejects.toThrow('statement timeout');

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('after a failed delete'),
        expect.objectContaining({ action: 'session_delete_batch_fail_failed' }),
      );
    });

    it('does not touch the batches of a delete that committed', async () => {
      const session = await createSession();
      await seedBatch(session.id, BatchStatus.PROCESSING, 'b-processing');

      await controls.delete(session.id);

      expect(await statuses()).toEqual([]);
    });
  });
});
