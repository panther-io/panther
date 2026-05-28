/**
 * Logging primitives for the core runtime.
 * @pk
 */

/**
 * Supported log levels.
 * @pk
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Structured log entry payload.
 * @pk
 */
export type LogEntry = {
  level: LogLevel;
  message: string;
  timestamp: Date;
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

/**
 * Low-level logger driver interface.
 * @pk
 */
export type LoggerDriver = {
  write(entry: LogEntry): void | Promise<void>;
};

/**
 * Logger configuration options.
 * @pk
 */
export type LoggerOptions = {
  level?: LogLevel;
  driver?: LoggerDriver;
  context?: Record<string, unknown>;
  onWrite?: (entry: LogEntry) => void | Promise<void>;
};

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

/**
 * Console-based logger driver.
 * @pk
 */
export class ConsoleLoggerDriver implements LoggerDriver {
  /**
   * Write the log entry to the console.
   * @pk
   */
  write(entry: LogEntry): void {
    const payload = {
      ...entry.context,
      ...entry.metadata,
    };
    const method = entry.level === "debug" ? "debug" : entry.level === "info" ? "info" : entry.level === "warn" ? "warn" : "error";
    console[method](`[panther:${entry.level}] ${entry.message}`, payload);
  }
}

/**
 * Structured logger with level filtering.
 * @pk
 */
export class Logger {
  private readonly level: LogLevel;
  private readonly driver: LoggerDriver;
  private readonly context: Record<string, unknown>;
  private readonly annotations: Record<string, unknown>;
  private readonly onWrite?: (entry: LogEntry) => void | Promise<void>;

  /**
   * Create a new logger instance.
   * @pk
   */
  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.driver = options.driver ?? new ConsoleLoggerDriver();
    this.context = options.context ?? {};
    this.annotations = {};
    this.onWrite = options.onWrite;
  }

  /**
   * Create a child logger with merged context.
   * @pk
   */
  child(context: Record<string, unknown>): Logger {
    const child = new Logger({
      level: this.level,
      driver: this.driver,
      context: {
        ...this.context,
        ...context,
      },
      onWrite: this.onWrite,
    });
    Object.assign(child.annotations, this.annotations);
    return child;
  }

  /**
   * Add mutable metadata that will be included in future log writes.
   * @pk
   */
  annotate(key: string, value: unknown): this {
    this.annotations[key] = value;
    return this;
  }

  /**
   * Add a tag to future log writes.
   * @pk
   */
  setTag(key: string, value: unknown): this {
    this.annotations[`tag.${key}`] = value;
    return this;
  }

  /**
   * Emit a debug log entry.
   * @pk
   */
  debug(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("debug", message, metadata);
  }

  /**
   * Emit an info log entry.
   * @pk
   */
  info(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("info", message, metadata);
  }

  /**
   * Emit a warning log entry.
   * @pk
   */
  warn(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("warn", message, metadata);
  }

  /**
   * Emit an error log entry.
   * @pk
   */
  error(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("error", message, metadata);
  }

  /**
   * Emit a fatal log entry.
   * @pk
   */
  fatal(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("fatal", message, metadata);
  }

  /**
   * Write a log entry if the level is enabled.
   * @pk
   */
  private async write(level: LogLevel, message: string, metadata: Record<string, unknown>): Promise<void> {
    if (levelWeight[level] < levelWeight[this.level]) {
      return;
    }

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      context: this.context,
      metadata: {
        ...this.annotations,
        ...metadata,
      },
    };

    await this.driver.write(entry);
    await this.onWrite?.(entry);
  }
}
