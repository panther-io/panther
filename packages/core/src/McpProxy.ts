import { type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer } from "node:http";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsRequest,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { DefaultErrorMapper, PantherErrorCode } from "./errors.js";
import { Logger } from "./logger.js";
import { McpServer } from "./McpServer.js";
import { fromProxyToolName, toProxyToolName } from "./nameMapping.js";
import { filterToolsByPolicy } from "./policy.js";
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
  type ProxyToolHandler,
  type ProxyToolPattern,
  type Registry,
  type ToolCallHook,
  type ToolCallHookFilter,
  type ToolCallRequest,
  type UserContext,
  type ResolvedSubject,
} from "./types.js";

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
  kind: "middleware" | "tool";
  scopeServer?: string;
  pattern?: CompiledToolPattern;
  handler: Middleware | ProxyToolHandler;
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
   * Handle an MCP HTTP request for session setup or routing.
   * @pk
   */
  /**
   * Create the MCP SDK server and attach handlers.
   * @pk
   */
  createSdkServer(user: UserContext = {}, identity?: IdentityMetadata, subject?: ResolvedSubject): McpSdkServer {
    const server = new McpSdkServer(
      { name: this.name, version: this.version },
      {
        capabilities: {
          tools: {},
          logging: {},
        },
        instructions: "Panther MCP proxy. Tool names are prefixed as <server>__<tool>.",
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async (request) => this.listTools(request.params, user, identity, subject));
    server.setRequestHandler(CallToolRequestSchema, async (request) => this.callTool(request.params, user, identity, subject));

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
      logger: this.logger,
      identityRequired: Boolean(this.identityOptions?.required),
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
    sessionId?: string;
  }): Logger {
    return this.logger.child({
      operation: options.operation,
      userId: options.user.id,
      subjectId: options.subject?.id ?? options.user.id,
      serverName: options.serverName,
      toolName: options.toolName,
      proxyToolName: options.proxyToolName,
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
    raw?: CallToolRequest["params"] | ListToolsRequest["params"];
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
    if (options.operation !== "tool:call") {
      context.policy = {
        matchedGroups: [],
        matchedPermissions: [],
        policy: options.policy,
      };
    }
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
    context.deny = response.deny.bind(response);
    context.fail = response.fail.bind(response);
    context.continue = response.continue.bind(response);
    context.inject = response.injectToAgent.bind(response);
    context.error = response.fail.bind(response);
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
      return result;
    }

    if (nextCalled && nextResult) {
      return nextResult;
    }

    return this.dispatchRoutes(routeIndex + 1, request, context, terminal);
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
  handler: Middleware | ProxyToolHandler,
  request: ToolCallRequest,
  context: ProxyContext,
  next: () => Promise<CallToolResult>,
): Promise<CallToolResult | void> {
  if (isLegacyMiddleware(handler)) {
    return (handler as LegacyMiddleware)(request, context, next);
  }

  try {
    return await (handler as ProxyMiddleware)(context, next);
  } catch (error) {
    if (handler.length === 2 && isLikelyLegacyTwoArgMiddlewareError(error)) {
      return (handler as unknown as LegacyMiddleware)(request, context, next);
    }

    throw error;
  }
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
