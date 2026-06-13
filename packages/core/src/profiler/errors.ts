import type { RuntimeEventLevel, RuntimeProfilerErrorPayload } from "./events.js";

export type RuntimeErrorContext = Record<string, unknown>;

export type FentarisRuntimeErrorOptions = {
  code?: string;
  severity?: RuntimeEventLevel;
  cause?: unknown;
  hints?: string[];
  context?: RuntimeErrorContext;
};

export class FentarisRuntimeError extends Error {
  readonly code: string;
  readonly severity: RuntimeEventLevel;
  readonly hints: string[];
  readonly context: RuntimeErrorContext;

  constructor(message: string, options: FentarisRuntimeErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? "FENTARIS_RUNTIME_ERROR";
    this.severity = options.severity ?? "error";
    this.hints = options.hints ?? [];
    this.context = options.context ?? {};
  }
}

export class FentarisMcpError extends FentarisRuntimeError {
  constructor(message: string, options: FentarisRuntimeErrorOptions = {}) {
    super(message, { code: "FENTARIS_MCP_ERROR", ...options });
  }
}

export class FentarisTransportError extends FentarisRuntimeError {
  constructor(message: string, options: FentarisRuntimeErrorOptions = {}) {
    super(message, { code: "FENTARIS_TRANSPORT_ERROR", ...options });
  }
}

export class FentarisPolicyError extends FentarisRuntimeError {
  constructor(message: string, options: FentarisRuntimeErrorOptions = {}) {
    super(message, { code: "FENTARIS_POLICY_ERROR", severity: "warn", ...options });
  }
}

export class FentarisExtensionError extends FentarisRuntimeError {
  constructor(message: string, options: FentarisRuntimeErrorOptions = {}) {
    super(message, { code: "FENTARIS_EXTENSION_ERROR", ...options });
  }
}

export class FentarisTimeoutError extends FentarisRuntimeError {
  constructor(message: string, options: FentarisRuntimeErrorOptions = {}) {
    super(message, {
      code: "FENTARIS_TIMEOUT_ERROR",
      severity: "warn",
      hints: ["Increase the timeout or inspect the upstream server latency."],
      ...options,
    });
  }
}

export function normalizeRuntimeError(error: unknown, options: FentarisRuntimeErrorOptions = {}): FentarisRuntimeError {
  if (error instanceof FentarisRuntimeError) {
    if (!Object.keys(options.context ?? {}).length && !options.hints?.length) {
      return error;
    }

    return new FentarisRuntimeError(error.message, {
      code: error.code,
      severity: error.severity,
      cause: error.cause,
      hints: [...error.hints, ...(options.hints ?? [])],
      context: { ...error.context, ...options.context },
    });
  }

  if (error instanceof Error) {
    return new FentarisRuntimeError(error.message, {
      code: options.code,
      severity: options.severity,
      cause: error,
      hints: options.hints,
      context: {
        originalName: error.name,
        ...options.context,
      },
    });
  }

  return new FentarisRuntimeError(String(error), options);
}

export function toRuntimeErrorPayload(error: unknown): RuntimeProfilerErrorPayload {
  const normalized = normalizeRuntimeError(error);
  return {
    name: normalized.name,
    code: normalized.code,
    message: normalized.message,
    severity: normalized.severity,
    hints: normalized.hints,
    context: normalized.context,
    cause: normalizeCause(normalized.cause),
  };
}

export function renderRuntimeError(error: unknown): string {
  const payload = toRuntimeErrorPayload(error);
  const context = Object.entries(payload.context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const hints = payload.hints.length > 0 ? `\nHint: ${payload.hints.join(" ")}` : "";
  return `[${payload.code}] ${payload.message}${context ? `\n${context}` : ""}${hints}`;
}

export function runtimeErrorEvent(error: unknown, context: RuntimeErrorContext = {}) {
  const normalized = normalizeRuntimeError(error, { context });
  return toRuntimeErrorPayload(normalized);
}

function normalizeCause(cause: unknown): RuntimeProfilerErrorPayload | { name: string; message: string } | undefined {
  if (!cause) {
    return undefined;
  }

  if (cause instanceof FentarisRuntimeError) {
    return toRuntimeErrorPayload(cause);
  }

  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }

  return { name: "UnknownCause", message: String(cause) };
}
