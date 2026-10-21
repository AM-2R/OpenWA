// The live feed's socket: what the page sends to open it and to join a room, and how it learns that the
// connection is gone for good. The client is the socket.io double (see vite-shim-hooks.mjs), which records
// what the hook sends and lets a test deliver the client's own events.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { holdConnect, lastIoCall, lastSocket, resetSocketDouble } from '../test-helpers/socket-io-double.ts';
import type { useWebSocket as useWebSocketFn } from './useWebSocket.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let useWebSocket: typeof useWebSocketFn;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  // The hook opens no socket without a key.
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  rtl = await import('@testing-library/react');
  ({ useWebSocket } = await import('./useWebSocket.ts'));
});

afterEach(() => {
  rtl.cleanup();
  resetSocketDouble();
});

test('the handshake carries the API key in auth and in a header, never in the URL', () => {
  rtl.renderHook(() => useWebSocket());

  const call = lastIoCall();
  assert.ok(call, 'expected the hook to open a socket');
  assert.ok(call.url.endsWith('/events'), `the socket was opened on ${call.url}`);
  assert.equal(call.url.includes('test-key'), false, 'the key is in the handshake URL');
  assert.equal(call.options.query, undefined, 'the key is in the handshake query');
  assert.deepEqual(call.options.auth, { apiKey: 'test-key' });
  assert.deepEqual(call.options.extraHeaders, { 'X-API-Key': 'test-key' });
});

test('no socket is opened without a key', () => {
  window.sessionStorage.removeItem('openwa_api_key');
  try {
    rtl.renderHook(() => useWebSocket());
    assert.equal(lastIoCall(), null);
  } finally {
    window.sessionStorage.setItem('openwa_api_key', 'test-key');
  }
});

test('a room is joined and left with frames of its own, and only once the handshake is done', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');

  result.current.subscribe('s1', ['message.received']);
  assert.deepEqual(socket.emitted, [], 'a frame went out before the connection was open');

  rtl.act(() => socket.receive('connect'));
  result.current.subscribe('s1', ['message.received']);
  result.current.unsubscribe('s1');
  assert.deepEqual(socket.emitted, [
    { event: 'message', args: [{ type: 'subscribe', sessionId: 's1', events: ['message.received'] }] },
    { event: 'message', args: [{ type: 'unsubscribe', sessionId: 's1' }] },
  ]);
});

test('the connection counts as failed once the client gives up reconnecting, and recovers on a redial', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  assert.equal(result.current.isConnected, true);

  // A dropped connection is the client's to retry: nothing is failed yet.
  rtl.act(() => socket.receive('disconnect', 'transport close'));
  assert.equal(result.current.isConnected, false);
  assert.equal(result.current.connectionFailed, false);

  // The attempts run out: only the client's manager says so, never the socket.
  rtl.act(() => socket.io.receive('reconnect_failed'));
  assert.equal(result.current.connectionFailed, true);

  rtl.act(() => result.current.reconnect());
  const redialed = lastSocket();
  assert.ok(redialed && redialed !== socket, 'expected the retry to open a fresh socket');
  rtl.act(() => redialed.receive('connect'));
  assert.equal(result.current.connectionFailed, false);
  assert.equal(result.current.isConnected, true);
});
