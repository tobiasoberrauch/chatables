/**
 * Structured JSON logger for all services.
 * Outputs to stdout for container-based collection (Fluentd/Loki).
 */

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

interface LogEntry {
  level: LogLevel;
  message: string;
  service: string;
  timestamp: string;
  traceId?: string;
  [key: string]: unknown;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
};

export class Logger {
  private readonly service: string;
  private readonly minLevel: LogLevel;

  constructor(service: string, minLevel: LogLevel = LogLevel.INFO) {
    this.service = service;
    this.minLevel = minLevel;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, meta);
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, {
      ...meta,
      error: error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : undefined,
    });
  }

  private log(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) return;

    const entry: LogEntry = {
      level,
      message,
      service: this.service,
      timestamp: new Date().toISOString(),
      ...meta,
    };

    const output = JSON.stringify(entry);

    if (level === LogLevel.ERROR) {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  }

  child(meta: Record<string, unknown>): ChildLogger {
    return new ChildLogger(this, meta);
  }
}

class ChildLogger {
  constructor(
    private readonly parent: Logger,
    private readonly meta: Record<string, unknown>,
  ) {}

  debug(message: string, meta?: Record<string, unknown>): void {
    this.parent.debug(message, { ...this.meta, ...meta });
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.parent.info(message, { ...this.meta, ...meta });
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.parent.warn(message, { ...this.meta, ...meta });
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    this.parent.error(message, error, { ...this.meta, ...meta });
  }
}
