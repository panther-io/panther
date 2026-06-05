import type {
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "./logger.js";

/**
 * Maybe a promise for async compatibility.
 * @pk
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * User context passed through requests.
 * @pk
 */
export type UserContext = {
  id?: string;
  secrets?: Record<string, string>;
  tokens?: Record<string, string>;
  [key: string]: unknown;
};

/**
 * Non-sensitive subject metadata declared in application code.
 * @pk
 */
export type SubjectMetadata = {
  displayName?: string;
  email?: string;
  tenantId?: string;
  tenant?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

/**
 * Configured group membership metadata for a resolved subject.
 * @pk
 */
export type GroupMembership = {
  id: string;
  name?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Credential source metadata safe to expose in middleware and logs.
 * @pk
 */
export type CredentialSourceMetadata = {
  reference: string;
  source: "user" | "group" | "default";
  userId?: string;
  groupId?: string;
};

/**
 * Effective policy metadata safe to expose in middleware and logs.
 * @pk
 */
export type PolicyMetadata = {
  policyName?: string;
  matchedGroups?: string[];
  matchedPermissions?: Array<{
    policyName: string;
    groupId?: string;
    serverName: string;
    toolName: string;
    effect: "allow" | "deny";
    metadata?: Record<string, unknown>;
  }>;
  denialReason?: string;
};

/**
 * Authenticated subject resolved from user and group declarations.
 * @pk
 */
export type ResolvedSubject = {
  id: string;
  displayName?: string;
  email?: string;
  metadata?: Record<string, unknown>;
  tenant?: Record<string, unknown>;
  groups: GroupMembership[];
  hasGroup(groupId: string): boolean;
};

/**
 * Identity metadata resolved at the proxy edge.
 * @pk
 */
export type IdentityMetadata = {
  strategy?: string;
  authenticated?: boolean;
  userId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Normalized tool call details for middleware.
 * @pk
 */
export type ToolCallRequest = {
  serverName: string;
  toolName: string;
  proxyToolName: string;
  arguments: CallToolRequest["params"]["arguments"];
  raw: CallToolRequest["params"];
};

/**
 * Filter for proxy call hooks.
 * @pk
 */
export type ToolCallHookFilter = {
  server?: string;
  tool?: string;
  proxyTool?: string;
};

/**
 * Event names supported by the proxy hook system.
 * @pk
 */
export type ProxyHookEvent = "call";

/**
 * Lifecycle event names emitted by the proxy.
 * @pk
 */
export type LifecycleHookEvent = "sessionStart" | "sessionEnd" | "toolFailure";

/**
 * Lifecycle hook context.
 * @pk
 */
export type LifecycleHookContext = {
  user: UserContext;
  subject?: ResolvedSubject;
  identity?: IdentityMetadata;
  sessionId?: string;
  request?: ToolCallRequest;
  error?: Error;
  log: Logger;
};

/**
 * Hook invoked for proxy lifecycle events.
 * @pk
 */
export type LifecycleHook = (event: LifecycleHookEvent, context: LifecycleHookContext) => MaybePromise<void>;

/**
 * Hook invoked for matched tool calls.
 * @pk
 */
export type ToolCallHook = (
  request: ToolCallRequest,
  context: MiddlewareContext,
) => MaybePromise<void | CallToolResult>;

/**
 * Hook invoked after upstream tool discovery and before returning tools to the client.
 * @pk
 */
export type ListToolsHook = (
  tools: ListToolsResult["tools"],
  context: ListToolsContext,
) => MaybePromise<ListToolsResult["tools"] | ListToolsResult | void>;

/**
 * Context passed to list tool hooks.
 * @pk
 */
export type ListToolsContext = {
  user: UserContext;
  subject?: ResolvedSubject;
  identity?: IdentityMetadata;
  log: Logger;
  policy?: Policy;
  policyDecision?: PolicyDecision;
  credentialSources?: CredentialSourceMetadata[];
};

/**
 * Helper for returning allow/deny responses from middleware.
 * @pk
 */
export class ResponseController {
  private readonly agentMessages: string[] = [];
  private structuredError: { code: number; message: string } | null = null;
  private readonly errorHandlers: Array<(error: Error) => MaybePromise<void>> = [];

  /**
   * Deny a tool call with a message.
   * @pk
   */
  deny(message: string): CallToolResult {
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }

  /**
   * Return a structured MCP-style error without throwing.
   * @pk
   */
  fail(code: number, message: string): CallToolResult {
    this.structuredError = { code, message };
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      _meta: {
        error: { code, message },
      },
    };
  }

  /**
   * Allow middleware to continue without overriding the response.
   * @pk
   */
  continue(): undefined {
    return undefined;
  }

  /**
   * Add guidance for the calling agent to the eventual tool response.
   * @pk
   */
  injectToAgent(message: string): void {
    if (message.trim()) {
      this.agentMessages.push(message);
    }
  }

  /**
   * Register a response event handler.
   * @pk
   */
  on(event: "error", handler: (error: Error) => MaybePromise<void>): void {
    this.errorHandlers.push(handler);
  }

  /**
   * Run registered error handlers.
   * @internal
   */
  async notifyError(error: Error): Promise<void> {
    for (const handler of this.errorHandlers) {
      await handler(error);
    }
  }

  /**
   * Apply queued agent guidance to a tool result.
   * @internal
   */
  applyInjections(result: CallToolResult): CallToolResult {
    const withError = this.structuredError
      ? {
          ...result,
          _meta: {
            ...result._meta,
            error: this.structuredError,
          },
        }
      : result;

    if (this.agentMessages.length === 0) {
      return withError;
    }

    return {
      ...withError,
      content: [
        ...withError.content,
        ...this.agentMessages.map((text) => ({
          type: "text" as const,
          text,
        })),
      ],
    };
  }

  /**
   * Return queued agent guidance as an error result.
   * @internal
   */
  injectedErrorResult(): CallToolResult | undefined {
    if (this.agentMessages.length === 0) {
      return undefined;
    }

    return {
      content: this.agentMessages.map((text) => ({
        type: "text" as const,
        text,
      })),
      isError: true,
    };
  }
}

/**
 * Middleware execution context.
 * @pk
 */
export type MiddlewareContext = {
  user: UserContext;
  subject?: ResolvedSubject;
  identity?: IdentityMetadata;
  log: Logger;
  res: ResponseController;
  policy?: Policy;
  policyDecision?: PolicyDecision;
  registry?: Registry;
  rateLimiter?: RateLimiter;
  credentialSources?: CredentialSourceMetadata[];
};

/**
 * Next middleware handler.
 * @pk
 */
export type Next = () => Promise<CallToolResult>;

/**
 * Middleware function signature.
 * @pk
 */
export type Middleware = (
  request: ToolCallRequest,
  context: MiddlewareContext,
  next: Next,
) => MaybePromise<CallToolResult | void>;

/**
 * Transport interface for MCP client interactions.
 * @pk
 */
export type PanterTransport = {
  listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult>;
  callTool(params: CallToolRequest["params"]): Promise<CallToolResult>;
  close(): Promise<void>;
};

/**
 * Tool permission model for policy enforcement.
 * @pk
 */
export type ToolPermission = {
  tool: string;
  effect?: "allow" | "deny";
  limiter?: RateLimiter;
  approval?: (request: ToolCallRequest, context: MiddlewareContext) => MaybePromise<boolean>;
  metadata?: Record<string, unknown>;
};

/**
 * Policy evaluation result.
 * @pk
 */
export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
  metadata?: PolicyMetadata & Record<string, unknown>;
};

/**
 * Policy for RBAC-style permission enforcement.
 * @pk
 */
export interface Policy {
  name: string;
  description?: string;
  getPermissions(serverName: string): ToolPermission[];
  evaluate(
    request: ToolCallRequest,
    user: UserContext,
    context?: MiddlewareContext,
  ): MaybePromise<PolicyDecision>;
  metadata?: {
    maxDailyCalls?: number;
    requiresApproval?: boolean;
    [key: string]: unknown;
  };
}

/**
 * Registry for resolving user data and secrets.
 * @pk
 */
export interface Registry {
  getUser(userId: string): MaybePromise<UserContext | null>;
  getSecrets(userId: string): MaybePromise<Record<string, string> | null>;
  getTokens(userId: string): MaybePromise<Record<string, string> | null>;
}

/**
 * Rate limit store for distributed tracking.
 * @pk
 */
export interface RateLimitStore {
  increment(key: string, window: number): MaybePromise<number>;
  get(key: string): MaybePromise<number>;
  reset(key: string): MaybePromise<void>;
}

/**
 * Rate limiter with sliding window and quota support.
 * @pk
 */
export interface RateLimiter {
  checkLimit(key: string): MaybePromise<boolean>;
  recordCall(key: string): MaybePromise<void>;
  getRemainingCalls(key: string): MaybePromise<number>;
  metadata?: {
    maxPerWindow?: number;
    windowMs?: number;
    maxDailyCalls?: number;
  };
}

/**
 * Identity resolution strategy.
 * @pk
 */
export type IdentityStrategy = {
  name: string;
  resolve(request: { headers?: Record<string, string>; [key: string]: unknown }): MaybePromise<UserContext | null>;
};

/**
 * Isolation runtime for per-user execution.
 * @pk
 */
export interface Isolation {
  queue(
    userId: string,
    fn: () => MaybePromise<CallToolResult>,
    timeout?: number,
  ): MaybePromise<CallToolResult>;
  close(): MaybePromise<void>;
}

/**
 * Error mapper for standardized MCP error responses.
 * @pk
 */
export type ErrorMapper = {
  mapError(error: unknown, context: { serverName?: string; toolName?: string }): {
    code: number;
    message: string;
  };
};

/**
 * Extended middleware context with governance.
 * @pk
 */
export type GovernanceContext = MiddlewareContext & {
  policy?: Policy;
  policyDecision?: PolicyDecision;
  identity?: IdentityMetadata;
  registry?: Registry;
  rateLimiter?: RateLimiter;
};
