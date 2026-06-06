import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Logger, type LoggerOptions } from "./logger.js";
import { McpProxy, type AutoLogOptions, type McpProxyOptions } from "./McpProxy.js";
import { McpServer, type EnvResolver } from "./McpServer.js";
import { HttpProxyExposureTransport, type HttpProxyExposureTransportOptions } from "./transports/HttpProxyExposureTransport.js";
import { SseProxyExposureTransport, type SseProxyExposureTransportOptions } from "./transports/SseProxyExposureTransport.js";
import { StdioProxyExposureTransport, type StdioProxyExposureTransportOptions } from "./transports/StdioProxyExposureTransport.js";
import { StdioTransport, type StdioTransportOptions } from "./transports/StdioTransport.js";
import { StreamableHttpMcpTransport, type StreamableHttpMcpTransportOptions } from "./transports/StreamableHttpMcpTransport.js";
import { SseMcpTransport, type SseMcpTransportOptions } from "./transports/SseMcpTransport.js";
import { MemoryRateLimitStore, SlidingWindowRateLimiter } from "./rateLimit.js";
import type {
  IdentityStrategy,
  Isolation,
  MaybePromise,
  PanterTransport,
  ProxyExposureTransport,
  ProxyMiddleware,
  ProxyNext,
  RateLimitStore,
} from "./types.js";

export type PantherOptions = Omit<McpProxyOptions, "servers" | "logger" | "identity" | "autoLog"> & {
  servers?: McpServer[];
  logger?: Logger | (LoggerOptions & { redact?: string[] });
  defaults?: {
    identityRequired?: boolean;
    autoLog?: boolean | AutoLogOptions;
  };
  identity?: McpProxyOptions["identity"];
  autoLog?: McpProxyOptions["autoLog"];
};

export type McpTransportDescriptor = {
  readonly __pantherMcpTransport: true;
  readonly transport: PanterTransport;
  readonly displayName?: string;
  readonly env?: EnvResolver;
  readonly isolation?: Isolation;
  readonly isolationTimeout?: number;
};

export type StdioMcpOptions = StdioTransportOptions & {
  displayName?: string;
  isolation?: Isolation | { perSubject?: boolean };
  isolationTimeout?: number;
};

export type HttpMcpOptions = StreamableHttpMcpTransportOptions & {
  displayName?: string;
};

export type LegacyHttpMcpOptions = Omit<HttpMcpOptions, "url"> & {
  url?: string | URL;
  baseUrl?: string;
};

export type SseMcpOptions = SseMcpTransportOptions & {
  displayName?: string;
};

export function panther(options: PantherOptions): McpProxy {
  const logger = options.logger instanceof Logger
    ? options.logger
    : options.logger
      ? new Logger(options.logger)
      : undefined;
  const identity = options.identity ?? (options.defaults?.identityRequired && options.auth
    ? { strategy: options.auth.identityStrategy(), required: true }
    : undefined);

  return new McpProxy({
    ...options,
    servers: options.servers ?? [],
    logger,
    identity,
    autoLog: options.autoLog ?? options.defaults?.autoLog,
  });
}

export const mcp = {
  stdio(options: StdioMcpOptions): McpTransportDescriptor {
    const { displayName, isolation, isolationTimeout, env, ...transportOptions } = options;
    return {
      __pantherMcpTransport: true,
      transport: new StdioTransport(transportOptions),
      displayName,
      env,
      isolation: isIsolation(isolation) ? isolation : undefined,
      isolationTimeout,
    };
  },

  http(options: LegacyHttpMcpOptions): McpTransportDescriptor {
    const { displayName, baseUrl, ...transportOptions } = options;
    return {
      __pantherMcpTransport: true,
      transport: new StreamableHttpMcpTransport({
        ...transportOptions,
        url: transportOptions.url ?? baseUrl ?? "",
      }),
      displayName,
    };
  },

  sse(options: SseMcpOptions): McpTransportDescriptor {
    const { displayName, ...transportOptions } = options;
    return {
      __pantherMcpTransport: true,
      transport: new SseMcpTransport(transportOptions),
      displayName,
    };
  },
};

export type HttpExposureOptions = HttpProxyExposureTransportOptions & {
  identity?: IdentityStrategy;
};

export function http(options: HttpExposureOptions = {}): ProxyExposureTransport {
  return new HttpProxyExposureTransport(options);
}

export function sse(options: (SseProxyExposureTransportOptions & { path?: string; identity?: IdentityStrategy }) = {}): ProxyExposureTransport {
  const { path, ...rest } = options;
  return new SseProxyExposureTransport({
    ...rest,
    ssePath: rest.ssePath ?? path,
  });
}

export function stdio(options: StdioProxyExposureTransportOptions & { subject?: string } = {}): ProxyExposureTransport {
  const { subject, user, ...rest } = options;
  return new StdioProxyExposureTransport({
    ...rest,
    user: user ?? (subject ? { id: subject } : undefined),
  });
}

export type ManualApprovalOptions = {
  reason?: string;
  timeoutMs?: number;
  approve?: (ctx: Parameters<ProxyMiddleware>[0]) => MaybePromise<boolean>;
};

export function manualApproval(options: ManualApprovalOptions = {}): ProxyMiddleware {
  return async (ctx, next) => {
    const approved = await options.approve?.(ctx);
    if (!approved) {
      return ctx.deny(options.reason ?? "Manual approval required.");
    }

    return next();
  };
}

export type FixedWindowRateLimitOptions = {
  limit: number;
  windowMs: number;
  store?: RateLimitStore;
  key?: (ctx: Parameters<ProxyMiddleware>[0]) => string;
  message?: string;
};

export const rateLimit = {
  fixedWindow(options: FixedWindowRateLimitOptions): ProxyMiddleware {
    const limiter = new SlidingWindowRateLimiter({
      store: options.store ?? new MemoryRateLimitStore(),
      maxPerWindow: options.limit,
      windowMs: options.windowMs,
    });

    return async (ctx, next) => {
      const key = options.key?.(ctx) ?? `${ctx.subject?.id ?? ctx.auth.userId ?? "anonymous"}:${ctx.server?.name ?? "*"}:${ctx.tool?.name ?? "*"}`;
      if (!(await limiter.checkLimit(key))) {
        return ctx.deny(options.message ?? "Rate limit exceeded.");
      }

      await limiter.recordCall(key);
      return next();
    };
  },
};

export function zodInput<TSchema extends z.ZodType>(schema: TSchema): ProxyMiddleware {
  return (ctx, next: ProxyNext): MaybePromise<CallToolResult | void> => {
    const result = schema.safeParse(ctx.args ?? {});
    if (!result.success) {
      return ctx.fail(-32602, result.error.issues.map((issue) => issue.message).join("; "));
    }

    ctx.args = result.data as Parameters<ProxyMiddleware>[0]["args"];
    return next();
  };
}

export function isMcpTransportDescriptor(value: unknown): value is McpTransportDescriptor {
  return Boolean(value && typeof value === "object" && "__pantherMcpTransport" in value);
}

export function descriptorToServer(name: string, descriptor: McpTransportDescriptor): McpServer {
  return new McpServer({
    name,
    displayName: descriptor.displayName,
    transport: descriptor.transport,
    env: descriptor.env,
    isolation: descriptor.isolation,
    isolationTimeout: descriptor.isolationTimeout,
  });
}

function isIsolation(value: unknown): value is Isolation {
  return Boolean(value && typeof value === "object" && "queue" in value);
}
