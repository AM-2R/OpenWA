import { createBaileysLogger } from './baileys-logger';

// Everything the logger writes to stdout while `emit` runs.
const captureOutput = (emit: () => void): string => {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string): boolean => {
    written.push(chunk);
    return true;
  };
  try {
    emit();
  } finally {
    (process.stdout as { write: unknown }).write = original;
  }
  return written.join('');
};

describe('createBaileysLogger redacts credentials the library hands it', () => {
  const captureLine = (write: (obj: unknown, msg?: string) => void, payload: unknown): Record<string, unknown> =>
    JSON.parse(captureOutput(() => write(payload))) as Record<string, unknown>;

  it('replaces a proxy password carried by a socks connect error', () => {
    const previous = process.env.BAILEYS_LOG_LEVEL;
    process.env.BAILEYS_LOG_LEVEL = 'debug';
    try {
      const logger = createBaileysLogger();
      const line = captureLine(logger.error, {
        err: { options: { proxy: { host: 'p', port: 1080, userId: 'u', password: 'hunter2' } } },
      });
      expect(JSON.stringify(line)).not.toContain('hunter2');
      expect(JSON.stringify(line)).toContain('[redacted]');
      expect(JSON.stringify(line)).toContain('"host":"p"');
    } finally {
      process.env.BAILEYS_LOG_LEVEL = previous;
    }
  });

  it("keeps an error's message and stack, nested or passed alone, and still redacts its props", () => {
    const previous = process.env.BAILEYS_LOG_LEVEL;
    process.env.BAILEYS_LOG_LEVEL = 'debug';
    try {
      const logger = createBaileysLogger();
      const err = Object.assign(new Error('Socks5 proxy rejected connection'), {
        options: { proxy: { host: 'p', password: 'hunter2' } },
      });
      for (const payload of [{ err }, err]) {
        const line = JSON.stringify(captureLine(logger.error, payload));
        expect(line).toContain('"message":"Socks5 proxy rejected connection"');
        expect(line).toContain('baileys-logger.spec.ts');
        expect(line).not.toContain('hunter2');
        expect(line).toContain('"host":"p"');
      }
    } finally {
      process.env.BAILEYS_LOG_LEVEL = previous;
    }
  });
});

// The library hands this logger whatever object a failure carried, so the record is not ours to shape.
describe('createBaileysLogger writes any record the library hands it', () => {
  let previousLevel: string | undefined;
  beforeEach(() => {
    previousLevel = process.env.BAILEYS_LOG_LEVEL;
    process.env.BAILEYS_LOG_LEVEL = 'debug';
  });
  afterEach(() => {
    if (previousLevel === undefined) delete process.env.BAILEYS_LOG_LEVEL;
    else process.env.BAILEYS_LOG_LEVEL = previousLevel;
  });

  const write = (record: unknown, msg?: string): Record<string, unknown> =>
    JSON.parse(captureOutput(() => createBaileysLogger().debug(record, msg))) as Record<string, unknown>;
  const nest = (levels: number, leaf: unknown): unknown => {
    let value = leaf;
    for (let i = 0; i < levels; i++) value = { level: value };
    return value;
  };
  const withCycle = (): Record<string, unknown> => {
    const socket: Record<string, unknown> = { id: 1 };
    socket.self = socket;
    return socket;
  };

  it.each(['password', 'secret', 'token', 'apikey', 'api_key', 'authorization', 'Authorization', 'API_KEY'])(
    'replaces the value under %s',
    key => {
      expect(write({ [key]: 'value-1', visible: 'v' }, 'x')).toMatchObject({ [key]: '[redacted]', visible: 'v' });
    },
  );

  it('writes an ordinary record exactly as given, apart from its credentials', () => {
    const record = {
      jid: '1@s.whatsapp.net',
      attempt: 2,
      tokenCount: 3, // names a credential word but is not one: only the exact names above are replaced
      list: [1, 'two', { three: 3 }],
      nested: { ok: true, none: null },
    };

    const { ts, ...line } = write({ ...record, token: 't' }, 'retrying');

    expect(ts).toEqual(expect.any(String));
    expect(JSON.stringify(line)).toBe(
      JSON.stringify({ level: 'debug', context: 'baileys-wire', ...record, token: '[redacted]', msg: 'retrying' }),
    );
  });

  it('writes a plain string as the message', () => {
    expect(write('connection opened')).toMatchObject({
      level: 'debug',
      context: 'baileys-wire',
      msg: 'connection opened',
    });
  });

  it('writes a wide record in full at the levels records normally have', () => {
    const { items } = write({ items: Array.from({ length: 1500 }, (_, id) => ({ id, tags: [id] })) }, 'x') as {
      items: unknown[];
    };

    expect(items).toHaveLength(1500);
    expect(items[1499]).toEqual({ id: 1499, tags: [1499] });
  });

  it('replaces a credential nested deeper than five levels', () => {
    const line = JSON.stringify(write({ record: nest(8, { password: 'value-deep', visible: 'v' }) }, 'x'));

    expect(line).not.toContain('value-deep');
    expect(line).toContain('"password":"[redacted]","visible":"v"');
  });

  it('writes what lies beyond the bounded amount of deep data as [Truncated], never raw', () => {
    const line = write({ record: nest(1500, { password: 'value-far' }), jid: 'j' }, 'x');

    expect(JSON.stringify(line)).not.toContain('value-far');
    expect(JSON.stringify(line)).toContain('"[Truncated]"');
    expect(line.jid).toBe('j');
  });

  it.each([
    ['a first-level', 1],
    ['a deep', 7],
  ])('writes %s circular reference as [Circular] and keeps the message', (_name, levels) => {
    const line = write({ record: nest(levels, withCycle()) }, 'socket closed');

    expect(line.msg).toBe('socket closed');
    expect(JSON.stringify(line)).toContain('"self":"[Circular]"');
  });

  it('writes a BigInt as its decimal text', () => {
    expect(write({ total: 10n, nested: { ids: [1n, 2n] } }, 'x')).toMatchObject({
      total: '10',
      nested: { ids: ['1', '2'] },
    });
  });

  it('never calls a toJSON on the record, so it cannot write what the redaction removed', () => {
    const line = write({ entity: { id: 1, toJSON: () => ({ password: 'value-json' }) } }, 'x');

    expect(JSON.stringify(line)).not.toContain('value-json');
    expect(line.entity).toEqual({ id: 1 });
  });

  it.each([
    [
      'a getter that throws',
      {
        get boom(): string {
          throw new Error('getter');
        },
      },
    ],
    [
      'a proxy whose traps throw',
      new Proxy(
        {},
        {
          ownKeys: (): never => {
            throw new Error('ownKeys');
          },
        },
      ),
    ],
  ])('writes the message without the record when it holds %s', (_name, record) => {
    expect(write(record, 'connection update')).toMatchObject({ msg: 'connection update', metadata: '[Unreadable]' });
  });

  it("keeps an error's message and stack when its own props hold a cycle or a BigInt", () => {
    const err = Object.assign(new Error('stream errored'), { attempts: 5n });
    Object.assign(err, { self: err });

    const line = write({ err }, 'x') as { err: Record<string, unknown> };

    expect(line.err).toMatchObject({ name: 'Error', message: 'stream errored', attempts: '5', self: '[Circular]' });
    expect(line.err.stack).toContain('baileys-logger.spec.ts');
  });
});
