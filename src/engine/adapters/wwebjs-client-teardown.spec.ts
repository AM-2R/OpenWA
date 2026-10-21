import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';
import { countsTowardSendBreaker, sentNothing } from '../../modules/message/send-pacing.service';
import * as loadRemoteMediaModule from '../../common/media/load-remote-media';

/**
 * A teardown (stop, logout, a browser crash) lands while an operation is parked on an await of its own: a
 * recipient lookup, a media fetch, the lookup of a chat. The adapter is in one of two states by then. While
 * client.destroy() runs it still holds the client but already reports DISCONNECTED; once destroy() settles
 * the client is null. In both the operation must answer the retryable not-ready 409 without touching the
 * page: left alone, a closing page fails a send with a plain 500 that the send breaker counts, and a null
 * client fails every other operation with a TypeError 500.
 */

const CHAT = '628111@c.us';
const LID = '159442138038327@lid';
const MEDIA_URL = 'https://files.example.com/a.png';

interface Gate {
  /** Settled by `open`. */
  wait: Promise<void>;
  open: () => void;
  /** How many calls are parked on `wait`, so a test knows the operation is where it was meant to be. */
  parkedCalls: number;
  park: () => Promise<void>;
}

function gate(): Gate {
  let open!: () => void;
  const wait = new Promise<void>(resolve => {
    open = resolve;
  });
  const parked: Gate = {
    wait,
    open,
    parkedCalls: 0,
    park: () => {
      parked.parkedCalls += 1;
      return wait;
    },
  };
  return parked;
}

const PHASES = ['while destroy() runs', 'after destroy() settled'] as const;
type Phase = (typeof PHASES)[number];

/** A READY adapter around `client`, and a way to begin its teardown in either phase. */
function readyAdapter(client: Record<string, unknown>) {
  const destroyed = gate();
  const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
  (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
  (adapter as unknown as { client: unknown }).client = { ...client, destroy: jest.fn(() => destroyed.wait) };
  let teardown: Promise<void> | undefined;
  return {
    adapter,
    tearDown: async (phase: Phase): Promise<void> => {
      teardown = adapter.disconnect();
      if (phase === 'after destroy() settled') {
        destroyed.open();
        await teardown;
      }
    },
    finish: async (): Promise<void> => {
      destroyed.open();
      await teardown;
    },
  };
}

/** Let every pending microtask and the macrotasks queued before this call run. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

type Outcome = { value: unknown } | { error: unknown };

/** How an operation ended, kept apart so a resolved value cannot be mistaken for a rejection. */
const outcomeOf = (operation: Promise<unknown>): Promise<Outcome> =>
  operation.then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  );

const found = (wid: string): { _serialized: string } => ({ _serialized: wid });

const closedTarget = (): Error => new Error('Protocol error (Runtime.callFunctionOn): Target closed.');

interface Case {
  name: string;
  /** The client the operation runs against, with its first await parked on `parked`; `unreached` must stay uncalled. */
  build: (parked: Gate) => { client: Record<string, unknown>; unreached?: jest.Mock };
  run: (adapter: WhatsAppWebJsAdapter) => Promise<unknown>;
}

const mediaFetchParked = (parked: Gate): void => {
  jest
    .spyOn(loadRemoteMediaModule, 'loadRemoteMediaBuffer')
    .mockImplementation(() => parked.park().then(() => ({ data: Buffer.from([1]), mimetype: 'image/png' })));
};

const CASES: Case[] = [
  {
    name: 'a text send',
    build: parked => {
      const sendMessage = jest.fn();
      return {
        client: { getNumberId: () => parked.park().then(() => found(CHAT)), sendMessage },
        unreached: sendMessage,
      };
    },
    run: adapter => adapter.sendTextMessage(CHAT, 'hi'),
  },
  {
    name: 'an image status post',
    build: parked => {
      mediaFetchParked(parked);
      const sendMessage = jest.fn();
      return { client: { sendMessage }, unreached: sendMessage };
    },
    run: adapter => adapter.postImageStatus({ mimetype: 'image/png', data: MEDIA_URL }, {}),
  },
  {
    name: 'a profile picture upload',
    build: parked => {
      mediaFetchParked(parked);
      const setProfilePicture = jest.fn();
      return { client: { setProfilePicture }, unreached: setProfilePicture };
    },
    run: adapter => adapter.setProfilePicture({ mimetype: 'image/png', data: MEDIA_URL }),
  },
  {
    name: 'a group invite revoke',
    build: parked => {
      const evaluate = jest.fn();
      return {
        client: { getChatById: () => parked.park().then(() => ({ isGroup: true })), pupPage: { evaluate } },
        unreached: evaluate,
      };
    },
    run: adapter => adapter.revokeGroupInviteCode('120363@g.us'),
  },
  {
    name: 'a chat label change',
    build: parked => {
      const addOrRemoveLabels = jest.fn();
      const chat = { getLabels: () => Promise.resolve([]) };
      return {
        client: { getChatById: () => parked.park().then(() => chat), addOrRemoveLabels },
        unreached: addOrRemoveLabels,
      };
    },
    run: adapter => adapter.addLabelToChat(CHAT, '7'),
  },
  {
    name: 'a chat mute',
    build: parked => {
      const muteChat = jest.fn();
      return { client: { getChatById: () => parked.park().then(() => ({})), muteChat }, unreached: muteChat };
    },
    run: adapter => adapter.muteChat(CHAT, Date.now() + 60_000),
  },
  {
    // The phone behind the lid is read after the lookup; contacts has no other read after an await.
    name: 'a number check of a migrated contact',
    build: parked => {
      const getContactLidAndPhone = jest.fn();
      return {
        client: { getNumberId: () => parked.park().then(() => found(LID)), getContactLidAndPhone },
        unreached: getContactLidAndPhone,
      };
    },
    run: adapter => adapter.getNumberId('5511987654321'),
  },
  {
    // The client is read again after the lookup, inside a catch that answers a missing group with null.
    name: 'a group info read',
    build: parked => {
      const group = {
        isGroup: true,
        id: { _serialized: '120363@g.us' },
        name: 'G',
        participants: [],
        groupMetadata: {},
      };
      return { client: { getChatById: () => parked.park().then(() => group), info: { wid: found(CHAT) } } };
    },
    run: adapter => adapter.getGroupInfo('120363@g.us'),
  },
  {
    // The reply and forward legs send through the quoted Message's own client, never through the host accessor.
    name: 'a reply',
    build: parked => {
      const reply = jest.fn();
      const chat = { fetchMessages: () => Promise.resolve([{ id: { _serialized: 'Q1' }, reply }]) };
      return {
        client: { getNumberId: () => parked.park().then(() => found(CHAT)), getChatById: () => Promise.resolve(chat) },
        unreached: reply,
      };
    },
    run: adapter => adapter.replyToMessage(CHAT, 'Q1', 'hi'),
  },
  {
    // The history read precedes the send: a page that dies under it means nothing went out.
    name: 'a reply parked in its history read',
    build: parked => {
      const reply = jest.fn();
      const chat = { fetchMessages: () => parked.park().then(() => Promise.reject(closedTarget())) };
      return {
        client: { getNumberId: () => Promise.resolve(found(CHAT)), getChatById: () => Promise.resolve(chat) },
        unreached: reply,
      };
    },
    run: adapter => adapter.replyToMessage(CHAT, 'Q1', 'hi'),
  },
  {
    name: 'a forward parked in the read of its source chat',
    build: parked => {
      const forward = jest.fn();
      const source = { fetchMessages: () => parked.park().then(() => Promise.reject(closedTarget())) };
      return {
        client: { getNumberId: () => Promise.resolve(found(CHAT)), getChatById: () => Promise.resolve(source) },
        unreached: forward,
      };
    },
    run: adapter => adapter.forwardMessage('src@c.us', CHAT, 'M1'),
  },
  {
    name: 'a forward parked in the destination lookup',
    build: parked => {
      const forward = jest.fn();
      const chat = { fetchMessages: () => Promise.resolve([{ id: { _serialized: 'M1' }, forward }]) };
      return {
        client: { getNumberId: () => parked.park().then(() => found(CHAT)), getChatById: () => Promise.resolve(chat) },
        unreached: forward,
      };
    },
    run: adapter => adapter.forwardMessage('src@c.us', CHAT, 'M1'),
  },
  {
    name: 'a forward parked in the read of the destination chat',
    build: parked => {
      const forward = jest.fn();
      const source = { fetchMessages: () => Promise.resolve([{ id: { _serialized: 'M1' }, forward }]) };
      const destination = { fetchMessages: () => Promise.resolve([]) };
      return {
        client: {
          getNumberId: () => Promise.resolve(found(CHAT)),
          getChatById: (id: string) =>
            id === 'src@c.us' ? Promise.resolve(source) : parked.park().then(() => destination),
        },
        unreached: forward,
      };
    },
    run: adapter => adapter.forwardMessage('src@c.us', CHAT, 'M1'),
  },
];

describe('whatsapp-web.js operations that race a session teardown', () => {
  afterEach(() => jest.restoreAllMocks());

  describe.each(PHASES)('%s', phase => {
    it.each(CASES)('answers the not-ready 409 for $name, before it reaches the page', async testCase => {
      const parked = gate();
      const { client, unreached } = testCase.build(parked);
      const { adapter, tearDown, finish } = readyAdapter(client);

      const outcome = outcomeOf(testCase.run(adapter));
      await settle();
      expect(parked.parkedCalls).toBe(1);
      await tearDown(phase);
      parked.open();
      const result = await outcome;
      await finish();

      if (unreached) expect(unreached).not.toHaveBeenCalled();
      expect(result).toEqual({ error: expect.any(EngineNotReadyError) as unknown });
      const { error } = result as { error: unknown };
      expect(countsTowardSendBreaker(error)).toBe(false);
      expect(sentNothing(error)).toBe(true);
    });
  });

  describe('the send retry after "No LID for user"', () => {
    it.each(PHASES)('answers the not-ready 409, not an unreachable recipient, %s', async phase => {
      // The first send fails on a stale id; the re-resolve parks, and the lookup then fails on the closing page.
      const parked = gate();
      const sendMessage = jest.fn().mockRejectedValue(new Error('No LID for user'));
      const getNumberId = jest
        .fn()
        .mockResolvedValueOnce(found(CHAT))
        .mockImplementationOnce(() =>
          parked.park().then(() => Promise.reject(new Error('Protocol error: Target closed'))),
        );
      const { adapter, tearDown, finish } = readyAdapter({ getNumberId, sendMessage });

      const outcome = outcomeOf(adapter.sendTextMessage(CHAT, 'hi'));
      await settle();
      expect(parked.parkedCalls).toBe(1);
      await tearDown(phase);
      parked.open();
      const result = await outcome;
      await finish();

      expect(result).toEqual({ error: expect.any(EngineNotReadyError) as unknown });
      expect((result as { error: unknown }).error).not.toBeInstanceOf(RecipientUnreachableError);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it.each(PHASES)('does not retry a reply once the session is going away, %s', async phase => {
      // The re-resolve names a different id, which would normally be retried, here on the Message's own client.
      const parked = gate();
      const reply = jest.fn().mockRejectedValue(new Error('No LID for user'));
      const chat = { fetchMessages: () => Promise.resolve([{ id: { _serialized: 'Q1' }, reply }]) };
      const getNumberId = jest
        .fn()
        .mockResolvedValueOnce(found(LID))
        .mockImplementationOnce(() => parked.park().then(() => found(CHAT)));
      const { adapter, tearDown, finish } = readyAdapter({ getNumberId, getChatById: () => Promise.resolve(chat) });

      const outcome = outcomeOf(adapter.replyToMessage(CHAT, 'Q1', 'hi'));
      await settle();
      expect(parked.parkedCalls).toBe(1);
      await tearDown(phase);
      parked.open();
      const result = await outcome;
      await finish();

      expect(reply).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ error: expect.any(EngineNotReadyError) as unknown });
    });
  });

  it.each([
    ['a reply', (adapter: WhatsAppWebJsAdapter) => adapter.replyToMessage(CHAT, 'Q1', 'hi')],
    ['a forward', (adapter: WhatsAppWebJsAdapter) => adapter.forwardMessage('src@c.us', CHAT, 'M1')],
  ])('leaves an ordinary failure in the history read of %s untouched on a ready session', async (_kind, run) => {
    const boom = new Error('Evaluation failed: boom');
    const chat = { fetchMessages: () => Promise.reject(boom) };
    const { adapter, finish } = readyAdapter({
      getNumberId: () => Promise.resolve(found(CHAT)),
      getChatById: () => Promise.resolve(chat),
    });

    await expect(run(adapter)).rejects.toBe(boom);
    await finish();
  });

  it('keeps a send that was already on the wire an outcome-unknown failure', async () => {
    const onWire = gate();
    const sendMessage = jest.fn(() =>
      onWire.park().then(() => Promise.reject(new Error('Protocol error (Runtime.callFunctionOn): Target closed.'))),
    );
    const { adapter, tearDown, finish } = readyAdapter({
      getNumberId: () => Promise.resolve(found(CHAT)),
      sendMessage,
    });

    const outcome = outcomeOf(adapter.sendTextMessage(CHAT, 'hi'));
    await settle();
    expect(onWire.parkedCalls).toBe(1);
    await tearDown('while destroy() runs');
    onWire.open();
    const { error } = (await outcome) as { error: unknown };
    await finish();

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EngineNotReadyError);
    expect(countsTowardSendBreaker(error)).toBe(true);
    expect(sentNothing(error)).toBe(false);
  });
});
