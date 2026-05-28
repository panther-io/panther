import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { PanterTransport } from "../types.js";

/**
 * Options for the stdio transport.
 * @pk
 */
export type StdioTransportOptions = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  stderr?: "inherit" | "pipe" | "overlapped" | "ignore";
  clientName?: string;
  clientVersion?: string;
};

/**
 * Stdio-based MCP transport implementation.
 * @pk
 */
export class StdioTransport implements PanterTransport {
  private readonly options: StdioTransportOptions;
  private client: Client | null = null;
  private connectPromise: Promise<Client> | null = null;

  /**
   * Create a new stdio transport.
   * @pk
   */
  constructor(options: StdioTransportOptions) {
    if (!options.command.trim()) {
      throw new Error("StdioTransport command cannot be empty");
    }

    this.options = options;
  }

  /**
   * Return a copy with merged environment variables.
   * @pk
   */
  withEnv(env: Record<string, string>): StdioTransport {
    return new StdioTransport({
      ...this.options,
      env: {
        ...this.options.env,
        ...env,
      },
    });
  }

  /**
   * List tools exposed by the MCP server.
   * @pk
   */
  async listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.tools) {
      return { tools: [] };
    }

    return client.listTools(params);
  }

  /**
   * Call a tool on the MCP server.
   * @pk
   */
  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    return (await this.getClient()).callTool(params, CallToolResultSchema) as Promise<CallToolResult>;
  }

  /**
   * Close the underlying client connection.
   * @pk
   */
  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.connectPromise = null;
  }

  private async getClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    if (!this.connectPromise) {
      this.connectPromise = this.connect();
    }

    try {
      this.client = await this.connectPromise;
      return this.client;
    } catch (error) {
      this.connectPromise = null;
      throw error;
    }
  }

  private async connect(): Promise<Client> {
    const client = new Client(
      {
        name: this.options.clientName ?? "panther-core",
        version: this.options.clientVersion ?? "0.1.0",
      },
      { capabilities: {} },
    );

    await client.connect(
      new StdioClientTransport({
        command: this.options.command,
        args: this.options.args ?? [],
        env: this.options.env,
        stderr: this.options.stderr ?? "inherit",
      }),
    );

    return client;
  }
}