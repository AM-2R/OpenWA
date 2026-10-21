import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server } from 'socket.io';
import { RedisIoAdapter, WS_REDIS_COMMAND_TIMEOUT_MS } from './redis-io.adapter';

/**
 * A Redis that keeps the connection open and stops answering never errors the socket, so the publish
 * client of the fan-out pair has to bound it itself. This runs the real adapter and the real ioredis
 * client against a peer that speaks just enough RESP to bring a client up, and can then go silent.
 */
class FakeRedis {
  silent = false;
  /** Every PUBLISH payload that reached the peer, answered or not. */
  readonly published: string[] = [];
  readonly sockets = new Set<net.Socket>();
  private readonly server: net.Server;

  constructor() {
    this.server = net.createServer(socket => {
      this.sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => this.sockets.delete(socket));
      let pending: Buffer = Buffer.alloc(0);
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        for (const command of FakeRedis.takeCommands(pending, rest => (pending = rest))) {
          if (command[0].toUpperCase() === 'PUBLISH') this.published.push(command[2]);
          // A stalled peer answers nothing the publisher or its reconnect asks. Subscriptions are exempt: the adapter
          // issues them without a handler, when a namespace is first used, and a SUBSCRIBE that no reply ever
          // settles is rejected as an unhandled rejection when the client is closed, which ends a Jest worker.
          if (!this.silent || /^p?subscribe$/i.test(command[0])) socket.write(FakeRedis.reply(command));
        }
      });
    });
  }

  listen(): Promise<number> {
    return new Promise(resolve =>
      this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as AddressInfo).port)),
    );
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  /** Parse every complete `*N` array of bulk strings off the front of `buf`; the remainder goes to `keep`. */
  private static takeCommands(buf: Buffer, keep: (rest: Buffer) => void): string[][] {
    const commands: string[][] = [];
    let offset = 0;
    for (;;) {
      if (buf[offset] !== 0x2a) break;
      const eol = buf.indexOf('\r\n', offset);
      if (eol < 0) break;
      const count = parseInt(buf.toString('utf8', offset + 1, eol), 10);
      let cursor = eol + 2;
      const parts: string[] = [];
      for (let i = 0; i < count; i++) {
        const lineEnd = buf.indexOf('\r\n', cursor);
        if (lineEnd < 0) break;
        const length = parseInt(buf.toString('utf8', cursor + 1, lineEnd), 10);
        if (buf.length < lineEnd + 2 + length + 2) break;
        parts.push(buf.toString('utf8', lineEnd + 2, lineEnd + 2 + length));
        cursor = lineEnd + 2 + length + 2;
      }
      if (parts.length < count) break;
      commands.push(parts);
      offset = cursor;
    }
    keep(buf.subarray(offset));
    return commands;
  }

  private static reply([name, ...args]: string[]): string {
    switch (name.toUpperCase()) {
      case 'INFO': {
        const info = '# Server\r\nredis_version:7.2.0\r\nloading:0\r\n';
        return `$${info.length}\r\n${info}\r\n`;
      }
      case 'PUBLISH':
        return ':1\r\n';
      case 'SUBSCRIBE':
      case 'PSUBSCRIBE':
        return args
          .map((channel, i) => `*3\r\n$9\r\nsubscribe\r\n$${channel.length}\r\n${channel}\r\n:${i + 1}\r\n`)
          .join('');
      default:
        return '+OK\r\n';
    }
  }
}

type Queue = { length: number };
type PublishClient = {
  status: string;
  commandQueue: Queue;
  offlineQueue: Queue;
  prevCommandQueue?: Queue | null;
  publish: (channel: string, message: string) => Promise<number>;
};

describe('RedisIoAdapter publish client against a Redis that stops answering', () => {
  const prevEnv = { ...process.env };
  let redis: FakeRedis;
  let adapter: RedisIoAdapter;
  let io: Server;
  let pub: PublishClient;

  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  /** Everything the client holds for a reply or for a connection: the three places ioredis keeps a command. */
  const held = (): number => pub.commandQueue.length + pub.offlineQueue.length + (pub.prevCommandQueue?.length ?? 0);
  const broadcast = (count: number): void => {
    for (let i = 0; i < count; i++)
      io.of('/events')
        .to('room')
        .emit('message', { body: 'x'.repeat(1024) });
  };
  const waitUntil = async (condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> => {
    for (let waited = 0; waited < timeoutMs; waited += 50) {
      if (await condition()) return true;
      await sleep(50);
    }
    return false;
  };

  beforeEach(async () => {
    redis = new FakeRedis();
    const port = await redis.listen();
    process.env.REDIS_ENABLED = 'true';
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = String(port);
    io = new Server();
    jest.spyOn(IoAdapter.prototype, 'createIOServer').mockReturnValue(io);
    jest.spyOn(IoAdapter.prototype, 'close').mockResolvedValue(undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    adapter = new RedisIoAdapter({} as never);
    adapter.createIOServer(0);
    pub = (adapter as unknown as { pubClient: PublishClient }).pubClient;
    expect(await waitUntil(() => pub.status === 'ready', 3000)).toBe(true);
  });

  afterEach(async () => {
    redis.silent = false;
    await adapter.close(io);
    await redis.close();
    jest.restoreAllMocks();
    process.env = { ...prevEnv };
  });

  it('still publishes to a healthy peer and holds nothing afterwards', async () => {
    broadcast(20);

    await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(1);
    expect(held()).toBe(0);
  });

  it('settles a publish within its deadline, holds no more events while the peer is silent, and recovers', async () => {
    redis.silent = true;

    // The peer is silent but the connection stays open: nothing errors, so the deadline is the only thing
    // that settles the command.
    const started = Date.now();
    const outcome = await Promise.race([
      pub.publish('socket.io#/events#', 'stalled-frame'),
      sleep(WS_REDIS_COMMAND_TIMEOUT_MS * 2).then(() => 'still pending'),
    ]);
    expect(outcome).toBe(0);
    expect(Date.now() - started).toBeLessThan(WS_REDIS_COMMAND_TIMEOUT_MS + 1000);

    // Past the first deadline, events keep arriving at a steady rate. None of them may pile up on the
    // client, whichever queue ioredis would park them in.
    const before = held();
    for (let batch = 0; batch < 5; batch++) {
      broadcast(100);
      await sleep(100);
    }
    expect(held() - before).toBeLessThan(20);

    // The peer answers again: the client comes back without a restart, and does not send again what the
    // abandoned socket had already put on the wire, which the peer may have delivered.
    redis.silent = false;
    expect(await waitUntil(async () => (await pub.publish('socket.io#/events#', 'probe')) === 1, 10_000)).toBe(true);
    expect(held()).toBe(0);
    expect(redis.published.filter(payload => payload === 'stalled-frame')).toHaveLength(1);
  }, 30_000);
});
