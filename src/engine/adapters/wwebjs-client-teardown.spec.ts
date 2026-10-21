import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
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
});
