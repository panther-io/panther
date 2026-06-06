import type {
  CallToolRequest,
  CallToolResult,
  CompleteRequest,
  CompleteResult,
  GetPromptRequest,
  GetPromptResult,
  ListPromptsRequest,
  ListPromptsResult,
  ListResourcesRequest,
  ListResourcesResult,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResult,
  ListToolsRequest,
  ListToolsResult,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "./logger.js";

/**
 * Maybe a promise for async compatibility.
 * @pk
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Request/result aliases for MCP server resource operations.
 * @pk
 */
export type ListResourcesParams = ListResourcesRequest["params"];
export type ListResourcesResponse = ListResourcesResult;
export type ReadResourceParams = ReadResourceRequest["params"];
export type ReadResourceResponse = ReadResourceResult;
export type ListResourceTemplatesParams = ListResourceTemplatesRequest["params"];
export type ListResourceTemplatesResponse = ListResourceTemplatesResult;

/**
 * Request/result aliases for MCP server prompt operations.
 * @pk
 */
export type ListPromptsParams = ListPromptsRequest["params"];
export type ListPromptsResponse = ListPromptsResult;
export type GetPromptParams = GetPromptRequest["params"];
export type GetPromptResponse = GetPromptResult;

/**
 * Request/result aliases for MCP completion operations.
 * @pk
 */
export type CompleteParams = CompleteRequest["params"];
export type CompleteResponse = CompleteResult;

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
    operation: McpOperationName;
    target?: string;
    targetKind?: CapabilityTargetKind;
    toolName?: string;
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
 * Structured subject metadata exposed through the unified context.
 * @pk
 */
export type ProxySubjectContext = ResolvedSubject;

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
 * Operation names handled by the unified proxy context.
 * @pk
 */
export type ProxyOperation = "tool:call" | "tools:list" | "session:start" | "session:end";

/**
 * Governed MCP operation names used by capability permissions.
 * @pk
 */
export type McpOperationName =
  | "tools:list"
  | "tool:call"
  | "resources:list"
  | "resource:read"
  | "resource-templates:list"
  | "prompts:list"
  | "prompt:get"
  | "completion:complete";

/**
 * Safe downstream transport metadata attached to a proxy operation.
 * @pk
 */
export type ProxyTransportContext = {
  type?: "http" | "stdio" | "sse" | "unknown";
  sessionId?: string;
  requestId?: string;
};

/**
 * Normalized authentication metadata exposed through the unified context.
 * @pk
 */
export type ProxyAuthContext = {
  strategy?: string;
  authenticated: boolean;
  userId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Structured policy metadata exposed through the unified context.
 * @pk
 */
export type ProxyPolicyContext = {
  allowed?: boolean;
  reason?: string;
  matchedGroups: string[];
  matchedPermissions: NonNullable<PolicyMetadata["matchedPermissions"]>;
  metadata?: Record<string, unknown>;
  policy?: Policy;
  decision?: PolicyDecision;
  can(server: string, tool: string): MaybePromise<boolean>;
};

/**
 * Selected upstream server metadata.
 * @pk
 */
export type ProxyServerContext = {
  name: string;
  displayName?: string;
};

/**
 * Selected tool metadata.
 * @pk
 */
export type ProxyToolContext = {
  name: string;
  proxyName: string;
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
  policy?: Policy | ProxyPolicyContext;
  policyDecision?: PolicyDecision;
  registry?: Registry;
  rateLimiter?: RateLimiter;
  credentialSources?: CredentialSourceMetadata[];
};

/**
 * Unified context for new proxy middleware, routes, and events.
 * @pk
 */
export type ProxyContext = MiddlewareContext & {
  operation: ProxyOperation;
  transport: ProxyTransportContext;
  auth: ProxyAuthContext;
  policy: ProxyPolicyContext;
  credentials: {
    sources: CredentialSourceMetadata[];
  };
  server?: ProxyServerContext;
  tool?: ProxyToolContext;
  args?: CallToolRequest["params"]["arguments"];
  raw?: CallToolRequest["params"] | ListToolsRequest["params"];
  state: Record<string, unknown>;
  response: ResponseController;
  deny(message: string): CallToolResult;
  fail(code: number, message: string): CallToolResult;
  continue(): undefined;
  inject(message: string): void;
  error(code: number, message: string): CallToolResult;
};

/**
 * Next middleware handler.
 * @pk
 */
export type Next = () => Promise<CallToolResult>;

/**
 * Next handler for unified proxy middleware.
 * @pk
 */
export type ProxyNext = () => Promise<CallToolResult>;

/**
 * Legacy middleware function signature.
 * @pk
 */
export type LegacyMiddleware = (
  request: ToolCallRequest,
  context: MiddlewareContext,
  next: Next,
) => MaybePromise<CallToolResult | void>;

/**
 * Express-like middleware function signature.
 * @pk
 */
export type ProxyMiddleware = (
  context: ProxyContext,
  next: ProxyNext,
) => MaybePromise<CallToolResult | void>;

/**
 * Middleware function signature.
 * @pk
 */
export type Middleware = LegacyMiddleware | ProxyMiddleware;

/**
 * Express-like tool route handler signature.
 * @pk
 */
export type ProxyToolHandler = ProxyMiddleware;

/**
 * Public tool pattern using `server.tool` dot notation and `*` wildcards.
 * @pk
 */
export type ProxyToolPattern = string;

/**
 * Unified event names emitted by the proxy runtime.
 * @pk
 */
export type ProxyEventName =
  | "session:start"
  | "session:end"
  | "tools:list:after"
  | "tool:start"
  | "tool:success"
  | "tool:error"
  | "tool:after";

/**
 * Filter for unified proxy events.
 * @pk
 */
export type ProxyEventFilter = {
  server?: string;
  tool?: string;
  proxyTool?: string;
};

/**
 * Unified event payload.
 * @pk
 */
export type ProxyEventPayload = {
  ctx: ProxyContext;
  tools?: ListToolsResult["tools"];
  result?: CallToolResult;
  error?: Error;
  durationMs?: number;
  success?: boolean;
};

/**
 * Unified event handler.
 * @pk
 */
export type ProxyEventHandler = (
  payload: ProxyEventPayload,
) => MaybePromise<ListToolsResult["tools"] | ListToolsResult | void>;

/**
 * Scoped server handle returned by `proxy.server(name)`.
 * @pk
 */
export type ProxyServerHandle = {
  readonly name: string;
  use(handler: Middleware): ProxyServerHandle;
  tool(pattern: ProxyToolPattern, handler: ProxyToolHandler): ProxyServerHandle;
  on(eventName: ProxyEventName, handler: ProxyEventHandler): ProxyServerHandle;
  on(eventName: ProxyEventName, filter: ProxyEventFilter, handler: ProxyEventHandler): ProxyServerHandle;
};

/**
 * Transport interface for MCP client interactions.
 * @pk
 */
export type PanterTransport = {
  listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult>;
  callTool(params: CallToolRequest["params"]): Promise<CallToolResult>;
  listResources?(params?: ListResourcesParams): Promise<ListResourcesResponse>;
  readResource?(params: ReadResourceParams): Promise<ReadResourceResponse>;
  listResourceTemplates?(params?: ListResourceTemplatesParams): Promise<ListResourceTemplatesResponse>;
  listPrompts?(params?: ListPromptsParams): Promise<ListPromptsResponse>;
  getPrompt?(params: GetPromptParams): Promise<GetPromptResponse>;
  complete?(params: CompleteParams): Promise<CompleteResponse>;
  close(): Promise<void>;
};

/**
 * Active downstream proxy exposure handle.
 * @pk
 */
export type ProxyExposureHandle = {
  close(): Promise<void>;
};

/**
 * Runtime operations shared by downstream proxy exposure transports.
 * @pk
 */
export type ProxyRuntime = {
  createSdkServer(user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject): unknown;
  resolveHttpUser(request: unknown): Promise<{ user: UserContext; identity?: IdentityMetadata; subject?: ResolvedSubject }>;
  resolveStdioUser(): Promise<{ user: UserContext; identity?: IdentityMetadata; subject?: ResolvedSubject }>;
  emitSessionStart(context: LifecycleHookContext): Promise<void>;
  emitSessionEnd(context: LifecycleHookContext): Promise<void>;
  logger: Logger;
  identityRequired: boolean;
};

/**
 * Transport interface for exposing the Panther proxy to downstream MCP clients.
 * @pk
 */
export type ProxyExposureTransport<THandle extends ProxyExposureHandle = ProxyExposureHandle> = {
  listen(runtime: ProxyRuntime): Promise<THandle>;
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
 * Capability target selector kind for policy permissions.
 * @pk
 */
export type CapabilityTargetKind = "tool" | "resource" | "resourceTemplate" | "prompt" | "completion";

/**
 * Operation-based permission model for governed MCP capabilities.
 * @pk
 */
export type CapabilityPermission = {
  server?: string;
  operation: McpOperationName | "*";
  target?: string;
  targetKind?: CapabilityTargetKind;
  effect?: "allow" | "deny";
  limiter?: RateLimiter;
  approval?: (request: CapabilityOperationRequest, context: MiddlewareContext) => MaybePromise<boolean>;
  metadata?: Record<string, unknown>;
};

/**
 * Normalized request used for operation-based policy evaluation.
 * @pk
 */
export type CapabilityOperationRequest = {
  serverName: string;
  operation: McpOperationName;
  target?: string;
  targetKind?: CapabilityTargetKind;
  raw?: unknown;
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
  getCapabilityPermissions?(serverName: string): CapabilityPermission[];
  evaluate(
    request: ToolCallRequest | CapabilityOperationRequest,
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
