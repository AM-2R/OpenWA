import { DataSource, type Repository } from 'typeorm';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { MessageMutationProjector } from './message-mutation-projector';
import { MessageProjector } from './message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';
import { deferred } from './inbound-room';
import type { Session } from './entities/session.entity';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import type { HookManager } from '../../core/hooks';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { SessionLidResolver } from './session-lid-resolver.service';
import type { LoggerService } from '../../common/services/logger.service';
import type {
  EditedMessage,
  IncomingMessage,
  IWhatsAppEngine,
} from '../../engine/interfaces/whatsapp-engine.interface';

describe('persisted edited message marker', () => {
  let db: DataSource;
  let repository: Repository<Message>;
  let projector: MessageMutationProjector;
  let queue: KeyedMutationQueue;
  let emit: jest.Mock;

  beforeEach(async () => {
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Message], synchronize: true });
    await db.initialize();
    repository = db.getRepository(Message);
    queue = new KeyedMutationQueue();
    emit = jest.fn();
    projector = new MessageMutationProjector(
      repository,
      { emitMessageEdited: emit } as unknown as EventsGateway,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhookService,
      queue,
      { error: jest.fn(), warn: jest.fn() } as unknown as LoggerService,
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  const source = { kind: 'edit' as const, chatId: '15550001111@c.us', fromMe: false };
  const edit = { messageId: 'WA_EDIT', chatId: source.chatId, fromMe: false, body: 'new' } as EditedMessage;
  const metadata = { reactions: { alice: '👍' }, media: { mimetype: 'image/jpeg', archived: true } };

  async function seed(type = 'text'): Promise<void> {
    await repository.save({
      sessionId: 's1',
      waMessageId: edit.messageId,
      chatId: source.chatId,
      from: source.chatId,
      to: 'me',
      direction: MessageDirection.INCOMING,
      body: 'old',
      type,
      metadata,
    });
  }

  async function drain(): Promise<void> {
    while (queue.size) await new Promise(resolve => setImmediate(resolve));
  }

  it('persists the inbound marker before notifying consumers, without losing other metadata', async () => {
    await seed();
    emit.mockImplementation(() => {
      // Inspect the storage at notification time, rather than assuming the queue wrote it first.
      const row = db.query('SELECT metadata FROM messages');
      return row.then((rows: Array<{ metadata: string }>) => {
        const storedMetadata = JSON.parse(rows[0].metadata) as Record<string, unknown>;
        expect(storedMetadata.edited).toBe(true);
      });
    });
    projector.applyMessageEditQueued('s1', edit);
    await drain();
    const stored = await repository.findOneByOrFail({ waMessageId: edit.messageId });
    expect(stored.body).toBe('new');
    expect(stored.metadata).toEqual({ ...metadata, edited: true });
    expect(emit).toHaveBeenCalledTimes(1);
    await emit.mock.results[0].value;
  });

  it('persists outbound edits as well', async () => {
    await seed();
    await repository.update({ waMessageId: edit.messageId }, { direction: MessageDirection.OUTGOING });
    await projector.recordOutboundMessageEdit('s1', edit.messageId, 'REST edit', { ...source, fromMe: true });
    const stored = await repository.findOneByOrFail({ waMessageId: edit.messageId });
    expect(stored.body).toBe('REST edit');
    expect(stored.metadata).toEqual({ ...metadata, edited: true });
  });

  it('does not restore or mark a revoked message', async () => {
    await seed('revoked');
    await repository.update({ waMessageId: edit.messageId }, { body: '', metadata: {} });
    projector.applyMessageEditQueued('s1', edit);
    await drain();
    const stored = await repository.findOneByOrFail({ waMessageId: edit.messageId });
    expect(stored.body).toBe('');
    expect(stored.metadata).toEqual({});
  });

  it('does not mark another chat when an edit names the wrong chat', async () => {
    await seed();
    projector.applyMessageEditQueued('s1', { ...edit, chatId: '15550002222@c.us' });
    await drain();
    expect((await repository.findOneByOrFail({ waMessageId: edit.messageId })).metadata).toEqual(metadata);
    expect(emit).not.toHaveBeenCalled();
  });
});

// An edit can reach a message before its row is written: its insert is out, or an earlier message of the
// chat holds the commit turn. The edit then lands on the row once it exists, and leaves the same marker.
describe('edited marker for a message whose row is not written yet', () => {
  const CHAT = '15550001111@c.us';
  let db: DataSource;
  let repository: Repository<Message>;
  let projector: MessageProjector;
  let engine: IWhatsAppEngine;
  // The insert of a row waits for the promise held under its message id.
  let stalled: Map<string, Promise<void>>;

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve));
  };
  const incoming = (id: string, over: Partial<IncomingMessage> = {}): IncomingMessage => ({
    id,
    chatId: CHAT,
    from: CHAT,
    to: 'me@c.us',
    body: 'original',
    type: 'text',
    timestamp: 1_700_000_000,
    fromMe: false,
    isGroup: false,
    kind: 'individual',
    ...over,
  });
  const editOf = (messageId: string, body: string): EditedMessage =>
    ({ messageId, chatId: CHAT, fromMe: false, body }) as EditedMessage;
  const stored = (waMessageId: string): Promise<Message> => repository.findOneByOrFail({ waMessageId });

  beforeEach(async () => {
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Message], synchronize: true });
    await db.initialize();
    repository = db.getRepository(Message);
    stalled = new Map();
    const insert = repository.insert.bind(repository);
    jest.spyOn(repository, 'insert').mockImplementation(async row => {
      await stalled.get((row as { waMessageId: string }).waMessageId);
      return insert(row);
    });
    const engines = new EngineRegistry();
    engine = { tag: 'one' } as unknown as IWhatsAppEngine;
    engines.set('s1', engine);
    projector = new MessageProjector(
      repository,
      { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>,
      engines,
      new Proxy({}, { get: () => jest.fn() }) as unknown as EventsGateway,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhookService,
      {
        execute: jest.fn((_event: string, data: unknown) => Promise.resolve({ continue: true, data })),
      } as unknown as HookManager,
      { ingest: jest.fn() } as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('marks a message edited while its insert is out, beside the metadata it was stored with', async () => {
    const insert = deferred<void>();
    stalled.set('A', insert.promise);
    projector.handleInboundMessage('s1', engine, incoming('A', { quotedMessage: { id: 'Q', body: 'quoted' } }));
    await flush();
    expect(await repository.count()).toBe(0);

    projector.applyMessageEditQueued('s1', editOf('A', 'edited'));
    projector.applyReactionQueued('s1', { messageId: 'A', chatId: CHAT, senderId: CHAT, reaction: '👍' });
    await flush();
    insert.resolve();
    await flush();

    const row = await stored('A');
    expect(row.body).toBe('edited');
    expect(row.metadata).toEqual({
      quotedMessage: { id: 'Q', body: 'quoted' },
      reactions: { [CHAT]: '👍' },
      edited: true,
    });
  });

  it('marks a message edited while it waits behind an earlier message of its chat', async () => {
    const insert = deferred<void>();
    stalled.set('A', insert.promise);
    projector.handleInboundMessage('s1', engine, incoming('A'));
    projector.handleInboundMessage('s1', engine, incoming('B'));
    await flush();

    projector.applyMessageEditQueued('s1', editOf('B', 'edited'));
    await flush();
    insert.resolve();
    await flush();

    expect(await stored('B')).toEqual(expect.objectContaining({ body: 'edited', metadata: { edited: true } }));
    expect((await stored('A')).metadata).toBeNull();
  });

  it('marks a send echoed behind an earlier message when a REST edit reaches it first', async () => {
    const insert = deferred<void>();
    stalled.set('A', insert.promise);
    projector.handleInboundMessage('s1', engine, incoming('A'));
    projector.handleOwnSendEcho('s1', engine, incoming('S', { fromMe: true, body: 'sent' }));
    await flush();

    await projector.recordOutboundMessageEdit('s1', 'S', 'rest edit', { kind: 'edit', chatId: CHAT, fromMe: true });
    insert.resolve();
    await flush();

    expect(await stored('S')).toEqual(
      expect.objectContaining({ body: 'rest edit', direction: MessageDirection.OUTGOING, metadata: { edited: true } }),
    );
  });

  it('leaves a message nobody edited unmarked', async () => {
    const insert = deferred<void>();
    stalled.set('A', insert.promise);
    projector.handleInboundMessage('s1', engine, incoming('A'));
    await flush();
    insert.resolve();
    await flush();

    expect((await stored('A')).metadata).toBeNull();
  });

  it('does not mark a message deleted after the edit while it was not written yet', async () => {
    const insert = deferred<void>();
    stalled.set('A', insert.promise);
    projector.handleInboundMessage('s1', engine, incoming('A'));
    await flush();

    projector.applyMessageEditQueued('s1', editOf('A', 'edited'));
    await projector.recordRevoke('s1', 'A');
    insert.resolve();
    await flush();

    expect(await stored('A')).toEqual(expect.objectContaining({ body: '', type: 'revoked', metadata: null }));
  });
});
