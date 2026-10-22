import { Injectable, LoggerService as NestLoggerService, Scope } from '@nestjs/common';
import { getRequestId } from './request-context';

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
  VERBOSE = 'verbose',
}

export enum LogFormat {
  JSON = 'json',
  PRETTY = 'pretty',
}

export interface LogContext {
  sessionId?: string;
  messageId?: string;
  webhookId?: string;
  action?: string;
  duration?: number;
  [key: string]: unknown;
}

// Defense-in-depth: redact the VALUES of secret-named keys before they reach the log sink, so a
// careless `logger.info('…', { password })` can't leak a credential. Matches the key NAME only
// (case-insensitive), never the value's content, to avoid false positives on innocuous fields.
const SECRET_KEY_PATTERN = /password|passwd|secret|token|api[-_]?key|authorization|credential|pepper|private[-_]?key/i;

// Metadata is copied whole down to this depth, however wide or dense, which is where it normally lives; that part is
// not bounded. Below it one log call copies at most REDACT_DEEP_NODES more objects and arrays and writes the rest as
// [Truncated], never raw, so a densely linked object graph cannot make it walk that part for long.
const REDACT_FULL_DEPTH = 5;
const REDACT_DEEP_NODES = 1000;
// Array.prototype.map visits every index, holes included, so a sparse array costs its length however little it
// holds (2**32 - 1 takes tens of seconds). An array longer than this, or below the whole levels longer than what is
// left of the node budget, is written as [Truncated] before any index is visited. The same goes for a typed array (a
// Buffer included), which lists one entry per element. Below the whole levels an object is listed, then truncated if
// its keys do not fit in what is left of the budget, which they are then charged to.
const REDACT_MAX_ARRAY_LENGTH = 1_000_000;

export interface RedactOptions {
  /** Whether the value under this key is a credential. Defaults to the secret-name pattern above. */
  isSecretKey?: (key: string) => boolean;
  /** Written in place of a credential's value. */
  marker?: string;
  /** Copy an Error with its name, message and stack too, which a copy of its own properties alone would lose. */
  errors?: boolean;
}

const isSecretName = (key: string): boolean => SECRET_KEY_PATTERN.test(key);

const TYPED_ARRAY_PROTOTYPE: object = Object.getPrototypeOf(Int8Array.prototype) as object;

/** The elements a typed array holds, read from the array itself, not from a `length` it claims. A DataView has none. */
function elementCount(view: ArrayBufferView): number {
  try {
    return Reflect.get(TYPED_ARRAY_PROTOTYPE, 'length', view) as number;
  } catch {
    return 0;
  }
}

/**
 * Return a copy of `value` with credential keys' values replaced by `[REDACTED]` (recursive). The copy always
 * serializes: an object met again inside itself becomes `[Circular]`, a nested BigInt its decimal text, and
 * whatever lies beyond the deep node budget `[Truncated]`. Shared with the Baileys wire logger.
 */
export function redactSecrets(value: unknown, options: RedactOptions = {}): unknown {
  const { isSecretKey = isSecretName, marker = '[REDACTED]', errors = false } = options;
  const budget = { nodes: REDACT_DEEP_NODES };
  const walk = (node: unknown, path: object[]): unknown => {
    // A function is not data: it is left out, as JSON.stringify leaves it out of an object and writes null in an array.
    if (typeof node === 'function') return undefined;
    if (node === null || typeof node !== 'object') return node;
    if (path.includes(node)) return '[Circular]';
    const deep = path.length >= REDACT_FULL_DEPTH;
    if (deep && --budget.nodes < 0) return '[Truncated]';
    const parents = [...path, node];
    const copy = (child: unknown): unknown => (typeof child === 'bigint' ? child.toString() : walk(child, parents));
    const room = deep ? budget.nodes : REDACT_MAX_ARRAY_LENGTH;
    if (Array.isArray(node)) {
      // Read once: the same number gates the copy and sizes it, whatever the object answers the next time.
      const length = node.length;
      if (length > room) return '[Truncated]';
      // A plain Array read by index: map would build the copy through the constructor of an Array subclass.
      return Array.from({ length }, (_, index) => copy(node[index]));
    }
    if (ArrayBuffer.isView(node) && elementCount(node) > room) return '[Truncated]';
    const props = node as Record<string, unknown>;
    const source =
      errors && node instanceof Error ? { name: node.name, message: node.message, stack: node.stack, ...props } : props;
    const keys = Object.keys(source);
    if (deep && keys.length > budget.nodes) {
      // Listed once, then charged: another reference to this object, or any other node, is refused without listing.
      budget.nodes -= keys.length;
      return '[Truncated]';
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const val = source[key];
      // JSON.stringify would call an own toJSON on the copy and write whatever it returns, redacted or not.
      if (key === 'toJSON' && typeof val === 'function') continue;
      out[key] = isSecretKey(key) ? marker : copy(val);
    }
    return out;
  };
  return walk(value, []);
}

/** Written in place of a message or trace that cannot be read. */
const UNPRINTABLE = '[Unprintable]';

/**
 * What a value that could not be turned into JSON is written as: a primitive as it prints, anything else not at all.
 * The text an object or a function gives for itself (its own toString, a function's source) never went through the
 * redaction, so it is not used.
 */
function plainText(value: unknown): string {
  return value === null || (typeof value !== 'object' && typeof value !== 'function') ? String(value) : UNPRINTABLE;
}

/** A non-string, non-Error message as one line of text (redacted like metadata, never throwing). */
function stringifyMessage(message: unknown): string {
  try {
    return JSON.stringify(redactSecrets(message)) ?? plainText(message);
  } catch {
    return plainText(message);
  }
}

// ANSI color codes — mirrors the palette NestJS's built-in ConsoleLogger uses so our
// pretty output blends in with the framework's own `[Nest] … LOG [Context]` lines.
const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  [LogLevel.ERROR]: ANSI.red,
  [LogLevel.WARN]: ANSI.yellow,
  [LogLevel.INFO]: ANSI.green,
  [LogLevel.DEBUG]: ANSI.magenta,
  [LogLevel.VERBOSE]: ANSI.cyan,
};

// NestJS prints `info` as `LOG`; match its labels so both log sources line up.
const LEVEL_LABEL: Record<LogLevel, string> = {
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.INFO]: 'LOG',
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.VERBOSE]: 'VERBOSE',
};

// Keys that are rendered in the line prefix rather than the trailing metadata.
const STRUCTURAL_KEYS = new Set(['timestamp', 'level', 'context', 'message', 'trace']);

@Injectable({ scope: Scope.TRANSIENT })
export class LoggerService implements NestLoggerService {
  private context: string = 'Application';
  private static logLevel: LogLevel = LogLevel.INFO;
  private static logFormat: LogFormat | null = null;

  static setLogLevel(level: LogLevel): void {
    LoggerService.logLevel = level;
  }

  // Explicitly pin the output format. When unset, the format is resolved from
  // LOG_FORMAT / TTY detection (see resolveFormat).
  static setLogFormat(format: LogFormat | null): void {
    LoggerService.logFormat = format;
  }

  setContext(context: string): void {
    this.context = context;
  }

  // Messages and traces are `unknown` because this is also Nest's framework logger (main.ts), and Nest
  // passes the thrown Error itself as the message of an unhandled-exception line; writeLog normalizes.
  log(message: unknown, context?: string | LogContext): void {
    this.writeLog(LogLevel.INFO, message, context);
  }

  error(message: unknown, trace?: unknown, context?: string | LogContext): void {
    this.writeLog(LogLevel.ERROR, message, context, trace);
  }

  fatal(message: unknown, context?: string | LogContext): void {
    this.writeLog(LogLevel.ERROR, message, context);
  }

  warn(message: unknown, context?: string | LogContext): void {
    this.writeLog(LogLevel.WARN, message, context);
  }

  debug(message: unknown, context?: string | LogContext): void {
    this.writeLog(LogLevel.DEBUG, message, context);
  }

  verbose(message: unknown, context?: string | LogContext): void {
    this.writeLog(LogLevel.VERBOSE, message, context);
  }

  private writeLog(level: LogLevel, rawMessage: unknown, context?: string | LogContext, rawTrace?: unknown): void {
    if (!this.shouldLog(level)) return;

    // The message and trace are whatever the caller (or Nest) handed over, so reading them is guarded like the metadata.
    let message: string;
    try {
      // An Error serializes to `{}`, so take its message and stack apart instead of losing both.
      if (rawMessage instanceof Error) {
        rawTrace ??= rawMessage.stack;
        rawMessage = rawMessage.message;
      }
      message = typeof rawMessage === 'string' ? rawMessage : stringifyMessage(rawMessage);
    } catch {
      message = UNPRINTABLE;
    }
    let trace: string | undefined;
    try {
      // An Error's stack is text unless something replaced it; anything that is not text is redacted like metadata.
      const text = rawTrace instanceof Error ? (rawTrace.stack ?? rawTrace.message) : rawTrace;
      trace = text === undefined || typeof text === 'string' ? text : stringifyMessage(text);
    } catch {
      trace = UNPRINTABLE;
    }

    const timestamp = new Date().toISOString();
    const contextName = typeof context === 'string' ? context : this.context;

    // Stamp every log line with the active request id (set by requestContextMiddleware) so a request
    // can be traced across logs. Absent outside a request scope (boot, workers, cron).
    const requestId = getRequestId();
    const render = (metadata: Record<string, unknown>): string => {
      // Caller metadata never replaces the structural fields: a plugin's ctx.logger meta arrives here
      // verbatim, and a `level`, `context` or `message` key in it would otherwise forge the whole line.
      const logEntry = {
        timestamp,
        level,
        context: contextName,
        message,
        ...Object.fromEntries(
          Object.entries(metadata).filter(([key]) => !STRUCTURAL_KEYS.has(key) && key !== 'requestId'),
        ),
        ...(trace !== undefined ? { trace } : {}),
        ...(requestId ? { requestId } : {}),
      };
      return LoggerService.resolveFormat() === LogFormat.PRETTY
        ? this.formatPretty(level, logEntry)
        : JSON.stringify(logEntry);
    };
    let output: string;
    try {
      const copy = typeof context === 'object' && context !== null ? redactSecrets(context) : {};
      // An array over the length limit comes back as the marker text: one field, not a record to spread.
      output = render(typeof copy === 'string' ? { metadata: copy } : (copy as Record<string, unknown>));
    } catch {
      // A getter or proxy trap in the caller's metadata threw. The line is still worth writing, without that metadata.
      output = render({ metadata: '[Unreadable]' });
    }

    switch (level) {
      case LogLevel.ERROR:
        console.error(output);
        break;
      case LogLevel.WARN:
        console.warn(output);
        break;
      default:
        console.log(output);
    }
  }

  // Render a single entry as a human-readable line in the same shape NestJS's ConsoleLogger uses
  // (so it lines up with the framework's own output), but tagged honestly as [OpenWA]:
  //   [OpenWA] 1896  - 25/06/2026, 4:59:22 PM     LOG [AuthService] API Docs: … sessionId=abc
  private formatPretty(level: LogLevel, entry: Record<string, unknown>): string {
    const useColor = LoggerService.colorEnabled();
    const paint = (code: string, text: string): string => (useColor ? `${code}${text}${ANSI.reset}` : text);

    const levelColor = LEVEL_COLOR[level];
    const label = LEVEL_LABEL[level].padStart(7);
    const timestamp = new Date(String(entry.timestamp)).toLocaleString();
    const contextName = String(entry.context);
    const message = String(entry.message);

    // Trailing structured metadata (sessionId, action, duration, …) shown dimmed as key=value pairs.
    const formatValue = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? ''));
    const meta = Object.entries(entry)
      .filter(([key, value]) => !STRUCTURAL_KEYS.has(key) && value !== undefined)
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(' ');

    let line =
      `${paint(levelColor, `[OpenWA] ${process.pid}  -`)} ${timestamp} ` +
      `${paint(levelColor, label)} ${paint(ANSI.yellow, `[${contextName}]`)} ${paint(levelColor, message)}`;

    if (meta) {
      line += ` ${paint(ANSI.dim, meta)}`;
    }

    // Error stack traces print on their own line(s), like NestJS.
    if (typeof entry.trace === 'string' && entry.trace) {
      line += `\n${paint(levelColor, entry.trace)}`;
    }

    return line;
  }

  private static resolveFormat(): LogFormat {
    if (LoggerService.logFormat) return LoggerService.logFormat;

    const explicit = process.env.LOG_FORMAT?.trim().toLowerCase();
    if (explicit === LogFormat.JSON || explicit === LogFormat.PRETTY) {
      return explicit;
    }

    // No explicit choice: structured JSON in production (containers, log aggregators),
    // human-readable pretty everywhere else. This mirrors NestJS's own logger, which
    // always prints its text format — and unlike a TTY check it stays correct when
    // stdout is piped through a dev runner (e.g. `concurrently` in `npm run dev`).
    return process.env.NODE_ENV === 'production' ? LogFormat.JSON : LogFormat.PRETTY;
  }

  private static colorEnabled(): boolean {
    // Honor the de-facto NO_COLOR / FORCE_COLOR conventions; otherwise colorize only a real TTY.
    if (process.env.NO_COLOR) return false;
    if (process.env.FORCE_COLOR) return true;
    return Boolean(process.stdout.isTTY);
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.ERROR, LogLevel.WARN, LogLevel.INFO, LogLevel.DEBUG, LogLevel.VERBOSE];
    const currentIndex = levels.indexOf(LoggerService.logLevel);
    const targetIndex = levels.indexOf(level);
    return targetIndex <= currentIndex;
  }
}

// Create a factory for easy instantiation
export function createLogger(context: string): LoggerService {
  const logger = new LoggerService();
  logger.setContext(context);
  return logger;
}
