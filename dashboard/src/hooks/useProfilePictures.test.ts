// The sidebar avatar batch asks the gateway for ids it does not hold yet, keeps what it was told for an
// hour, and keeps the previous pictures on screen while a smaller batch is out.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import type { useProfilePictures as useProfilePicturesFn } from './useProfilePictures.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let useProfilePictures: typeof useProfilePicturesFn;
const clients: QueryClient[] = [];

const HOUR = 60 * 60 * 1000;

// Every batch the gateway was asked for.
const requests: Array<{ sessionId: string; ids: string[] }> = [];
const urlFor = (sessionId: string, id: string) => `https://pps.example/${sessionId}/${id}`;
const everyUrl = (sessionId: string, ids: string[]) =>
  Promise.resolve(json({ pictures: Object.fromEntries(ids.map(id => [id, urlFor(sessionId, id)])) }));
let answer: (sessionId: string, ids: string[]) => Promise<Response> = everyUrl;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// The next request waits for the returned release, then gets the answer it would have had.
function holdNextAnswer(): () => void {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const previous = answer;
  answer = (sessionId, ids) => {
    answer = previous;
    return gate.then(() => previous(sessionId, ids));
  };
  return release;
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const match = /\/sessions\/([^/]+)\/contacts\/profile-pictures\?ids=(.*)$/.exec(url);
    if (!match) return Promise.resolve(json({ message: `unstubbed ${url}` }, 404));
    const ids = match[2].split(',').map(decodeURIComponent);
    requests.push({ sessionId: match[1], ids });
    return answer(match[1], ids);
  }) as typeof fetch;
  rtl = await import('@testing-library/react');
  ({ useProfilePictures } = await import('./useProfilePictures.ts'));
});

afterEach(async () => {
  rtl.cleanup();
  // Cancel before clearing: clear() silently cancels a fetch still in flight, whose settling then re-arms
  // the 30 minute gc timer of the query it just dropped, where nothing can clear it.
  for (const client of clients.splice(0)) {
    await client.cancelQueries();
    client.clear();
  }
  requests.length = 0;
  answer = everyUrl;
  focusManager.setFocused(undefined);
});

interface Props {
  sessionId: string | undefined;
  ids: string[];
}

function renderPictures(sessionId: string | undefined, ids: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return rtl.renderHook(({ sessionId, ids }: Props) => useProfilePictures(sessionId, ids), {
    wrapper,
    initialProps: { sessionId, ids },
  });
}

const asked = () => requests.map(request => request.ids);

test('asks for the ids in list order and stops at 50', async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `chat-${i}`);
  const { result } = renderPictures('s1', ids);
  await rtl.waitFor(() => assert.equal(Object.keys(result.current.data ?? {}).length, 50));
  assert.deepEqual(asked(), [ids.slice(0, 50)]);
  assert.equal(result.current.data?.['chat-49'], urlFor('s1', 'chat-49'));
  assert.equal(result.current.data?.['chat-50'], undefined);
});

test('a change of membership by one id asks for that id alone', async () => {
  const { result, rerender } = renderPictures('s1', ['a', 'b', 'c']);
  await rtl.waitFor(() => assert.equal(Object.keys(result.current.data ?? {}).length, 3));

  rerender({ sessionId: 's1', ids: ['b', 'c', 'd'] });
  await rtl.waitFor(() => assert.equal(result.current.data?.d, urlFor('s1', 'd')));
  assert.deepEqual(asked(), [['a', 'b', 'c'], ['d']]);
  // The data covers the ids now requested: the ones held are still there and the one pushed out is not.
  assert.deepEqual(result.current.data, { b: urlFor('s1', 'b'), c: urlFor('s1', 'c'), d: urlFor('s1', 'd') });
  assert.equal(result.current.isStale, false);
});

test('asks for nothing when every requested id is already held', async () => {
  const { result, rerender } = renderPictures('s1', ['a', 'b', 'c']);
  await rtl.waitFor(() => assert.equal(Object.keys(result.current.data ?? {}).length, 3));

  rerender({ sessionId: 's1', ids: ['a', 'b'] });
  await rtl.waitFor(() => assert.deepEqual(result.current.data, { a: urlFor('s1', 'a'), b: urlFor('s1', 'b') }));
  rerender({ sessionId: 's1', ids: ['c', 'b'] });
  await rtl.waitFor(() => assert.deepEqual(result.current.data, { b: urlFor('s1', 'b'), c: urlFor('s1', 'c') }));
  assert.equal(requests.length, 1);
});

test('the same ids in another order are not asked for again', async () => {
  const { result, rerender } = renderPictures('s1', ['a', 'b']);
  await rtl.waitFor(() => assert.equal(Object.keys(result.current.data ?? {}).length, 2));
  rerender({ sessionId: 's1', ids: ['b', 'a'] });
  await rtl.waitFor(() => assert.equal(result.current.isFetching, false));
  assert.equal(requests.length, 1);
});

test('an id that came back null is held as well and not asked for again', async () => {
  answer = (sessionId, ids) =>
    Promise.resolve(
      json({ pictures: Object.fromEntries(ids.map(id => [id, id === 'b' ? null : urlFor(sessionId, id)])) }),
    );
  const { result, rerender } = renderPictures('s1', ['a', 'b']);
  await rtl.waitFor(() => assert.ok('b' in (result.current.data ?? {})));
  assert.equal(result.current.data?.b, null);

  rerender({ sessionId: 's1', ids: ['a', 'b', 'd'] });
  await rtl.waitFor(() => assert.equal(result.current.data?.d, urlFor('s1', 'd')));
  assert.deepEqual(asked(), [['a', 'b'], ['d']]);
  assert.equal(result.current.data?.b, null);
});

test('an id the answer leaves out is not held', async () => {
  answer = (sessionId, ids) => Promise.resolve(json({ pictures: { [ids[0]]: urlFor(sessionId, ids[0]) } }));
  const { result, rerender } = renderPictures('s1', ['a', 'b']);
  await rtl.waitFor(() => assert.deepEqual(result.current.data, { a: urlFor('s1', 'a') }));

  answer = everyUrl;
  rerender({ sessionId: 's1', ids: ['a', 'b', 'c'] });
  await rtl.waitFor(() => assert.equal(result.current.data?.c, urlFor('s1', 'c')));
  assert.deepEqual(asked(), [
    ['a', 'b'],
    ['b', 'c'],
  ]);
});

test('an id held for an hour is asked for again, the ones held for less are not', async t => {
  let clock = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => clock);
  const { result, rerender } = renderPictures('s1', ['a', 'b']);
  await rtl.waitFor(() => assert.equal(Object.keys(result.current.data ?? {}).length, 2));

  clock += HOUR / 2;
  rerender({ sessionId: 's1', ids: ['a', 'b', 'c'] });
  await rtl.waitFor(() => assert.equal(result.current.data?.c, urlFor('s1', 'c')));
  assert.deepEqual(asked(), [['a', 'b'], ['c']]);

  // 70 minutes in: a and b are 70 minutes old, c is 40.
  clock += (HOUR * 2) / 3;
  rerender({ sessionId: 's1', ids: ['a', 'b', 'c', 'd'] });
  await rtl.waitFor(() => assert.equal(result.current.data?.d, urlFor('s1', 'd')));
  assert.deepEqual(asked(), [['a', 'b'], ['c'], ['a', 'b', 'd']]);
});

test('a refresh that fails after every held picture expired does not count as a fresh hour', async t => {
  let clock = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => clock);
  const { result } = renderPictures('s1', ['a', 'b']);
  await rtl.waitFor(() => assert.equal(Object.keys(result.current.data ?? {}).length, 2));

  clock += HOUR + 60_000;
  answer = () => Promise.resolve(json({ message: 'Too many requests' }, 429));
  rtl.act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  // dataUpdatedAt moves to the clock only once the refresh has settled; isFetching alone can still read idle.
  await rtl.waitFor(() => assert.equal(result.current.dataUpdatedAt, clock));
  assert.equal(requests.length, 2);
  // The pictures already held stay on screen, but the query is not settled: the next focus tries again.
  assert.deepEqual(result.current.data, { a: urlFor('s1', 'a'), b: urlFor('s1', 'b') });
  assert.equal(result.current.isError, false);
  assert.equal(result.current.isStale, true);

  answer = everyUrl;
  clock += 1_000;
  rtl.act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await rtl.waitFor(() => assert.equal(result.current.dataUpdatedAt, clock));
  assert.deepEqual(requests.at(-1)?.ids, ['a', 'b']);
  assert.equal(requests.length, 3);
  assert.equal(result.current.isStale, false);
});

test('a later key does not extend the life of the pictures it reuses', async t => {
  let clock = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => clock);
  const { result, rerender } = renderPictures('s1', ['a', 'b']);
  await rtl.waitFor(() => assert.equal(Object.keys(result.current.data ?? {}).length, 2));

  // 59 minutes in, c joins: a and b are reused, and the query is only as fresh as the older of them.
  clock += HOUR - 60_000;
  rerender({ sessionId: 's1', ids: ['a', 'b', 'c'] });
  await rtl.waitFor(() => assert.equal(result.current.data?.c, urlFor('s1', 'c')));
  assert.deepEqual(asked(), [['a', 'b'], ['c']]);

  clock += 2 * 60_000;
  rtl.act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await rtl.waitFor(() => assert.equal(requests.length, 3));
  assert.deepEqual(requests.at(-1)?.ids, ['a', 'b']);
});

test('the previous pictures stay while a smaller batch is out', async () => {
  const { result, rerender } = renderPictures('s1', ['a', 'b', 'c']);
  await rtl.waitFor(() => assert.equal(Object.keys(result.current.data ?? {}).length, 3));
  const release = holdNextAnswer();

  rerender({ sessionId: 's1', ids: ['b', 'c', 'd'] });
  await rtl.waitFor(() => assert.equal(requests.length, 2));
  assert.equal(result.current.isPlaceholderData, true);
  assert.deepEqual(result.current.data, {
    a: urlFor('s1', 'a'),
    b: urlFor('s1', 'b'),
    c: urlFor('s1', 'c'),
  });

  release();
  await rtl.waitFor(() => assert.equal(result.current.data?.d, urlFor('s1', 'd')));
  assert.equal(result.current.isPlaceholderData, false);
});

test("one session's pictures are never shown for, or reused by, another", async () => {
  const { result, rerender } = renderPictures('s1', ['a', 'b']);
  await rtl.waitFor(() => assert.equal(Object.keys(result.current.data ?? {}).length, 2));
  const release = holdNextAnswer();

  rerender({ sessionId: 's2', ids: ['a', 'b'] });
  await rtl.waitFor(() => assert.equal(requests.length, 2));
  assert.deepEqual(requests[1], { sessionId: 's2', ids: ['a', 'b'] });
  const shown = () => result.current.data;
  assert.equal(shown(), undefined, "the previous session's pictures showed under the new one");

  release();
  await rtl.waitFor(() => assert.equal(result.current.data?.a, urlFor('s2', 'a')));
  assert.equal(result.current.data?.b, urlFor('s2', 'b'));

  // Back on the first session what it holds is reused, and nothing of the second leaks into it.
  rerender({ sessionId: 's1', ids: ['a', 'c'] });
  await rtl.waitFor(() => assert.equal(result.current.data?.c, urlFor('s1', 'c')));
  assert.deepEqual(requests.at(-1), { sessionId: 's1', ids: ['c'] });
  assert.equal(result.current.data?.a, urlFor('s1', 'a'));
});

test('a top-up that fails keeps the pictures already held and is retried on the next change', async () => {
  const { result, rerender } = renderPictures('s1', ['a', 'b']);
  await rtl.waitFor(() => assert.equal(Object.keys(result.current.data ?? {}).length, 2));

  answer = () => Promise.resolve(json({ message: 'Too many requests' }, 429));
  rerender({ sessionId: 's1', ids: ['a', 'b', 'c'] });
  await rtl.waitFor(() => assert.equal(requests.length, 2));
  await rtl.waitFor(() => assert.equal(result.current.isFetching, false));
  assert.equal(result.current.isError, false);
  assert.deepEqual(result.current.data, { a: urlFor('s1', 'a'), b: urlFor('s1', 'b') });

  answer = everyUrl;
  rerender({ sessionId: 's1', ids: ['a', 'b', 'c', 'd'] });
  await rtl.waitFor(() => assert.equal(result.current.data?.d, urlFor('s1', 'd')));
  assert.deepEqual(requests.at(-1)?.ids, ['c', 'd']);
});

test('a batch short of an id is stale at once, and the next focus asks again for just that id', async () => {
  const { result, rerender } = renderPictures('s1', ['a', 'b']);
  await rtl.waitFor(() => assert.equal(Object.keys(result.current.data ?? {}).length, 2));

  answer = () => Promise.resolve(json({ message: 'Too many requests' }, 429));
  rerender({ sessionId: 's1', ids: ['a', 'b', 'c'] });
  await rtl.waitFor(() => assert.equal(requests.length, 2));
  await rtl.waitFor(() => assert.equal(result.current.isFetching, false));
  assert.equal(result.current.isStale, true);

  answer = everyUrl;
  rtl.act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await rtl.waitFor(() => assert.equal(result.current.data?.c, urlFor('s1', 'c')));
  assert.deepEqual(requests.at(-1)?.ids, ['c']);
  assert.equal(requests.length, 3);
  assert.equal(result.current.isStale, false);
});

test('a first batch that fails reports the error', async () => {
  answer = () => Promise.resolve(json({ message: 'Too many requests' }, 429));
  const { result } = renderPictures('s1', ['a', 'b']);
  await rtl.waitFor(() => assert.equal(result.current.isError, true));
  assert.equal(result.current.data, undefined);
});

test('asks for nothing without a session or without ids', async () => {
  const none = renderPictures(undefined, ['a']);
  const empty = renderPictures('s1', []);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(requests.length, 0);
  assert.equal(none.result.current.data, undefined);
  assert.equal(empty.result.current.data, undefined);
});
