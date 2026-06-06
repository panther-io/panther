import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
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
import {
  ProgressNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpUpstreamNotificationHandler, PanterTransport } from "../types.js";

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
  private readonly notificationHandlers = new Set<McpUpstreamNotificationHandler>();

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
    const transport = new StdioTransport({
      ...this.options,
      env: {
        ...this.options.env,
        ...env,
      },
    });
    for (const handler of this.notificationHandlers) {
      transport.onNotification(handler);
    }
    return transport;
  }

  onNotification(handler: McpUpstreamNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
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

  async listResources(params?: ListResourcesRequest["params"]): Promise<ListResourcesResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.resources) {
      return { resources: [] };
    }

    return client.listResources(params);
  }

  async readResource(params: ReadResourceRequest["params"]): Promise<ReadResourceResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.resources) {
      throw unsupportedCapability("resources");
    }

    return client.readResource(params);
  }

  async listResourceTemplates(params?: ListResourceTemplatesRequest["params"]): Promise<ListResourceTemplatesResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.resources) {
      return { resourceTemplates: [] };
    }

    return client.listResourceTemplates(params);
  }

  async listPrompts(params?: ListPromptsRequest["params"]): Promise<ListPromptsResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.prompts) {
      return { prompts: [] };
    }

    return client.listPrompts(params);
  }

  async getPrompt(params: GetPromptRequest["params"]): Promise<GetPromptResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.prompts) {
      throw unsupportedCapability("prompts");
    }

    return client.getPrompt(params);
  }

  async complete(params: CompleteRequest["params"]): Promise<CompleteResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.completions) {
      throw unsupportedCapability("completions");
    }

    return client.complete(params);
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

    this.registerNotificationHandlers(client);
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

  private registerNotificationHandlers(client: Client): void {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.emitNotification({ type: "tools:list-changed" });
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      await this.emitNotification({ type: "resources:list-changed" });
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      await this.emitNotification({ type: "prompts:list-changed" });
    });
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
      await this.emitNotification({ type: "resources:updated", uri: notification.params.uri });
    });
    client.setNotificationHandler(ProgressNotificationSchema, async (notification) => {
      await this.emitNotification({
        type: "progress",
        progressToken: notification.params.progressToken,
        progress: notification.params.progress,
        total: notification.params.total,
        message: notification.params.message,
      });
    });
  }

  private async emitNotification(notification: Parameters<McpUpstreamNotificationHandler>[0]): Promise<void> {
    await Promise.all([...this.notificationHandlers].map((handler) => handler(notification)));
  }
}

function unsupportedCapability(capability: "resources" | "prompts" | "completions"): Error {
  return new Error(`Upstream MCP server does not support ${capability}`);
}
