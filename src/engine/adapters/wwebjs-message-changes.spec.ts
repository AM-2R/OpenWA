import { EventEmitter } from 'events';
import { WAState, type Client } from 'whatsapp-web.js';
import type { Repository } from 'typeorm';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import type { WwebjsLifecycle } from './wwebjs-lifecycle';
import type { WwebjsEngineHost } from './wwebjs-host';
import { registerWwebjsMessageEvents } from './wwebjs-message-events';
import { EngineRegistry } from '../engine-registry.service';
import { MessageProjector } from '../../modules/session/message-projector.service';
import { deferred } from '../../modules/session/inbound-room';
import { createLogger } from '../../common/services/logger.service';
import type { Message } from '../../modules/message/entities/message.entity';
import type { Session } from '../../modules/session/entities/session.entity';
import type { EventsGateway } from '../../modules/events/events.gateway';
import type { WebhookService } from '../../modules/webhook/webhook.service';
import type { HookManager } from '../../core/hooks';
import type { StatusStoreService } from '../../modules/status-store/status-store.service';
import type { SessionLidResolver } from '../../modules/session/session-lid-resolver.service';
import type {
  EditedMessage,
  EngineEventCallbacks,
  InboundTicket,
  IncomingMessage,
  IWhatsAppEngine,
  ReactionEvent,
  RevokedMessage,
} from '../interfaces/whatsapp-engine.interface';

/**
 * A message is handed to the session only once its contact, media and quoted message were fetched. A
 * change that reaches it meanwhile (an edit, a delete for everyone or a reaction) is kept for the row by a
 * session that holds each arrival (PostgreSQL), and was lost on the SQLite wiring, which learns of the
 * message only when it is handed over: the message was then stored and announced as it was before.
 */

type Row = Record<string, unknown>;

const CHAT = '628111@c.us';
const SELF = '628123@c.us';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
};

// TypeORM's FindOperator, read without importing its internals, as the projector specs do.
const matches = (row: Row, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([key, want]) => {
    if (key === 'metadata') return true;
    const op = want as { _type?: string; _value?: unknown } | null;
    if (op && typeof op === 'object' && op._type === 'not') return row[key] !== op._value;
    return row[key] === want;
  });

/** A message as whatsapp-web.js hands it to the `message` and `message_create` events. */
const incoming = (
  id: string,
  body: string,
  opts: { page?: jest.Mock; contact?: Promise<null>; fromMe?: boolean } = {},
) => ({
  id: { _serialized: id },
  from: opts.fromMe ? SELF : CHAT,
  to: opts.fromMe ? CHAT : SELF,
  body,
  type: opts.page ? 'image' : 'chat',
  timestamp: 1_700_000_000,
  fromMe: Boolean(opts.fromMe),
  hasMedia: Boolean(opts.page),
  _data: { mimetype: 'image/png', size: 3 },
  client: { pupPage: { evaluate: opts.page } },
  getContact: jest.fn(() => opts.contact ?? Promise.resolve(null)),
  hasQuotedMsg: false,
});

const editEvent = (client: EventEmitter, id: string, body: string, opts: { media?: boolean; fromMe?: boolean } = {}) =>
  client.emit(
    'message_edit',
    {
      id: { _serialized: id },
      from: opts.fromMe ? SELF : CHAT,
      to: opts.fromMe ? CHAT : SELF,
      type: opts.media ? 'image' : 'chat',
      fromMe: Boolean(opts.fromMe),
      hasMedia: Boolean(opts.media),
    },
    body,
  );

const revokeEvent = (client: EventEmitter, id: string, opts: { fromMe?: boolean } = {}) =>
  client.emit(
    'message_revoke_everyone',
    {
      id: { _serialized: `revoke-of-${id}` },
      from: opts.fromMe ? SELF : CHAT,
      to: opts.fromMe ? CHAT : SELF,
      fromMe: Boolean(opts.fromMe),
      timestamp: 2,
    },
    { id: { _serialized: id } },
  );

const reactionEvent = (client: EventEmitter, id: string, reaction: string) =>
  client.emit('message_reaction', { msgId: { _serialized: id }, id: { remote: CHAT }, reaction, senderId: CHAT });

describe.each([
  ['PostgreSQL', 'postgres'],
  ['SQLite', 'better-sqlite3'],
])('a change that reaches a message whatsapp-web.js still processes, on %s', (_name, type) => {
  const env = { ...process.env };
  let rows: Row[];
  let dispatch: jest.Mock;
  let client: EventEmitter;
  // The bodies the message:received and message:sent hooks were given, and a gate that holds the first of them.
  let hooked: string[];
  let hookGate: Promise<void> | undefined;

  beforeEach(() => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    rows = [];
    hooked = [];
    hookGate = undefined;
    // The real projector over a stand-in `messages` table, wired as the database wires it: only PostgreSQL
    // admits a message on arrival.
    const repo = {
      manager: { connection: { options: { type } } },
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(({ where }: { where: Row }) => Promise.resolve(rows.find(r => matches(r, where)) ?? null)),
      create: jest.fn((x: Row) => ({ ...x })),
      insert: jest.fn((row: Row) => {
        // As the real table's unique index refuses a second row under an id.
        if (rows.some(r => r.waMessageId === row.waMessageId)) {
          return Promise.reject(
            Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }),
          );
        }
        rows.push({ ...row });
        return Promise.resolve({ identifiers: [{ id: `pk-${String(row.waMessageId)}` }], generatedMaps: [] });
      }),
      update: jest.fn((where: Row, patch: Row) => {
        const hit = rows.filter(r => matches(r, where));
        for (const r of hit) Object.assign(r, patch);
        return Promise.resolve({ affected: hit.length });
      }),
    };
    dispatch = jest.fn().mockResolvedValue(undefined);
    const engines = new EngineRegistry();
    const engine = {} as IWhatsAppEngine;
    engines.set('s1', engine);
    const projector = new MessageProjector(
      repo as unknown as Repository<Message>,
      { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>,
      engines,
      new Proxy({}, { get: () => jest.fn() }) as unknown as EventsGateway,
      { dispatch } as unknown as WebhookService,
      {
        execute: jest.fn(async (event: string, data: unknown) => {
          if (event === 'message:received' || event === 'message:sent') hooked.push(String((data as Row).body));
          if (event === 'message:received') await hookGate;
          return { continue: true, data };
        }),
      } as unknown as HookManager,
      { ingest: jest.fn() } as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
    );
    const callbacks: EngineEventCallbacks = {
      ...(type === 'postgres'
        ? {
            admitInbound: (a: Parameters<MessageProjector['admitInbound']>[2]) =>
              projector.admitInbound('s1', engine, a),
          }
        : {}),
      onMessage: (m, t) => projector.handleInboundMessage('s1', engine, m, t),
      onMessageCreate: (m, t) => projector.handleOwnSendEcho('s1', engine, m, t),
      onMessageRevoked: (m, actor) => projector.handleMessageRevoked('s1', engine, m, actor),
      onMessageEdited: m => projector.applyMessageEditQueued('s1', m),
      onMessageReaction: r => projector.applyReactionQueued('s1', r),
    };
    // The real adapter wiring, as WhatsAppWebJsAdapter.setupEventHandlers builds it.
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'changes',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    client = Object.assign(new EventEmitter(), {
      info: { wid: { user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
    });
    (adapter as unknown as { client: unknown }).client = client;
    (adapter as unknown as { callbacks: unknown }).callbacks = callbacks;
    (adapter as unknown as { lifecycle: WwebjsLifecycle }).lifecycle.setupEventHandlers();
  });

  afterEach(() => {
    process.env = { ...env };
  });

  /** The payloads dispatched to webhooks under one event, in order. */
  const events = (event: string): Row[] =>
    (dispatch.mock.calls as Array<[string, string, Row]>).filter(c => c[1] === event).map(c => c[2]);

  const download = () => {
    const page = deferred<{ mimetype: string; data: string }>();
    return { page: jest.fn(() => page.promise), finish: () => page.resolve({ mimetype: 'image/png', data: 'QUJD' }) };
  };

  // What a message deleted for everyone while it was processed leaves behind. PostgreSQL held the message from its
  // arrival and stores it cleared. SQLite is told of it only at the hand-over, which is skipped, as the Baileys
  // adapter skips it: no row, no hook, no announcement.
  const deletedRows = (id: string): unknown[] =>
    type === 'postgres'
      ? [expect.objectContaining({ waMessageId: id, body: '', type: 'revoked', metadata: null })]
      : [];

  it('leaves no content of a message deleted for everyone during its contact lookup, and announces none', async () => {
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'secret', { contact: contact.promise }));
    await flush();
    revokeEvent(client, 'A');
    await flush();
    contact.resolve(null);
    await flush();

    expect(rows).toEqual(deletedRows('A'));
    expect(hooked).toEqual([]);
    expect(events('message.received')).toEqual([]);
    expect(events('message.revoked')).toHaveLength(1);
  });

  it('leaves no content of a message deleted for everyone during its media download, and announces none', async () => {
    const media = download();
    client.emit('message', incoming('M', 'caption', { page: media.page }));
    await flush();
    revokeEvent(client, 'M');
    await flush();
    media.finish();
    await flush();

    expect(rows).toEqual(deletedRows('M'));
    expect(hooked).toEqual([]);
    expect(events('message.received')).toEqual([]);
    expect(events('message.revoked')).toHaveLength(1);
  });

  it('stores an edit made during the contact lookup, marked edited, and announces the edited text', async () => {
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    await flush();
    editEvent(client, 'A', 'fixed');
    await flush();
    contact.resolve(null);
    await flush();

    expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'fixed', metadata: { edited: true } })]);
    expect(hooked).toEqual(['fixed']);
    expect(events('message.received').map(m => m.body)).toEqual(['fixed']);
    expect(events('message.edited').map(m => m.body)).toEqual(['fixed']);
  });

  it('stores an edit made during the media download beside the media, and announces the edited text', async () => {
    const media = download();
    client.emit('message', incoming('M', 'cap', { page: media.page }));
    await flush();
    editEvent(client, 'M', 'new cap', { media: true });
    await flush();
    media.finish();
    await flush();

    expect(rows).toEqual([
      expect.objectContaining({
        waMessageId: 'M',
        body: 'new cap',
        metadata: { media: expect.objectContaining({ mimetype: 'image/png' }) as unknown, edited: true },
      }),
    ]);
    expect(hooked).toEqual(['new cap']);
    expect(events('message.received').map(m => m.body)).toEqual(['new cap']);
  });

  it('applies the edits of one message in the order they arrived', async () => {
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    await flush();
    editEvent(client, 'A', 'v1');
    editEvent(client, 'A', 'v2');
    await flush();
    contact.resolve(null);
    await flush();

    expect(rows[0].body).toBe('v2');
    expect(hooked).toEqual(['v2']);
    expect(events('message.edited').map(m => m.body)).toEqual(['v1', 'v2']);
    expect(events('message.received').map(m => m.body)).toEqual(['v2']);
  });

  it('stores a reaction made during the contact lookup on the row once it is written', async () => {
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    await flush();
    reactionEvent(client, 'A', '👍');
    await flush();
    contact.resolve(null);
    await flush();

    expect(rows).toEqual([expect.objectContaining({ body: 'orig', metadata: { reactions: { [CHAT]: '👍' } } })]);
    expect(events('message.reaction')).toHaveLength(1);
  });

  it('stores a reaction made during the media download beside the media', async () => {
    const media = download();
    client.emit('message', incoming('M', 'cap', { page: media.page }));
    await flush();
    reactionEvent(client, 'M', '❤️');
    await flush();
    media.finish();
    await flush();

    expect(rows).toEqual([
      expect.objectContaining({
        waMessageId: 'M',
        metadata: { media: expect.objectContaining({ mimetype: 'image/png' }) as unknown, reactions: { [CHAT]: '❤️' } },
      }),
    ]);
  });

  it('stores a reaction beside the edit that reached the message before it', async () => {
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    await flush();
    editEvent(client, 'A', 'fixed');
    reactionEvent(client, 'A', '👍');
    await flush();
    contact.resolve(null);
    await flush();

    expect(rows).toEqual([
      expect.objectContaining({ body: 'fixed', metadata: { edited: true, reactions: { [CHAT]: '👍' } } }),
    ]);
  });

  it('leaves no content of a message edited and then deleted during its contact lookup', async () => {
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    await flush();
    editEvent(client, 'A', 'fixed');
    revokeEvent(client, 'A');
    await flush();
    contact.resolve(null);
    await flush();

    expect(rows).toEqual(deletedRows('A'));
    expect(hooked).toEqual([]);
    expect(events('message.received')).toEqual([]);
  });

  it('leaves no content of an own send deleted for everyone during its media download, and announces none', async () => {
    const media = download();
    client.emit('message_create', incoming('S', 'sent', { page: media.page, fromMe: true }));
    await flush();
    revokeEvent(client, 'S', { fromMe: true });
    await flush();
    media.finish();
    await flush();

    expect(rows).toEqual(deletedRows('S'));
    expect(hooked).toEqual([]);
    expect(events('message.sent')).toEqual([]);
  });

  // The REST send stored its row before the echo came, so the delete has a row to clear on both wirings.
  it('clears the row a REST send stored when its echo is deleted during its media download', async () => {
    rows.push({
      sessionId: 's1',
      waMessageId: 'S',
      chatId: CHAT,
      direction: 'outgoing',
      type: 'image',
      body: 'sent',
      metadata: { media: { mimetype: 'image/png', data: 'QUJD' } },
    });
    const media = download();
    client.emit('message_create', incoming('S', 'sent', { page: media.page, fromMe: true }));
    await flush();
    revokeEvent(client, 'S', { fromMe: true });
    await flush();
    media.finish();
    await flush();

    expect(rows).toEqual([expect.objectContaining({ waMessageId: 'S', body: '', type: 'revoked', metadata: null })]);
    expect(hooked).toEqual([]);
    expect(events('message.sent')).toEqual([]);
  });

  it('stores an own send edited during its media download marked edited, and announces the edited text', async () => {
    const media = download();
    client.emit('message_create', incoming('S', 'sent', { page: media.page, fromMe: true }));
    await flush();
    editEvent(client, 'S', 'sent again', { media: true, fromMe: true });
    await flush();
    media.finish();
    await flush();

    expect(rows).toEqual([expect.objectContaining({ waMessageId: 'S', body: 'sent again' })]);
    expect((rows[0].metadata as Row).edited).toBe(true);
    expect(hooked).toEqual(['sent again']);
    expect(events('message.sent').map(m => m.body)).toEqual(['sent again']);
  });

  // An edit that repeats the text the message carries changes nothing: it is announced, and leaves no mark.
  it('announces an edit that repeats the text during the contact lookup, and does not mark the message edited', async () => {
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'same', { contact: contact.promise }));
    await flush();
    editEvent(client, 'A', 'same');
    await flush();

    expect(events('message.edited')).toHaveLength(1);
    contact.resolve(null);
    await flush();

    expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'same' })]);
    expect(rows[0].metadata ?? {}).not.toHaveProperty('edited');
  });

  // The hook of message:received can run for a while, and the row is written when it returns.
  it('announces an edit that repeats the text while the hook runs, and does not mark the message edited', async () => {
    const hook = deferred<void>();
    hookGate = hook.promise;
    client.emit('message', incoming('A', 'same'));
    await flush();
    editEvent(client, 'A', 'same');
    await flush();
    hook.resolve();
    await flush();

    expect(events('message.edited')).toHaveLength(1);
    expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'same' })]);
    expect(rows[0].metadata ?? {}).not.toHaveProperty('edited');
  });

  it('stores an edit that changes the text while the hook runs, marked edited', async () => {
    const hook = deferred<void>();
    hookGate = hook.promise;
    client.emit('message', incoming('A', 'orig'));
    await flush();
    editEvent(client, 'A', 'fixed');
    await flush();
    hook.resolve();
    await flush();

    expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'fixed', metadata: { edited: true } })]);
  });
});

describe('changes kept while whatsapp-web.js processes a message (adapter level)', () => {
  /** Calls of the engine callbacks in the order they were made, with the registration under test. */
  const wire = (extra: Partial<EngineEventCallbacks> = {}, media: Promise<undefined> = Promise.resolve(undefined)) => {
    const order: string[] = [];
    // The body of each message handed over, in order, and the text it arrived with where an edit was applied.
    const bodies: string[] = [];
    const arrivals: Array<string | undefined> = [];
    const callbacks: EngineEventCallbacks = {
      onMessage: (m: IncomingMessage) => {
        order.push(`message ${m.id}`);
        bodies.push(m.body);
        arrivals.push(m.originalBody);
      },
      onMessageCreate: (m: IncomingMessage) => {
        order.push(`own ${m.id}`);
        bodies.push(m.body);
        arrivals.push(m.originalBody);
      },
      onMessageEdited: (e: EditedMessage) => {
        order.push(`edit ${e.messageId} ${e.body}`);
      },
      onMessageRevoked: (r: RevokedMessage) => {
        order.push(`revoke ${r.revokedId ?? r.id}`);
      },
      onMessageReaction: (r: ReactionEvent) => {
        order.push(`react ${r.messageId} ${r.reaction}`);
      },
      ...extra,
    };
    const client = new EventEmitter();
    const host = {
      logger: createLogger('wwebjs-message-changes.spec'),
      getCallbacks: () => callbacks,
      capInboundMediaFor: jest.fn(() => media),
    } as unknown as WwebjsEngineHost;
    registerWwebjsMessageEvents(client as unknown as Client, host);
    return { client, order, bodies, arrivals, callbacks };
  };

  // The bounds of wwebjs-message-events.ts: changes kept per message, and messages tracked at once.
  const PER_MESSAGE = 64;
  const TRACKED = 5_000;

  it('hands a message over with its latest edit, and delivers what reached it right after, in order', async () => {
    const { client, order, bodies } = wire();
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    editEvent(client, 'A', 'fixed');
    reactionEvent(client, 'A', '👍');
    editEvent(client, 'A', 'fixed twice');
    await flush();
    expect(order).toEqual([]);

    contact.resolve(null);
    await flush();

    expect(order).toEqual(['message A', 'edit A fixed', 'react A 👍', 'edit A fixed twice']);
    expect(bodies).toEqual(['fixed twice']);
  });

  it('hands over the text a message arrived with beside the edit applied to it', async () => {
    const { client, bodies, arrivals } = wire();
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    editEvent(client, 'A', 'v1');
    editEvent(client, 'A', 'v2');

    contact.resolve(null);
    await flush();

    expect(bodies).toEqual(['v2']);
    expect(arrivals).toEqual(['orig']);
  });

  it('hands over no arrival text when no edit was applied', async () => {
    const { client, arrivals } = wire();
    const plain = deferred<null>();
    const reacted = deferred<null>();
    const restored = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: plain.promise }));
    client.emit('message', incoming('B', 'orig', { contact: reacted.promise }));
    client.emit('message', incoming('C', 'orig', { contact: restored.promise }));
    reactionEvent(client, 'B', '👍');
    editEvent(client, 'C', 'v1');
    editEvent(client, 'C', 'orig');

    plain.resolve(null);
    reacted.resolve(null);
    restored.resolve(null);
    await flush();

    expect(arrivals).toEqual([undefined, undefined, undefined]);
  });

  it('hands over the text an own send arrived with beside the edit applied to it', async () => {
    const download = deferred<undefined>();
    const { client, bodies, arrivals } = wire({}, download.promise);
    client.emit('message_create', incoming('S', 'sent', { page: jest.fn(), fromMe: true }));
    editEvent(client, 'S', 'sent again', { media: true, fromMe: true });

    download.resolve(undefined);
    await flush();

    expect(bodies).toEqual(['sent again']);
    expect(arrivals).toEqual(['sent']);
  });

  it('does not hand over a message deleted meanwhile, and delivers what reached it', async () => {
    const { client, order, bodies } = wire();
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    editEvent(client, 'A', 'fixed');
    reactionEvent(client, 'A', '👍');
    revokeEvent(client, 'A');
    await flush();
    expect(order).toEqual([]);

    contact.resolve(null);
    await flush();

    expect(order).toEqual(['edit A fixed', 'react A 👍', 'revoke A']);
    expect(bodies).toEqual([]);
  });

  it('does not hand over a message deleted after more changes than are kept', async () => {
    const { client, order, bodies } = wire();
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    for (let i = 1; i <= PER_MESSAGE; i++) editEvent(client, 'A', `v${i}`);
    revokeEvent(client, 'A');
    expect(order).toHaveLength(PER_MESSAGE + 1);
    expect(order.at(-1)).toBe('revoke A');

    contact.resolve(null);
    await flush();

    expect(order).toHaveLength(PER_MESSAGE + 1);
    expect(bodies).toEqual([]);
  });

  it('delivers at once a delete that reaches a message already handed over', async () => {
    const { client, order } = wire();
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    contact.resolve(null);
    await flush();
    revokeEvent(client, 'A');

    expect(order).toEqual(['message A', 'revoke A']);
  });

  it('delivers at once what reaches a message the session holds from its arrival', async () => {
    const ticket: InboundTicket = {
      reserve: () => false,
      holdUntil: () => undefined,
      drop: () => undefined,
      revoked: false,
    };
    const { client, order, bodies } = wire({ admitInbound: () => ticket });
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    editEvent(client, 'A', 'fixed');
    revokeEvent(client, 'A');
    expect(order).toEqual(['edit A fixed', 'revoke A']);

    contact.resolve(null);
    await flush();

    // The session applies them itself: the message goes over as it arrived.
    expect(order).toEqual(['edit A fixed', 'revoke A', 'message A']);
    expect(bodies).toEqual(['orig']);
  });

  it('delivers at once what reaches another message, and what reaches a message already handed over', async () => {
    const { client, order } = wire();
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    editEvent(client, 'Z', 'elsewhere');
    reactionEvent(client, 'Z', '👍');
    expect(order).toEqual(['edit Z elsewhere', 'react Z 👍']);

    contact.resolve(null);
    await flush();
    editEvent(client, 'A', 'late');
    reactionEvent(client, 'A', '👍');

    expect(order).toEqual(['edit Z elsewhere', 'react Z 👍', 'message A', 'edit A late', 'react A 👍']);
  });

  it('delivers at once what reaches a status post', async () => {
    const { client, order } = wire();
    const contact = deferred<null>();
    client.emit('message', { ...incoming('ST', 'story', { contact: contact.promise }), from: 'status@broadcast' });
    editEvent(client, 'ST', 'edited story');
    expect(order).toEqual(['edit ST edited story']);

    contact.resolve(null);
    await flush();

    expect(order).toEqual(['edit ST edited story', 'message ST']);
  });

  it('delivers an edit that repeats the text at once and keeps one that changes it', async () => {
    const { client, order, bodies } = wire();
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    editEvent(client, 'A', 'orig');
    editEvent(client, 'A', 'v1');
    editEvent(client, 'A', 'v1');
    editEvent(client, 'A', 'orig');
    expect(order).toEqual(['edit A orig', 'edit A v1']);

    contact.resolve(null);
    await flush();

    expect(order).toEqual(['edit A orig', 'edit A v1', 'message A', 'edit A v1', 'edit A orig']);
    expect(bodies).toEqual(['orig']);
  });

  it('forgets the message when its processing fails, after delivering what it kept', async () => {
    const { client, order } = wire({
      onMessage: () => {
        throw new Error('boom');
      },
    });
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    editEvent(client, 'A', 'fixed');
    expect(order).toEqual([]);

    contact.resolve(null);
    await flush();
    expect(order).toEqual(['edit A fixed']);
    editEvent(client, 'A', 'later');

    expect(order).toEqual(['edit A fixed', 'edit A later']);
  });

  it('hands an own send over with its latest edit, and delivers what reached it right after', async () => {
    const download = deferred<undefined>();
    const { client, order, bodies } = wire({}, download.promise);
    client.emit('message_create', incoming('S', 'sent', { page: jest.fn(), fromMe: true }));
    editEvent(client, 'S', 'sent again', { media: true, fromMe: true });
    await flush();
    expect(order).toEqual([]);

    download.resolve(undefined);
    await flush();

    expect(order).toEqual(['own S', 'edit S sent again']);
    expect(bodies).toEqual(['sent again']);
  });

  it('does not hand over an own send deleted meanwhile, and delivers what reached it', async () => {
    const download = deferred<undefined>();
    const { client, order, bodies } = wire({}, download.promise);
    client.emit('message_create', incoming('S', 'sent', { page: jest.fn(), fromMe: true }));
    editEvent(client, 'S', 'sent again', { media: true, fromMe: true });
    revokeEvent(client, 'S', { fromMe: true });
    await flush();

    download.resolve(undefined);
    await flush();

    expect(order).toEqual(['edit S sent again', 'revoke S']);
    expect(bodies).toEqual([]);
  });

  it('forgets an own send when handing it over fails, after delivering what it kept', async () => {
    const download = deferred<undefined>();
    const { client, order } = wire(
      {
        onMessageCreate: () => {
          throw new Error('boom');
        },
      },
      download.promise,
    );
    client.emit('message_create', incoming('S', 'sent', { page: jest.fn(), fromMe: true }));
    editEvent(client, 'S', 'sent again', { media: true, fromMe: true });
    expect(order).toEqual([]);

    download.resolve(undefined);
    await flush();
    expect(order).toEqual(['edit S sent again']);
    editEvent(client, 'S', 'later', { media: true, fromMe: true });

    expect(order).toEqual(['edit S sent again', 'edit S later']);
  });

  it('delivers at once a reaction whose message id could not be read', async () => {
    const { client, order } = wire();
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    client.emit('message_reaction', { msgId: {}, id: { remote: CHAT }, reaction: '👍', senderId: CHAT });
    expect(order).toEqual(['react  👍']);

    contact.resolve(null);
    await flush();
  });

  // An id that could not be read keys nothing: two such messages in flight must not share what is kept for either.
  it('hands over each of two messages whose id could not be read with its own text', async () => {
    const { client, order, bodies } = wire();
    const first = deferred<null>();
    const second = deferred<null>();
    client.emit('message', { ...incoming('x', 'first text', { contact: first.promise }), id: {} });
    client.emit('message', { ...incoming('x', 'second text', { contact: second.promise }), id: {} });
    editEvent(client, '', 'an edit of neither');
    expect(order).toEqual(['edit  an edit of neither']);

    second.resolve(null);
    first.resolve(null);
    await flush();

    expect(bodies).toEqual(['second text', 'first text']);
  });

  it('hands over neither delivery of an id that was deleted meanwhile', async () => {
    const { client, order, bodies } = wire();
    const first = deferred<null>();
    const second = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: first.promise }));
    client.emit('message', incoming('A', 'orig', { contact: second.promise }));
    revokeEvent(client, 'A');

    second.resolve(null);
    await flush();
    first.resolve(null);
    await flush();
    revokeEvent(client, 'A');

    expect(order).toEqual(['revoke A', 'revoke A']);
    expect(bodies).toEqual([]);
  });

  it('shares what reached an id between two deliveries of it, and forgets the id after both', async () => {
    const { client, order } = wire();
    const first = deferred<null>();
    const second = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: first.promise }));
    client.emit('message', incoming('A', 'orig', { contact: second.promise }));
    editEvent(client, 'A', 'fixed');
    expect(order).toEqual([]);

    second.resolve(null);
    await flush();
    expect(order).toEqual(['message A', 'edit A fixed']);

    first.resolve(null);
    await flush();
    editEvent(client, 'A', 'late');

    expect(order).toEqual(['message A', 'edit A fixed', 'message A', 'edit A late']);
  });

  it('delivers the rest when one kept change fails', async () => {
    const { client, order } = wire({
      onMessageEdited: () => {
        throw new Error('boom');
      },
    });
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    editEvent(client, 'A', 'fixed');
    reactionEvent(client, 'A', '👍');

    contact.resolve(null);
    await flush();

    expect(order).toEqual(['message A', 'react A 👍']);
  });

  it('keeps a bounded number of changes for one message, delivering the rest in order at once', async () => {
    const { client, order } = wire();
    const contact = deferred<null>();
    client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
    for (let i = 1; i <= PER_MESSAGE + 6; i++) editEvent(client, 'A', `v${i}`);
    expect(order).toHaveLength(PER_MESSAGE + 1);

    contact.resolve(null);
    await flush();

    const edits = order.filter(entry => entry.startsWith('edit'));
    expect(edits).toEqual(Array.from({ length: PER_MESSAGE + 6 }, (_, i) => `edit A v${i + 1}`));
    expect(order.indexOf('message A')).toBe(PER_MESSAGE + 1);
  });

  it('tracks a bounded number of messages, delivering what reaches the others at once', async () => {
    const { client, order } = wire();
    const contact = deferred<null>();
    for (let i = 0; i < TRACKED; i++) client.emit('message', incoming(`m${i}`, 'orig', { contact: contact.promise }));
    client.emit('message', incoming('over', 'orig', { contact: contact.promise }));
    editEvent(client, 'm0', 'kept');
    editEvent(client, 'over', 'at once');

    expect(order).toEqual(['edit over at once']);

    contact.resolve(null);
    await flush();

    expect(order[0]).toBe('edit over at once');
    expect(order.indexOf('edit m0 kept')).toBeGreaterThan(order.indexOf('message m0'));
    expect(order).toHaveLength(TRACKED + 3);
  });
});
