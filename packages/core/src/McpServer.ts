import type {
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { assertValidServerName } from "./nameMapping.js";
import type { PanterTransport, UserContext } from "./types.js";

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
    return this.transportFor(user).callTool(params);
  }

  /**
   * Close all transports.
   * @pk
   */
  async close(): Promise<void> {
    await Promise.all([...this.userTransports.values()].map((transport) => transport.close()));
    this.userTransports.clear();
    await this.transport.close();
  }

  private transportFor(user: UserContext): PanterTransport {
    if (!this.env) {
      return this.transport;
    }

    const resolvedEnv = typeof this.env === "function" ? this.env(user) : this.env;
    const key = user.id ?? "default";
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
