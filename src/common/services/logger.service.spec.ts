import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { LoggerService, LogLevel, LogFormat, createLogger, redactSecrets } from './logger.service';
import { runWithRequestId } from './request-context';

interface LogEntry {
  timestamp: string;
  level: string;
  context: string;
  message: string;
  sessionId?: string;
  action?: string;
  trace?: string;
}

// Helper to safely extract log output from mock calls
function getLogOutput(spy: jest.SpyInstance): LogEntry {
  const calls = spy.mock.calls as string[][];
  return JSON.parse(calls[0][0]) as LogEntry;
}

// Helper to read the raw (unparsed) string a spy was called with.
function getRawOutput(spy: jest.SpyInstance): string {
  const calls = spy.mock.calls as string[][];
  return calls[0][0];
}

describe('LoggerService', () => {
  let logger: LoggerService;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    logger = new LoggerService();
    logger.setContext('TestContext');
    // Pin JSON so structured-output assertions are deterministic regardless of TTY/LOG_FORMAT.
    LoggerService.setLogFormat(LogFormat.JSON);
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    LoggerService.setLogFormat(null);
    LoggerService.setLogLevel(LogLevel.INFO);
  });

  describe('log', () => {
    it('should log info messages with context', () => {
      logger.log('Test message');

      expect(consoleSpy).toHaveBeenCalled();
      const output = getLogOutput(consoleSpy);
      expect(output.level).toBe('info');
      expect(output.message).toBe('Test message');
      expect(output.context).toBe('TestContext');
      expect(output.timestamp).toBeDefined();
    });

    it('should log with additional metadata', () => {
      logger.log('Test message', { sessionId: '123', action: 'test' });

      const output = getLogOutput(consoleSpy);
      expect(output.sessionId).toBe('123');
      expect(output.action).toBe('test');
    });
  });

  describe('secret redaction', () => {
    it('redacts the values of secret-named keys in the metadata', () => {
      logger.log('auth', { password: 'hunter2', apiKey: 'abc123', userId: 'u1' });

      const output = getLogOutput(consoleSpy) as unknown as Record<string, unknown>;
      expect(output.password).toBe('[REDACTED]');
      expect(output.apiKey).toBe('[REDACTED]');
      expect(output.userId).toBe('u1');
    });

    it.each([
      'passwd',
      'secret',
      'token',
      'accessToken',
      'authorization',
      'credentials',
      'apiPepper',
      'privateKey',
      'private-key',
      'api-key',
      'api_key',
    ])('redacts the value under the key %s', key => {
      logger.log('auth', { [key]: 'value-1', visible: 'v' });

      const output = getLogOutput(consoleSpy) as unknown as Record<string, unknown>;
      expect(output[key]).toBe('[REDACTED]');
      expect(output.visible).toBe('v');
    });

    it('redacts secret-named keys inside arrays of objects', () => {
      logger.log('cfg', {
        instances: [
          { name: 'a', secret: 's1' },
          { name: 'b', token: 't1' },
        ],
      });

      const output = getLogOutput(consoleSpy) as unknown as { instances: Array<Record<string, string>> };
      expect(output.instances).toEqual([
        { name: 'a', secret: '[REDACTED]' },
        { name: 'b', token: '[REDACTED]' },
      ]);
    });

    it('redacts secret-named keys nested inside the metadata', () => {
      logger.log('cfg', { config: { redisPassword: 'p', host: 'h' } });

      const output = getLogOutput(consoleSpy) as unknown as { config: { redisPassword: string; host: string } };
      expect(output.config.redisPassword).toBe('[REDACTED]');
      expect(output.config.host).toBe('h');
    });

    it('redacts a secret-named key however deep it sits', () => {
      let deep: Record<string, unknown> = { password: 'value-deep', visible: 'v' };
      for (let i = 0; i < 12; i++) deep = { level: deep };
      logger.log('cfg', { config: deep });

      const line = getRawOutput(consoleSpy);
      expect(line).not.toContain('value-deep');
      expect(line).toContain('"password":"[REDACTED]","visible":"v"');
    });

    it('never writes what lies beyond the bounded amount of deep metadata it copies', () => {
      let chain: Record<string, unknown> = { password: 'value-far' };
      for (let i = 0; i < 1500; i++) chain = { next: chain };
      logger.log('cfg', { chain, sessionId: 's1' });

      const output = getLogOutput(consoleSpy) as unknown as Record<string, unknown>;
      expect(getRawOutput(consoleSpy)).not.toContain('value-far');
      expect(getRawOutput(consoleSpy)).toContain('"[Truncated]"');
      expect(output.sessionId).toBe('s1');
    });

    // The first five levels were always copied whole, however wide, and still are.
    it('writes a wide structure in full at the levels metadata normally has', () => {
      logger.log('cfg', { items: Array.from({ length: 1500 }, (_, id) => ({ id, tags: [id] })) });

      const { items } = getLogOutput(consoleSpy) as unknown as { items: unknown[] };
      expect(items).toHaveLength(1500);
      expect(items[0]).toEqual({ id: 0, tags: [0] });
      expect(items[1499]).toEqual({ id: 1499, tags: [1499] });
    });

    it('truncates the rows of a wide array below the last whole level once the budget is spent', () => {
      logger.log('cfg', { a: { b: { c: { items: Array.from({ length: 1500 }, (_, id) => ({ id })) } } } });

      const { items } = (getLogOutput(consoleSpy) as unknown as { a: { b: { c: { items: unknown[] } } } }).a.b.c;
      expect(items).toHaveLength(1500);
      expect(items[0]).toEqual({ id: 0 });
      expect(items[1499]).toBe('[Truncated]');
    });
  });

  // Plugin ctx.logger spreads its caller's metadata in verbatim, so the metadata is whatever the plugin holds.
  describe('metadata the logger cannot take as is', () => {
    const entityWithCycle = (): Record<string, unknown> => {
      const entity: Record<string, unknown> = { id: 1 };
      entity.self = entity;
      return entity;
    };
    const parsed = (): Record<string, unknown> => getLogOutput(consoleSpy) as unknown as Record<string, unknown>;

    it('writes a circular reference as [Circular] and keeps the rest of the line', () => {
      logger.log('saved', { sessionId: 's1', entity: entityWithCycle() });

      expect(parsed()).toMatchObject({ message: 'saved', sessionId: 's1', entity: { id: 1, self: '[Circular]' } });
    });

    it('does not mistake a repeated, non-circular reference for a cycle', () => {
      const shared = { id: 1 };
      logger.log('saved', { a: shared, list: [shared, shared] });

      expect(parsed()).toMatchObject({ a: { id: 1 }, list: [{ id: 1 }, { id: 1 }] });
    });

    it('writes a BigInt as its decimal text', () => {
      logger.log('saved', { total: 10n, nested: { ids: [1n, 2n] } });

      expect(parsed()).toMatchObject({ total: '10', nested: { ids: ['1', '2'] } });
    });

    it('writes ordinary nested metadata exactly as given, apart from its secrets', () => {
      const metadata = {
        sessionId: 's1',
        counts: [1, 2, 3],
        none: null,
        flag: false,
        nested: { a: { b: { c: 'x' } } },
      };
      logger.log('saved', { ...metadata, nested: { ...metadata.nested, token: 't' } });

      const { timestamp, ...line } = parsed();
      expect(timestamp).toEqual(expect.any(String));
      expect(JSON.stringify(line)).toBe(
        JSON.stringify({
          level: 'info',
          context: 'TestContext',
          message: 'saved',
          ...metadata,
          nested: { ...metadata.nested, token: '[REDACTED]' },
        }),
      );
    });

    const throwingGetter = () => ({
      get boom(): string {
        throw new Error('getter');
      },
    });
    const throwingProxy = () => ({
      unreadable: new Proxy(
        {},
        {
          ownKeys: (): never => {
            throw new Error('ownKeys');
          },
        },
      ),
    });
    const throwingToJson = () => ({
      entity: {
        id: 1,
        toJSON: (): never => {
          throw new Error('toJSON');
        },
      },
    });

    it.each([
      ['a getter that throws', throwingGetter],
      ['a proxy whose traps throw', throwingProxy],
    ])('keeps the line, without its metadata, for %s', (_name, metadata) => {
      expect(() => logger.log('saved', metadata())).not.toThrow();

      expect(parsed()).toMatchObject({ message: 'saved', metadata: '[Unreadable]' });
    });

    it('never calls a toJSON on the metadata, so it cannot write what the redaction removed', () => {
      logger.log('saved', { entity: { id: 1, toJSON: () => ({ password: 'value-json' }) } });

      expect(getRawOutput(consoleSpy)).not.toContain('value-json');
      expect(parsed().entity).toEqual({ id: 1 });
    });

    describe.each([LogFormat.JSON, LogFormat.PRETTY])('in %s output', format => {
      beforeEach(() => {
        LoggerService.setLogFormat(format);
      });

      it.each([
        ['a circular reference', () => ({ entity: entityWithCycle() })],
        ['a BigInt', () => ({ total: 10n })],
        ['a getter that throws', throwingGetter],
        ['a proxy whose traps throw', throwingProxy],
        ['a toJSON that throws', throwingToJson],
      ])('does not throw on %s in the metadata', (_name, metadata) => {
        expect(() => logger.log('saved', metadata())).not.toThrow();

        expect(getRawOutput(consoleSpy)).toContain('saved');
      });
    });
  });

  // Array.prototype.map visits every index of an array, holes included, so a sparse array costs its length
  // however little it holds: the largest one takes tens of seconds to walk.
  describe('a sparse array of the largest length', () => {
    const sparse = (): unknown[] => {
      const list: unknown[] = [];
      list.length = 2 ** 32 - 1;
      return list;
    };
    const parsed = (): Record<string, unknown> => getLogOutput(consoleSpy) as unknown as Record<string, unknown>;

    it('is written as [Truncated] at once in the first levels, with the rest of the line kept', () => {
      const started = Date.now();
      logger.log('saved', { sessionId: 's1', list: sparse() });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(parsed()).toMatchObject({ message: 'saved', sessionId: 's1', list: '[Truncated]' });
    });

    it('is written as [Truncated] at once below the fifth level, with the rest of the line kept', () => {
      const started = Date.now();
      logger.log('saved', { sessionId: 's1', a: { b: { c: { d: { e: { list: sparse() } } } } } });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(parsed()).toMatchObject({
        message: 'saved',
        sessionId: 's1',
        a: { b: { c: { d: { e: { list: '[Truncated]' } } } } },
      });
    });
  });

  describe('an array subclass', () => {
    class Rows extends Array<unknown> {
      toJSON(): string[] {
        return ['replaced'];
      }
    }

    it('is written as the plain array it holds, in the metadata and as the message', () => {
      logger.log('saved', { rows: Rows.from([1, { token: 't' }]) });
      logger.log(Rows.from([1, 2]));

      const calls = consoleSpy.mock.calls as string[][];
      expect(JSON.parse(calls[0][0])).toMatchObject({ rows: [1, { token: '[REDACTED]' }] });
      expect(JSON.parse(calls[1][0])).toMatchObject({ message: '[1,2]' });
    });
  });

  // Nest passes the framework's own message and trace through, so the two slots hold whatever it was handed.
  describe('a message or trace that cannot be read', () => {
    const revokedProxy = (): object => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    };
    const throwingPrototype = (): object =>
      new Proxy(
        {},
        {
          getPrototypeOf: (): never => {
            throw new Error('getPrototypeOf');
          },
        },
      );
    const throwingMessage = (): Error =>
      Object.defineProperty(new Error('boom'), 'message', {
        get: (): never => {
          throw new Error('message getter');
        },
      });

    describe.each([LogFormat.JSON, LogFormat.PRETTY])('in %s output', format => {
      beforeEach(() => {
        LoggerService.setLogFormat(format);
      });

      it.each([
        ['a revoked proxy', revokedProxy],
        ['a proxy whose prototype read throws', throwingPrototype],
        ['an Error whose message getter throws', throwingMessage],
      ])('writes %s passed as the message as [Unprintable]', (_name, unreadable) => {
        const errorSpy = jest.spyOn(console, 'error');

        expect(() => logger.log(unreadable())).not.toThrow();
        expect(() => logger.error(unreadable())).not.toThrow();

        expect(getRawOutput(consoleSpy)).toContain('[Unprintable]');
        expect(getRawOutput(errorSpy)).toContain('[Unprintable]');
      });

      it.each([
        ['a revoked proxy', revokedProxy],
        ['a proxy whose prototype read throws', throwingPrototype],
      ])('writes %s passed as the trace as [Unprintable] and keeps the message', (_name, unreadable) => {
        const errorSpy = jest.spyOn(console, 'error');

        expect(() => logger.error('saved-message', unreadable())).not.toThrow();

        expect(getRawOutput(errorSpy)).toContain('saved-message');
        expect(getRawOutput(errorSpy)).toContain('[Unprintable]');
      });

      it('keeps the message when an Error whose message getter throws is passed as the trace', () => {
        const errorSpy = jest.spyOn(console, 'error');

        expect(() => logger.error('saved-message', throwingMessage())).not.toThrow();

        expect(getRawOutput(errorSpy)).toContain('saved-message');
      });

      it('keeps a readable trace when the message cannot be read', () => {
        const errorSpy = jest.spyOn(console, 'error');

        logger.error(revokedProxy(), 'saved-trace');

        expect(getRawOutput(errorSpy)).toContain('[Unprintable]');
        expect(getRawOutput(errorSpy)).toContain('saved-trace');
      });

      describe('an Error passed as the trace whose stack is not text', () => {
        const withStack = (stack: unknown): Error => Object.assign(new Error('boom'), { stack });
        const cyclic = (): Record<string, unknown> => {
          const value: Record<string, unknown> = { id: 1 };
          value.self = value;
          return value;
        };

        it.each([
          ['an object', () => withStack({ password: 'value-stack', frame: 'f1' }), '"password":"[REDACTED]"'],
          ['a list of call sites', () => withStack([{ token: 'value-stack' }]), '"token":"[REDACTED]"'],
          ['a cyclic object', () => withStack(cyclic()), '[Circular]'],
          ['a BigInt', () => withStack(98765432109876543210n), '98765432109876543210'],
          [
            'nothing, with an object as the message',
            () => Object.assign(new Error('x'), { stack: undefined, message: { password: 'value-stack' } }),
            '"password":"[REDACTED]"',
          ],
        ])('writes %s as redacted text and keeps the message', (_name, make, written) => {
          const errorSpy = jest.spyOn(console, 'error');

          expect(() => logger.error('saved-message', make())).not.toThrow();

          const line = getRawOutput(errorSpy);
          expect(line).toContain('saved-message');
          expect(line).not.toContain('value-stack');
          expect(line.replace(/\\"/g, '"')).toContain(written);
        });
      });
    });
  });

  describe('error', () => {
    it('should log error messages to console.error', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('Error message', 'stack trace');

      expect(errorSpy).toHaveBeenCalled();
      const output = getLogOutput(errorSpy);
      expect(output.level).toBe('error');
      expect(output.message).toBe('Error message');
      expect(output.trace).toBe('stack trace');
    });
  });

  // Plugin ctx.logger meta reaches the logger verbatim, so caller metadata must not be able to rewrite
  // the fields a reader trusts to say who logged what, at which level.
  describe('structural fields', () => {
    it('keeps level, context, message, timestamp, trace and requestId out of reach of caller metadata', () => {
      logger.log('[plugin-a] hi', {
        level: 'error',
        context: 'AuthService',
        message: 'API key rotated',
        timestamp: '1970-01-01T00:00:00.000Z',
        trace: 'forged stack',
        requestId: 'forged',
        pluginId: 'plugin-a',
      });

      const output = getLogOutput(consoleSpy) as unknown as Record<string, unknown>;
      expect(output.level).toBe('info');
      expect(output.context).toBe('TestContext');
      expect(output.message).toBe('[plugin-a] hi');
      expect(output.timestamp).not.toBe('1970-01-01T00:00:00.000Z');
      expect(output).not.toHaveProperty('trace');
      expect(output).not.toHaveProperty('requestId');
      expect(output.pluginId).toBe('plugin-a');
    });

    it("still takes error()'s trace and string context from its own parameters", () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('boom', 'real stack', 'OtherContext');

      const output = getLogOutput(errorSpy);
      expect(output.context).toBe('OtherContext');
      expect(output.trace).toBe('real stack');
    });

    it("keeps error()'s own trace over one smuggled in its metadata", () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('boom', 'real stack', { trace: 'forged stack', sessionId: 's1' });

      const output = getLogOutput(errorSpy);
      expect(output.trace).toBe('real stack');
      expect(output.context).toBe('TestContext');
      expect(output.sessionId).toBe('s1');
    });
  });

  describe('warn', () => {
    it('should log warning messages to console.warn', () => {
      const warnSpy = jest.spyOn(console, 'warn');
      logger.warn('Warning message');

      expect(warnSpy).toHaveBeenCalled();
      const output = getLogOutput(warnSpy);
      expect(output.level).toBe('warn');
      expect(output.message).toBe('Warning message');
    });
  });

  describe('log levels', () => {
    it('should not log debug when level is INFO', () => {
      LoggerService.setLogLevel(LogLevel.INFO);
      logger.debug('Debug message');

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should log debug when level is DEBUG', () => {
      LoggerService.setLogLevel(LogLevel.DEBUG);
      logger.debug('Debug message');

      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe('pretty format', () => {
    beforeEach(() => {
      LoggerService.setLogFormat(LogFormat.PRETTY);
    });

    it('should render a NestJS-style human-readable line instead of JSON', () => {
      logger.log('Test message');

      const output = getRawOutput(consoleSpy);
      // Not JSON.
      expect(() => {
        JSON.parse(output);
      }).toThrow();
      // NestJS-style prefix, level label, context and message all present.
      expect(output).toContain('[OpenWA]');
      expect(output).toContain('LOG');
      expect(output).toContain('[TestContext]');
      expect(output).toContain('Test message');
    });

    it('should append metadata as key=value pairs', () => {
      logger.log('Test message', { sessionId: '123', action: 'test' });

      const output = getRawOutput(consoleSpy);
      expect(output).toContain('sessionId=123');
      expect(output).toContain('action=test');
    });

    it('should append the stack trace on a new line for errors', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('Error message', 'stack trace line');

      const output = getRawOutput(errorSpy);
      expect(output).toContain('Error message');
      expect(output).toContain('stack trace line');
      expect(output).toMatch(/\n.*stack trace line/);
    });
  });

  describe('non-string input (the call shapes Nest uses)', () => {
    it('renders an Error passed as the message with its stack as the trace', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error(new Error('boom'));

      const output = getLogOutput(errorSpy);
      expect(output.message).toBe('boom');
      expect(output.trace).toContain('Error: boom');
      expect(output.trace).toMatch(/\n\s+at /);
    });

    it('turns an Error or other value passed as the trace into a string', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('failed', new Error('inner'));
      logger.error('failed', 42);

      const calls = errorSpy.mock.calls as string[][];
      expect((JSON.parse(calls[0][0]) as LogEntry).trace).toContain('Error: inner');
      expect((JSON.parse(calls[1][0]) as LogEntry).trace).toBe('42');
    });

    it('redacts an object passed as the trace, in json and pretty output', () => {
      const errorSpy = jest.spyOn(console, 'error');
      const redacted = '{"a":1,"password":"[REDACTED]","n":{"token":"[REDACTED]"}}';
      const trace = { a: 1, password: 'value-trace', n: { token: 'value-token' } };

      logger.error('failed', trace);
      expect(getLogOutput(errorSpy).trace).toBe(redacted);

      errorSpy.mockClear();
      LoggerService.setLogFormat(LogFormat.PRETTY);
      logger.error('failed', trace);
      expect(getRawOutput(errorSpy)).toContain(redacted);
      expect(getRawOutput(errorSpy)).not.toContain('value-');
    });

    it('serializes an object message with secret-named keys redacted', () => {
      logger.log({ a: 1, password: 'p' });

      expect(getLogOutput(consoleSpy).message).toBe('{"a":1,"password":"[REDACTED]"}');
    });

    it('does not throw on a circular object message', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(() => logger.log(circular)).not.toThrow();
      expect(typeof getLogOutput(consoleSpy).message).toBe('string');
    });

    it('writes a circular object message with the cycle marked', () => {
      const circular: Record<string, unknown> = { id: 1 };
      circular.self = circular;

      logger.log(circular);

      expect(getLogOutput(consoleSpy).message).toBe('{"id":1,"self":"[Circular]"}');
    });

    it('does not throw on a circular message that has no prototype', () => {
      const bare = Object.create(null) as Record<string, unknown>;
      bare.self = bare;

      expect(() => logger.log(bare)).not.toThrow();
      expect(getLogOutput(consoleSpy).message).toBe('{"self":"[Circular]"}');
    });

    it('writes a BigInt message as its decimal text', () => {
      logger.log(10n);

      expect(getLogOutput(consoleSpy).message).toBe('10');
    });

    it('does not throw on a message that cannot be read at all', () => {
      const unreadable = new Proxy(
        {},
        {
          ownKeys: (): never => {
            throw new Error('ownKeys');
          },
          get: (): never => {
            throw new Error('get');
          },
        },
      );

      expect(() => logger.log(unreadable)).not.toThrow();
      expect(getLogOutput(consoleSpy).message).toBe('[Unprintable]');
    });

    it('writes fatal() at error level', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.fatal('down');

      const output = getLogOutput(errorSpy);
      expect(output.level).toBe('error');
      expect(output.message).toBe('down');
    });
  });

  describe('as the Nest framework logger', () => {
    beforeEach(() => {
      Logger.overrideLogger(createLogger('Nest'));
    });
    afterEach(() => {
      Logger.overrideLogger(new ConsoleLogger());
    });

    it("keeps the exception handler's message, stack, context and request id", () => {
      const errorSpy = jest.spyOn(console, 'error');
      runWithRequestId('req-1', () => new Logger('ExceptionsHandler').error(new Error('boom')));

      const output = getLogOutput(errorSpy) as LogEntry & { requestId?: string };
      expect(output.context).toBe('ExceptionsHandler');
      expect(output.message).toBe('boom');
      expect(output.trace).toContain('Error: boom');
      expect(output.requestId).toBe('req-1');
    });

    it('applies LOG_LEVEL to framework lines', () => {
      new Logger('X').debug('d');
      expect(consoleSpy).not.toHaveBeenCalled();

      new Logger('X').log('m');
      expect(getLogOutput(consoleSpy).context).toBe('X');
    });
  });

  // Without the option Nest keeps its ConsoleLogger, which ignores LOG_LEVEL and LOG_FORMAT.
  it('is installed as the framework logger by main.ts', () => {
    const mainSrc = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');
    expect(mainSrc).toMatch(/await NestFactory\.create\(AppModule, \{[^}]*\blogger: createLogger\('Nest'\)/);
  });

  describe('createLogger', () => {
    it('should create logger with context', () => {
      const testLogger = createLogger('MyContext');
      testLogger.log('Test');

      const output = getLogOutput(consoleSpy);
      expect(output.context).toBe('MyContext');
    });
  });
});

// The Baileys wire logger reuses this copy with its own key policy and marker, so the options are pinned directly.
describe('redactSecrets', () => {
  it('replaces the value under a secret-named key with [REDACTED] unless told otherwise', () => {
    expect(redactSecrets({ accessToken: 't', visible: 'v' })).toEqual({ accessToken: '[REDACTED]', visible: 'v' });
  });

  it('takes the credential keys and the marker from its options', () => {
    const options = { isSecretKey: (key: string) => key === 'password', marker: '[masked]' };

    expect(redactSecrets({ accessToken: 't', password: 'p' }, options)).toEqual({
      accessToken: 't',
      password: '[masked]',
    });
  });

  it('copies an Error with its name, message and stack, and its own props through the same checks, when asked to', () => {
    const error = Object.assign(new Error('boom'), { token: 't', attempts: 5n });

    const copy = redactSecrets({ error }, { errors: true }) as { error: Record<string, unknown> };

    expect(copy.error).toMatchObject({ name: 'Error', message: 'boom', token: '[REDACTED]', attempts: '5' });
    expect(copy.error.stack).toContain('Error: boom');
  });

  it('copies an array as a plain array, whatever class it is an instance of', () => {
    class Rows extends Array<unknown> {}

    const copy = redactSecrets({ rows: Rows.from([1, { token: 't' }]) }) as { rows: unknown[] };

    expect(Object.getPrototypeOf(copy.rows)).toBe(Array.prototype);
    expect(copy.rows).toEqual([1, { token: '[REDACTED]' }]);
  });

  describe('an array longer than one call may walk', () => {
    const zeros = (length: number): number[] => new Array<number>(length).fill(0);

    it('copies a million entries in the first levels and writes a longer array as [Truncated]', () => {
      const whole = redactSecrets({ list: zeros(1_000_000) }) as { list: unknown[] };

      expect(whole.list).toHaveLength(1_000_000);
      expect(redactSecrets({ list: zeros(1_000_001) })).toEqual({ list: '[Truncated]' });
    });

    it('copies a deep array that fits in what is left of the node budget and writes a longer one as [Truncated]', () => {
      // The array sits just below the fifth level: it costs 1 of the 1000 nodes, which leaves 999 entries.
      const deep = (list: unknown): unknown => ({ a: { b: { c: { d: { list } } } } });

      expect(redactSecrets(deep(zeros(999)))).toEqual(deep(zeros(999)));
      expect(redactSecrets(deep(zeros(1000)))).toEqual(deep('[Truncated]'));
    });
  });

  describe('the bounds of the copy', () => {
    // `rows` ends up `above` objects below the top, so its entries sit one level lower: with 3 above they are in
    // the fifth level, the last one copied whole, and with 4 above they are in the sixth, the first one that costs.
    const rowsBelow = (above: number, rows: unknown): unknown => {
      let value = rows;
      for (let i = 0; i < above; i++) value = { level: value };
      return value;
    };
    const rowsIn = (copy: unknown, above: number): unknown[] => {
      let value = copy as Record<string, unknown>;
      for (let i = 0; i < above; i++) value = value.level as Record<string, unknown>;
      return value as unknown as unknown[];
    };
    const objects = (length: number): Array<{ id: number }> => Array.from({ length }, (_, id) => ({ id }));

    it('copies every entry of the fifth level whole, however many there are', () => {
      const rows = rowsIn(redactSecrets(rowsBelow(3, objects(1500))), 3);

      expect(rows).toHaveLength(1500);
      expect(rows[1499]).toEqual({ id: 1499 });
    });

    it('copies exactly 1000 objects of the sixth level and writes the rest as [Truncated]', () => {
      const rows = rowsIn(redactSecrets(rowsBelow(4, objects(1500))), 4);

      expect(rows).toHaveLength(1500);
      expect(rows[999]).toEqual({ id: 999 });
      expect(rows[1000]).toBe('[Truncated]');
      expect(rows.filter(row => row === '[Truncated]')).toHaveLength(500);
    });

    it('writes an object met again inside itself as [Circular], however many objects lie between', () => {
      const first: Record<string, unknown> = { id: 'first' };
      first.second = { id: 'second', first };

      expect(redactSecrets({ first })).toEqual({
        first: { id: 'first', second: { id: 'second', first: '[Circular]' } },
      });
    });

    it('writes an array met again inside itself as [Circular], however many arrays lie between', () => {
      const outer: unknown[] = [];
      outer.push([outer]);
      const own: unknown[] = [];
      own.push(own);

      expect(redactSecrets({ outer, own })).toEqual({ outer: [['[Circular]']], own: ['[Circular]'] });
    });

    it('keeps an own toJSON that is not a function, and drops one that is', () => {
      expect(
        redactSecrets({ kept: { id: 1, toJSON: 'not a function' }, dropped: { id: 2, toJSON: () => 'x' } }),
      ).toEqual({
        kept: { id: 1, toJSON: 'not a function' },
        dropped: { id: 2 },
      });
    });
  });
});
