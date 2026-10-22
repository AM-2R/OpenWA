/**
 * The adapter is the whole opt-in surface for cross-replica fan-out, so what has to hold is narrow
 * and load-bearing: it attaches the Redis adapter ONLY when Redis is enabled, never opens a
 * connection otherwise (a single-node deployment must pay nothing), survives a client-construction
 * failure by falling back rather than crashing the boot, and closes both connections on shutdown.
 */

const redisInstances: FakeRedis[] = [];

class FakeRedis {
  readonly handlers: Record<string, (err: Error) => void> = {};
  quit = jest.fn().mockResolvedValue('OK');
  disconnect = jest.fn();
  readonly sent = jest.fn().mockResolvedValue(1);
  publish(channel: string, message: string): Promise<number> {
    return this.sent(channel, message) as Promise<number>;
  }
  constructor(public readonly opts?: unknown) {
    redisInstances.push(this);
  }
  on(event: string, handler: (err: Error) => void): this {
    this.handlers[event] = handler;
    return this;
  }
}

jest.mock('ioredis', () => ({ __esModule: true, default: FakeRedis }));

// The mock's return references its args, so createAdapter(pub, sub) yields an identifiable value
// carrying both clients — proving both that it was called with the pair and that its result is
// what gets handed to server.adapter().
const createAdapterMock = jest.fn((pub: unknown, sub: unknown) => ({ tag: 'redis-adapter-fn', pub, sub }));
jest.mock('@socket.io/redis-adapter', () => ({
  createAdapter: (pub: unknown, sub: unknown) => createAdapterMock(pub, sub),
}));

import {
  RedisIoAdapter,
  isWsRedisEnabled,
  wsRedisOptions,
  WS_REDIS_COMMAND_TIMEOUT_MS,
  WS_REDIS_MAX_UNANSWERED,
  WS_REDIS_QUIT_TIMEOUT_MS,
  WS_REDIS_SOCKET_TIMEOUT_MS,
} from './redis-io.adapter';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server } from 'socket.io';

describe('RedisIoAdapter', () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    redisInstances.length = 0;
    createAdapterMock.mockClear();
  });

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  type NamespaceMiddleware = (socket: unknown, next: (error?: Error) => void) => void;

  const fakeServer = (): {
    server: Server;
    adapterFn: jest.Mock;
    namespaceOf: jest.Mock;
    rootUse: jest.Mock<void, [NamespaceMiddleware]>;
  } => {
    const adapterFn = jest.fn();
    const rootUse = jest.fn<void, [NamespaceMiddleware]>();
    const namespaceOf = jest.fn(() => ({ use: rootUse }));
    return { server: { adapter: adapterFn, of: namespaceOf } as unknown as Server, adapterFn, namespaceOf, rootUse };
  };

  /** Stub the base createIOServer so no real socket.io server is spun up. */
  const withBaseServer = (server: Server): jest.SpyInstance => {
    return jest.spyOn(IoAdapter.prototype, 'createIOServer').mockReturnValue(server);
  };

  describe('isWsRedisEnabled', () => {
    it('is true only for the exact string "true"', () => {
      process.env.REDIS_ENABLED = 'true';
      expect(isWsRedisEnabled()).toBe(true);
      for (const v of ['false', 'True', '1', '']) {
        process.env.REDIS_ENABLED = v;
        expect(isWsRedisEnabled()).toBe(false);
      }
      delete process.env.REDIS_ENABLED;
      expect(isWsRedisEnabled()).toBe(false);
    });
  });

  describe('wsRedisOptions', () => {
    it('maps the same REDIS_* env the cache/throttler read', () => {
      process.env.REDIS_HOST = 'redis.internal';
      process.env.REDIS_PORT = '6380';
      process.env.REDIS_PASSWORD = 'secret';
      const opts = wsRedisOptions();
      expect(opts.host).toBe('redis.internal');
      expect(opts.port).toBe(6380);
      expect(opts.password).toBe('secret');
      // Reconnect-forever so a blip never strands the SUBSCRIBE connection.
      expect(typeof opts.retryStrategy).toBe('function');
      expect((opts.retryStrategy as (n: number) => number)(100)).toBe(5000);
    });

    it('connects over TLS when REDIS_TLS=true', () => {
      process.env.REDIS_TLS = 'true';
      try {
        expect(wsRedisOptions().tls).toEqual({});
      } finally {
        delete process.env.REDIS_TLS;
      }
    });
  });

  describe('createIOServer', () => {
    it('opens no Redis connection and does not touch the adapter when Redis is disabled', () => {
      delete process.env.REDIS_ENABLED;
      const { server, adapterFn } = fakeServer();
      const spy = withBaseServer(server);
      try {
        const adapter = new RedisIoAdapter({} as never);
        expect(adapter.createIOServer(2785)).toBe(server);
        expect(redisInstances).toHaveLength(0);
        expect(adapterFn).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it.each(['true', undefined])('refuses the root namespace whether or not Redis is enabled (%s)', enabled => {
      if (enabled === undefined) delete process.env.REDIS_ENABLED;
      else process.env.REDIS_ENABLED = enabled;
      const { server, namespaceOf, rootUse } = fakeServer();
      const spy = withBaseServer(server);
      try {
        new RedisIoAdapter({} as never).createIOServer(2785);
        expect(namespaceOf).toHaveBeenCalledWith('/');
        const [middleware] = rootUse.mock.calls[0];
        const next = jest.fn();
        middleware({}, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid namespace' }));
      } finally {
        spy.mockRestore();
      }
    });

    // Gateway options such as the client frame bound reach the Socket.IO server through this call.
    it.each(['true', undefined])('hands the server options to the base server untouched (%s)', enabled => {
      if (enabled === undefined) delete process.env.REDIS_ENABLED;
      else process.env.REDIS_ENABLED = enabled;
      const spy = withBaseServer(fakeServer().server);
      try {
        const options = { maxHttpBufferSize: 8192 };
        new RedisIoAdapter({} as never).createIOServer(0, options as never);
        expect(spy).toHaveBeenCalledWith(0, options);
      } finally {
        spy.mockRestore();
      }
    });

    it('attaches the Redis adapter with a pub/sub pair when Redis is enabled', () => {
      process.env.REDIS_ENABLED = 'true';
      const { server, adapterFn } = fakeServer();
      const spy = withBaseServer(server);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        // pub and sub = two clients, both given an error handler.
        expect(redisInstances).toHaveLength(2);
        expect(redisInstances[0].handlers.error).toBeDefined();
        expect(redisInstances[1].handlers.error).toBeDefined();
        expect(createAdapterMock).toHaveBeenCalledWith(redisInstances[0], redisInstances[1]);
        expect(adapterFn).toHaveBeenCalledWith(
          expect.objectContaining({ tag: 'redis-adapter-fn', pub: redisInstances[0], sub: redisInstances[1] }),
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps the subscriber commands queued for as long as Redis is down at boot', () => {
      process.env.REDIS_ENABLED = 'true';
      const spy = withBaseServer(fakeServer().server);
      try {
        new RedisIoAdapter({} as never).createIOServer(2785);
        const [pub, sub] = redisInstances as [FakeRedis, FakeRedis];
        // The adapter subscribes once; a flushed SUBSCRIBE is never sent again, so the sub client
        // must not give up on it. The publisher stays bounded.
        expect((sub.opts as { maxRetriesPerRequest?: unknown }).maxRetriesPerRequest).toBeNull();
        expect((pub.opts as { maxRetriesPerRequest?: unknown }).maxRetriesPerRequest).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    // A Redis that keeps the connection open and stops answering never errors the publisher's socket, so only
    // its own deadlines release what it holds. The subscriber must not inherit them: it waits for no reply, and
    // a destroyed socket or a dropped queue would strand its one-time SUBSCRIBE.
    it('puts the deadlines on the publisher only', () => {
      process.env.REDIS_ENABLED = 'true';
      const spy = withBaseServer(fakeServer().server);
      try {
        new RedisIoAdapter({} as never).createIOServer(2785);
        const [pub, sub] = redisInstances as [FakeRedis, FakeRedis];
        expect(pub.opts).toMatchObject({
          commandTimeout: WS_REDIS_COMMAND_TIMEOUT_MS,
          socketTimeout: WS_REDIS_SOCKET_TIMEOUT_MS,
          enableOfflineQueue: false,
          autoResendUnfulfilledCommands: false,
        });
        // Both are real deadlines, and the socket may not be cut off before a command has had its full time: the
        // socket timer runs on this process's own event loop, so a short one drops healthy connections.
        expect(Number.isFinite(WS_REDIS_COMMAND_TIMEOUT_MS)).toBe(true);
        expect(Number.isFinite(WS_REDIS_SOCKET_TIMEOUT_MS)).toBe(true);
        expect(WS_REDIS_SOCKET_TIMEOUT_MS).toBeGreaterThanOrEqual(WS_REDIS_COMMAND_TIMEOUT_MS);
        for (const option of [
          'commandTimeout',
          'socketTimeout',
          'enableOfflineQueue',
          'autoResendUnfulfilledCommands',
        ]) {
          expect(sub.opts).not.toHaveProperty(option);
        }
        expect(sub.opts).toMatchObject({ maxRetriesPerRequest: null });
      } finally {
        spy.mockRestore();
      }
    });

    it('gives a failed publish an owner, since the adapter drops the promise it returns', async () => {
      process.env.REDIS_ENABLED = 'true';
      const { server } = fakeServer();
      const spy = withBaseServer(server);
      try {
        new RedisIoAdapter({} as never).createIOServer(2785);
        const [pub] = redisInstances;
        // What ioredis does to every publish queued during an outage once its retries run out.
        pub.sent.mockRejectedValueOnce(new Error('Reached the max retries per request limit (which is 20).'));
        await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(0);
        await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(1);
        expect(pub.sent).toHaveBeenCalledWith('socket.io#/events#', 'frame');
      } finally {
        spy.mockRestore();
      }
    });

    // The cap reads the length of the client's command queue, which ioredis keeps on an internal property.
    describe('the cap on unanswered commands', () => {
      const withPublisher = async (
        queue: { length: number } | undefined,
        check: (pub: FakeRedis) => Promise<void>,
      ): Promise<void> => {
        process.env.REDIS_ENABLED = 'true';
        const spy = withBaseServer(fakeServer().server);
        try {
          new RedisIoAdapter({} as never).createIOServer(2785);
          const [pub] = redisInstances;
          if (queue) (pub as unknown as { commandQueue: { length: number } }).commandQueue = queue;
          await check(pub);
        } finally {
          spy.mockRestore();
        }
      };

      it('does not publish a frame while the queue is at the cap, and publishes again below it', async () => {
        // The figure docs/13 quotes. A 10 s silence at 1000 events a second must still fit, with room to spare.
        expect(WS_REDIS_MAX_UNANSWERED).toBe(12_000);
        expect(WS_REDIS_MAX_UNANSWERED).toBeGreaterThanOrEqual((WS_REDIS_SOCKET_TIMEOUT_MS / 1000) * 1000 * 1.2);
        const queue = { length: WS_REDIS_MAX_UNANSWERED };
        await withPublisher(queue, async pub => {
          await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(0);
          expect(pub.sent).not.toHaveBeenCalled();
          queue.length = WS_REDIS_MAX_UNANSWERED - 1;
          await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(1);
          expect(pub.sent).toHaveBeenCalledTimes(1);
        });
      });

      it('applies no cap, and does not fail, when the client exposes no command queue', async () => {
        await withPublisher(undefined, async pub => {
          await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(1);
          expect(pub.sent).toHaveBeenCalledTimes(1);
        });
      });
    });

    it('falls back to the base server (no crash) if wiring the adapter throws', () => {
      process.env.REDIS_ENABLED = 'true';
      const { server, adapterFn } = fakeServer();
      adapterFn.mockImplementation(() => {
        throw new Error('adapter boom');
      });
      const spy = withBaseServer(server);
      try {
        const adapter = new RedisIoAdapter({} as never);
        expect(() => adapter.createIOServer(2785)).not.toThrow();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('close', () => {
    it('quits both pub and sub clients', async () => {
      process.env.REDIS_ENABLED = 'true';
      const { server } = fakeServer();
      const createSpy = withBaseServer(server);
      const closeSpy = jest.spyOn(IoAdapter.prototype, 'close').mockResolvedValue(undefined);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        const [pub, sub] = redisInstances;

        await adapter.close(server);

        expect(pub.quit).toHaveBeenCalledTimes(1);
        expect(sub.quit).toHaveBeenCalledTimes(1);
        // Always release the socket, so a clean quit still can't leave the reconnect timer alive.
        expect(pub.disconnect).toHaveBeenCalledTimes(1);
        expect(sub.disconnect).toHaveBeenCalledTimes(1);
        expect(closeSpy).toHaveBeenCalledWith(server);
      } finally {
        createSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });

    // The server must close BEFORE the clients are released: the namespace adapters unsubscribe as
    // the server closes, and issuing those on already-quit clients surfaced as a handful of
    // unhandled-rejection ERRORs on every graceful shutdown.
    it('closes the server before releasing the pub/sub clients', async () => {
      process.env.REDIS_ENABLED = 'true';
      const { server } = fakeServer();
      const createSpy = withBaseServer(server);
      const order: string[] = [];
      const closeSpy = jest.spyOn(IoAdapter.prototype, 'close').mockImplementation(() => {
        order.push('super.close');
        return Promise.resolve();
      });
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        const [pub, sub] = redisInstances;
        pub.quit.mockImplementation(() => {
          order.push('pub.quit');
          return Promise.resolve();
        });
        sub.quit.mockImplementation(() => {
          order.push('sub.quit');
          return Promise.resolve();
        });

        await adapter.close(server);

        expect(order[0]).toBe('super.close');
        expect(order).toContain('pub.quit');
        expect(order).toContain('sub.quit');
      } finally {
        createSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });

    it('does not hang when quit() never resolves (Redis down at shutdown), then force-disconnects', async () => {
      jest.useFakeTimers();
      process.env.REDIS_ENABLED = 'true';
      const { server } = fakeServer();
      const createSpy = withBaseServer(server);
      const closeSpy = jest.spyOn(IoAdapter.prototype, 'close').mockResolvedValue(undefined);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        const [pub, sub] = redisInstances;
        // The exact outage shape: quit() queued to the offline queue, never settles.
        pub.quit.mockReturnValue(new Promise(() => undefined));
        sub.quit.mockReturnValue(new Promise(() => undefined));

        const closed = adapter.close(server);
        // Drive the per-client deadline; without it the await would block forever.
        await jest.advanceTimersByTimeAsync(WS_REDIS_QUIT_TIMEOUT_MS + 10);
        await expect(closed).resolves.toBeUndefined();

        expect(pub.disconnect).toHaveBeenCalledTimes(1);
        expect(sub.disconnect).toHaveBeenCalledTimes(1);
        expect(closeSpy).toHaveBeenCalledWith(server);
      } finally {
        jest.useRealTimers();
        createSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });

    it('is safe to close when Redis was never enabled (no clients to quit)', async () => {
      delete process.env.REDIS_ENABLED;
      const { server } = fakeServer();
      const createSpy = withBaseServer(server);
      const closeSpy = jest.spyOn(IoAdapter.prototype, 'close').mockResolvedValue(undefined);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        await expect(adapter.close(server)).resolves.toBeUndefined();
      } finally {
        createSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });
  });
});
