import { type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer } from "node:http";
import { compileToolPattern, matchesToolPattern, type RouteEntry } from "./routes.js";
import { createContextualLogger, createProxyContext, createPolicyCan, createCapabilityContext } from "./context.js";
import { isCapabilityAllowed } from "./capabilities.js";
import { dispatchRouteHandler } from "./middleware.js";
import { routeCompletion, completionTarget, capabilityToolRequest, isStructuredPolicyErrorResult, toStructuredError } from "./operations.js";
import { operationEventName, matchesCallHook, matchesEventFilter, dispatchCallHooks, emitProxyEvent, type EventEntry } from "./events.js";
import { emitLifecycle } from "./lifecycle.js";
import { createSdkServer } from "./sdkServer.js";
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
} from "@modelcontextprotocol/sdk/types.js";
import { DefaultErrorMapper, FentarisErrorCode } from "../errors.js";
import { Logger } from "../logger.js";
import { McpServer, type ServerCredentialBinding } from "../server/McpServer.js";
import {
  fromProxyPromptName,
  fromProxyResourceTemplateUri,
  fromProxyResourceUri,
  fromProxyToolName,
  toProxyPromptName,
  toProxyResourceTemplateUri,
  toProxyResourceUri,
  toProxyToolName,
} from "../nameMapping.js";
import { filterToolsByPolicy, getToolPermission } from "../policy.js";
import { getCapabilityPermission, toCapabilityPermissions } from "../policy.js";
import { FentarisAuth } from "../auth.js";
import { resolveCredentialSource, type CredentialSourceMap } from "../credentials/index.js";
import {
  buildSubjectIndex,
  evaluateGroupPolicies,
  filterToolsByGroupPolicies,
  type Group,
  type SubjectIndex,
} from "../governance.js";
import { HttpProxyExposureTransport } from "../transports/exposure/HttpProxyExposureTransport.js";
import { ResponseController } from "../types/middleware.js";
import type { CapabilityOperationRequest, ToolCallRequest } from "../types/mcp-operation.js";
import type { CredentialSourceMetadata, IdentityMetadata, ResolvedSubject, UserContext } from "../types/shared.js";
import type {
  ListToolsHook,
  Middleware,
  MiddlewareContext,
  LegacyMiddleware,
  LifecycleHook,
  LifecycleHookEvent,
  ProxyHookEvent,
  ProxyMiddleware,
  ToolCallHook,
  ToolCallHookFilter,
} from "../types/middleware.js";
import type { ProxyOperationResult } from "../types/mcp-operation.js";
import type { CapabilityPermission, ErrorMapper, IdentityStrategy, Policy, Registry } from "../types/policy.js";
import type {
  ProxyContext,
  ProxyEventFilter,
  ProxyEventHandler,
  ProxyEventName,
  ProxyExposureHandle,
  ProxyExposureTransport,
  ProxyRuntime,
  ProxyServerHandle,
  ProxyOperationHandler,
  ProxyToolHandler,
  ProxyToolPattern,
} from "../types/proxy.js";

class PolicyDeniedError extends Error {
  readonly code: number;
  readonly context?: ProxyContext;

  constructor(message: string, code: number = FentarisErrorCode.PolicyDenied, context?: ProxyContext) {
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
  defaults?: {
    credentials?: CredentialSourceMap;
  };
  auth?: FentarisAuth;
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
  private readonly defaultCredentials: CredentialSourceMap;
  private readonly subjectIndex?: SubjectIndex;
  private readonly auth?: FentarisAuth;
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
    this.policy = options.policy;
    this.groups = options.groups ?? [];
    this.defaultCredentials = { ...(options.defaults?.credentials ?? {}) };
    this.identityOptions = normalizeIdentityOptions(
      options.identity ?? options.auth?.identityStrategy() ?? declaredApiKeyIdentityStrategy(this.groups),
      Boolean(options.auth) || hasDeclaredApiKeys(this.groups),
    );
    this.subjectIndex = this.groups.length > 0 ? buildSubjectIndex(this.groups) : undefined;
    this.registry = options.registry;
    this.autoLog = normalizeAutoLog(options.autoLog);
    this.errorMapper = options.errorMapper ?? new DefaultErrorMapper();
    this.name = options.name ?? "fentaris-core-proxy";
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
        const { user: userForServer } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
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
    const log = createContextualLogger({ logger: this.logger }, {
      operation: "tools:list",
      user: resolvedUser,
      subject: resolvedSubject,
      identity,
    });
    const context = createProxyContext({ registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.policy }, {
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

    const eventResult = await emitProxyEvent(this.eventHandlers, "tools:list:after", { ctx: context, tools });
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
    const server = this.serverByName.get(serverName);
    const log = createContextualLogger({ logger: this.logger }, {
      operation: "tool:call",
      user: resolvedUser,
      subject: resolvedSubject,
      identity,
      serverName,
      toolName,
      proxyToolName: params.name,
    });
    const context = createProxyContext({ registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.policy }, {
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
      can: createPolicyCan({ groups: this.groups, subjectIndex: this.subjectIndex, policy: this.policy }, resolvedSubject),
    };

    const startedAt = Date.now();
    this.writeAutoLog("start", log, request, context, startedAt);
    try {
      let upstreamUser = resolvedUser;
      if (server && (!context.policyDecision || context.policyDecision.allowed)) {
        const upstream = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
        upstreamUser = upstream.user;
        context.credentialSources = upstream.credentialSource ? [upstream.credentialSource] : undefined;
        context.credentials.sources = context.credentialSources ?? [];
      }

      if (!context.policyDecision || context.policyDecision.allowed) {
        await emitProxyEvent(this.eventHandlers, "tool:start", { ctx: context, durationMs: 0 });
      }
      const hookResult = await dispatchCallHooks(this.callHooks, request, context);
      const result =
        hookResult ??
        (await this.dispatchRoutes(0, request, context, () => {
          if (context.policyDecision && !context.policyDecision.allowed) {
            const denied = context.res.fail(
              FentarisErrorCode.PolicyDenied,
              context.policyDecision.reason ?? "Tool call denied by policy",
            );
            return Promise.resolve({
              ...denied,
              _meta: {
                ...denied._meta,
                error: {
                  ...(isRecord(denied._meta?.error) ? denied._meta.error : {}),
                  policy: context.policyDecision.metadata,
                },
              },
            });
          }

          return this.forwardToolCall(params, upstreamUser);
        }));
      const response = context.res.applyInjections(result);
      this.writeAutoLog("success", log, request, context, startedAt, response);
      await emitProxyEvent(this.eventHandlers, "tool:success", { ctx: context, result: response, durationMs: Date.now() - startedAt, success: true });
      await emitProxyEvent(this.eventHandlers, "tool:after", { ctx: context, result: response, durationMs: Date.now() - startedAt, success: true });
      return response;
    } catch (error) {
      const normalizedError = normalizeError(error);
      const mappedError = this.errorMapper.mapError(normalizedError, { serverName, toolName });
      this.writeAutoLog("failure", log, request, context, startedAt, undefined, normalizedError);
      await emitLifecycle(this.lifecycleHooks, "toolFailure", {
        user: resolvedUser,
        subject: resolvedSubject,
        identity,
        request,
        error: normalizedError,
        log,
      });
      await emitProxyEvent(this.eventHandlers, "tool:error", { ctx: context, error: normalizedError, durationMs: Date.now() - startedAt, success: false });
      await context.res.notifyError(normalizedError);
      const injectedResult = context.res.injectedErrorResult();
      if (injectedResult) {
        await emitProxyEvent(this.eventHandlers, "tool:after", { ctx: context, result: injectedResult, error: normalizedError, durationMs: Date.now() - startedAt, success: false });
        return injectedResult;
      }
      const failed = context.res.fail(mappedError.code, mappedError.message);
      await emitProxyEvent(this.eventHandlers, "tool:after", { ctx: context, result: failed, error: normalizedError, durationMs: Date.now() - startedAt, success: false });
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
        const context = createCapabilityContext({ logger: this.logger, registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.policy }, {
          operation: "resources:list",
          serverName: server.name,
          targetKind: "resource",
          raw: params,
          user: resolvedUser,
          subject: resolvedSubject,
          identity: _identity,
        });
        if (
          !isCapabilityAllowed({ groups: this.groups, policy: this.policy, subjectIndex: this.subjectIndex }, 
            { serverName: server.name, operation: "resources:list", targetKind: "resource" },
            resolvedSubject,
            userGroups,
          )
        ) {
          return [];
        }
        const result = await this.dispatchOperationRoutes(context, async () => {
          const { user: userForServer, credentialSource } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
          context.credentialSources = credentialSource ? [credentialSource] : undefined;
          context.credentials.sources = context.credentialSources ?? [];
          const upstream = await server.listResources(params, userForServer);
          return {
            resources: upstream.resources.filter((resource) =>
              isCapabilityAllowed({ groups: this.groups, policy: this.policy, subjectIndex: this.subjectIndex }, 
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
      const { user: userForServer, credentialSource } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
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
        const context = createCapabilityContext({ logger: this.logger, registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.policy }, {
          operation: "resource-templates:list",
          serverName: server.name,
          targetKind: "resourceTemplate",
          raw: params,
          user: resolvedUser,
          subject: resolvedSubject,
          identity: _identity,
        });
        if (
          !isCapabilityAllowed({ groups: this.groups, policy: this.policy, subjectIndex: this.subjectIndex }, 
            { serverName: server.name, operation: "resource-templates:list", targetKind: "resourceTemplate" },
            resolvedSubject,
            userGroups,
          )
        ) {
          return [];
        }
        const result = await this.dispatchOperationRoutes(context, async () => {
          const { user: userForServer, credentialSource } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
          context.credentialSources = credentialSource ? [credentialSource] : undefined;
          context.credentials.sources = context.credentialSources ?? [];
          const upstream = await server.listResourceTemplates(params, userForServer);
          return {
            resourceTemplates: upstream.resourceTemplates.filter((template) =>
              isCapabilityAllowed({ groups: this.groups, policy: this.policy, subjectIndex: this.subjectIndex }, 
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
        const context = createCapabilityContext({ logger: this.logger, registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.policy }, {
          operation: "prompts:list",
          serverName: server.name,
          targetKind: "prompt",
          raw: params,
          user: resolvedUser,
          subject: resolvedSubject,
          identity: _identity,
        });
        if (!isCapabilityAllowed({ groups: this.groups, policy: this.policy, subjectIndex: this.subjectIndex }, { serverName: server.name, operation: "prompts:list", targetKind: "prompt" }, resolvedSubject, userGroups)) {
          return [];
        }
        const result = await this.dispatchOperationRoutes(context, async () => {
          const { user: userForServer, credentialSource } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
          context.credentialSources = credentialSource ? [credentialSource] : undefined;
          context.credentials.sources = context.credentialSources ?? [];
          const upstream = await server.listPrompts(params, userForServer);
          return {
            prompts: upstream.prompts.filter((prompt) =>
              isCapabilityAllowed({ groups: this.groups, policy: this.policy, subjectIndex: this.subjectIndex }, 
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
      const { user: userForServer, credentialSource } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
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
      const { user: userForServer, credentialSource } = await this.applyUpstreamAuth(server, resolvedUser, resolvedSubject);
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
    await emitLifecycle(this.lifecycleHooks, "sessionStart", context);
    const proxyContext = createProxyContext({ registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.policy }, {
      operation: "session:start",
      user: context.user,
      subject: context.subject,
      identity: context.identity,
      log: createContextualLogger({ logger: this.logger }, {
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
    await emitProxyEvent(this.eventHandlers, "session:start", { ctx: proxyContext });
  }

  /**
   * Emit a downstream session end lifecycle event.
   * @pk
   */
  async emitSessionEnd(context: Parameters<LifecycleHook>[1]): Promise<void> {
    await emitLifecycle(this.lifecycleHooks, "sessionEnd", context);
    const proxyContext = createProxyContext({ registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.policy }, {
      operation: "session:end",
      user: context.user,
      subject: context.subject,
      identity: context.identity,
      log: createContextualLogger({ logger: this.logger }, {
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
    await emitProxyEvent(this.eventHandlers, "session:end", { ctx: proxyContext });
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
      createSdkServer: (user, identity, subject) => createSdkServer(this as unknown as Parameters<typeof createSdkServer>[0], user, identity, subject),
      resolveHttpUser: (request) => this.resolveHttpUser(request as IncomingMessage),
      resolveStdioUser: () => this.resolveStdioUser(),
      emitSessionStart: (context) => this.emitSessionStart(context),
      emitSessionEnd: (context) => this.emitSessionEnd(context),
      logger: this.logger,
      identityRequired: Boolean(this.identityOptions?.required),
    };
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
    const context = createCapabilityContext({ logger: this.logger, registry: this.registry, serverByName: this.serverByName, groups: this.groups, subjectIndex: this.subjectIndex, policy: this.policy }, {
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
      can: createPolicyCan({ groups: this.groups, subjectIndex: this.subjectIndex, policy: this.policy }, subject),
    };

    if (decision && !decision.allowed) {
      throw new PolicyDeniedError(decision.reason ?? `Operation "${request.operation}" denied by policy`, FentarisErrorCode.PolicyDenied, context);
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
    await emitProxyEvent(this.eventHandlers, operationEventName(context.operation, "start"), { ctx: context, durationMs: 0 });
    this.writeCapabilityAuditLog("start", context, startedAt);

    try {
      const result = await terminal();
      const durationMs = Date.now() - startedAt;
      this.writeCapabilityAuditLog("success", context, startedAt, result);
      await emitProxyEvent(this.eventHandlers, operationEventName(context.operation, "success"), { ctx: context, result, durationMs, success: true });
      await emitProxyEvent(this.eventHandlers, operationEventName(context.operation, "after"), { ctx: context, result, durationMs, success: true });
      return result;
    } catch (error) {
      const normalizedError = normalizeError(error);
      const durationMs = Date.now() - startedAt;
      this.writeCapabilityAuditLog("failure", context, startedAt, undefined, normalizedError);
      await emitProxyEvent(this.eventHandlers, operationEventName(context.operation, "error"), { ctx: context, error: normalizedError, durationMs, success: false });
      await emitProxyEvent(this.eventHandlers, operationEventName(context.operation, "after"), { ctx: context, error: normalizedError, durationMs, success: false });
      throw error;
    }
  }

  private async emitDeniedCapabilityError(error: unknown): Promise<void> {
    if (!(error instanceof PolicyDeniedError) || !error.context) {
      return;
    }

    const startedAt = Date.now();
    this.writeCapabilityAuditLog("failure", error.context, startedAt, undefined, error);
    await emitProxyEvent(this.eventHandlers, operationEventName(error.context.operation, "error"), {
      ctx: error.context,
      error,
      durationMs: 0,
      success: false,
    });
    await emitProxyEvent(this.eventHandlers, operationEventName(error.context.operation, "after"), {
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
    console.error(" \x1b[38;2;6;182;212m🐾 Fentaris Proxy\x1b[0m \x1b[90mv0.1.0\x1b[0m");
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

  private async applyUpstreamAuth(
    server: McpServer,
    user: UserContext,
    subject: ResolvedSubject | undefined,
  ): Promise<{ user: UserContext; credentialSource?: CredentialSourceMetadata }> {
    const bindings = server.getCredentialBindings();
    const legacyBinding = bindings.length === 0 ? this.auth?.getBinding(server.name) : undefined;
    const effectiveBindings: ServerCredentialBinding[] = legacyBinding
      ? [{ ...legacyBinding, credential: { reference: legacyBinding.credential } as ServerCredentialBinding["credential"] }]
      : bindings;
    if (effectiveBindings.length === 0) {
      return { user };
    }

    if (!subject) {
      throw new Error(`Upstream auth for server "${server.name}" requires an authenticated subject`);
    }

    let resolvedUser = user;
    let firstCredentialSource: CredentialSourceMetadata | undefined;
    for (const binding of effectiveBindings) {
      const credential = await this.resolveCredential(binding.credential.reference, subject);
      if (!credential) {
        throw new Error(`Missing upstream credential "${binding.credential.reference}" for server "${server.name}"`);
      }

      firstCredentialSource ??= {
        reference: credential.reference,
        source: credential.source,
        userId: credential.userId,
        groupId: credential.groupId,
      };
      resolvedUser = {
        ...resolvedUser,
        __fentarisUpstreamEnv: {
          ...(isRecord(resolvedUser.__fentarisUpstreamEnv) ? resolvedUser.__fentarisUpstreamEnv : {}),
          ...toUpstreamEnv(binding, credential.value),
        },
      };
    }

    return {
      user: resolvedUser,
      credentialSource: firstCredentialSource,
    };
  }

  private async resolveCredential(
    reference: string,
    subject: ResolvedSubject,
  ): Promise<(CredentialSourceMetadata & { value: string }) | null> {
    const user = this.groups.flatMap((group) => group.users).find((candidate) => candidate.id === subject.id);
    const userSource = user?.credentials[reference];
    if (userSource) {
      return { reference, value: await resolveCredentialSource(userSource), source: "user", userId: subject.id };
    }

    for (const membership of subject.groups) {
      const group = this.groups.find((candidate) => candidate.id === membership.id);
      const source = group?.credentials[reference];
      if (source) {
        return { reference, value: await resolveCredentialSource(source), source: "group", groupId: group.id };
      }
    }

    const defaultSource = this.defaultCredentials[reference];
    if (defaultSource) {
      return { reference, value: await resolveCredentialSource(defaultSource), source: "default" };
    }

    return this.auth?.resolveCredential(reference, subject) ?? null;
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
}

/**
 * Create a Fentaris proxy with the express-like routing API.
 * @pk
 */
export function createProxy(options: McpProxyOptions): McpProxy {
  return new McpProxy(options);
}

/**
 * Create a Fentaris proxy with the express-like routing API.
 * @pk
 */
export const fentaris = createProxy;

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

function hasDeclaredApiKeys(groups: Group[]): boolean {
  return groups.some((group) => group.users.some((user) => user.apiKeys.length > 0));
}

function declaredApiKeyIdentityStrategy(groups: Group[]): IdentityStrategy | undefined {
  if (!hasDeclaredApiKeys(groups)) {
    return undefined;
  }

  return {
    name: "declared-api-key",
    async resolve(request) {
      const apiKey = request.headers?.["x-fentaris-api-key"];
      if (!apiKey) {
        return null;
      }

      for (const user of groups.flatMap((group) => group.users)) {
        for (const source of user.apiKeys) {
          const candidate = await resolveCredentialSource(source);
          if (candidate === apiKey || candidate === FentarisAuth.hashApiKey(apiKey)) {
            return { id: user.id };
          }
        }
      }

      return null;
    },
  };
}

function toUpstreamEnv(binding: ServerCredentialBinding, credential: string): Record<string, string> {
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















