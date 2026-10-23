import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm';
import { Session } from './entities/session.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';
import { SessionLidResolver } from './session-lid-resolver.service';
import { buildMessageMetadata, REVOKED_ROW_PATCH, storableWaMessageId } from './message-row.mapper';
import { MessageMutationProjector } from './message-mutation-projector';
import { mutationTargetsForeignRow, type MutationSource, type StoredMessageRef } from './message-mutation-guard';
import { updateMessageMetadata } from '../message/message-metadata';
import { persistHistoryMessages } from './message-history-projector';
import { isTransientDbError, isUniqueViolation } from '../../common/utils/db-errors';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { StatusStoreService } from '../status-store/status-store.service';
import { ChatMediaArchiveService } from '../chat-media/chat-media-archive.service';
import { AutomationRulesService } from '../automation/automation-rules.service';
import { buildIncomingStatus } from '../status-store/incoming-status';
import type { StatusUpdate } from '../status-store/entities/status-update.entity';
import {
  IWhatsAppEngine,
  DeliveryStatus,
  MessageReceiptEvent,
  IncomingMessage,
  InboundOutcome,
  InboundReceipt,
  InboundTicket,
  ReactionEvent,
  EditedMessage,
  RevokedMessage,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { deferred, InboundRoom, roomState, type RoomState } from './inbound-room';
import { createLogger } from '../../common/services/logger.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import {
  deliveryStatusToMessageStatus,
  deliveryStatusToAck,
  ackStatusTransitionFrom,
} from '../message/message-status.util';
import { isMessagePayload } from '../../core/hooks/hook-results';

/**
 * Projects engine message events into the `messages` table and out to webhooks/WebSocket.
 *
 * This is the data path for messages: inbound arrivals, own-send echoes, delivery acks, revokes,
 * reactions, edits, and the pre-connection history backfill. It is deliberately separate from
 * SessionEngineLifecycle, which owns the session *lifecycle* (start/stop/delete/reconnect). The two
 * share
 * only the engine identity guard — a late event from a superseded engine must never mutate a
 * session that now belongs to a different one, or to none — which both read from EngineRegistry.
 *
 * Every entry point takes the captured `(sessionId, engine)` pair its engine callback closed over,
 * so those staleness checks behave exactly as they did while this code sat inline in
 * initializeEngine.
 */
/**
 * Delay before retrying an ack UPDATE that matched 0 rows. A fast delivered/read ack can arrive before
 * the send's 2nd save (which writes waMessageId) has committed, so the first UPDATE finds no row. One
 * retry after this delay closes that race; the forward-only transition guard keeps it idempotent.
 */
export const ACK_RECONCILE_DELAY_MS = 750;

/**
 * Delay before the single retry of a message insert that failed transiently (lock contention, a
 * dropped connection, a pool timeout). The engine delivers each message once, so without the retry
 * one busy moment loses the row for good.
 */
export const PERSIST_RETRY_DELAY_MS = 300;

/** How many of its messages marked edited a session remembers as marked (see markedEdited). */
const EDITED_MARKS_KEPT_PER_SESSION = 500;

/**
 * How a message insert ended: `yes` the row landed, `dup` a unique violation (`retried` says whether
 * it came from the retry, when the first attempt may have committed before its error), `failed` a
 * non-conflict error, `stale` the engine was retired while the retry waited.
 */
type InsertOutcome = { landed: 'yes' | 'failed' | 'stale' } | { landed: 'dup'; retried: boolean };

/** Persist-stage outcome threaded into the inbound dispatch stage (was closure state in the hook continuation). */
interface InboundPersistOutcome {
  dbMessage: Message;
  persisted: boolean;
}

/**
 * Type of the `{ ...message }` copy the `message:received` hook returns (was the closure-inferred
 * spread type in handleInboundMessage). Kept as an object type rather than the IncomingMessage
 * interface so it stays assignable to the Record<string, unknown> dispatch/emit params — interfaces
 * carry no implicit index signature.
 */
type InboundMessageData = { [K in keyof IncomingMessage]: IncomingMessage[K] };

const quoteOf = (m: Pick<IncomingMessage, 'chatId' | 'body'>) => ({ chatId: m.chatId, body: m.body });

/** Where a message lives and who wrote it: what a change aimed at it is held to (see mutationTargetsForeignRow). */
const refOf = (m: Pick<IncomingMessage, 'chatId' | 'fromMe' | 'author'>): StoredMessageRef => ({
  chatId: m.chatId,
  direction: m.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
  author: m.author,
});

/** What a delivery claims to be, as the rule that refuses a change aimed at a stored row reads it. */
const claimOf = (m: Pick<IncomingMessage, 'chatId' | 'fromMe' | 'author'>): MutationSource => ({
  kind: 'edit',
  chatId: m.chatId,
  fromMe: m.fromMe,
  author: m.author,
});

/** A message not yet written, and the changes that reached it meanwhile (see inboundInFlight). */
interface InFlightEntry {
  // What a quote of it may lend, as the hook chain last left it. Never the message itself: a repeat
  // delivery shares the entry, and its payload must not outlive the slot that accounts for it.
  // Unset while the message is admitted but not yet emitted (see admitInbound).
  quote?: Pick<IncomingMessage, 'chatId' | 'body'>;
  // Where the message lives and who wrote it, so a change recorded for it meanwhile is held to the same
  // chat, direction and author rule as the row it will become (see mutationTargetsForeignRow).
  ref?: StoredMessageRef;
  revoked?: boolean;
  // Set when the revoke came from the engine, so message.revoked went out for it.
  revokeAnnounced?: boolean;
  editedBody?: string;
  // The text the message arrived with, which an edit is compared with: one that repeats the text so far changes
  // nothing. Unset while the message is admitted but not yet emitted.
  body?: string;
  // An edit held for the message or applied by the engine changed its text, or was asked for: the row it lands on is
  // marked edited.
  edited?: boolean;
  ackStatus?: MessageStatus;
  // Latest reaction per sender; '' means the sender withdrew theirs.
  reactions?: Record<string, string>;
  // Tickets sharing the entry: a repeat delivery keeps what was recorded for the first one.
  holders?: number;
}

/**
 * A message admitted on arrival (PostgreSQL only): its place in the chat's hook and commit order, its
 * claim on the session's room when it downloads media, and its in-flight entry, so a change that
 * targets it before its emit is kept for its row.
 */
class InboundTurn implements InboundTicket {
  state: 'pending' | 'emitted' | 'dropped' = 'pending';
  /** The commit to run in the chat's turn, or null when the message will not be emitted. */
  readonly outcome = deferred<(() => Promise<void>) | null>();
  readonly emitted = deferred<void>();
  /** Resolved once every earlier message of the chat was emitted or dropped: the hook may start. */
  readonly hookGate = deferred<void>();

  constructor(
    readonly engine: IWhatsAppEngine,
    readonly entry: InFlightEntry,
    private readonly room?: InboundRoom,
    readonly s?: RoomState,
  ) {}

  get revoked(): boolean {
    return this.entry.revoked === true;
  }

  // A message revoked before its download needs none: its row is stored cleared.
  reserve(): boolean | Promise<boolean> {
    if (!this.s || !this.room || this.state === 'dropped') return false;
    if (this.entry.revoked) return this.giveUp();
    return this.s.granted || this.room.wait(this.s).then(granted => granted && !this.entry.revoked);
  }

  /** Leave the room's queue, if still in it: once admitted, the claim passes the slot straight on. */
  giveUp(): false {
    if (this.s && !this.s.granted) {
      this.s.abandoned = true;
      this.s.grant.resolve(false);
    }
    return false;
  }

  holdUntil(p: Promise<unknown>): void {
    this.s?.holds.push(p.catch(() => undefined));
  }

  emit(job: () => Promise<void>): void {
    if (this.state !== 'pending') return;
    this.state = 'emitted';
    this.emitted.resolve();
    this.outcome.resolve(job);
  }

  drop(): void {
    if (this.state !== 'pending') return;
    this.state = 'dropped';
    this.outcome.resolve(null);
    this.emitted.resolve();
    this.giveUp();
  }
}

@Injectable()
export class MessageProjector {
  private readonly logger = createLogger('MessageProjector');

  // Serializes stored-message mutations per `${sessionId}:${waMessageId}`. Reactions perform a
  // read-modify-write and rapid edits must remain latest-write-wins; sharing one chain also preserves
  // order when different mutation kinds for the same message arrive together.
  private readonly messageMutations = new KeyedMutationQueue((key, err) => {
    // Both current mutation implementations contain their own contextual error handling. Keep a
    // final guard here so a future implementation cannot leak a rejected fire-and-forget promise
    // or permanently block the message's later mutations.
    this.logger.error(`Unexpected failure applying message mutation: ${key}`, String(err));
  });

  // Serializes the insert and dispatch of each chat's messages, by `${sessionId}:${chatId}`: hook
  // chains finish in any order, but a chat's rows, websocket events and webhooks follow arrival.
  private readonly chatCommits = new KeyedMutationQueue((key, err) => {
    this.logger.error(`Unexpected failure committing a message: ${key}`, String(err));
  });

  // PostgreSQL only: a chat's `message:received` / `message:sent` chains start in arrival order, each
  // once every earlier admitted message of the chat was emitted or dropped (see admitInbound).
  private readonly chatEmits = new KeyedMutationQueue((key, err) => {
    this.logger.error(`Unexpected failure ordering a message: ${key}`, String(err));
  });

  // Per session, not per engine: a replaced engine's payloads still waiting for their rows keep
  // counting, so a reconnect cannot multiply the room.
  private readonly rooms = new Map<string, InboundRoom>();

  // Admitted messages not yet committed, by session, so retiring an engine can release its own.
  private readonly tickets = new Map<string, Set<InboundTurn>>();

  // Messages not yet written, by `${sessionId}:${waMessageId}`: inbound ones from the start of their
  // `message:received` chain, own-send echoes from the start of their `message:sent` chain, each until
  // its commit (which may wait behind earlier messages of the chat) ends. A handler that quotes the
  // message reads it from here, and a revoke, edit or ack landing meanwhile finds no row to update: it
  // is recorded here and applied once the row is written (see applyChangesMadeInFlight).
  // On PostgreSQL the entry exists from the message's arrival (admitInbound), before its emit.
  private readonly inboundInFlight = new Map<string, InFlightEntry>();

  // Ids whose row was marked edited, by session, while it has an engine: an own message delivered again loses its
  // insert to that row, and is announced with the mark without reading it (see commitOwnSendEcho). Never stored; past
  // EDITED_MARKS_KEPT_PER_SESSION the oldest is forgotten, and a repeat of it goes out unmarked.
  private readonly markedEdited = new Map<string, Set<string>>();

  // Reaction/edit applies, extracted to a plain collaborator. It shares this instance's
  // messageMutations queue, so the public enqueue path and the queued applies serialize on one chain.
  private readonly mutationProjector: MessageMutationProjector;

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    private readonly engines: EngineRegistry,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly hookManager: HookManager,
    private readonly statusStore: StatusStoreService,
    private readonly lidResolver: SessionLidResolver,
    @Optional()
    private readonly configService?: ConfigService,
    // Optional so the projector can still be constructed standalone (specs, and any wiring that
    // predates the archive). Absent simply means inbound media is not archived.
    @Optional()
    private readonly chatMediaArchive?: ChatMediaArchiveService,
    // Optional for the same reason. Absent simply means no autoreply rules are evaluated.
    @Optional()
    private readonly automationRules?: AutomationRulesService,
  ) {
    this.mutationProjector = new MessageMutationProjector(
      this.messageRepository,
      this.eventsGateway,
      this.webhookService,
      this.messageMutations,
      this.logger,
      (sessionId, waMessageId) => this.noteMarkedEdited(sessionId, waMessageId),
    );
    this.engines.onRetire((id, engine) => {
      for (const t of this.tickets.get(id) ?? []) if (t.engine === engine) t.drop();
      this.deleteRoomIfIdle(id);
      if (!this.engines.has(id)) this.markedEdited.delete(id);
    });
  }

  private noteMarkedEdited(sessionId: string, waMessageId: string): void {
    let marks = this.markedEdited.get(sessionId);
    if (!marks) this.markedEdited.set(sessionId, (marks = new Set()));
    marks.add(waMessageId);
    if (marks.size > EDITED_MARKS_KEPT_PER_SESSION) marks.delete(marks.values().next().value!);
  }

  /**
   * Whether the engines hold each inbound message from its arrival until its row is written. Only
   * PostgreSQL needs it: a downloaded payload waits in memory for its asynchronous insert, while
   * better-sqlite3 writes synchronously, so the backlog drains within the arrival's own task.
   */
  get holdsInbound(): boolean {
    return this.messageRepository.manager?.connection?.options?.type === 'postgres';
  }

  /**
   * Admit a message as it arrives (see EngineEventCallbacks.admitInbound), synchronously, in arrival
   * order. The engine passes the ticket to its emit or drops it. Each admitted message of a chat
   * starts its hook chain and is committed in this order, and changes that target it before its emit
   * are recorded on its in-flight entry. One that downloads media asks the session's room for a slot
   * now, granted in arrival order and held until its row is written.
   */
  admitInbound(
    id: string,
    engine: IWhatsAppEngine,
    a: { id: string; chatId: string; needsRoom: boolean; status: boolean; fromMe?: boolean; author?: string },
  ): InboundTicket | undefined {
    if (!this.engines.isLive(id, engine)) return undefined;
    const key = a.status || !a.id ? null : `${id}:${a.id}`;
    let entry: InFlightEntry = {};
    if (key) {
      entry = this.inboundInFlight.get(key) ?? entry;
      this.inboundInFlight.set(key, entry);
      // From the arrival, so a change that reaches the message while it downloads media is held to the rule
      // of the row it will become. Only when the engine says whose message it is: a guessed direction
      // would refuse the account's own change.
      if (a.fromMe !== undefined) entry.ref ??= refOf({ chatId: a.chatId, fromMe: a.fromMe, author: a.author });
    }
    entry.holders = (entry.holders ?? 0) + 1;
    const room = a.needsRoom ? this.room(id) : undefined;
    const t = new InboundTurn(engine, entry, room, room && roomState());
    let set = this.tickets.get(id);
    if (!set) this.tickets.set(id, (set = new Set()));
    set.add(t);
    const finish = (): void => {
      if (entry.holders) entry.holders--;
      if (key && !entry.holders && this.inboundInFlight.get(key) === entry) this.inboundInFlight.delete(key);
      set.delete(t);
      if (!set.size && this.tickets.get(id) === set) this.tickets.delete(id);
      t.s?.done.resolve();
    };
    if (a.status) {
      void t.outcome.promise.then(finish);
    } else {
      const chatKey = `${id}:${a.chatId}`;
      this.chatEmits.enqueue(chatKey, () => {
        t.hookGate.resolve();
        return t.emitted.promise;
      });
      this.chatCommits.enqueue(chatKey, async () => {
        try {
          const job = await t.outcome.promise;
          if (job) await job();
        } finally {
          finish();
        }
      });
    }
    if (room && t.s) {
      void room.request(t.s).then(() => {
        if (!this.engines.has(id)) this.deleteRoomIfIdle(id);
      });
    }
    return t;
  }

  private room(id: string): InboundRoom {
    let room = this.rooms.get(id);
    if (!room) this.rooms.set(id, (room = new InboundRoom()));
    return room;
  }

  private deleteRoomIfIdle(id: string): void {
    if (this.rooms.get(id)?.idle) this.rooms.delete(id);
  }

  /**
   * Engine callback body, lifted out of initializeEngine so the wiring table stays readable. With a
   * ticket (PostgreSQL), the hook chain starts in the chat's arrival order and the commit takes the
   * turn admitInbound reserved; whatever path returns early drops the ticket. The receipt, for an
   * engine that wants to know what became of its message, settles once the commit ends (see
   * {@link InboundOutcome}). There is none when the engine is no longer live or the message is skipped as
   * ephemeral; one that settles with nothing says nothing, as when the hook chain failed.
   */
  handleInboundMessage(
    id: string,
    engine: IWhatsAppEngine,
    message: IncomingMessage,
    ticket?: InboundTicket,
  ): InboundReceipt | undefined {
    const turn = ticket instanceof InboundTurn ? ticket : undefined;
    try {
      return this.receiveInbound(id, engine, message, turn);
    } finally {
      turn?.drop();
    }
  }

  private receiveInbound(
    id: string,
    engine: IWhatsAppEngine,
    message: IncomingMessage,
    turn?: InboundTurn,
  ): InboundReceipt | undefined {
    if (!this.engines.isLive(id, engine)) return;
    if (message.isStatusBroadcast) {
      const ingest = this.ingestInboundStatus(id, engine, message);
      // The status store holds the payload until the ingest settles.
      turn?.holdUntil(ingest);
      // Its own table takes the status whatever the id, and a story is never a row of `messages`: one
      // that finds a message there under its id reuses that id. Only an engine that keeps its own copy of
      // a message reads the outcome, so the lookup is made when it is asked for, and once.
      let judged: Promise<InboundOutcome | undefined> | undefined;
      const judge = (): Promise<InboundOutcome | undefined> => ingest.then(() => this.judgeRepeat(id, message));
      return {
        get settled(): Promise<InboundOutcome | undefined> {
          return (judged ??= judge());
        },
      };
    }
    if (this.shouldSkipEphemeralMessage(id, message)) return;
    this.logger.debug(`Message received from ${message.from}`, {
      sessionId: id,
      messageId: message.id,
      from: message.from,
      action: 'message_received',
    });
    // Update last active timestamp
    void this.sessionRepository.update(id, { lastActiveAt: new Date() }).catch(() => undefined);
    // Convert IncomingMessage to plain object for dispatch
    const messageData = { ...message };
    // What an engine says of the edit it applied is for the session alone: no hook, row or consumer sees it.
    delete messageData.originalBody;
    // Tracks what the chain's current copy lends a quote, so one taken mid-chain carries an earlier
    // handler's rewrite.
    const inFlightKey = `${id}:${message.id}`;
    const inFlight = turn
      ? Object.assign(turn.entry, { quote: quoteOf(messageData), ref: turn.entry.ref ?? refOf(messageData) })
      : this.trackInFlight(inFlightKey, messageData);
    this.arrive(inFlight, message);

    const onFailure = (err: unknown): null => {
      this.logger.error(`onMessage handler failed for ${id}`, String(err));
      return null;
    };
    // Execute hook for message received - plugins can modify or stop processing. The hook chain and
    // sender resolution run concurrently across messages; the catch is attached now so a failure
    // while the commit waits its turn is never an unhandled rejection.
    const prepared = this.startHookChain(id, engine, turn, messageData, () =>
      this.hookManager
        .execute('message:received', messageData, {
          sessionId: id,
          source: 'Engine',
          accept: data => {
            if (!isMessagePayload(data)) return false;
            inFlight.quote = quoteOf(data);
            return true;
          },
        })
        .then(({ data }) =>
          this.prepareInboundMessage(id, this.messageOrEngineCopy(id, 'message:received', data, message)),
        ),
    ).catch(onFailure);
    const outcome = deferred<InboundOutcome | undefined>();
    this.commitInTurn(id, message, turn, async () => {
      try {
        const finalMessage = await prepared;
        if (finalMessage) outcome.resolve(await this.commitInboundMessage(id, engine, finalMessage));
      } catch (err) {
        onFailure(err);
      } finally {
        outcome.resolve(undefined); // no effect once settled above
        if (!turn) this.untrackInFlight(inFlightKey, inFlight);
      }
    });
    return { settled: outcome.promise };
  }

  /**
   * Start a message's hook chain: at once without a turn. With one, once every earlier admitted
   * message of the chat was emitted or dropped, so hooks start in arrival order. A message revoked
   * before then skips its hooks, as its content is gone, and an edit made before then reaches them.
   */
  private startHookChain(
    id: string,
    engine: IWhatsAppEngine,
    turn: InboundTurn | undefined,
    messageData: InboundMessageData,
    run: () => Promise<InboundMessageData>,
  ): Promise<InboundMessageData | null> {
    if (!turn) return run();
    const { entry } = turn;
    return turn.hookGate.promise.then(() => {
      if (!this.engines.isLive(id, engine)) return null;
      if (entry.revoked) return messageData;
      // A delivery that came deleted has no text for the edit to replace.
      if (entry.editedBody !== undefined && messageData.type !== 'revoked') messageData.body = entry.editedBody;
      return run();
    });
  }

  /** Queue a message's commit on its chat, or hand it to the turn admitInbound already queued. */
  private commitInTurn(
    id: string,
    message: IncomingMessage,
    turn: InboundTurn | undefined,
    job: () => Promise<void>,
  ): void {
    if (turn) turn.emit(job);
    else this.chatCommits.enqueue(this.chatCommitKey(id, message), job);
  }

  /** Record a message as not yet written; a re-fire of the same id keeps the changes recorded so far. */
  private trackInFlight(key: string, message: InboundMessageData): InFlightEntry {
    const { ref, revoked, revokeAnnounced, editedBody, edited, ackStatus, reactions } =
      this.inboundInFlight.get(key) ?? {};
    const inFlight: InFlightEntry = {
      quote: quoteOf(message),
      // The first delivery of an id says whose message it is: a repeat sent from another chat must not
      // take that over from it, or a change aimed through the repeat would be judged by the wrong rule.
      ref: ref ?? refOf(message),
      revoked,
      revokeAnnounced,
      editedBody,
      edited,
      ackStatus,
      reactions,
    };
    this.inboundInFlight.set(key, inFlight);
    return inFlight;
  }

  /**
   * The engine handed the message over: an edit held until now is compared with the text it arrived with. One the
   * engine applied itself changed that text, though a later one may have restored it (it names the arrival text only
   * then, so it can equal the body), and marks the row the same way.
   */
  private arrive(entry: InFlightEntry, message: IncomingMessage): void {
    entry.body = message.originalBody ?? message.body;
    if (message.originalBody !== undefined || (entry.editedBody !== undefined && entry.editedBody !== entry.body)) {
      entry.edited = true;
    }
  }

  /** Keep an edit for the row of a message not written yet. One that repeats the text so far changes nothing. */
  private holdEdit(entry: InFlightEntry, body: string): void {
    const soFar = entry.editedBody ?? entry.body;
    if (soFar !== undefined && body !== soFar) entry.edited = true;
    entry.editedBody = body;
  }

  /** Drop the entry once its commit ended, unless a re-fire of the same id replaced it. */
  private untrackInFlight(key: string, inFlight: object): void {
    if (this.inboundInFlight.get(key) === inFlight) this.inboundInFlight.delete(key);
  }

  /**
   * Key of the per-chat commit queue. A slow hook chain for one message must not let a later message
   * of the same chat be stored and announced first, so the insert and dispatch of every message in a
   * chat (inbound and own-send echo alike) run in arrival order. Keyed on the engine's chatId, not
   * on a hook's rewrite.
   */
  private chatCommitKey(id: string, message: IncomingMessage): string {
    return `${id}:${message.chatId}`;
  }

  /**
   * The inbound message a `message:received` chain is carrying, as the chain last rewrote it, from the
   * moment the chain starts until the message's row is written; undefined otherwise. The row does not
   * exist while the chain runs, so a handler that replies to the message finds nothing to quote in the
   * table.
   */
  inFlightInbound(sessionId: string, waMessageId: string): Pick<IncomingMessage, 'chatId' | 'body'> | undefined {
    const entry = waMessageId ? this.inboundInFlight.get(`${sessionId}:${waMessageId}`) : undefined;
    // Admitted but not emitted yet: nobody can have heard of it, so it has nothing to lend.
    if (!entry?.quote) return undefined;
    // A revoked message lends no text, as its cleared row would not; the chatId still scopes the quote.
    return entry.revoked ? { chatId: entry.quote.chatId, body: '' } : entry.quote;
  }

  /**
   * The message a `message:received` / `message:sent` hook chain handed back, or a fresh copy of the
   * engine's message when it is not one: null, a primitive, or an object without the `id` and `chatId`
   * every row and dispatch keys on. HookManager already skips such a result per handler
   * ({@link isMessagePayload}), keeping an earlier handler's rewrite; this is the last guard. A plugin
   * returning `data: null` to mean "I consumed it" used to throw below and erase the message from
   * history, webhooks and the websocket. A plugin may rewrite a message; it cannot make the gateway
   * forget it (see {@link prepareInboundMessage}).
   */
  private messageOrEngineCopy(
    id: string,
    event: 'message:received' | 'message:sent',
    data: unknown,
    message: IncomingMessage,
  ): InboundMessageData {
    const candidate = data as Partial<IncomingMessage> | null;
    if (isMessagePayload(candidate)) {
      return candidate as InboundMessageData;
    }
    this.logger.warn(`A ${event} hook returned a payload that is not a message; using the engine's copy`, {
      sessionId: id,
      messageId: message.id,
      received: candidate === null ? 'null' : typeof candidate,
      action: 'hook_message_discarded',
    });
    const copy = { ...message };
    delete copy.originalBody;
    return copy;
  }

  /** `isStatusBroadcast` arm of {@link handleInboundMessage}: ingest into the status store, not the message pipeline. */
  private ingestInboundStatus(id: string, engine: IWhatsAppEngine, message: IncomingMessage): Promise<void> {
    // Status/Story posts arrive via the inbound path for some engines; ingest them into the
    // status store instead of the message pipeline. Mirrors the isStatusBroadcast guard in
    // onMessageCreate below: an own-send echo (fromMe) stays a plain drop — never ingested,
    // never dispatched — so a status you posted never re-appears in your own webhooks/API as
    // if a contact had posted it.
    if (message.fromMe) return Promise.resolve();
    const status = buildIncomingStatus(message);
    if (!status) return Promise.resolve();
    return (
      this.statusStore
        .ingest(id, status)
        // Dispatch only on a fresh insert: ingest also resolves with the pre-existing row
        // for a duplicate delivery (or the winner's row after a lost insert race), and the
        // webhook must fire once per status, not once per (re)delivery.
        .then(({ row, created }) => {
          // The ingest awaited; a stop()/delete() can retire this engine mid-flight — don't
          // dispatch for a session that no longer exists (mirrors message.received's re-check).
          if (!this.engines.isLive(id, engine)) return;
          if (created) this.dispatchStatusReceived(id, row);
        })
        .catch(err =>
          this.logger.warn('Status ingest failed', {
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
    );
  }

  /** Operator opt-out gate for disappearing messages: true when the message must be skipped entirely. */
  private shouldSkipEphemeralMessage(id: string, message: IncomingMessage): boolean {
    // Ephemeral/disappearing messages: skip persist + dispatch when the operator opted out.
    // A message is ephemeral when its chat has a disappearing-messages timer (ephemeralDuration > 0).
    if (
      !resolveFeatureFlags(this.configService).storeEphemeralMessages &&
      message.ephemeralDuration &&
      message.ephemeralDuration > 0
    ) {
      this.logger.debug('Skipping ephemeral message', {
        sessionId: id,
        messageId: message.id,
        chatId: message.chatId,
        ephemeralDuration: message.ephemeralDuration,
      });
      return true;
    }
    return false;
  }

  /** Post-hook continuation of {@link handleInboundMessage} that may run concurrently: resolve the sender. */
  private async prepareInboundMessage(id: string, finalMessage: InboundMessageData): Promise<InboundMessageData> {
    // `continue: false` is deliberately NOT read here. It means "stop the handler chain", which
    // HookManager has already done — the plugins after the one that returned it never ran. It
    // does not mean "this message never happened".
    //
    // Honouring it here used to skip everything below: the message was never written to the
    // messages table, never dispatched to webhooks, and never emitted over the websocket. An
    // auto-reply plugin returning `false` for its ordinary purpose — keeping other bots from
    // answering the same message — silently erased the customer's message from the operator's
    // own history, leaving a thread of bot replies answering nothing. Nothing in the hook
    // contract (`HookResult.continue`, docs/19) or the webhook contract (`message.received`
    // fires when "an inbound message arrives", docs/06) hinted at that, and a sandboxed
    // marketplace plugin could swallow a session's entire inbound traffic with no audit trail.
    //
    // The message has already arrived at WhatsApp. A plugin can stop other plugins from acting
    // on it; it cannot make the gateway forget it. Pre-action hooks are where a veto belongs —
    // `message:sending` blocks a send that has not happened yet (core/hooks/sending-gate.ts).

    // Persist the incoming message so the dashboard chats view can render history.
    const incoming: IncomingMessage = finalMessage;

    // Inline @lid -> phone resolution (#263), opt-in via RESOLVE_LID_TO_PHONE. Best-effort:
    // attaches senderPhone (digits or null) before persist/dispatch so webhook/ws consumers
    // get it in a single pass. Only for privacy-id senders, so no lookup for normal numbers.
    if (resolveFeatureFlags(this.configService).resolveLidToPhone && incoming.isLidSender && !incoming.fromMe) {
      incoming.senderPhone = await this.lidResolver.resolveSenderPhone(id, incoming.author ?? incoming.from);
    }
    return finalMessage;
  }

  /** Per-chat, in-order stage of {@link handleInboundMessage}: persist, then dispatch. */
  private async commitInboundMessage(
    id: string,
    engine: IWhatsAppEngine,
    finalMessage: InboundMessageData,
  ): Promise<InboundOutcome | undefined> {
    const outcome = await this.persistInboundMessage(id, engine, finalMessage);
    if (outcome === 'repeat') return this.judgeRepeat(id, finalMessage);
    if (outcome) this.dispatchInboundMessage(id, finalMessage, outcome);
    return undefined;
  }

  /**
   * Whether a message the insert refused as a repeat is another message than the one holding its id.
   * A re-fire of the same message is not, but an id reused from another chat, another side of the
   * conversation or another author of a group is: the engine is told, so its copy under that id does
   * not stand in for the stored message. Judged by the rule that refuses a change aimed at the row, so
   * what that rule would refuse to edit is not this message. A row that cannot be read, or that does
   * not prove a difference, says nothing and the engine keeps its copy.
   */
  private async judgeRepeat(id: string, message: InboundMessageData): Promise<InboundOutcome | undefined> {
    const reason = await this.mutationProjector.foreignRowReason(
      id,
      storableWaMessageId(message.id) ?? '',
      claimOf(message),
    );
    if (!reason) return undefined;
    this.logger.warn('Dropping a message that reuses the id of a different stored message', {
      sessionId: id,
      messageId: message.id,
      reason,
      action: 'message_id_reused',
    });
    return { conflict: true };
  }

  /**
   * Build the inbound row and insert it under the UNIQUE dedup oracle. Returns the row plus whether
   * the insert landed, 'repeat' when the id already has a row (an engine re-fire, or another message
   * under the same id), or null when the pipeline must stop (stale engine).
   */
  private async persistInboundMessage(
    id: string,
    engine: IWhatsAppEngine,
    incoming: IncomingMessage,
  ): Promise<InboundPersistOutcome | 'repeat' | null> {
    const metadata = buildMessageMetadata(incoming);

    const chatName = incoming.contact?.pushName ?? incoming.contact?.name ?? undefined;

    const dbMessage = this.messageRepository.create({
      sessionId: id,
      waMessageId: storableWaMessageId(incoming.id),
      chatId: incoming.chatId,
      chatName,
      // Group poster (participant JID) — `from` is the group JID, so this is the stable
      // sender identity the chat view keys attribution runs/colors on. Undefined for 1:1.
      author: incoming.author,
      from: incoming.from,
      to: incoming.to,
      body: incoming.body,
      type: incoming.type,
      direction: incoming.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
      timestamp: incoming.timestamp,
      status: MessageStatus.SENT,
      metadata,
    });

    // The hook chain above is async; a delete()/teardown can retire this engine while it
    // awaits. Re-check liveness so a late continuation can't persist an orphan messages row
    // (the row has no FK, so a session-delete cleanup would never reap it) or dispatch for a
    // session that no longer exists. Mirrors the synchronous isLiveEngine gate at entry.
    if (!this.engines.isLive(id, engine)) return null;
    const insertedCleared = this.applyHeldChanges(id, dbMessage);

    // De-duplicate at the source: the engine can re-fire `message` for one inbound message
    // (#464). UNIQUE(sessionId, waMessageId) makes the insert the atomic dedup oracle — a
    // near-simultaneous re-fire loses the race and is skipped here, so persist + webhook + WS
    // happen exactly once. Fail-open: a non-conflict DB error still dispatches, so a real
    // message is never dropped by a transient DB failure.
    const outcome = await this.insertWithRetry(id, engine, dbMessage, 'incoming');
    if (outcome.landed === 'yes') {
      this.applyChangesMadeInFlight(id, incoming.id, insertedCleared);
      return { dbMessage, persisted: true };
    }
    if (outcome.landed === 'stale') return null;
    // A duplicate on the first attempt is a re-fire: the original already persisted and dispatched.
    // A duplicate on the retry is ambiguous: the first attempt may have committed before its error,
    // in which case nothing dispatched yet, so dispatch fail-open (without the row-bound hook), and
    // that row still has to take a revoke or edit that arrived in flight.
    if (outcome.landed === 'dup' && !outcome.retried) return 'repeat';
    if (outcome.landed === 'dup') this.applyChangesMadeInFlight(id, incoming.id, false, claimOf(incoming));
    return { dbMessage, persisted: false };
  }

  /**
   * PostgreSQL holds a message from its arrival, so a revoke or edit often lands before its row: write
   * the row as the change leaves it, so `message:persisted` and the media archive never see content
   * that was taken back. A change landing during the insert is still applied after it. Returns whether
   * the row is written cleared.
   */
  private applyHeldChanges(id: string, dbMessage: Message): boolean {
    if (!this.holdsInbound) return false;
    const entry = dbMessage.waMessageId ? this.inboundInFlight.get(`${id}:${dbMessage.waMessageId}`) : undefined;
    if (entry?.revoked) Object.assign(dbMessage, REVOKED_ROW_PATCH);
    else {
      if (entry?.editedBody !== undefined) dbMessage.body = entry.editedBody;
      if (entry?.edited) dbMessage.metadata = { ...dbMessage.metadata, edited: true };
    }
    return entry?.revoked === true;
  }

  /**
   * Insert a message row under the UNIQUE(sessionId, waMessageId) dedup oracle. `insert()` (not
   * `save()`) is load-bearing: a duplicate insert throws, which is the atomic dedup oracle for #464
   * re-fires. A transient failure is retried once after {@link PERSIST_RETRY_DELAY_MS}, re-checking
   * that the engine is still live so a retired session never gets an orphan row. On success the
   * DB-generated columns are merged onto `dbMessage`.
   */
  private async insertWithRetry(
    id: string,
    engine: IWhatsAppEngine,
    dbMessage: Message,
    direction: 'incoming' | 'outgoing',
  ): Promise<InsertOutcome> {
    const label = `Failed to save ${direction} message ${dbMessage.waMessageId} to database`;
    const insert = async (): Promise<InsertOutcome> => {
      const result = await this.messageRepository.insert(dbMessage as unknown as QueryDeepPartialEntity<Message>);
      // `insert()` (not `save()`) does NOT merge DB-generated columns (@PrimaryGeneratedColumn,
      // @CreateDateColumn) back onto the entity instance — so merge them explicitly here, before
      // the `message:persisted` emit. `identifiers[0]` always carries the PK on both SQLite and
      // Postgres; `generatedMaps[0]` adds createdAt where the driver returns it (Postgres yes;
      // SQLite historically does not — acceptable; the PK is the load-bearing field for plugins).
      Object.assign(dbMessage, result.identifiers[0] ?? {}, result.generatedMaps?.[0] ?? {});
      return { landed: 'yes' };
    };
    try {
      return await insert();
    } catch (err) {
      if (isUniqueViolation(err)) return { landed: 'dup', retried: false };
      if (!isTransientDbError(err)) {
        this.logger.error(label, String(err));
        return { landed: 'failed' };
      }
      this.logger.warn(`${label}, retrying once`, { sessionId: id, error: String(err) });
    }
    await new Promise(resolve => setTimeout(resolve, PERSIST_RETRY_DELAY_MS));
    if (!this.engines.isLive(id, engine)) return { landed: 'stale' };
    try {
      return await insert();
    } catch (err) {
      if (isUniqueViolation(err)) return { landed: 'dup', retried: true };
      this.logger.error(label, String(err));
      return { landed: 'failed' };
    }
  }

  /**
   * Write a revoke, edit, reaction or ack that arrived before the message's row existed onto the row
   * just inserted: its own write matched no row then. Queued on the message's mutation chain, so it
   * lands after any edit already queued, and a revoke wins over the rest. A change arriving after the
   * insert finds the row itself. Reactions are only stored here; their event already went out. A row
   * inserted cleared is cleared again, in case a change raced the insert, without announcing it:
   * `message:persisted` already carried it cleared. Where the insert lost, a pending revoke announces the
   * row it clears, which an earlier revoke may have cleared and announced already, and a revoke event still
   * waiting for its own row read when the insert lands announces it once more: a consumer may see the
   * cleared row more than once under the same id.
   *
   * `lostInsert`, set when the delivery's insert lost to a row under the id, says what the delivery claims
   * to be. That row may be the message itself (its first attempt committed before the error) or another
   * message's (an id reused from another chat): the changes go to it only if it is the message. The
   * judgement is the first step of the slot taken on the chain here, not a read ahead of it, so a change
   * of the message that arrives while the row is read queues behind the write instead of being
   * overwritten by it.
   */
  private applyChangesMadeInFlight(
    id: string,
    waMessageId: string,
    insertedCleared = false,
    lostInsert?: MutationSource,
  ): void {
    const pending = waMessageId ? this.inboundInFlight.get(`${id}:${waMessageId}`) : undefined;
    if (!pending) return;
    const { ackStatus } = pending;
    const rowChanges = Boolean(
      pending.revoked || pending.editedBody !== undefined || pending.edited || pending.reactions,
    );
    if (!ackStatus && !rowChanges) return;
    const advance = (): void => {
      if (!ackStatus) return;
      void this.advanceAck(id, waMessageId, ackStatus).catch(err =>
        this.logger.error(`Failed to advance ack for ${waMessageId}`, String(err)),
      );
    };
    if (!lostInsert) {
      advance();
      if (rowChanges) {
        this.enqueueMessageMutation(id, waMessageId, () =>
          this.writeChangesMadeInFlight(id, waMessageId, pending, insertedCleared),
        );
      }
      return;
    }
    this.enqueueMessageMutation(id, waMessageId, async () => {
      const reason = await this.mutationProjector.foreignRowReason(id, waMessageId, lostInsert);
      if (reason) {
        this.logger.warn('Not applying the changes of a message to the stored message that holds its id', {
          sessionId: id,
          messageId: waMessageId,
          reason,
        });
        return;
      }
      advance();
      await this.writeChangesMadeInFlight(id, waMessageId, pending, insertedCleared);
    });
  }

  /** The row part of {@link applyChangesMadeInFlight}. Must run on the mutation chain. */
  private async writeChangesMadeInFlight(
    id: string,
    waMessageId: string,
    pending: InFlightEntry,
    insertedCleared: boolean,
  ): Promise<void> {
    if (pending.revoked) return this.revokeRow(id, waMessageId, !insertedCleared);
    try {
      if (pending.editedBody !== undefined) {
        await this.messageRepository.update({ sessionId: id, waMessageId }, { body: pending.editedBody });
      }
      if (pending.reactions) await this.storeReactions(id, waMessageId, pending.reactions);
      // The marker an edit of a stored row leaves, written last so a lost metadata race costs it alone.
      if (pending.edited) await this.mutationProjector.markMessageEdited(id, waMessageId);
    } catch (err) {
      this.logger.error(`Failed to apply changes to message ${waMessageId}`, String(err));
    }
  }

  /** Merge reactions into the row's metadata, withdrawing a sender's on ''. Must run on the mutation chain. */
  private async storeReactions(id: string, waMessageId: string, changes: Record<string, string>): Promise<void> {
    await updateMessageMetadata(this.messageRepository, { sessionId: id, waMessageId }, metadata => {
      const reactions = { ...(metadata.reactions as Record<string, string> | undefined) };
      for (const [sender, reaction] of Object.entries(changes)) {
        if (reaction) reactions[sender] = reaction;
        else delete reactions[sender];
      }
      return { ...metadata, reactions };
    });
  }

  /**
   * Clear a revoked message's stored row, on the message's mutation chain so a reaction or edit queued
   * before it cannot write content back afterwards. Used by the engine's revoke event and by the REST
   * delete. Best-effort like every stored-message mutation: never rejects, and resolves once the write
   * has run.
   *
   * With `source`, the caller has not had the stored row judge the revoke yet: the message still arriving
   * is taken back only if the revoke agrees with it, and the row is cleared only if the revoke is not
   * foreign to it. Without one, the revoke was judged by the caller (the engine's revoke event is).
   */
  recordRevoke(sessionId: string, waMessageId: string, source?: MutationSource): Promise<void> {
    // A message not written yet takes the revoke once its row lands; the UPDATE below matches nothing.
    const inFlight = this.inboundInFlight.get(`${sessionId}:${waMessageId}`);
    if (inFlight && !(source && this.foreignToInFlight(inFlight, source))) this.holdRevoked(sessionId, inFlight);
    return new Promise(resolve =>
      this.enqueueMessageMutation(sessionId, waMessageId, () =>
        this.revokeRow(sessionId, waMessageId, true, source).finally(resolve),
      ),
    );
  }

  /** Take back a message not written yet: its row is stored cleared, and media waiting for room needs none. */
  private holdRevoked(sessionId: string, entry: InFlightEntry): void {
    entry.revoked = true;
    for (const t of this.tickets.get(sessionId) ?? []) if (t.entry === entry) t.giveUp();
  }

  /**
   * Apply {@link REVOKED_ROW_PATCH}, then hand the cleared row to `message:persisted` so a plugin index
   * keyed by row id drops the content too. Must run on the message's mutation chain. The row is the
   * table's one under the id, which another chat's message may hold: a `source` that the row proves
   * foreign leaves it alone.
   */
  private async revokeRow(
    sessionId: string,
    waMessageId: string,
    notify = true,
    source?: MutationSource,
  ): Promise<void> {
    // An undefined condition is DROPPED from the where-clause, which would clear every row of the session.
    if (!waMessageId) return;
    try {
      const reason = source && (await this.mutationProjector.foreignRowReason(sessionId, waMessageId, source));
      if (reason) {
        this.logger.warn('Dropping a revoke aimed at a message of another chat or sender', {
          sessionId,
          messageId: waMessageId,
          reason,
        });
        return;
      }
      const result = await this.messageRepository.update({ sessionId, waMessageId }, REVOKED_ROW_PATCH);
      this.markedEdited.get(sessionId)?.delete(waMessageId);
      if (!result?.affected || !notify) return;
      const row = await this.messageRepository.findOne({ where: { sessionId, waMessageId } });
      if (!row) return;
      void this.hookManager
        .execute('message:persisted', { sessionId, message: row }, { sessionId, source: 'SessionService' })
        .catch(() => undefined);
    } catch (err) {
      this.logger.error(`Failed to clear revoked message ${waMessageId}`, String(err));
    }
  }

  /** Fan an accepted inbound message out: `message:persisted` plugin hook, webhook, websocket emit. */
  private dispatchInboundMessage(id: string, finalMessage: InboundMessageData, outcome: InboundPersistOutcome): void {
    const { dbMessage, persisted } = outcome;
    // Fire-and-forget: a plugin handler must never break the receive path. Both engine adapters
    // (wwjs `message` and Baileys `upsert`) converge on this persist, so one emit covers inbound.
    // The built-in FTS search provider is DB-synced and does NOT consume this; it exists for
    // plugin providers (Spec 2) + general use.
    // Gate ONLY the hook on `persisted`: on a non-unique insert error (transient SQLITE_BUSY /
    // lock-timeout / connection drop) the row was never stored and `dbMessage.id` is undefined,
    // so emitting `message:persisted` would hand plugins an id-less payload for a row that isn't
    // in the DB. The webhook/WS dispatch below stays fail-open — a real inbound message must
    // never be dropped on a transient DB failure; only the hook requires a durable row.
    if (persisted) {
      void this.hookManager
        .execute(
          'message:persisted',
          { sessionId: id, message: dbMessage },
          { sessionId: id, source: 'SessionService' },
        )
        .catch(() => undefined);

      // Fire-and-forget for the same reason as the hook above: the receive path must not wait on
      // storage. Gated on `persisted` because the archive updates the row by id, and on a failed
      // insert there is no row to point at the file. A no-op unless archiving is enabled.
      void this.chatMediaArchive?.archive(dbMessage).catch(() => undefined);
    }

    const announced = this.withChangesMadeInFlight(id, finalMessage);
    if (!announced) return;
    // Dispatch to webhooks with potentially modified message
    void this.webhookService.dispatch(id, 'message.received', announced);
    // Autoreply rules ride the same at-most-once dispatch (the insert oracle above dedupes engine
    // re-fires) and stay fail-open like the webhook: a broken rule must never break the receive path.
    void this.automationRules?.evaluateInbound(id, announced).catch(() => undefined);
    // Emit real-time event to WebSocket clients
    this.eventsGateway.emitMessage(id, announced);
  }

  /**
   * The message as a revoke or edit that arrived while it was in flight left it, for its announcement:
   * null once the engine revoked it (message.revoked already went out, so the deleted content is not
   * announced after it), the revoked placeholder when only the REST delete did (a delete-for-me emits no
   * engine revoke, and the message still exists for its sender) or when it was delivered deleted, the edited
   * body when edited (message.edited already went out with it), plus `edited: true` when the row is marked
   * for it or already was (`rowMarked`): a consumer that held no copy of the message could not apply that
   * event. The stored row takes the same changes in {@link applyChangesMadeInFlight}.
   */
  private withChangesMadeInFlight(
    id: string,
    message: InboundMessageData,
    rowMarked = false,
  ): (InboundMessageData & { edited?: true }) | null {
    const pending = this.inboundInFlight.get(`${id}:${message.id}`);
    if (pending?.revokeAnnounced) return null;
    if (pending?.revoked || message.type === 'revoked') {
      // Nothing of the content survives, as in REVOKED_ROW_PATCH: no edit held for it, and no mark.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { media, quotedMessage, call, buttons, button, location, order, product, poll, mentionedIds, ...kept } =
        message;
      return { ...kept, body: '', type: 'revoked' };
    }
    const edited = rowMarked || pending?.edited;
    // An edit the engine applied before the hand-over is in the body already.
    if (pending?.editedBody === undefined) return edited ? { ...message, edited: true as const } : message;
    return { ...message, body: pending.editedBody, ...(edited ? { edited: true as const } : {}) };
  }

  /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
  handleOwnSendEcho(id: string, engine: IWhatsAppEngine, message: IncomingMessage, ticket?: InboundTicket): void {
    const turn = ticket instanceof InboundTurn ? ticket : undefined;
    try {
      this.receiveOwnSendEcho(id, engine, message, turn);
    } finally {
      turn?.drop();
    }
  }

  /** {@link handleOwnSendEcho} with the ticket resolved; every early return leaves the ticket to be dropped. */
  private receiveOwnSendEcho(id: string, engine: IWhatsAppEngine, message: IncomingMessage, turn?: InboundTurn): void {
    if (!this.engines.isLive(id, engine)) return;
    // `message_create` fires for every message the account creates, including sends composed on a
    // linked phone — which the `message`/`onMessage` event never delivers. Incoming messages are
    // already handled by `onMessage`, so only outgoing (`fromMe`) ones produce `message.sent` here.
    if (!message.fromMe) {
      return;
    }

    // Status/Story posts are account-created but not real conversations; don't emit `message.sent`
    // for them. The adapter flags these (the engine-specific pseudo-JID stays out of this layer).
    if (message.isStatusBroadcast) {
      return;
    }

    this.logger.debug(`Message sent to ${message.to}`, {
      sessionId: id,
      messageId: message.id,
      to: message.to,
      action: 'message_sent',
    });
    // Update last active timestamp
    void this.sessionRepository.update(id, { lastActiveAt: new Date() }).catch(() => undefined);
    const messageData = { ...message };
    delete messageData.originalBody;

    const onFailure = (err: unknown): null => {
      this.logger.error(`onMessageCreate handler failed for ${id}`, String(err));
      return null;
    };
    // The commit may wait behind a slow earlier message of the chat; a revoke, edit or ack of this
    // send landing meanwhile is recorded here and applied once the row is written. Like the inbound
    // path, the entry follows the chain's rewrites, so a quote carries what the row will hold.
    const inFlightKey = `${id}:${message.id}`;
    const inFlight = turn
      ? Object.assign(turn.entry, { quote: quoteOf(messageData), ref: turn.entry.ref ?? refOf(messageData) })
      : this.trackInFlight(inFlightKey, messageData);
    this.arrive(inFlight, message);
    // Execute hook for message sent - plugins can modify or stop processing. Like the inbound path,
    // the hook chain runs concurrently and the commit waits its turn on the chat's queue.
    const prepared = this.startHookChain(id, engine, turn, messageData, () =>
      this.hookManager
        .execute('message:sent', messageData, {
          sessionId: id,
          source: 'Engine',
          accept: data => {
            if (!isMessagePayload(data)) return false;
            inFlight.quote = quoteOf(data);
            return true;
          },
        })
        .then(({ data }) => this.messageOrEngineCopy(id, 'message:sent', data, message)),
    ).catch(onFailure);
    this.commitInTurn(id, message, turn, async () => {
      try {
        const finalMessage = await prepared;
        if (finalMessage) await this.commitOwnSendEcho(id, engine, finalMessage);
      } catch (err) {
        onFailure(err);
      } finally {
        if (!turn) this.untrackInFlight(inFlightKey, inFlight);
      }
    });
  }

  /** Per-chat, in-order stage of {@link handleOwnSendEcho}: persist, then dispatch `message.sent`. */
  private async commitOwnSendEcho(
    id: string,
    engine: IWhatsAppEngine,
    finalMessage: InboundMessageData,
  ): Promise<void> {
    // `continue: false` is not read here, for the same reason as the message:received path
    // above: the send has already happened, so a plugin can stop the handler chain but cannot
    // un-send it. Skipping the persist below dropped the operator's own outgoing message from
    // history and from `message.sent` webhooks.

    // Persist the outgoing message so local history reflects sends composed on a linked phone
    // (message_create is the ONLY event those produce). It also fires for API-originated sends,
    // which the REST send path persists itself; the UNIQUE(sessionId, waMessageId) index is
    // the atomic dedup oracle between the two writers: the loser skips its insert, and
    // persistSentState additionally drops its redundant PENDING row when the echo won. The
    // webhook/WS dispatch below is identical whether the insert won, lost, or failed: the
    // message.sent contract is unchanged.
    const outgoing: IncomingMessage = finalMessage;
    const metadata = buildMessageMetadata(outgoing, true);

    // The ephemeral opt-out gates STORAGE only (mirrors onMessage); the live dispatch below
    // is today's contract and stays.
    const mayPersist =
      resolveFeatureFlags(this.configService).storeEphemeralMessages ||
      !(outgoing.ephemeralDuration && outgoing.ephemeralDuration > 0);

    let rowMarked = false;
    if (mayPersist) {
      const dbMessage = this.messageRepository.create({
        sessionId: id,
        waMessageId: storableWaMessageId(outgoing.id),
        chatId: outgoing.chatId,
        from: outgoing.from,
        to: outgoing.to,
        body: outgoing.body,
        type: outgoing.type,
        direction: MessageDirection.OUTGOING,
        timestamp: outgoing.timestamp,
        status: MessageStatus.SENT,
        metadata,
      });
      // The hook chain above is async; a delete()/teardown can retire this engine while it
      // awaits. Re-check liveness so a late continuation can't persist an orphan row
      // (mirrors onMessage).
      if (!this.engines.isLive(id, engine)) return;
      const insertedCleared = this.applyHeldChanges(id, dbMessage);
      // A unique violation means the REST send path already persisted this API-originated
      // send: the dedup oracle working as intended, not an error. Any other failure (after the
      // one transient retry) fails open, so a real send is never dropped on a DB fault.
      const outcome = await this.insertWithRetry(id, engine, dbMessage, 'outgoing');
      if (outcome.landed === 'stale') return;
      // The REST writer may have won either attempt; its row still takes the echo's pending changes.
      if (outcome.landed === 'dup') {
        this.applyChangesMadeInFlight(id, outgoing.id, false, claimOf(outgoing));
        // That row may be older than this delivery and edited since, the edit still being written: announced once the
        // changes queued for the message have run, with the mark they left.
        rowMarked = await new Promise<boolean>(resolve =>
          this.enqueueMessageMutation(id, outgoing.id, () =>
            Promise.resolve(resolve(this.markedEdited.get(id)?.has(outgoing.id) === true)),
          ),
        );
      }
      if (outcome.landed === 'yes') {
        // The id had no row, so a mark remembered for it was of a row removed since.
        this.markedEdited.get(id)?.delete(outgoing.id);
        this.applyChangesMadeInFlight(id, outgoing.id, insertedCleared);
        // Fire-and-forget, mirroring onMessage: plugin providers (search etc.) see phone-
        // composed sends exactly like API sends.
        void this.hookManager
          .execute(
            'message:persisted',
            { sessionId: id, message: dbMessage },
            { sessionId: id, source: 'SessionService' },
          )
          .catch(() => undefined);

        // Archive this send's media, mirroring onMessage. This is the ONLY path a phone-composed
        // send takes, so the REST-side chokepoint would never see it. Opt-in twice over
        // (CHAT_MEDIA_ARCHIVE_ENABLED + _OUTBOUND) and a no-op otherwise; archive() itself
        // refuses a row that is already archived, so the REST writer racing us costs at most one
        // duplicate file write, which archive() deletes because the first pointer wins.
        if (this.configService?.get<boolean>('chatMedia.archiveOutbound', false) === true) {
          void this.chatMediaArchive?.archive(dbMessage).catch(() => undefined);
        }
      }
    }

    const sent = this.withChangesMadeInFlight(id, finalMessage, rowMarked);
    if (!sent) return;
    void this.webhookService.dispatch(id, 'message.sent', sent);
    // Emit real-time event to WebSocket clients (as message.sent, not message.received)
    this.eventsGateway.emitMessageSent(id, sent);
  }

  /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
  handleMessageAck(
    id: string,
    engine: IWhatsAppEngine,
    messageId: string,
    status: DeliveryStatus,
    chatId?: string,
  ): void {
    if (!this.engines.isLive(id, engine)) return;
    this.logger.debug(`Message ack: ${messageId} -> ${status}`, {
      sessionId: id,
      messageId,
      status,
      action: 'message_ack',
    });

    // Reflect real delivery state on the stored message (#220): delivered/read/failed advance the
    // stored status; pending/sent carry no upgrade (it's already SENT — visibly "not delivered").
    // The UPDATE is guarded to the allowed prior statuses so delivery state only ADVANCES: an
    // out-of-order/late ack cannot downgrade a higher status, which also makes these
    // fire-and-forget writes race-safe at the DB level.
    const messageStatus = deliveryStatusToMessageStatus(status);
    if (messageStatus) {
      // A message not written yet (its commit waits behind an earlier one of the chat) keeps the
      // furthest ack for when its row lands; the UPDATEs below would match nothing.
      const inFlight = this.inboundInFlight.get(`${id}:${messageId}`);
      if (inFlight && (!inFlight.ackStatus || ackStatusTransitionFrom(messageStatus).includes(inFlight.ackStatus))) {
        inFlight.ackStatus = messageStatus;
      }
      const advanceAck = (): Promise<number> => this.advanceAck(id, messageId, messageStatus);

      const logNoop = (): void =>
        this.logger.debug(`Message ack ${messageId}: no status row advanced to ${messageStatus} (${status})`, {
          sessionId: id,
          messageId,
          status,
          action: 'message_ack_noop',
        });

      const onAckError = (err: unknown): void =>
        this.logger.error(`Failed to advance ack for ${messageId}`, String(err));

      void advanceAck()
        .then(affected => {
          if (affected > 0) return;
          // affected:0 — most likely the send's 2nd save (which writes waMessageId) hasn't committed
          // yet, so the row isn't matchable. Each ack is one-shot (WhatsApp won't necessarily resend),
          // so retry ONCE after a short delay to close that race rather than leave it stuck at SENT.
          const timer = setTimeout(() => {
            void advanceAck()
              .then(retried => {
                if (retried === 0) logNoop();
              })
              .catch(onAckError);
          }, ACK_RECONCILE_DELAY_MS);
          timer.unref?.();
        })
        .catch(onAckError);
    }

    // One ack payload, emitted identically over the socket and the webhook so a client coded
    // against either channel sees the same shape. `id` mirrors the field every other message.*
    // event carries (and the idempotency-key resolver reads). `ack` is a deprecated legacy field
    // kept for backward compatibility — new consumers should read the neutral `status`. `chatId`
    // rides along when the engine's update names the chat, so a webhook `chatId` condition scopes
    // ack and failure events to that chat instead of suppressing them outright.
    const ackPayload = {
      id: messageId,
      messageId,
      status,
      ack: deliveryStatusToAck(status),
      ...(chatId ? { chatId } : {}),
    };

    // Push the live delivery/read tick to the dashboard over the websocket.
    this.eventsGateway.emitMessageAck(id, ackPayload);

    // Dispatch the delivery/read receipt to webhooks (#155). Outgoing `message.sent` is handled
    // solely by `onMessageCreate`, so the ack path deliberately does NOT emit `message.sent`.
    void this.webhookService.dispatch(id, 'message.ack', ackPayload);

    // Surface delivery failures actively so consumers don't have to poll for them (#220). Use a
    // distinct object (not the shared ackPayload) so this separate event can't be perturbed by an
    // in-place payload mutation in the concurrent message.ack dispatch's webhook:before hook.
    if (status === 'failed') {
      void this.webhookService.dispatch(id, 'message.failed', { ...ackPayload });
    }

    // Notify plugins of the delivery/read receipt. The `message:ack` hook event was declared in
    // the HookEvent union but never emitted, so any plugin registered for it silently never fired.
    // Fire-and-forget: an ack is a notification with nothing downstream to cancel, so the hook's
    // `continue` flag is moot. Delivery failures surface here as status `failed` — `message:failed`
    // stays reserved for send-time send failures, which carry a distinct `{ error, input }` payload.
    void this.hookManager.execute(
      'message:ack',
      { messageId, status, ack: deliveryStatusToAck(status) },
      { sessionId: id, source: 'Engine' },
    );
  }

  /**
   * Engine callback body for one recipient's receipt (Baileys group and status messages). Nothing is
   * stored: the event is forwarded as is, over the socket and the webhook with the same shape. `id`
   * mirrors the other message.* events (and is what the idempotency-key resolver reads); `chatId` lets
   * webhook chatId filters scope it.
   */
  handleMessageReceipt(id: string, engine: IWhatsAppEngine, event: MessageReceiptEvent): void {
    if (!this.engines.isLive(id, engine)) return;
    const payload = {
      id: event.messageId,
      messageId: event.messageId,
      chatId: event.chatId,
      participant: event.participant,
      status: event.status,
      timestamp: event.timestamp,
    };
    this.eventsGateway.emitMessageReceipt(id, payload);
    void this.webhookService.dispatch(id, 'message.receipt', payload);
  }

  /**
   * Advance a stored message's delivery status, returning the rows changed. Scoped by sessionId:
   * waMessageId is unique per account/chat, not global, so an ack on one session must never advance a
   * same-id row in another session. The In() guard makes the UPDATE forward-only (a late/out-of-order
   * ack can't downgrade) and idempotent on retry.
   */
  private advanceAck(id: string, messageId: string, messageStatus: MessageStatus): Promise<number> {
    return this.messageRepository
      .update(
        { sessionId: id, waMessageId: messageId, status: In(ackStatusTransitionFrom(messageStatus)) },
        { status: messageStatus },
      )
      .then(result => result.affected ?? 0);
  }

  /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
  handleMessageRevoked(
    id: string,
    engine: IWhatsAppEngine,
    message: RevokedMessage,
    actor?: { fromMe: boolean },
  ): void {
    if (!this.engines.isLive(id, engine)) return;
    this.logger.debug(`Message revoked: ${message.id}`, {
      sessionId: id,
      messageId: message.id,
      action: 'message_revoked',
    });

    // Clear the stored message (best-effort; the message may not be in the DB). The
    // dashboard renders the localized "message deleted" text, so no display string is
    // persisted here.
    //
    // Match on `revokedId` (the ORIGINAL deleted message's id) when present: on wwebjs
    // `message.id` is the revocation notification, which never matches a stored row.
    // `revokedId` falls back to `id` (Baileys, where the two are the same).
    const revokedWaMessageId = message.revokedId ?? message.id;
    const apply = (): void => {
      void this.recordRevoke(id, revokedWaMessageId);
      const inFlight = this.inboundInFlight.get(`${id}:${revokedWaMessageId}`);
      if (inFlight) inFlight.revokeAnnounced = true;

      // Notify consumers regardless of whether the row existed: webhook (message.revoked
      // is a declared event) + the real-time dashboard stream.
      const revokedPayload = message as unknown as Record<string, unknown>;
      void this.webhookService.dispatch(id, 'message.revoked', revokedPayload);
      this.eventsGateway.emitMessageRevoked(id, revokedPayload);
    };
    // whatsapp-web.js reports only what WhatsApp Web itself accepted, so it passes no actor and is applied at
    // once: its ids name the chat, so no row of another chat can hold the id. An engine that applies no
    // validation to a revoke says who made it, and the stored row says whose message it names: a revoke the
    // row proves foreign is dropped, announcement included.
    if (!actor) {
      apply();
      return;
    }
    const source = { kind: 'revoke', chatId: message.chatId, fromMe: actor.fromMe } as const;
    const inFlight = this.inboundInFlight.get(`${id}:${revokedWaMessageId}`);
    // A message still arriving, once the entry it is held under agrees with the revoke, is taken back at
    // once: waiting for a read would let its emit run, and announce the deleted content, first. That is all
    // the entry can vouch for. A repeat of an id sent from another chat is held under it too, and the row
    // under the id may be the other chat's message, which only the row can say: the announcement and the
    // clearing of the row wait for it.
    const held = inFlight !== undefined && !this.foreignToInFlight(inFlight, source);
    if (held) {
      this.holdRevoked(id, inFlight);
      inFlight.revokeAnnounced = true;
    }
    // Otherwise judged by the stored row, which a change the entry called foreign has to find, and accept.
    const needsRow = inFlight !== undefined && !held;
    void this.mutationProjector.storedRowVerdict(id, revokedWaMessageId, source).then(verdict => {
      if (!this.engines.isLive(id, engine)) return;
      if (verdict.reason || (needsRow && !verdict.exists)) {
        if (verdict.reason) {
          this.logger.warn('Dropping a revoke aimed at a message of another chat or sender', {
            sessionId: id,
            messageId: revokedWaMessageId,
            reason: verdict.reason,
          });
        }
        return;
      }
      apply();
    });
  }

  /** History backfill persist, extracted to message-history-projector.ts (stateless function). */
  persistHistoryMessages(id: string, engine: IWhatsAppEngine, messages: IncomingMessage[]): Promise<IncomingMessage[]> {
    return persistHistoryMessages(
      this.messageRepository,
      this.configService,
      id,
      messages,
      this.logger,
      () => this.engines.isLive(id, engine),
      row => {
        if (!this.engines.isLive(id, engine)) return;
        void this.hookManager
          .execute('message:persisted', { sessionId: id, message: row }, { sessionId: id, source: 'SessionService' })
          .catch(() => undefined);
      },
    );
  }

  /** Reaction apply, queued on the per-message mutation chain — see MessageMutationProjector. */
  applyReactionQueued(id: string, event: ReactionEvent): void {
    // A message not written yet keeps the reaction for its row; the live event still goes out now.
    const inFlight = event.messageId ? this.inboundInFlight.get(`${id}:${event.messageId}`) : undefined;
    let needsRow = false;
    if (inFlight) {
      // The row it will become would drop the change, so it is not kept for it. Nothing is announced on
      // that word alone either: a stored row of the same id (a repeat sent from another chat reached the
      // entry, not the message it repeats) is the one to ask, and without one the change goes no further.
      if (this.foreignToInFlight(inFlight, { kind: 'reaction', chatId: event.chatId })) needsRow = true;
      else (inFlight.reactions ??= {})[event.senderId] = event.reaction ?? '';
    }
    this.mutationProjector.applyReactionQueued(id, event, needsRow);
  }

  /** Edit apply, queued on the per-message mutation chain — see MessageMutationProjector. */
  applyMessageEditQueued(id: string, message: EditedMessage): void {
    const inFlight = this.inboundInFlight.get(`${id}:${message.messageId}`);
    let needsRow = false;
    if (inFlight) {
      // See applyReactionQueued: judged foreign, it is not kept for the row, and a stored row decides.
      const source = { kind: 'edit', chatId: message.chatId, fromMe: message.fromMe, author: message.author } as const;
      if (this.foreignToInFlight(inFlight, source)) needsRow = true;
      else this.holdEdit(inFlight, message.body);
    }
    this.mutationProjector.applyMessageEditQueued(id, message, needsRow);
  }

  /**
   * Whether a change names a message of another chat, or one it may not change, judged against the
   * message still waiting for its row. Recording it for the row would carry it into `message.received`
   * and the insert, past the check the row's own update applies.
   */
  private foreignToInFlight(inFlight: InFlightEntry, source: MutationSource): boolean {
    if (!inFlight.ref || !source.chatId) return false;
    const foreign = mutationTargetsForeignRow(inFlight.ref, source);
    if (foreign) {
      this.logger.warn('Not keeping a change aimed at a message of another chat or sender', {
        reason: foreign,
        kind: source.kind,
      });
    }
    return foreign !== null;
  }

  /** Queue a message-scoped mutation. A failed operation is isolated so later events still run. */
  enqueueMessageMutation(id: string, messageId: string, work: () => Promise<void>): void {
    this.mutationProjector.enqueueMessageMutation(id, messageId, work);
  }

  /** Stored-row update for a REST outbound edit, on the same mutation chain — see MessageMutationProjector. */
  recordOutboundMessageEdit(
    sessionId: string,
    messageId: string,
    body: string,
    source?: MutationSource,
  ): Promise<void> {
    // With a `source`, the message still arriving takes the edit only if it agrees with it, and the row
    // only if it is not foreign to it, as for recordRevoke.
    const inFlight = this.inboundInFlight.get(`${sessionId}:${messageId}`);
    if (inFlight && !(source && this.foreignToInFlight(inFlight, source))) {
      this.holdEdit(inFlight, body);
      // Asked for by the caller, and marked as the stored row is: the text it carries does not matter.
      inFlight.edited = true;
    }
    return this.mutationProjector.recordOutboundMessageEdit(sessionId, messageId, body, source);
  }

  /**
   * Dispatches the opt-in `status.received` webhook once an inbound status row is ingested, and
   * mirrors it over the websocket so the dashboard's statuses view refreshes live instead of
   * waiting for a focus refetch. `WebhookService.dispatch` already filters delivery to webhooks
   * whose `events` array includes `status.received`, so no extra gating is needed here. No media
   * bytes are included in the payload — consumers fetch media via the status media endpoint.
   */
  private dispatchStatusReceived(sessionId: string, row: StatusUpdate): void {
    const payload = {
      sessionId,
      statusId: row.waStatusId,
      contact: {
        id: row.contactJid,
        ...(row.contactName ? { name: row.contactName } : {}),
        ...(row.contactPushName ? { pushName: row.contactPushName } : {}),
      },
      type: row.type,
      ...(row.caption ? { caption: row.caption } : {}),
      hasMedia: Boolean(row.mediaPath) && !row.mediaOmitted,
      mediaOmitted: row.mediaOmitted,
      ...(row.omitReason ? { omitReason: row.omitReason } : {}),
      postedAt: row.postedAt,
      expiresAt: row.expiresAt,
    };
    void this.webhookService.dispatch(sessionId, 'status.received', payload);
    this.eventsGateway.emitStatusReceived(sessionId, payload);
  }
}
