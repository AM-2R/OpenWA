import { DataSource, type Repository } from 'typeorm';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { MessageMutationProjector } from './message-mutation-projector';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import type { LoggerService } from '../../common/services/logger.service';
import type { EditedMessage } from '../../engine/interfaces/whatsapp-engine.interface';

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
