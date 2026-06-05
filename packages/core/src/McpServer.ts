import type {
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { assertValidServerName } from "./nameMapping.js";
import type { Isolation, PanterTransport, UserContext } from "./types.js";

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
    if (!this.env && !upstreamEnv) {
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
      return existing;
    }

    if (!isEnvAwareTransport(this.transport)) {
      throw new Error(`Transport for server "${this.name}" does not support env injection`);
    }

    const transport = this.transport.withEnv(resolvedEnv);
    this.userTransports.set(key, transport);
    return transport;
  }
}

/**
 * Type guard for env-aware transports.
 * @pk
 */
function isEnvAwareTransport(transport: PanterTransport): transport is EnvAwareTransport {
  return "withEnv" in transport && typeof transport.withEnv === "function";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
