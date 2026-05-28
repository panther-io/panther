export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type LogEntry = {
  level: LogLevel;
  message: string;
  timestamp: Date;
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type LoggerDriver = {
  write(entry: LogEntry): void | Promise<void>;
};

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

export class ConsoleLoggerDriver implements LoggerDriver {
  write(entry: LogEntry): void {
    const payload = {
      ...entry.context,
      ...entry.metadata,
    };
    const method = entry.level === "debug" ? "debug" : entry.level === "info" ? "info" : entry.level === "warn" ? "warn" : "error";
    console[method](`[panther:${entry.level}] ${entry.message}`, payload);
  }
}

export class Logger {
  private readonly level: LogLevel;
  private readonly driver: LoggerDriver;
  private readonly context: Record<string, unknown>;
  private readonly onWrite?: (entry: LogEntry) => void | Promise<void>;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.driver = options.driver ?? new ConsoleLoggerDriver();
    this.context = options.context ?? {};
    this.onWrite = options.onWrite;
  }

  child(context: Record<string, unknown>): Logger {
    return new Logger({
      level: this.level,
      driver: this.driver,
      context: {
        ...this.context,
        ...context,
      },
      onWrite: this.onWrite,
    });
  }

  debug(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("debug", message, metadata);
  }

  info(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("info", message, metadata);
  }

  warn(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("warn", message, metadata);
  }

  error(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("error", message, metadata);
  }

  fatal(message: string, metadata: Record<string, unknown> = {}): void {
    void this.write("fatal", message, metadata);
  }

  private async write(level: LogLevel, message: string, metadata: Record<string, unknown>): Promise<void> {
    if (levelWeight[level] < levelWeight[this.level]) {
      return;
    }

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      context: this.context,
      metadata,
    };

    await this.driver.write(entry);
    await this.onWrite?.(entry);
  }
}
