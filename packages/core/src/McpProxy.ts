import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
import {
  ResponseController,
  type CredentialSourceMetadata,
  type ErrorMapper,
  type ListToolsHook,
  type Middleware,
  type MiddlewareContext,
  type IdentityMetadata,
  type IdentityStrategy,
  type LifecycleHook,
  type LifecycleHookEvent,
  type Policy,
  type ProxyHookEvent,
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

/**
 * Active MCP session state.
 * @pk
 */
type SessionState = {
  transport: StreamableHTTPServerTransport;
  server: McpSdkServer;
  user: UserContext;
  identity?: IdentityMetadata;
  subject?: ResolvedSubject;
};

/**
 * HTTP proxy for multiple MCP servers.
 * @pk
 */
export class McpProxy {
  private readonly servers: McpServer[];
  private readonly serverByName = new Map<string, McpServer>();
  private readonly middleware: Middleware[] = [];
  private readonly callHooks: Array<{ filter: ToolCallHookFilter; handler: ToolCallHook }> = [];
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
    return this;
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
  on(event: ProxyHookEvent, filterOrHandler: ToolCallHookFilter | ToolCallHook, maybeHandler?: ToolCallHook): this {
    if (event !== "call") {
      throw new Error(`Unsupported proxy hook event "${event}"`);
    }

    const filter = typeof filterOrHandler === "function" ? {} : filterOrHandler;
    const handler = typeof filterOrHandler === "function" ? filterOrHandler : maybeHandler;
    if (!handler) {
      throw new Error(`Missing handler for proxy hook event "${event}"`);
    }

    this.callHooks.push({ filter, handler });
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
    const sessions = new Map<string, SessionState>();

    this.httpServer = createServer(async (req, res) => {
      if (req.url?.split("?")[0] !== path) {
        sendText(res, 404, "Not Found");
        return;
      }

      if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
        sendText(res, 405, "Method Not Allowed", { Allow: "GET, POST, DELETE" });
        return;
      }

      try {
        const { user, identity, subject } = await this.resolveUser(req);
        if (this.identityOptions?.required && !identity?.authenticated) {
          sendJsonRpcError(res, 401, PantherErrorCode.Unauthorized, "Unauthorized");
          return;
        }

        await this.handleMcpRequest(req, res, sessions, user, identity, subject);
      } catch (error) {
        this.logger.error("Error handling MCP proxy request", { error: safeErrorMessage(error) });
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, -32603, "Internal server error");
        }
      }
    });

    await new Promise<void>((resolve) => {
      this.httpServer?.listen(port, () => {
        this.printStartupBanner(port, path);
        callback?.();
        resolve();
      });
    });

    return this.httpServer;
  }

  /**
   * Close the HTTP server and all backends.
   * @pk
   */
  async close(): Promise<void> {
    const closeHttpServer = this.httpServer
      ? new Promise<void>((resolve, reject) => {
          this.httpServer?.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        })
      : Promise.resolve();

    await closeHttpServer;
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
    const log = this.logger.child({ userId: resolvedUser.id, event: "listTools" });

    for (const hook of this.listToolsHooks) {
      const result = await hook(tools, { user: resolvedUser, subject: resolvedSubject, identity, log, policy: this.policy });
      if (Array.isArray(result)) {
        tools = result;
      } else if (result?.tools) {
        tools = result.tools;
      }
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
    const log = this.logger.child({
      userId: resolvedUser.id,
      serverName,
      toolName,
      proxyToolName: params.name,
    });
    const context: MiddlewareContext = {
      user: resolvedUser,
      subject: resolvedSubject,
      identity,
      log,
      res: new ResponseController(),
      policy: this.policy,
      registry: this.registry,
    };
    const userGroups = resolvedSubject ? this.subjectIndex?.groupsFor(resolvedSubject.id) ?? [] : [];
    if (this.groups.length > 0) {
      context.policyDecision = await evaluateGroupPolicies(userGroups, request, resolvedUser, context);
    } else if (this.policy) {
      context.policyDecision = await this.policy.evaluate(request, resolvedUser, context);
    }

    const startedAt = Date.now();
    this.writeAutoLog("start", log, request, context, startedAt);
    try {
      let upstreamUser = resolvedUser;
      if (!context.policyDecision || context.policyDecision.allowed) {
        const upstream = this.applyUpstreamAuth(serverName, resolvedUser, resolvedSubject);
        upstreamUser = upstream.user;
        context.credentialSources = upstream.credentialSource ? [upstream.credentialSource] : undefined;
      }

      const hookResult = await this.dispatchCallHooks(request, context);
      const result =
        hookResult ??
        (await this.dispatchMiddleware(0, request, context, () => {
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
      await context.res.notifyError(normalizedError);
      const injectedResult = context.res.injectedErrorResult();
      if (injectedResult) {
        return injectedResult;
      }
      return context.res.fail(mappedError.code, mappedError.message);
    }
  }

  /**
   * Handle an MCP HTTP request for session setup or routing.
   * @pk
   */
  private async handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    sessions: Map<string, SessionState>,
    user: UserContext,
    identity: IdentityMetadata | undefined,
    subject: ResolvedSubject | undefined,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        sendJsonRpcError(res, 404, -32001, "Session not found");
        return;
      }

      await session.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== "POST") {
      sendJsonRpcError(res, 400, -32000, "A new MCP session must start with POST initialize");
      return;
    }

    const sdkServer = this.createSdkServer(user, identity, subject);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, { transport, server: sdkServer, user, identity, subject });
        this.logger.debug("MCP proxy session initialized", { sessionId: newSessionId, userId: user.id });
        void this.emitLifecycle("sessionStart", {
          user,
          identity,
          sessionId: newSessionId,
          log: this.logger.child({ userId: user.id, sessionId: newSessionId }),
        });
      },
    });

    transport.onclose = async () => {
      const initializedSessionId = transport.sessionId;
      if (initializedSessionId) {
        sessions.delete(initializedSessionId);
      }
      await this.emitLifecycle("sessionEnd", {
        user,
        identity,
        sessionId: initializedSessionId,
        log: this.logger.child({ userId: user.id, sessionId: initializedSessionId }),
      });
      await sdkServer.close();
    };

    await sdkServer.connect(transport);
    await transport.handleRequest(req, res);
  }

  /**
   * Create the MCP SDK server and attach handlers.
   * @pk
   */
  private createSdkServer(user: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject): McpSdkServer {
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
    const result = await middleware(request, context, async () => {
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
}

/**
 * Prefix tool descriptions with the server name.
 * @pk
 */
function annotateDescription(serverName: string, description: string | undefined): string {
  return description ? `[${serverName}] ${description}` : `Proxied from ${serverName}`;
}

/**
 * Send a JSON-RPC error response.
 * @pk
 */
function sendJsonRpcError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
  res.writeHead(httpStatus, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Send a plain text response.
 * @pk
 */
function sendText(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain", ...headers });
  res.end(body);
}

/**
 * Get a safe error message for logging.
 * @pk
 */
function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
