import { type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer } from "node:http";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type CompleteRequest,
  type CompleteResult,
  type GetPromptRequest,
  type GetPromptResult,
  type ListPromptsRequest,
  type ListPromptsResult,
  type ListResourcesRequest,
  type ListResourcesResult,
  type ListResourceTemplatesRequest,
  type ListResourceTemplatesResult,
  type ListToolsRequest,
  type ListToolsResult,
  type ReadResourceRequest,
  type ReadResourceResult,
  type SubscribeRequest,
  type UnsubscribeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { DefaultErrorMapper, PantherErrorCode } from "./errors.js";
import { Logger } from "./logger.js";
import { McpServer } from "./McpServer.js";
import {
  fromProxyPromptName,
  fromProxyResourceTemplateUri,
  fromProxyResourceUri,
  fromProxyToolName,
  toProxyPromptName,
  toProxyResourceTemplateUri,
  toProxyResourceUri,
  toProxyToolName,
} from "./nameMapping.js";
import { filterToolsByPolicy, getToolPermission } from "./policy.js";
import { getCapabilityPermission, toCapabilityPermissions } from "./policy.js";
import type { PantherAuth } from "./auth.js";
import {
  buildSubjectIndex,
  evaluateGroupPolicies,
  filterToolsByGroupPolicies,
  type Group,
  type SubjectIndex,
} from "./governance.js";
import { HttpProxyExposureTransport } from "./transports/HttpProxyExposureTransport.js";
import {
  ResponseController,
  type CapabilityOperationRequest,
  type CapabilityPermission,
  type CredentialSourceMetadata,
  type ErrorMapper,
  type ListToolsHook,
  type Middleware,
  type MiddlewareContext,
  type IdentityMetadata,
  type IdentityStrategy,
  type LegacyMiddleware,
  type LifecycleHook,
  type LifecycleHookEvent,
  type Policy,
  type ProxyContext,
  type ProxyEventFilter,
  type ProxyEventHandler,
  type ProxyEventName,
  type ProxyHookEvent,
  type ProxyExposureHandle,
  type ProxyExposureTransport,
  type ProxyMiddleware,
  type ProxyRuntime,
  type ProxyServerHandle,
  type ProxyOperationHandler,
  type ProxyOperationResult,
  type ProxyToolHandler,
  type ProxyToolPattern,
  type Registry,
  type ToolCallHook,
  type ToolCallHookFilter,
  type ToolCallRequest,
  type UserContext,
  type ResolvedSubject,
  type McpDownstreamNotification,
  type McpUpstreamNotification,
  type SessionUtilityRegistry,
  type SessionUtilityState,
} from "./types.js";

class PolicyDeniedError extends Error {
  readonly code: number;
  readonly context?: ProxyContext;

  constructor(message: string, code: number = PantherErrorCode.PolicyDenied, context?: ProxyContext) {
    super(message);
    this.code = code;
    this.context = context;
    this.name = "PolicyDeniedError";
  }
}

/**
 * Options for creating an MCP proxy server.
 * @pk
 */
export type McpProxyOptions = {
  servers: McpServer[];
  port?: number;
  path?: string;
  logger?: Logger;
  user?: UserContext | ((request: IncomingMessage) => UserContext | Promise<UserContext>);
  identity?: IdentityStrategy | IdentityResolverOptions;
  policy?: Policy;
  groups?: Group[];
  auth?: PantherAuth;
  registry?: Registry;
  autoLog?: boolean | AutoLogOptions;
  errorMapper?: ErrorMapper;
  name?: string;
  version?: string;
};

/**
 * Auto-log configuration for proxied tool calls.
 * @pk
 */
export type AutoLogOptions = {
  enabled?: boolean;
  startLevel?: "debug" | "info";
  successLevel?: "debug" | "info";
  failureLevel?: "warn" | "error";
};

/**
 * Identity resolver configuration for proxy-edge auth.
 * @pk
 */
export type IdentityResolverOptions = {
  strategy: IdentityStrategy;
  required?: boolean;
};

/**
 * Optional start overrides for the MCP proxy.
 * @pk
 */
export type McpProxyStartOptions = {
  port?: number;
  path?: string;
};

type RouteEntry = {
  kind: "middleware" | "tool" | "operation";
  scopeServer?: string;
  operation?: ProxyContext["operation"];
  pattern?: CompiledToolPattern;
  handler: Middleware | ProxyToolHandler | ProxyOperationHandler;
};

type EventEntry = {
  eventName: ProxyEventName;
  filter: ProxyEventFilter;
  handler: ProxyEventHandler;
};

type CompiledToolPattern = {
  original: string;
  server?: RegExp;
  tool: RegExp;
  scopedServer?: string;
};

/**
 * HTTP proxy for multiple MCP servers.
 * @pk
 */
export class McpProxy {
  private readonly servers: McpServer[];
  private readonly serverByName = new Map<string, McpServer>();
  private readonly middleware: Middleware[] = [];
  private readonly routes: RouteEntry[] = [];
  private readonly callHooks: Array<{ filter: ToolCallHookFilter; handler: ToolCallHook }> = [];
  private readonly eventHandlers: EventEntry[] = [];
  private readonly lifecycleHooks: LifecycleHook[] = [];
  private readonly listToolsHooks: ListToolsHook[] = [];
  private readonly logger: Logger;
  private readonly userResolver?: McpProxyOptions["user"];
  private readonly identityOptions?: IdentityResolverOptions;
  private readonly policy?: Policy;
  private readonly groups: Group[];
  private readonly subjectIndex?: SubjectIndex;
  private readonly auth?: PantherAuth;
  private readonly registry?: Registry;
  private readonly autoLog: Required<AutoLogOptions> | null;
  private readonly errorMapper: ErrorMapper;
  private readonly name: string;
  private readonly version: string;
  private readonly defaultPort?: number;
  private readonly defaultPath: string;
  private httpServer: HttpServer | null = null;
  private readonly exposureHandles = new Set<ProxyExposureHandle>();
  private readonly sessionUtilities = new Map<string, SessionUtilityState>();
  private readonly sessionNotificationSenders = new Map<string, (notification: McpDownstreamNotification) => Promise<void>>();
  private readonly resourceSubscriptions = new Map<string, { serverName: string; uri: string; proxyUri: string; sessions: Set<string> }>();

  /**
   * Create a new MCP proxy instance.
   * @pk
   */
  constructor(options: McpProxyOptions) {
    this.servers = options.servers;
    this.logger = options.logger ?? new Logger();
    this.userResolver = options.user;
    this.auth = options.auth;
    this.identityOptions = normalizeIdentityOptions(options.identity ?? options.auth?.identityStrategy(), Boolean(options.auth));
    this.policy = options.policy;
    this.groups = options.groups ?? [];
    this.subjectIndex = this.groups.length > 0 ? buildSubjectIndex(this.groups) : undefined;
    this.registry = options.registry;
    this.autoLog = normalizeAutoLog(options.autoLog);
    this.errorMapper = options.errorMapper ?? new DefaultErrorMapper();
    this.name = options.name ?? "panther-core-proxy";
    this.version = options.version ?? "0.1.0";
    this.defaultPort = options.port;
    this.defaultPath = options.path ?? "/mcp";

    for (const server of this.servers) {
      if (this.serverByName.has(server.name)) {
        throw new Error(`Duplicate MCP server name "${server.name}"`);
      }
      this.serverByName.set(server.name, server);
      server.onNotification((notification) => this.handleUpstreamNotification(notification));
    }
  }

  /**
   * Register a middleware handler.
   * @pk
   */
  use(middleware: Middleware): this {
    this.middleware.push(middleware);
    this.routes.push({ kind: "middleware", handler: middleware });
    return this;
  }

  /**
   * Register a global tool route with a public server.tool pattern.
   * @pk
   */
  tool(pattern: ProxyToolPattern, handler: ProxyToolHandler): this {
    this.routes.push({ kind: "tool", pattern: compileToolPattern(pattern), handler });
    return this;
  }

  /**
   * Register a global operation route for governed non-tool operations.
   * @pk
   */
  operation(operation: ProxyContext["operation"], handler: ProxyOperationHandler): this {
    this.routes.push({ kind: "operation", operation, handler });
    return this;
  }

  /**
   * Register or retrieve a scoped server handle.
   * @pk
   */
  server(name: string, server?: McpServer): ProxyServerHandle {
    if (server) {
      if (server.name !== name) {
        throw new Error(`Server handle "${name}" cannot register MCP server "${server.name}"`);
      }
      if (!this.serverByName.has(name)) {
        this.servers.push(server);
        this.serverByName.set(name, server);
      }
    }

    return new McpProxyServerHandle(this, name);
  }

  /**
   * Register an event hook.
   * @pk
   */
  on(event: "call", handler: ToolCallHook): this;
  /**
   * Register a filtered event hook.
   * @pk
   */
  on(event: "call", filter: ToolCallHookFilter, handler: ToolCallHook): this;
  /**
   * Register a unified proxy event handler.
   * @pk
   */
  on(event: ProxyEventName, handler: ProxyEventHandler): this;
  /**
   * Register a filtered unified proxy event handler.
   * @pk
   */
  on(event: ProxyEventName, filter: ProxyEventFilter, handler: ProxyEventHandler): this;
  on(
    event: ProxyHookEvent | ProxyEventName,
    filterOrHandler: ToolCallHookFilter | ToolCallHook | ProxyEventFilter | ProxyEventHandler,
    maybeHandler?: ToolCallHook | ProxyEventHandler,
  ): this {
    if (event !== "call") {
      const filter = typeof filterOrHandler === "function" ? {} : filterOrHandler;
      const handler = typeof filterOrHandler === "function" ? filterOrHandler : maybeHandler;
      if (!handler) {
        throw new Error(`Missing handler for proxy event "${event}"`);
      }
      this.eventHandlers.push({
        eventName: event,
        filter,
        handler: handler as ProxyEventHandler,
      });
      return this;
    }

    const filter = typeof filterOrHandler === "function" ? {} : filterOrHandler;
    const handler = typeof filterOrHandler === "function" ? filterOrHandler : maybeHandler;
    if (!handler) {
      throw new Error(`Missing handler for proxy hook event "${event}"`);
    }

    this.callHooks.push({ filter, handler: handler as ToolCallHook });
    return this;
  }

  /**
   * Register a lifecycle hook.
   * @pk
   */
  onLifecycle(event: LifecycleHookEvent, handler: LifecycleHook): this {
    this.lifecycleHooks.push((emittedEvent, context) => {
      if (emittedEvent === event) {
        return handler(emittedEvent, context);
      }

      return undefined;
    });
    return this;
  }

  /**
   * Register a hook that can transform listed tools.
   * @pk
   */
  onListTools(hook: ListToolsHook): this {
    this.listToolsHooks.push(hook);
    return this;
  }

  /**
   * Start the HTTP server.
   * @pk
   */
  async start(onStarted?: () => void): Promise<HttpServer>;
  /**
   * Start the HTTP server with optional overrides.
   * @pk
   */
  async start(options?: McpProxyStartOptions, onStarted?: () => void): Promise<HttpServer>;
  async start(
    optionsOrCallback: McpProxyStartOptions | (() => void) = {},
    onStarted?: () => void,
  ): Promise<HttpServer> {
    if (this.httpServer) {
      return this.httpServer;
    }

    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : onStarted;
    const port = options.port ?? this.defaultPort ?? 3000;
    const path = options.path ?? this.defaultPath;
    const handle = await this.listen(
      new HttpProxyExposureTransport({
        port,
        path,
        onStarted: () => {
        this.printStartupBanner(port, path);
        callback?.();
        },
      }),
    );
    this.httpServer = handle.server;

    return this.httpServer;
  }

  /**
   * Start the proxy with an explicit downstream exposure transport.
   * @pk
   */
  async listen<THandle extends ProxyExposureHandle>(transport: ProxyExposureTransport<THandle>): Promise<THandle> {
    const handle = await transport.listen(this.createRuntime());
    this.exposureHandles.add(handle);
    return handle;
  }

  /**
   * Close the HTTP server and all backends.
   * @pk
   */
  async close(): Promise<void> {
    await Promise.all([...this.exposureHandles].map((handle) => handle.close()));
    this.exposureHandles.clear();
    this.httpServer = null;
    this.sessionUtilities.clear();
    this.sessionNotificationSenders.clear();
    await Promise.all(this.servers.map((server) => server.close()));
  }

  /**
   * List tools across all configured servers.
   * @pk
   */
  async listTools(
    params?: ListToolsRequest["params"],
    user: UserContext = {},
    identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<ListToolsResult> {
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const userGroups = resolvedSubject ? this.subjectIndex?.groupsFor(resolvedSubject.id) ?? [] : [];
    const results = await Promise.all(
      this.servers.map(async (server) => {
        const { user: userForServer } = this.applyUpstreamAuth(server.name, resolvedUser, resolvedSubject);
        const result = await server.listTools(params, userForServer);
        const tools = this.groups.length > 0
          ? filterToolsByGroupPolicies(result.tools, server.name, userGroups)
          : this.policy ? filterToolsByPolicy(result.tools, server.name, this.policy) : result.tools;
        return tools.map((tool) => ({
          ...tool,
          name: toProxyToolName(server.name, tool.name),
          title: tool.title ?? `${server.displayName}: ${tool.name}`,
          description: annotateDescription(server.displayName, tool.description),
        }));
      }),
    );

    let tools: ListToolsResult["tools"] = results.flat();
    const log = this.createContextualLogger({
      operation: "tools:list",
      user: resolvedUser,
      subject: resolvedSubject,
      identity,
    });
    const context = this.createProxyContext({
      operation: "tools:list",
      user: resolvedUser,
      subject: resolvedSubject,
      identity,
      log,
      raw: params,
      policy: this.policy,
    });

    for (const hook of this.listToolsHooks) {
      const result = await hook(tools, {
        user: resolvedUser,
        subject: resolvedSubject,
        identity,
        log,
        policy: this.policy,
        credentialSources: context.credentials.sources,
      });
      if (Array.isArray(result)) {
        tools = result;
      } else if (result?.tools) {
        tools = result.tools;
      }
    }

    const eventResult = await this.emitProxyEvent("tools:list:after", { ctx: context, tools });
    if (Array.isArray(eventResult)) {
      tools = eventResult;
    } else if (eventResult?.tools) {
      tools = eventResult.tools;
    }

    return { tools };
  }

  /**
   * Call a proxied tool with middleware dispatch.
   * @pk
   */
  async callTool(
    params: CallToolRequest["params"],
    user: UserContext = {},
    identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<CallToolResult> {
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const { serverName, toolName } = fromProxyToolName(params.name);
    const request: ToolCallRequest = {
      serverName,
      toolName,
      proxyToolName: params.name,
      arguments: params.arguments,
      raw: params,
    };
    const log = this.createContextualLogger({
      operation: "tool:call",
      user: resolvedUser,
      subject: resolvedSubject,
      identity,
      serverName,
      toolName,
      proxyToolName: params.name,
    });
    const context = this.createProxyContext({
      operation: "tool:call",
      user: resolvedUser,
      subject: resolvedSubject,
      identity,
      log,
      request,
      raw: params,
      policy: this.policy,
    });
    const userGroups = resolvedSubject ? this.subjectIndex?.groupsFor(resolvedSubject.id) ?? [] : [];
    if (this.groups.length > 0) {
      context.policyDecision = await evaluateGroupPolicies(userGroups, request, resolvedUser, context);
    } else if (this.policy) {
      context.policyDecision = await this.policy.evaluate(request, resolvedUser, context);
    }
    context.policy = {
      allowed: context.policyDecision?.allowed,
      reason: context.policyDecision?.reason,
      matchedGroups: context.policyDecision?.metadata?.matchedGroups ?? userGroups.map((group) => group.id),
      matchedPermissions: context.policyDecision?.metadata?.matchedPermissions ?? [],
      metadata: context.policyDecision?.metadata,
      policy: this.policy,
      decision: context.policyDecision,
      can: this.createPolicyCan(resolvedSubject),
    };

    const startedAt = Date.now();
    this.writeAutoLog("start", log, request, context, startedAt);
    try {
      let upstreamUser = resolvedUser;
      if (!context.policyDecision || context.policyDecision.allowed) {
        const upstream = this.applyUpstreamAuth(serverName, resolvedUser, resolvedSubject);
        upstreamUser = upstream.user;
        context.credentialSources = upstream.credentialSource ? [upstream.credentialSource] : undefined;
        context.credentials.sources = context.credentialSources ?? [];
      }

      if (!context.policyDecision || context.policyDecision.allowed) {
        await this.emitProxyEvent("tool:start", { ctx: context, durationMs: 0 });
      }
      const hookResult = await this.dispatchCallHooks(request, context);
      const result =
        hookResult ??
        (await this.dispatchRoutes(0, request, context, () => {
          if (context.policyDecision && !context.policyDecision.allowed) {
            return Promise.resolve(
              context.res.fail(
                PantherErrorCode.PolicyDenied,
                context.policyDecision.reason ?? "Tool call denied by policy",
              ),
            );
          }

          return this.forwardToolCall(params, upstreamUser);
        }));
      const response = context.res.applyInjections(result);
      this.writeAutoLog("success", log, request, context, startedAt, response);
      await this.emitProxyEvent("tool:success", { ctx: context, result: response, durationMs: Date.now() - startedAt, success: true });
      await this.emitProxyEvent("tool:after", { ctx: context, result: response, durationMs: Date.now() - startedAt, success: true });
      return response;
    } catch (error) {
      const normalizedError = normalizeError(error);
      const mappedError = this.errorMapper.mapError(normalizedError, { serverName, toolName });
      this.writeAutoLog("failure", log, request, context, startedAt, undefined, normalizedError);
      await this.emitLifecycle("toolFailure", {
        user: resolvedUser,
        subject: resolvedSubject,
        identity,
        request,
        error: normalizedError,
        log,
      });
      await this.emitProxyEvent("tool:error", { ctx: context, error: normalizedError, durationMs: Date.now() - startedAt, success: false });
      await context.res.notifyError(normalizedError);
      const injectedResult = context.res.injectedErrorResult();
      if (injectedResult) {
        await this.emitProxyEvent("tool:after", { ctx: context, result: injectedResult, error: normalizedError, durationMs: Date.now() - startedAt, success: false });
        return injectedResult;
      }
      const failed = context.res.fail(mappedError.code, mappedError.message);
      await this.emitProxyEvent("tool:after", { ctx: context, result: failed, error: normalizedError, durationMs: Date.now() - startedAt, success: false });
      return failed;
    }
  }

  /**
   * List resources across all configured servers.
   * @pk
   */
  async listResources(
    params?: ListResourcesRequest["params"],
    user: UserContext = {},
    _identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<ListResourcesResult> {
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const userGroups = resolvedSubject ? this.subjectIndex?.groupsFor(resolvedSubject.id) ?? [] : [];
    const results = await Promise.all(
      this.servers.map(async (server) => {
        const context = this.createCapabilityContext({
          operation: "resources:list",
          serverName: server.name,
          targetKind: "resource",
          raw: params,
          user: resolvedUser,
          subject: resolvedSubject,
          identity: _identity,
        });
        if (
          !this.isCapabilityAllowed(
            { serverName: server.name, operation: "resources:list", targetKind: "resource" },
            resolvedSubject,
            userGroups,
          )
        ) {
          return [];
        }
        const result = await this.dispatchOperationRoutes(context, async () => {
          const { user: userForServer, credentialSource } = this.applyUpstreamAuth(server.name, resolvedUser, resolvedSubject);
          context.credentialSources = credentialSource ? [credentialSource] : undefined;
          context.credentials.sources = context.credentialSources ?? [];
          const upstream = await server.listResources(params, userForServer);
          return {
            resources: upstream.resources.filter((resource) =>
              this.isCapabilityAllowed(
                {
                  serverName: server.name,
                  operation: "resource:read",
                  target: resource.uri,
                  targetKind: "resource",
                  raw: resource,
                },
                resolvedSubject,
                userGroups,
              ),
            ).map((resource) => ({
              ...resource,
              uri: toProxyResourceUri(server.name, resource.uri),
            })),
          };
        }) as ListResourcesResult;
        return result.resources;
      }),
    );

    return { resources: results.flat() };
  }

  /**
   * Read a proxied resource from its owning upstream server.
   * @pk
   */
  async readResource(
    params: ReadResourceRequest["params"],
    user: UserContext = {},
    identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<ReadResourceResult> {
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const { serverName, uri } = fromProxyResourceUri(params.uri);
    const server = this.requireServer(serverName);
    let context: ProxyContext;
    try {
      context = await this.enforceCapabilityPolicy(
        {
          serverName,
          operation: "resource:read",
          target: uri,
          targetKind: "resource",
          proxyTarget: params.uri,
          raw: params,
        },
        resolvedUser,
        resolvedSubject,
        identity,
      );
    } catch (error) {
      await this.emitDeniedCapabilityError(error);
      throw error;
    }
    return this.runCapabilityOperation(context, async () => {
      const { user: userForServer, credentialSource } = this.applyUpstreamAuth(server.name, resolvedUser, resolvedSubject);
      context.credentialSources = credentialSource ? [credentialSource] : undefined;
      context.credentials.sources = context.credentialSources ?? [];
      const result = await this.dispatchOperationRoutes(context, async () => server.readResource({ ...params, uri }, userForServer)) as ReadResourceResult;

      return {
        ...result,
        contents: result.contents.map((content) => ({
          ...content,
          uri: toProxyResourceUri(server.name, content.uri),
        })),
      };
    }) as Promise<ReadResourceResult>;
  }

  async subscribeResource(
    params: SubscribeRequest["params"],
    user: UserContext = {},
    _identity?: IdentityMetadata,
    subject?: ResolvedSubject,
    sessionId?: string,
  ): Promise<{ _meta?: Record<string, unknown> }> {
    if (!sessionId) {
      throw new Error("Resource subscriptions require an active downstream session");
    }

    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const { serverName, uri } = fromProxyResourceUri(params.uri);
    const server = this.requireServer(serverName);
    const key = resourceSubscriptionKey(serverName, uri);
    let subscription = this.resourceSubscriptions.get(key);
    if (!subscription) {
      const { user: userForServer } = this.applyUpstreamAuth(server.name, resolvedUser, resolvedSubject);
      await server.subscribeResource({ ...params, uri }, userForServer);
      subscription = { serverName, uri, proxyUri: params.uri, sessions: new Set() };
      this.resourceSubscriptions.set(key, subscription);
    }

    subscription.sessions.add(sessionId);
    this.ensureSessionUtilityState(sessionId).resourceSubscriptions.add(params.uri);
    return {};
  }

  async unsubscribeResource(
    params: UnsubscribeRequest["params"],
    user: UserContext = {},
    _identity?: IdentityMetadata,
    subject?: ResolvedSubject,
    sessionId?: string,
  ): Promise<{ _meta?: Record<string, unknown> }> {
    if (!sessionId) {
      throw new Error("Resource subscriptions require an active downstream session");
    }

    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const { serverName, uri } = fromProxyResourceUri(params.uri);
    const key = resourceSubscriptionKey(serverName, uri);
    const subscription = this.resourceSubscriptions.get(key);
    if (!subscription) {
      this.sessionUtilities.get(sessionId)?.resourceSubscriptions.delete(params.uri);
      return {};
    }

    subscription.sessions.delete(sessionId);
    this.sessionUtilities.get(sessionId)?.resourceSubscriptions.delete(params.uri);
    if (subscription.sessions.size === 0) {
      const server = this.requireServer(serverName);
      const { user: userForServer } = this.applyUpstreamAuth(server.name, resolvedUser, resolvedSubject);
      await server.unsubscribeResource({ ...params, uri }, userForServer);
      this.resourceSubscriptions.delete(key);
    }

    return {};
  }

  /**
   * List resource templates across all configured servers.
   * @pk
   */
  async listResourceTemplates(
    params?: ListResourceTemplatesRequest["params"],
    user: UserContext = {},
    _identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<ListResourceTemplatesResult> {
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const userGroups = resolvedSubject ? this.subjectIndex?.groupsFor(resolvedSubject.id) ?? [] : [];
    const results = await Promise.all(
      this.servers.map(async (server) => {
        const context = this.createCapabilityContext({
          operation: "resource-templates:list",
          serverName: server.name,
          targetKind: "resourceTemplate",
          raw: params,
          user: resolvedUser,
          subject: resolvedSubject,
          identity: _identity,
        });
        if (
          !this.isCapabilityAllowed(
            { serverName: server.name, operation: "resource-templates:list", targetKind: "resourceTemplate" },
            resolvedSubject,
            userGroups,
          )
        ) {
          return [];
        }
        const result = await this.dispatchOperationRoutes(context, async () => {
          const { user: userForServer, credentialSource } = this.applyUpstreamAuth(server.name, resolvedUser, resolvedSubject);
          context.credentialSources = credentialSource ? [credentialSource] : undefined;
          context.credentials.sources = context.credentialSources ?? [];
          const upstream = await server.listResourceTemplates(params, userForServer);
          return {
            resourceTemplates: upstream.resourceTemplates.filter((template) =>
              this.isCapabilityAllowed(
                {
                  serverName: server.name,
                  operation: "resource-templates:list",
                  target: template.uriTemplate,
                  targetKind: "resourceTemplate",
                  raw: template,
                },
                resolvedSubject,
                userGroups,
              ),
            ).map((template) => ({
              ...template,
              uriTemplate: toProxyResourceTemplateUri(server.name, template.uriTemplate),
            })),
          };
        }) as ListResourceTemplatesResult;
        return result.resourceTemplates;
      }),
    );

    return { resourceTemplates: results.flat() };
  }

  /**
   * List prompts across all configured servers.
   * @pk
   */
  async listPrompts(
    params?: ListPromptsRequest["params"],
    user: UserContext = {},
    _identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<ListPromptsResult> {
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const userGroups = resolvedSubject ? this.subjectIndex?.groupsFor(resolvedSubject.id) ?? [] : [];
    const results = await Promise.all(
      this.servers.map(async (server) => {
        const context = this.createCapabilityContext({
          operation: "prompts:list",
          serverName: server.name,
          targetKind: "prompt",
          raw: params,
          user: resolvedUser,
          subject: resolvedSubject,
          identity: _identity,
        });
        if (!this.isCapabilityAllowed({ serverName: server.name, operation: "prompts:list", targetKind: "prompt" }, resolvedSubject, userGroups)) {
          return [];
        }
        const result = await this.dispatchOperationRoutes(context, async () => {
          const { user: userForServer, credentialSource } = this.applyUpstreamAuth(server.name, resolvedUser, resolvedSubject);
          context.credentialSources = credentialSource ? [credentialSource] : undefined;
          context.credentials.sources = context.credentialSources ?? [];
          const upstream = await server.listPrompts(params, userForServer);
          return {
            prompts: upstream.prompts.filter((prompt) =>
              this.isCapabilityAllowed(
                {
                  serverName: server.name,
                  operation: "prompt:get",
                  target: prompt.name,
                  targetKind: "prompt",
                  raw: prompt,
                },
                resolvedSubject,
                userGroups,
              ),
            ).map((prompt) => ({
              ...prompt,
              name: toProxyPromptName(server.name, prompt.name),
            })),
          };
        }) as ListPromptsResult;
        return result.prompts;
      }),
    );

    return { prompts: results.flat() };
  }

  /**
   * Get a proxied prompt from its owning upstream server.
   * @pk
   */
  async getPrompt(
    params: GetPromptRequest["params"],
    user: UserContext = {},
    identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<GetPromptResult> {
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const { serverName, promptName } = fromProxyPromptName(params.name);
    const server = this.requireServer(serverName);
    let context: ProxyContext;
    try {
      context = await this.enforceCapabilityPolicy(
        {
          serverName,
          operation: "prompt:get",
          target: promptName,
          targetKind: "prompt",
          proxyTarget: params.name,
          raw: params,
        },
        resolvedUser,
        resolvedSubject,
        identity,
      );
    } catch (error) {
      await this.emitDeniedCapabilityError(error);
      throw error;
    }
    return this.runCapabilityOperation(context, async () => {
      const { user: userForServer, credentialSource } = this.applyUpstreamAuth(server.name, resolvedUser, resolvedSubject);
      context.credentialSources = credentialSource ? [credentialSource] : undefined;
      context.credentials.sources = context.credentialSources ?? [];
      return this.dispatchOperationRoutes(context, async () => server.getPrompt({ ...params, name: promptName }, userForServer)) as Promise<GetPromptResult>;
    }) as Promise<GetPromptResult>;
  }

  /**
   * Complete a proxied prompt or resource-template argument.
   * @pk
   */
  async complete(
    params: CompleteRequest["params"],
    user: UserContext = {},
    identity?: IdentityMetadata,
    subject?: ResolvedSubject,
  ): Promise<CompleteResult> {
    const resolvedUser = await this.resolveRegistryUser(user);
    const resolvedSubject = this.resolveSubject(resolvedUser, subject);
    const routed = routeCompletion(params);
    const server = this.requireServer(routed.serverName);
    let context: ProxyContext;
    try {
      context = await this.enforceCapabilityPolicy(
        {
          serverName: routed.serverName,
          operation: "completion:complete",
          target: completionTarget(routed.params),
          targetKind: "completion",
          proxyTarget: completionTarget(params),
          completionRefType: params.ref.type,
          argumentName: params.argument.name,
          raw: params,
        },
        resolvedUser,
        resolvedSubject,
        identity,
      );
    } catch (error) {
      await this.emitDeniedCapabilityError(error);
      throw error;
    }
    return this.runCapabilityOperation(context, async () => {
      const { user: userForServer, credentialSource } = this.applyUpstreamAuth(server.name, resolvedUser, resolvedSubject);
      context.credentialSources = credentialSource ? [credentialSource] : undefined;
      context.credentials.sources = context.credentialSources ?? [];
      return this.dispatchOperationRoutes(context, async () => server.complete(routed.params, userForServer)) as Promise<CompleteResult>;
    }) as Promise<CompleteResult>;
  }

  /**
   * Handle an MCP HTTP request for session setup or routing.
   * @pk
   */
  /**
   * Create the MCP SDK server and attach handlers.
   * @pk
   */
  createSdkServer(user: UserContext = {}, identity?: IdentityMetadata, subject?: ResolvedSubject): McpSdkServer {
    const capabilities = this.createServerCapabilities();
    const server = new McpSdkServer(
      { name: this.name, version: this.version },
      {
        capabilities,
        instructions:
          "Panther MCP proxy. Tool and prompt names are prefixed as <server>__<name>; resources use panther:// proxy URIs.",
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async (request) => this.listTools(request.params, user, identity, subject));
    server.setRequestHandler(CallToolRequestSchema, async (request) => this.callTool(request.params, user, identity, subject));
    if (capabilities.resources) {
      server.setRequestHandler(ListResourcesRequestSchema, async (request) =>
        this.listResources(request.params, user, identity, subject));
      server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
        this.readResource(request.params, user, identity, subject));
      server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) =>
        this.listResourceTemplates(request.params, user, identity, subject));
      server.setRequestHandler(SubscribeRequestSchema, async (request, extra) =>
        this.subscribeResource(request.params, user, identity, subject, extra.sessionId));
      server.setRequestHandler(UnsubscribeRequestSchema, async (request, extra) =>
        this.unsubscribeResource(request.params, user, identity, subject, extra.sessionId));
    }
    if (capabilities.prompts) {
      server.setRequestHandler(ListPromptsRequestSchema, async (request) =>
        this.listPrompts(request.params, user, identity, subject));
      server.setRequestHandler(GetPromptRequestSchema, async (request) =>
        this.getPrompt(request.params, user, identity, subject));
    }
    if (capabilities.completions) {
      server.setRequestHandler(CompleteRequestSchema, async (request) =>
        this.complete(request.params, user, identity, subject));
    }

    return server;
  }

  /**
   * Resolve user context from an HTTP downstream request.
   * @pk
   */
  async resolveHttpUser(req: IncomingMessage): Promise<{ user: UserContext; identity?: IdentityMetadata; subject?: ResolvedSubject }> {
    return this.resolveUser(req);
  }

  /**
   * Resolve user context for non-HTTP stdio downstream exposure.
   * @pk
   */
  async resolveStdioUser(): Promise<{ user: UserContext; identity?: IdentityMetadata; subject?: ResolvedSubject }> {
    const user = typeof this.userResolver === "function" ? await this.userResolver({} as IncomingMessage) : this.userResolver ?? {};
    return { user, subject: this.resolveSubject(user) };
  }

  /**
   * Emit a downstream session start lifecycle event.
   * @pk
   */
  async emitSessionStart(context: Parameters<LifecycleHook>[1]): Promise<void> {
    await this.emitLifecycle("sessionStart", context);
    const proxyContext = this.createProxyContext({
      operation: "session:start",
      user: context.user,
      subject: context.subject,
      identity: context.identity,
      log: this.createContextualLogger({
        operation: "session:start",
        user: context.user,
        subject: context.subject,
        identity: context.identity,
        sessionId: context.sessionId,
      }),
      request: context.request,
      transport: { sessionId: context.sessionId },
      policy: this.policy,
    });
    await this.emitProxyEvent("session:start", { ctx: proxyContext });
  }

  /**
   * Emit a downstream session end lifecycle event.
   * @pk
   */
  async emitSessionEnd(context: Parameters<LifecycleHook>[1]): Promise<void> {
    if (context.sessionId) {
      this.cleanupSessionSubscriptions(context.sessionId);
    }
    await this.emitLifecycle("sessionEnd", context);
    const proxyContext = this.createProxyContext({
      operation: "session:end",
      user: context.user,
      subject: context.subject,
      identity: context.identity,
      log: this.createContextualLogger({
        operation: "session:end",
        user: context.user,
        subject: context.subject,
        identity: context.identity,
        sessionId: context.sessionId,
      }),
      request: context.request,
      transport: { sessionId: context.sessionId },
      policy: this.policy,
    });
    await this.emitProxyEvent("session:end", { ctx: proxyContext });
  }

  registerServerMiddleware(serverName: string, handler: Middleware): void {
    this.routes.push({ kind: "middleware", scopeServer: serverName, handler });
  }

  registerServerTool(serverName: string, pattern: ProxyToolPattern, handler: ProxyToolHandler): void {
    this.routes.push({ kind: "tool", scopeServer: serverName, pattern: compileToolPattern(pattern, serverName), handler });
  }

  registerServerOperation(serverName: string, operation: ProxyContext["operation"], handler: ProxyOperationHandler): void {
    this.routes.push({ kind: "operation", scopeServer: serverName, operation, handler });
  }

  registerServerEvent(serverName: string, eventName: ProxyEventName, filter: ProxyEventFilter, handler: ProxyEventHandler): void {
    this.eventHandlers.push({
      eventName,
      filter: {
        ...filter,
        server: serverName,
      },
      handler,
    });
  }

  private createRuntime(): ProxyRuntime {
    return {
      createSdkServer: (user, identity, subject) => this.createSdkServer(user, identity, subject),
      resolveHttpUser: (request) => this.resolveHttpUser(request as IncomingMessage),
      resolveStdioUser: () => this.resolveStdioUser(),
      emitSessionStart: (context) => this.emitSessionStart(context),
      emitSessionEnd: (context) => this.emitSessionEnd(context),
      sendSessionNotification: (sessionId, notification) => this.sendSessionNotification(sessionId, notification),
      registerSessionNotificationSender: (sessionId, sender) => this.registerSessionNotificationSender(sessionId, sender),
      sessionUtilities: this.createSessionUtilityRegistry(),
      logger: this.logger,
      identityRequired: Boolean(this.identityOptions?.required),
    };
  }

  private async sendSessionNotification(
    sessionId: string,
    notification: McpDownstreamNotification,
  ): Promise<boolean> {
    const sender = this.sessionNotificationSenders.get(sessionId);
    if (!sender) {
      return false;
    }

    await sender(notification);
    return true;
  }

  private async handleUpstreamNotification(notification: McpUpstreamNotification): Promise<void> {
    if (notification.type === "tools:list-changed") {
      await this.broadcastNotification({ method: "notifications/tools/list_changed" });
      return;
    }

    if (notification.type === "resources:list-changed") {
      await this.broadcastNotification({ method: "notifications/resources/list_changed" });
      return;
    }

    if (notification.type === "prompts:list-changed") {
      await this.broadcastNotification({ method: "notifications/prompts/list_changed" });
      return;
    }

    if (notification.type !== "resources:updated") {
      return;
    }

    const serverName = notification.serverName;
    if (!serverName) {
      return;
    }

    const subscription = this.resourceSubscriptions.get(resourceSubscriptionKey(serverName, notification.uri));
    if (!subscription) {
      return;
    }

    await Promise.all(
      [...subscription.sessions].map((sessionId) =>
        this.sendSessionNotification(sessionId, {
          method: "notifications/resources/updated",
          params: { uri: subscription.proxyUri },
        }),
      ),
    );
  }

  private async broadcastNotification(notification: McpDownstreamNotification): Promise<void> {
    await Promise.all([...this.sessionUtilities.keys()].map((sessionId) => this.sendSessionNotification(sessionId, notification)));
  }

  private cleanupSessionSubscriptions(sessionId: string): void {
    for (const [key, subscription] of this.resourceSubscriptions) {
      subscription.sessions.delete(sessionId);
      if (subscription.sessions.size === 0) {
        this.resourceSubscriptions.delete(key);
      }
    }
  }

  private registerSessionNotificationSender(
    sessionId: string,
    sender: (notification: McpDownstreamNotification) => Promise<void> | void,
  ): () => void {
    this.sessionNotificationSenders.set(sessionId, async (notification) => {
      await sender(notification);
    });
    return () => {
      if (this.sessionNotificationSenders.get(sessionId) === sender) {
        this.sessionNotificationSenders.delete(sessionId);
      } else {
        this.sessionNotificationSenders.delete(sessionId);
      }
    };
  }

  private createSessionUtilityRegistry(): SessionUtilityRegistry {
    return {
      ensure: (sessionId) => this.ensureSessionUtilityState(sessionId),
      get: (sessionId) => this.sessionUtilities.get(sessionId),
      delete: (sessionId) => {
        const state = this.sessionUtilities.get(sessionId);
        if (state) {
          for (const request of state.activeRequests.values()) {
            if (request.timeout) {
              clearTimeout(request.timeout);
            }
          }
        }
        this.sessionUtilities.delete(sessionId);
      },
      size: () => this.sessionUtilities.size,
    };
  }

  private ensureSessionUtilityState(sessionId: string): SessionUtilityState {
    let state = this.sessionUtilities.get(sessionId);
    if (!state) {
      state = createSessionUtilityState();
      this.sessionUtilities.set(sessionId, state);
    }
    return state;
  }

  private createServerCapabilities(): {
    tools: object;
    logging: object;
    resources?: object;
    prompts?: object;
    completions?: object;
  } {
    return {
      tools: { listChanged: true },
      logging: {},
      ...(this.servers.some((server) => server.supportsResources()) ? { resources: { subscribe: true, listChanged: true } } : {}),
      ...(this.servers.some((server) => server.supportsPrompts()) ? { prompts: { listChanged: true } } : {}),
      ...(this.servers.some((server) => server.supportsCompletions()) ? { completions: {} } : {}),
    };
  }

  private createContextualLogger(options: {
    operation: ProxyContext["operation"];
    user: UserContext;
    subject?: ResolvedSubject;
    identity?: IdentityMetadata;
    serverName?: string;
    toolName?: string;
    proxyToolName?: string;
    target?: string;
    targetKind?: string;
    sessionId?: string;
  }): Logger {
    return this.logger.child({
      operation: options.operation,
      userId: options.user.id,
      subjectId: options.subject?.id ?? options.user.id,
      serverName: options.serverName,
      toolName: options.toolName,
      proxyToolName: options.proxyToolName,
      target: options.target,
      targetKind: options.targetKind,
      transportType: "unknown",
      sessionId: options.sessionId,
      identityStrategy: options.identity?.strategy,
      authenticated: options.identity?.authenticated,
    });
  }

  private createProxyContext(options: {
    operation: ProxyContext["operation"];
    user: UserContext;
    subject?: ResolvedSubject;
    identity?: IdentityMetadata;
    log: Logger;
    request?: ToolCallRequest;
    capability?: CapabilityOperationRequest & {
      proxyTarget?: string;
      completionRefType?: "ref/prompt" | "ref/resource";
      argumentName?: string;
    };
    raw?: ProxyContext["raw"];
    transport?: ProxyContext["transport"];
    policy?: Policy;
  }): ProxyContext {
    const response = new ResponseController();
    const state: Record<string, unknown> = {};
    const policyDecision = undefined as ProxyContext["policyDecision"];
    const legacyContext: MiddlewareContext = {
      user: options.user,
      subject: options.subject,
      identity: options.identity,
      log: options.log,
      res: response,
      policy: options.policy,
      registry: this.registry,
      policyDecision,
    };
    const context = legacyContext as ProxyContext;
    context.operation = options.operation;
    context.transport = options.transport ?? {
      type: "unknown",
      sessionId: stringMetadata(options.identity?.metadata, "sessionId"),
      requestId: stringMetadata(options.identity?.metadata, "requestId"),
    };
    context.auth = {
      strategy: options.identity?.strategy,
      authenticated: options.identity?.authenticated ?? Boolean(options.user.id),
      userId: options.identity?.userId ?? options.user.id,
      metadata: options.identity?.metadata,
    };
    context.policy = {
      matchedGroups: [],
      matchedPermissions: [],
      policy: options.policy,
      can: this.createPolicyCan(options.subject),
    };
    context.credentials = { sources: [] };
    context.response = response;
    context.res = response;
    context.state = state;
    context.raw = options.raw;
    if (options.request) {
      const server = this.serverByName.get(options.request.serverName);
      context.server = {
        name: options.request.serverName,
        displayName: server?.displayName,
      };
      context.tool = {
        name: options.request.toolName,
        proxyName: options.request.proxyToolName,
      };
      context.args = options.request.arguments;
    }
    if (options.capability) {
      const server = this.serverByName.get(options.capability.serverName);
      context.server = {
        name: options.capability.serverName,
        displayName: server?.displayName,
      };
      if (options.capability.targetKind === "resource") {
        context.resource = {
          uri: options.capability.target,
          proxyUri: options.capability.proxyTarget,
        };
      } else if (options.capability.targetKind === "resourceTemplate") {
        context.resource = {
          uriTemplate: options.capability.target,
          proxyUriTemplate: options.capability.proxyTarget,
        };
      } else if (options.capability.targetKind === "prompt" && options.capability.target) {
        context.prompt = {
          name: options.capability.target,
          proxyName: options.capability.proxyTarget ?? options.capability.target,
        };
      } else if (options.capability.targetKind === "completion" && options.capability.target) {
        context.completion = {
          refType: options.capability.completionRefType ?? "ref/prompt",
          target: options.capability.target,
          proxyTarget: options.capability.proxyTarget,
          argumentName: options.capability.argumentName ?? "",
        };
      }
    }
    context.deny = response.deny.bind(response);
    context.fail = response.fail.bind(response);
    context.continue = response.continue.bind(response);
    context.inject = response.injectToAgent.bind(response);
    context.error = response.fail.bind(response);
    return context;
  }

  private createPolicyCan(subject: ResolvedSubject | undefined): ProxyContext["policy"]["can"] {
    return (serverName: string, toolName: string): boolean => {
      if (this.groups.length > 0) {
        const groups = subject ? this.subjectIndex?.groupsFor(subject.id) ?? [] : [];
        let allowed = false;

        for (const group of groups) {
          const permission = getToolPermission(group.policy.getPermissions(serverName), toolName);
          if (!permission) {
            continue;
          }

          if (permission.effect === "deny") {
            return false;
          }

          allowed = true;
        }

        return allowed;
      }

      if (this.policy) {
        const permission = getToolPermission(this.policy.getPermissions(serverName), toolName);
        if (!permission) {
          return false;
        }

        return permission.effect !== "deny";
      }

      return true;
    };
  }

  private isCapabilityAllowed(
    request: CapabilityOperationRequest,
    subject: ResolvedSubject | undefined,
    userGroups: Group[] = subject ? this.subjectIndex?.groupsFor(subject.id) ?? [] : [],
  ): boolean {
    if (this.groups.length > 0) {
      let allowed = false;

      for (const group of userGroups) {
        const permission = getCapabilityPermission(capabilityPermissionsForPolicy(group.policy, request.serverName), request);
        if (!permission) {
          continue;
        }

        if (permission.effect === "deny") {
          return false;
        }

        allowed = true;
      }

      return allowed;
    }

    if (this.policy) {
      const permission = getCapabilityPermission(capabilityPermissionsForPolicy(this.policy, request.serverName), request);
      if (!permission) {
        return false;
      }

      return permission.effect !== "deny";
    }

    return true;
  }

  private createCapabilityContext(
    request: CapabilityOperationRequest & {
      proxyTarget?: string;
      completionRefType?: "ref/prompt" | "ref/resource";
      argumentName?: string;
    } & {
      user: UserContext;
      subject?: ResolvedSubject;
      identity?: IdentityMetadata;
    },
  ): ProxyContext {
    const log = this.createContextualLogger({
      operation: request.operation,
      user: request.user,
      subject: request.subject,
      identity: request.identity,
      serverName: request.serverName,
      target: request.target,
      targetKind: request.targetKind,
    });
    return this.createProxyContext({
      operation: request.operation,
      user: request.user,
      subject: request.subject,
      identity: request.identity,
      log,
      capability: request,
      raw: request.raw as ProxyContext["raw"],
      policy: this.policy,
    });
  }

  private async enforceCapabilityPolicy(
    request: CapabilityOperationRequest & {
      proxyTarget?: string;
      completionRefType?: "ref/prompt" | "ref/resource";
      argumentName?: string;
    },
    user: UserContext,
    subject: ResolvedSubject | undefined,
    identity: IdentityMetadata | undefined,
  ): Promise<ProxyContext> {
    const context = this.createCapabilityContext({
      ...request,
      user,
      subject,
      identity,
    });
    const userGroups = subject ? this.subjectIndex?.groupsFor(subject.id) ?? [] : [];
    let decision;

    if (this.groups.length > 0) {
      decision = await evaluateGroupPolicies(userGroups, request, user, context);
    } else if (this.policy) {
      decision = await this.policy.evaluate(request, user, context);
    }

    context.policyDecision = decision;
    context.policy = {
      allowed: decision?.allowed,
      reason: decision?.reason,
      matchedGroups: decision?.metadata?.matchedGroups ?? userGroups.map((group) => group.id),
      matchedPermissions: decision?.metadata?.matchedPermissions ?? [],
      metadata: decision?.metadata,
      policy: this.policy,
      decision,
      can: this.createPolicyCan(subject),
    };

    if (decision && !decision.allowed) {
      throw new PolicyDeniedError(decision.reason ?? `Operation "${request.operation}" denied by policy`, PantherErrorCode.PolicyDenied, context);
    }

    return context;
  }

  /**
   * Execute middleware in sequence.
   * @pk
   */
  private async dispatchMiddleware(
    index: number,
    request: ToolCallRequest,
    context: MiddlewareContext,
    terminal: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const middleware = this.middleware[index];
    if (!middleware) {
      return terminal();
    }

    let nextCalled = false;
    let nextResult: CallToolResult | undefined;
    const result = await (middleware as LegacyMiddleware)(request, context, async () => {
      if (nextCalled) {
        throw new Error("Middleware next() called multiple times");
      }

      nextCalled = true;
      nextResult = await this.dispatchMiddleware(index + 1, request, context, terminal);
      return nextResult;
    });

    if (result) {
      return result;
    }

    if (nextCalled && nextResult) {
      return nextResult;
    }

    return this.dispatchMiddleware(index + 1, request, context, terminal);
  }

  private async dispatchRoutes(
    index: number,
    request: ToolCallRequest,
    context: ProxyContext,
    terminal: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const route = this.routes.slice(index).find((entry) => this.matchesRoute(entry, request, context));
    if (!route) {
      return terminal();
    }
    const routeIndex = this.routes.indexOf(route);

    let nextCalled = false;
    let nextResult: CallToolResult | undefined;
    const next = async () => {
      if (nextCalled) {
        throw new Error("Middleware next() called multiple times");
      }

      nextCalled = true;
      nextResult = await this.dispatchRoutes(routeIndex + 1, request, context, terminal);
      return nextResult;
    };

    const result = await dispatchRouteHandler(route.handler, request, context, next);

    if (result) {
      return result as CallToolResult;
    }

    if (nextCalled && nextResult) {
      return nextResult;
    }

    return this.dispatchRoutes(routeIndex + 1, request, context, terminal);
  }

  private async dispatchOperationRoutes(
    context: ProxyContext,
    terminal: () => Promise<ProxyOperationResult>,
    index = 0,
  ): Promise<ProxyOperationResult> {
    const route = this.routes.slice(index).find((entry) => this.matchesOperationRoute(entry, context));
    if (!route) {
      return terminal();
    }
    const routeIndex = this.routes.indexOf(route);

    let nextCalled = false;
    let nextResult: ProxyOperationResult | undefined;
    const next = async () => {
      if (nextCalled) {
        throw new Error("Middleware next() called multiple times");
      }

      nextCalled = true;
      nextResult = await this.dispatchOperationRoutes(context, terminal, routeIndex + 1);
      return nextResult;
    };

    const result = await dispatchRouteHandler(route.handler, context.tool ? {
      serverName: context.server?.name ?? "",
      toolName: context.tool.name,
      proxyToolName: context.tool.proxyName,
      arguments: context.args,
      raw: context.raw as CallToolRequest["params"],
    } : capabilityToolRequest(context), context, next);

    if (result) {
      if (isStructuredPolicyErrorResult(result)) {
        const error = toStructuredError(result._meta?.error);
        throw new PolicyDeniedError(error?.message ?? "Operation denied by middleware", error?.code);
      }

      return result;
    }

    if (nextCalled && nextResult) {
      return nextResult;
    }

    return this.dispatchOperationRoutes(context, terminal, routeIndex + 1);
  }

  private async runCapabilityOperation(
    context: ProxyContext,
    terminal: () => Promise<ProxyOperationResult>,
  ): Promise<ProxyOperationResult> {
    const startedAt = Date.now();
    await this.emitProxyEvent(operationEventName(context.operation, "start"), { ctx: context, durationMs: 0 });
    this.writeCapabilityAuditLog("start", context, startedAt);

    try {
      const result = await terminal();
      const durationMs = Date.now() - startedAt;
      this.writeCapabilityAuditLog("success", context, startedAt, result);
      await this.emitProxyEvent(operationEventName(context.operation, "success"), { ctx: context, result, durationMs, success: true });
      await this.emitProxyEvent(operationEventName(context.operation, "after"), { ctx: context, result, durationMs, success: true });
      return result;
    } catch (error) {
      const normalizedError = normalizeError(error);
      const durationMs = Date.now() - startedAt;
      this.writeCapabilityAuditLog("failure", context, startedAt, undefined, normalizedError);
      await this.emitProxyEvent(operationEventName(context.operation, "error"), { ctx: context, error: normalizedError, durationMs, success: false });
      await this.emitProxyEvent(operationEventName(context.operation, "after"), { ctx: context, error: normalizedError, durationMs, success: false });
      throw error;
    }
  }

  private async emitDeniedCapabilityError(error: unknown): Promise<void> {
    if (!(error instanceof PolicyDeniedError) || !error.context) {
      return;
    }

    const startedAt = Date.now();
    this.writeCapabilityAuditLog("failure", error.context, startedAt, undefined, error);
    await this.emitProxyEvent(operationEventName(error.context.operation, "error"), {
      ctx: error.context,
      error,
      durationMs: 0,
      success: false,
    });
    await this.emitProxyEvent(operationEventName(error.context.operation, "after"), {
      ctx: error.context,
      error,
      durationMs: 0,
      success: false,
    });
  }

  private matchesRoute(entry: RouteEntry, request: ToolCallRequest, context: ProxyContext): boolean {
    if (entry.scopeServer && entry.scopeServer !== request.serverName) {
      return false;
    }

    if (entry.kind === "tool") {
      return context.operation === "tool:call" && entry.pattern !== undefined && matchesToolPattern(entry.pattern, request);
    }

    return true;
  }

  private matchesOperationRoute(entry: RouteEntry, context: ProxyContext): boolean {
    if (entry.scopeServer && entry.scopeServer !== context.server?.name) {
      return false;
    }

    if (entry.kind === "tool") {
      return false;
    }

    if (entry.kind === "operation") {
      return entry.operation === context.operation;
    }

    return true;
  }

  /**
   * Execute matching call hooks in registration order.
   * @pk
   */
  private async dispatchCallHooks(
    request: ToolCallRequest,
    context: MiddlewareContext,
  ): Promise<CallToolResult | undefined> {
    for (const hook of this.callHooks) {
      if (!matchesCallHook(hook.filter, request)) {
        continue;
      }

      const result = await hook.handler(request, context);
      if (result) {
        return result;
      }
    }

    return undefined;
  }

  /**
   * Print the startup banner to stderr.
   * @pk
   */
  private printStartupBanner(port: number, path: string): void {
    const art = [
      "██████╗  █████╗ ███╗   ██╗████████╗██╗  ██╗███████╗██████╗",
      "██╔══██╗██╔══██╗████╗  ██║╚══██╔══╝██║  ██║██╔════╝██╔══██╗",
      "██████╔╝███████║██╔██╗ ██║   ██║   ███████║█████╗  ██████╔╝",
      "██╔═══╝ ██╔══██║██║╚██╗██║   ██║   ██╔══██║██╔══╝  ██╔══██╗",
      "██║     ██║  ██║██║ ╚████║   ██║   ██║  ██║███████╗██║  ██║",
      "╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝",
    ];

    const width = Math.max(...art.map((line) => line.length));
    const top = ` ╭${"─".repeat(width + 4)}╮`;
    const bottom = ` ╰${"─".repeat(width + 4)}╯`;
    const empty = ` │${" ".repeat(width + 4)}│`;

    const gradientLine = (text: string): string => {
      let output = "";
      for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (char === " ") {
          output += char;
          continue;
        }

        const ratio = i / Math.max(1, text.length - 1);
        const red = Math.round(79 + ratio * (6 - 79));
        const green = Math.round(70 + ratio * (182 - 70));
        const blue = Math.round(229 + ratio * (212 - 229));
        output += `\x1b[38;2;${red};${green};${blue}m${char}`;
      }

      return `${output}\x1b[0m`;
    };

    console.error();
    console.error(gradientLine(top));
    console.error(gradientLine(empty));
    for (const line of art) {
      const padded = ` │  ${line}${" ".repeat(width - line.length)}  │`;
      console.error(gradientLine(padded));
    }
    console.error(gradientLine(empty));
    console.error(gradientLine(bottom));
    console.error();
    console.error(" \x1b[38;2;6;182;212m🐾 Panther Proxy\x1b[0m \x1b[90mv0.1.0\x1b[0m");
    console.error(" \x1b[32m\x1b[1m🚀 Proxy ready\x1b[0m");
    console.error(` \x1b[36m⚡ Listening on:\x1b[0m  http://localhost:${port}${path}`);
    console.error();
  }

  /**
   * Forward a tool call to the selected server.
   * @pk
   */
  private async forwardToolCall(params: CallToolRequest["params"], user: UserContext): Promise<CallToolResult> {
    const { serverName, toolName } = fromProxyToolName(params.name);
    const server = this.serverByName.get(serverName);
    if (!server) {
      return new ResponseController().deny(`Unknown MCP server "${serverName}"`);
    }

    return server.callTool(
      {
        ...params,
        name: toolName,
      },
      user,
    );
  }

  private requireServer(serverName: string): McpServer {
    const server = this.serverByName.get(serverName);
    if (!server) {
      throw new Error(`Unknown MCP server "${serverName}"`);
    }

    return server;
  }

  /**
   * Resolve the user context from the incoming request.
   * @pk
   */
  private async resolveUser(req: IncomingMessage): Promise<{ user: UserContext; identity?: IdentityMetadata; subject?: ResolvedSubject }> {
    if (this.identityOptions) {
      const resolved = await this.identityOptions.strategy.resolve({ headers: normalizeHeaders(req.headers), request: req });
      const subject = this.resolveSubject(resolved ?? {});
      return {
        user: resolved ?? {},
        subject,
        identity: {
          strategy: this.identityOptions.strategy.name,
          authenticated: Boolean(resolved),
          userId: resolved?.id,
        },
      };
    }

    if (typeof this.userResolver === "function") {
      const user = await this.userResolver(req);
      return { user, subject: this.resolveSubject(user) };
    }

    const user = this.userResolver ?? {};
    return { user, subject: this.resolveSubject(user) };
  }

  private async resolveRegistryUser(user: UserContext): Promise<UserContext> {
    if (!this.registry || !user.id) {
      return user;
    }

    const [registryUser, secrets, tokens] = await Promise.all([
      this.registry.getUser(user.id),
      this.registry.getSecrets(user.id),
      this.registry.getTokens(user.id),
    ]);

    return {
      ...(registryUser ?? {}),
      ...user,
      id: user.id,
      ...(secrets ? { secrets } : {}),
      ...(tokens ? { tokens } : {}),
    };
  }

  private resolveSubject(user: UserContext, subject?: ResolvedSubject): ResolvedSubject | undefined {
    if (subject) {
      return subject;
    }

    if (!this.subjectIndex) {
      return undefined;
    }

    if (!user.id) {
      return undefined;
    }

    const resolved = this.subjectIndex.resolve(user.id);
    if (!resolved) {
      throw new Error(`Authenticated user "${user.id}" is not declared in any configured group`);
    }

    return resolved;
  }

  private applyUpstreamAuth(
    serverName: string,
    user: UserContext,
    subject: ResolvedSubject | undefined,
  ): { user: UserContext; credentialSource?: CredentialSourceMetadata } {
    const binding = this.auth?.getBinding(serverName);
    if (!binding) {
      return { user };
    }

    if (!subject) {
      throw new Error(`Upstream auth for server "${serverName}" requires an authenticated subject`);
    }

    const credential = this.auth?.resolveCredential(binding.credential, subject);
    if (!credential) {
      throw new Error(`Missing upstream credential "${binding.credential}" for server "${serverName}"`);
    }

    const env = toUpstreamEnv(binding, credential.value);
    return {
      user: {
        ...user,
        __pantherUpstreamEnv: {
          ...(isRecord(user.__pantherUpstreamEnv) ? user.__pantherUpstreamEnv : {}),
          ...env,
        },
      },
      credentialSource: {
        reference: credential.reference,
        source: credential.source,
        userId: credential.userId,
        groupId: credential.groupId,
      },
    };
  }

  private writeAutoLog(
    event: "start" | "success" | "failure",
    log: Logger,
    request: ToolCallRequest,
    context: MiddlewareContext,
    startedAt: number,
    result?: CallToolResult,
    error?: Error,
  ): void {
    if (!this.autoLog) {
      return;
    }

    const metadata = {
      event: `tool.${event}`,
      durationMs: event === "start" ? undefined : Date.now() - startedAt,
      userId: context.user.id,
      identity: context.identity,
      policy: context.policyDecision?.metadata,
      allowed: context.policyDecision?.allowed,
      isError: result?.isError,
      error: error?.message,
      arguments: event === "start" ? request.arguments : undefined,
    };

    if (event === "start") {
      log[this.autoLog.startLevel]("Tool call started", metadata);
    } else if (event === "success") {
      log[this.autoLog.successLevel]("Tool call completed", metadata);
    } else {
      log[this.autoLog.failureLevel]("Tool call failed", metadata);
    }
  }

  private writeCapabilityAuditLog(
    event: "start" | "success" | "failure",
    context: ProxyContext,
    startedAt: number,
    result?: ProxyOperationResult,
    error?: Error,
  ): void {
    const metadata = {
      event: `${context.operation}.${event}`,
      operation: context.operation,
      durationMs: event === "start" ? undefined : Date.now() - startedAt,
      subjectId: context.subject?.id,
      userId: context.user.id,
      serverName: context.server?.name,
      target: context.resource?.uri ?? context.resource?.uriTemplate ?? context.prompt?.name ?? context.completion?.target,
      policy: context.policy.decision?.metadata,
      allowed: context.policy.allowed,
      credentialSource: context.credentials.sources[0]?.source,
      credentialReference: context.credentials.sources[0]?.reference,
      success: event === "success" ? true : undefined,
      isError: result && "isError" in result ? result.isError : undefined,
      error: error?.message,
    };

    if (event === "failure") {
      context.log.warn("MCP capability operation failed", metadata);
    } else {
      context.log.info("MCP capability operation", metadata);
    }
  }

  private async emitLifecycle(
    event: LifecycleHookEvent,
    context: Parameters<LifecycleHook>[1],
  ): Promise<void> {
    for (const hook of this.lifecycleHooks) {
      await hook(event, context);
    }
  }

  private async emitProxyEvent(
    eventName: ProxyEventName,
    payload: Parameters<ProxyEventHandler>[0],
  ): Promise<ListToolsResult["tools"] | ListToolsResult | void> {
    let transformedTools: ListToolsResult["tools"] | ListToolsResult | undefined = undefined;
    for (const entry of this.eventHandlers) {
      if (entry.eventName !== eventName || !matchesEventFilter(entry.filter, payload.ctx)) {
        continue;
      }

      const result = await entry.handler({
        ...payload,
        tools: transformedTools
          ? Array.isArray(transformedTools)
            ? transformedTools
            : transformedTools.tools
          : payload.tools,
      });
      if (eventName === "tools:list:after" && (Array.isArray(result) || result?.tools)) {
        transformedTools = result;
      }
    }

    return transformedTools;
  }
}

class McpProxyServerHandle implements ProxyServerHandle {
  constructor(
    private readonly proxy: McpProxy,
    readonly name: string,
  ) {}

  use(handler: Middleware): ProxyServerHandle {
    this.proxy.registerServerMiddleware(this.name, handler);
    return this;
  }

  tool(pattern: ProxyToolPattern, handler: ProxyToolHandler): ProxyServerHandle {
    this.proxy.registerServerTool(this.name, pattern, handler);
    return this;
  }

  operation(operation: ProxyContext["operation"], handler: ProxyOperationHandler): ProxyServerHandle {
    this.proxy.registerServerOperation(this.name, operation, handler);
    return this;
  }

  on(eventName: ProxyEventName, handler: ProxyEventHandler): ProxyServerHandle;
  on(eventName: ProxyEventName, filter: ProxyEventFilter, handler: ProxyEventHandler): ProxyServerHandle;
  on(
    eventName: ProxyEventName,
    filterOrHandler: ProxyEventFilter | ProxyEventHandler,
    maybeHandler?: ProxyEventHandler,
  ): ProxyServerHandle {
    const filter = typeof filterOrHandler === "function" ? {} : filterOrHandler;
    const handler = typeof filterOrHandler === "function" ? filterOrHandler : maybeHandler;
    if (!handler) {
      throw new Error(`Missing handler for proxy event "${eventName}"`);
    }
    this.proxy.registerServerEvent(this.name, eventName, filter, handler);
    return this;
  }
}

/**
 * Prefix tool descriptions with the server name.
 * @pk
 */
function annotateDescription(serverName: string, description: string | undefined): string {
  return description ? `[${serverName}] ${description}` : `Proxied from ${serverName}`;
}

/**
 * Normalize thrown values into Error instances.
 * @pk
 */
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeIdentityOptions(
  identity: McpProxyOptions["identity"] | undefined,
  required = false,
): IdentityResolverOptions | undefined {
  if (!identity) {
    return undefined;
  }

  return "strategy" in identity ? { required, ...identity } : { strategy: identity, required };
}

function toUpstreamEnv(binding: NonNullable<ReturnType<PantherAuth["getBinding"]>>, credential: string): Record<string, string> {
  if (binding.type === "bearer") {
    return { AUTHORIZATION: `Bearer ${credential}` };
  }

  if (binding.type === "header") {
    return { [binding.header]: credential };
  }

  return { [binding.env]: credential };
}

function isRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      normalized[key.toLowerCase()] = value.join(", ");
    } else if (value !== undefined) {
      normalized[key.toLowerCase()] = value;
    }
  }

  return normalized;
}

function normalizeAutoLog(autoLog: McpProxyOptions["autoLog"] | undefined): Required<AutoLogOptions> | null {
  if (!autoLog) {
    return null;
  }

  const options = autoLog === true ? {} : autoLog;
  if (options.enabled === false) {
    return null;
  }

  return {
    enabled: true,
    startLevel: options.startLevel ?? "debug",
    successLevel: options.successLevel ?? "info",
    failureLevel: options.failureLevel ?? "error",
  };
}

function createSessionUtilityState(): SessionUtilityState {
  return {
    resourceSubscriptions: new Set(),
    activeRequests: new Map(),
    progressTokens: new Map(),
    cancellations: new Set(),
    logLevel: "info",
  };
}

function resourceSubscriptionKey(serverName: string, uri: string): string {
  return `${serverName}\0${uri}`;
}

function routeCompletion(params: CompleteRequest["params"]): {
  serverName: string;
  params: CompleteRequest["params"];
} {
  if (params.ref.type === "ref/prompt") {
    const { serverName, promptName } = fromProxyPromptName(params.ref.name);
    return {
      serverName,
      params: {
        ...params,
        ref: {
          ...params.ref,
          name: promptName,
        },
      },
    };
  }

  const { serverName, uriTemplate } = fromProxyResourceTemplateUri(params.ref.uri);
  return {
    serverName,
    params: {
      ...params,
      ref: {
        ...params.ref,
        uri: uriTemplate,
      },
    },
  };
}

function completionTarget(params: CompleteRequest["params"]): string {
  return params.ref.type === "ref/prompt" ? params.ref.name : params.ref.uri;
}

function operationEventName(
  operation: ProxyContext["operation"],
  phase: "start" | "success" | "error" | "after",
): ProxyEventName {
  if (operation === "resource:read") {
    return `resource:${phase}`;
  }

  if (operation === "prompt:get") {
    return `prompt:${phase}`;
  }

  if (operation === "completion:complete") {
    return `completion:${phase}`;
  }

  return `tool:${phase}`;
}

function capabilityPermissionsForPolicy(policy: Policy, serverName: string): CapabilityPermission[] {
  return policy.getCapabilityPermissions?.(serverName) ?? toCapabilityPermissions(serverName, policy.getPermissions(serverName));
}

/**
 * Match a call hook filter against a request.
 * @pk
 */
function matchesCallHook(filter: ToolCallHookFilter, request: ToolCallRequest): boolean {
  if (filter.server && filter.server !== request.serverName) {
    return false;
  }

  if (filter.tool && filter.tool !== request.toolName) {
    return false;
  }

  if (filter.proxyTool && filter.proxyTool !== request.proxyToolName) {
    return false;
  }

  return true;
}

function matchesEventFilter(filter: ProxyEventFilter, context: ProxyContext): boolean {
  if (filter.server && filter.server !== context.server?.name) {
    return false;
  }

  if (filter.tool && filter.tool !== context.tool?.name) {
    return false;
  }

  if (filter.proxyTool && filter.proxyTool !== context.tool?.proxyName) {
    return false;
  }

  return true;
}

function isLegacyMiddleware(handler: Middleware | ProxyToolHandler): handler is LegacyMiddleware {
  return handler.length >= 3;
}

async function dispatchRouteHandler(
  handler: Middleware | ProxyToolHandler | ProxyOperationHandler,
  request: ToolCallRequest,
  context: ProxyContext,
  next: () => Promise<ProxyOperationResult>,
): Promise<ProxyOperationResult | void> {
  if (isLegacyMiddleware(handler)) {
    return (handler as LegacyMiddleware)(request, context, next as () => Promise<CallToolResult>);
  }

  try {
    return await (handler as ProxyMiddleware)(context, next);
  } catch (error) {
    if (handler.length === 2 && isLikelyLegacyTwoArgMiddlewareError(error)) {
      return (handler as unknown as LegacyMiddleware)(request, context, next as () => Promise<CallToolResult>);
    }

    throw error;
  }
}

function capabilityToolRequest(context: ProxyContext): ToolCallRequest {
  return {
    serverName: context.server?.name ?? "",
    toolName: context.operation,
    proxyToolName: context.operation,
    arguments: undefined,
    raw: { name: context.operation },
  };
}

function isStructuredPolicyErrorResult(result: ProxyOperationResult): result is CallToolResult {
  return "isError" in result && result.isError === true && Boolean(result._meta?.error);
}

function toStructuredError(error: unknown): { code?: number; message?: string } | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const code = "code" in error && typeof error.code === "number" ? error.code : undefined;
  const message = "message" in error && typeof error.message === "string" ? error.message : undefined;
  return { code, message };
}

function isLikelyLegacyTwoArgMiddlewareError(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }

  return /reading '(res|deny|fail|continue|inject|error|user|subject|identity|log|policy|policyDecision|credentialSources)'/.test(error.message);
}

function compileToolPattern(pattern: ProxyToolPattern, scopedServer?: string): CompiledToolPattern {
  if (!pattern.trim()) {
    throw new Error("Tool pattern cannot be empty");
  }
  if (pattern.includes("__")) {
    throw new Error(`Tool pattern "${pattern}" must use public dot notation, not internal "__" names`);
  }

  const parts = pattern.split(".");
  if (scopedServer) {
    if (parts.length > 2) {
      throw new Error(`Invalid server-scoped tool pattern "${pattern}"`);
    }
    if (parts.length === 2 && parts[0] !== scopedServer && parts[0] !== "*") {
      throw new Error(`Server-scoped tool pattern "${pattern}" cannot target server "${parts[0]}" from handle "${scopedServer}"`);
    }
    const tool = parts.length === 2 ? parts[1] : parts[0];
    validatePatternSegment(tool, "tool", pattern);
    return {
      original: pattern,
      scopedServer,
      tool: wildcardRegex(tool),
    };
  }

  if (parts.length !== 2) {
    throw new Error(`Tool pattern "${pattern}" must use "server.tool" dot notation`);
  }

  const [server, tool] = parts;
  validatePatternSegment(server, "server", pattern);
  validatePatternSegment(tool, "tool", pattern);
  return {
    original: pattern,
    server: wildcardRegex(server),
    tool: wildcardRegex(tool),
  };
}

function validatePatternSegment(segment: string | undefined, label: string, pattern: string): asserts segment is string {
  if (!segment) {
    throw new Error(`Invalid ${label} segment in tool pattern "${pattern}"`);
  }
}

function matchesToolPattern(pattern: CompiledToolPattern, request: ToolCallRequest): boolean {
  if (pattern.scopedServer && pattern.scopedServer !== request.serverName) {
    return false;
  }
  if (pattern.server && !pattern.server.test(request.serverName)) {
    return false;
  }
  return pattern.tool.test(request.toolName);
}

function wildcardRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}
