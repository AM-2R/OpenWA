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

    it('truncates a wide structure that sits deep in the metadata after the bound', () => {
      logger.log('cfg', { a: { b: { c: { d: { items: Array.from({ length: 1500 }, (_, id) => ({ id })) } } } } });

      const { items } = (getLogOutput(consoleSpy) as unknown as { a: { b: { c: { d: { items: unknown[] } } } } }).a.b.c
        .d;
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
});
