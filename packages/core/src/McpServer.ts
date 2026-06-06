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
  SubscribeRequest,
  UnsubscribeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { assertValidServerName } from "./nameMapping.js";
import type { Isolation, McpUpstreamNotificationHandler, PanterTransport, UserContext } from "./types.js";

/**
 * Resolve environment variables per user.
 * @pk
 */
export type EnvResolver = Record<string, string> | ((user: UserContext) => Record<string, string>);

/**
 * Configuration for an MCP server wrapper.
 * @pk
 */
export type McpServerOptions = {
  name: string;
  displayName?: string;
  transport: PanterTransport;
  env?: EnvResolver;
  isolation?: Isolation;
  isolationTimeout?: number;
};

type EnvAwareTransport = PanterTransport & {
  withEnv(env: Record<string, string>): PanterTransport;
};

type UserAwareTransport = PanterTransport & {
  withUser(user: UserContext): PanterTransport;
};

/**
 * MCP server wrapper with optional per-user env injection.
 * @pk
 */
export class McpServer {
  readonly name: string;
  readonly displayName: string;

  private readonly transport: PanterTransport;
  private readonly env?: EnvResolver;
  private readonly isolation?: Isolation;
  private readonly isolationTimeout?: number;
  private readonly userTransports = new Map<string, PanterTransport>();
  private readonly notificationHandlers = new Set<McpUpstreamNotificationHandler>();
  private readonly notificationUnsubscribers = new WeakMap<PanterTransport, Array<() => void>>();

  /**
   * Create a new MCP server wrapper.
   * @pk
   */
  constructor(options: McpServerOptions) {
    assertValidServerName(options.name);

    this.name = options.name;
    this.displayName = options.displayName ?? options.name;
    this.transport = options.transport;
    this.env = options.env;
    this.isolation = options.isolation;
    this.isolationTimeout = options.isolationTimeout;
  }

  /**
   * List tools for a given user.
   * @pk
   */
  async listTools(params?: ListToolsRequest["params"], user: UserContext = {}): Promise<ListToolsResult> {
    return this.transportFor(user).listTools(params);
  }

  /**
   * Call a tool for a given user.
   * @pk
   */
  async callTool(params: CallToolRequest["params"], user: UserContext = {}): Promise<CallToolResult> {
    if (!this.isolation) {
      return this.transportFor(user).callTool(params);
    }

    return this.isolation.queue(
      user.id ?? "anonymous",
      () => this.transportFor(user).callTool(params),
      this.isolationTimeout,
    );
  }

  /**
   * List resources for a given user.
   * @pk
   */
  async listResources(params?: ListResourcesRequest["params"], user: UserContext = {}): Promise<ListResourcesResult> {
    const transport = this.transportFor(user);
    if (!transport.listResources) {
      return { resources: [] };
    }

    return transport.listResources(params);
  }

  /**
   * Read a resource for a given user.
   * @pk
   */
  async readResource(params: ReadResourceRequest["params"], user: UserContext = {}): Promise<ReadResourceResult> {
    const transport = this.transportFor(user);
    if (!transport.readResource) {
      throw unsupportedCapability(this.name, "resources");
    }

    return transport.readResource(params);
  }

  async subscribeResource(params: SubscribeRequest["params"], user: UserContext = {}): Promise<{ _meta?: Record<string, unknown> }> {
    const transport = this.transportFor(user);
    if (!transport.subscribeResource) {
      throw unsupportedCapability(this.name, "resource subscriptions");
    }

    return transport.subscribeResource(params);
  }

  async unsubscribeResource(params: UnsubscribeRequest["params"], user: UserContext = {}): Promise<{ _meta?: Record<string, unknown> }> {
    const transport = this.transportFor(user);
    if (!transport.unsubscribeResource) {
      throw unsupportedCapability(this.name, "resource subscriptions");
    }

    return transport.unsubscribeResource(params);
  }

  /**
   * List resource templates for a given user.
   * @pk
   */
  async listResourceTemplates(
    params?: ListResourceTemplatesRequest["params"],
    user: UserContext = {},
  ): Promise<ListResourceTemplatesResult> {
    const transport = this.transportFor(user);
    if (!transport.listResourceTemplates) {
      return { resourceTemplates: [] };
    }

    return transport.listResourceTemplates(params);
  }

  /**
   * List prompts for a given user.
   * @pk
   */
  async listPrompts(params?: ListPromptsRequest["params"], user: UserContext = {}): Promise<ListPromptsResult> {
    const transport = this.transportFor(user);
    if (!transport.listPrompts) {
      return { prompts: [] };
    }

    return transport.listPrompts(params);
  }

  /**
   * Get a prompt for a given user.
   * @pk
   */
  async getPrompt(params: GetPromptRequest["params"], user: UserContext = {}): Promise<GetPromptResult> {
    const transport = this.transportFor(user);
    if (!transport.getPrompt) {
      throw unsupportedCapability(this.name, "prompts");
    }

    return transport.getPrompt(params);
  }

  /**
   * Complete a prompt or resource argument for a given user.
   * @pk
   */
  async complete(params: CompleteRequest["params"], user: UserContext = {}): Promise<CompleteResult> {
    const transport = this.transportFor(user);
    if (!transport.complete) {
      throw unsupportedCapability(this.name, "completions");
    }

    return transport.complete(params);
  }

  async ping(user: UserContext = {}): Promise<{ _meta?: Record<string, unknown> }> {
    const transport = this.transportFor(user);
    if (!transport.ping) {
      return {};
    }

    return transport.ping();
  }

  async cancelRequest(requestId: string | number, reason: string | undefined, user: UserContext = {}): Promise<void> {
    const transport = this.transportFor(user);
    await transport.cancelRequest?.(requestId, reason);
  }

  /**
   * Whether the configured transport exposes resource operations.
   * @pk
   */
  supportsResources(): boolean {
    return Boolean(this.transport.listResources || this.transport.readResource || this.transport.listResourceTemplates);
  }

  /**
   * Whether the configured transport exposes prompt operations.
   * @pk
   */
  supportsPrompts(): boolean {
    return Boolean(this.transport.listPrompts || this.transport.getPrompt);
  }

  /**
   * Whether the configured transport exposes completion operations.
   * @pk
   */
  supportsCompletions(): boolean {
    return Boolean(this.transport.complete);
  }

  onNotification(handler: McpUpstreamNotificationHandler): () => void {
    const scopedHandler: McpUpstreamNotificationHandler = (notification) =>
      handler({ ...notification, serverName: notification.serverName ?? this.name });
    this.notificationHandlers.add(scopedHandler);
    this.attachNotificationHandlers(this.transport);
    for (const transport of this.userTransports.values()) {
      this.attachNotificationHandlers(transport);
    }

    return () => {
      this.notificationHandlers.delete(scopedHandler);
    };
  }

  /**
   * Close all transports.
   * @pk
   */
  async close(): Promise<void> {
    await Promise.all([...this.userTransports.values()].map((transport) => transport.close()));
    this.userTransports.clear();
    await this.isolation?.close();
    await this.transport.close();
  }

  private transportFor(user: UserContext): PanterTransport {
    const upstreamEnv = isStringRecord(user.__pantherUpstreamEnv) ? user.__pantherUpstreamEnv : undefined;
    const supportsUserContext = isUserAwareTransport(this.transport);
    if (!this.env && !upstreamEnv && !supportsUserContext) {
      return this.transport;
    }

    const configuredEnv = typeof this.env === "function" ? this.env(user) : this.env;
    const resolvedEnv = {
      ...(configuredEnv ?? {}),
      ...(upstreamEnv ?? {}),
    };
    const key = `${user.id ?? "default"}:${JSON.stringify(Object.entries(resolvedEnv).sort(([left], [right]) => left.localeCompare(right)))}`;
    const existing = this.userTransports.get(key);
    if (existing) {
      this.attachNotificationHandlers(existing);
      return existing;
    }

    let transport = this.transport;
    if ((this.env || upstreamEnv) && !isEnvAwareTransport(transport)) {
      throw new Error(`Transport for server "${this.name}" does not support env injection`);
    }

    if (this.env || upstreamEnv) {
      transport = (transport as EnvAwareTransport).withEnv(resolvedEnv);
    }

    if (isUserAwareTransport(transport)) {
      transport = transport.withUser(user);
    }

    this.userTransports.set(key, transport);
    this.attachNotificationHandlers(transport);
    return transport;
  }

  private attachNotificationHandlers(transport: PanterTransport): void {
    if (!transport.onNotification || this.notificationUnsubscribers.has(transport)) {
      return;
    }

    const unsubscribers = [...this.notificationHandlers].map((handler) => transport.onNotification?.(handler)).filter(Boolean) as Array<() => void>;
    this.notificationUnsubscribers.set(transport, unsubscribers);
  }
}

/**
 * Type guard for env-aware transports.
 * @pk
 */
function isEnvAwareTransport(transport: PanterTransport): transport is EnvAwareTransport {
  return "withEnv" in transport && typeof transport.withEnv === "function";
}

function isUserAwareTransport(transport: PanterTransport): transport is UserAwareTransport {
  return "withUser" in transport && typeof transport.withUser === "function";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unsupportedCapability(serverName: string, capability: "resources" | "prompts" | "completions" | "resource subscriptions"): Error {
  return new Error(`Transport for server "${serverName}" does not support ${capability}`);
}
