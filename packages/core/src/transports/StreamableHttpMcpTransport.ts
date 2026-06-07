import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, type StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolRequest,
  CallToolResult,
  ClientCapabilities,
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
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  ProgressNotificationSchema,
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveHttpTransportHeaders, type HttpTransportAuthOptions } from "../transportAuth.js";
import type { ClientFeatureBridge, McpUpstreamNotificationHandler, PanterTransport, UserContext } from "../types.js";

/**
 * Options for native MCP Streamable HTTP upstream transport.
 * @pk
 */
export type StreamableHttpMcpTransportOptions = {
  url: string | URL;
  auth?: HttpTransportAuthOptions;
  requestInit?: RequestInit;
  fetch?: StreamableHTTPClientTransportOptions["fetch"];
  sessionId?: string;
  clientName?: string;
  clientVersion?: string;
  clientCapabilities?: ClientCapabilities;
  clientFeatureBridge?: ClientFeatureBridge;
};

/**
 * Native MCP Streamable HTTP upstream transport for http:// and https:// servers.
 * @pk
 */
export class StreamableHttpMcpTransport implements PanterTransport {
  private readonly options: StreamableHttpMcpTransportOptions;
  private readonly user: UserContext;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connectPromise: Promise<Client> | null = null;
  private readonly notificationHandlers = new Set<McpUpstreamNotificationHandler>();

  /**
   * Create a native MCP Streamable HTTP transport.
   * @pk
   */
  constructor(options: StreamableHttpMcpTransportOptions, user: UserContext = {}) {
    const url = new URL(options.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("StreamableHttpMcpTransport url must use http:// or https://");
    }

    this.options = { ...options, url };
    this.user = user;
  }

  /**
   * Return a copy bound to the current proxy user context.
   * @pk
   */
  withUser(user: UserContext): StreamableHttpMcpTransport {
    const transport = new StreamableHttpMcpTransport(this.options, user);
    for (const handler of this.notificationHandlers) {
      transport.onNotification(handler);
    }
    return transport;
  }

  withClientCapabilities(capabilities: ClientCapabilities): StreamableHttpMcpTransport {
    const transport = new StreamableHttpMcpTransport({ ...this.options, clientCapabilities: capabilities }, this.user);
    for (const handler of this.notificationHandlers) {
      transport.onNotification(handler);
    }
    return transport;
  }

  withClientFeatureBridge(bridge: ClientFeatureBridge): StreamableHttpMcpTransport {
    const transport = new StreamableHttpMcpTransport({ ...this.options, clientFeatureBridge: bridge }, this.user);
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

  async listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.tools) {
      return { tools: [] };
    }

    return client.listTools(params);
  }

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

  async subscribeResource(params: SubscribeRequest["params"]): Promise<{ _meta?: Record<string, unknown> }> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.resources?.subscribe) {
      throw unsupportedCapability("resource subscriptions");
    }

    return client.subscribeResource(params);
  }

  async unsubscribeResource(params: UnsubscribeRequest["params"]): Promise<{ _meta?: Record<string, unknown> }> {
    const client = await this.getClient();
    if (!client.getServerCapabilities()?.resources?.subscribe) {
      throw unsupportedCapability("resource subscriptions");
    }

    return client.unsubscribeResource(params);
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

  async ping(): Promise<{ _meta?: Record<string, unknown> }> {
    return (await this.getClient()).ping();
  }

  async cancelRequest(requestId: string | number, reason?: string): Promise<void> {
    const client = await this.getClient();
    await client.notification({
      method: "notifications/cancelled",
      params: { requestId, reason },
    });
  }

  async close(): Promise<void> {
    await this.client?.close();
    await this.transport?.close();
    this.client = null;
    this.transport = null;
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
    const headers = await resolveHttpTransportHeaders(this.options.auth, this.user);
    const client = new Client(
      {
        name: this.options.clientName ?? "panther-core",
        version: this.options.clientVersion ?? "0.1.0",
      },
      { capabilities: this.options.clientCapabilities ?? {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.options.url), {
      fetch: this.options.fetch,
      sessionId: this.options.sessionId,
      requestInit: {
        ...this.options.requestInit,
        headers: {
          ...headersFrom(this.options.requestInit?.headers),
          ...headers,
        },
      },
    });

    this.registerNotificationHandlers(client);
    this.registerClientFeatureHandlers(client);
    await client.connect(transport);
    this.transport = transport;
    return client;
  }

  private registerNotificationHandlers(client: Client): void {
    if (typeof client.setNotificationHandler !== "function") {
      return;
    }

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
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
      await this.emitNotification({
        type: "logging:message",
        level: notification.params.level,
        logger: notification.params.logger,
        data: notification.params.data,
      });
    });
  }

  private registerClientFeatureHandlers(client: Client): void {
    const bridge = this.options.clientFeatureBridge;
    if (!bridge || typeof client.setRequestHandler !== "function") {
      return;
    }

    const listRoots = bridge.listRoots;
    if (listRoots) {
      client.setRequestHandler(ListRootsRequestSchema, async (request) => listRoots(request.params));
    }
    const createMessage = bridge.createMessage;
    if (createMessage) {
      client.setRequestHandler(CreateMessageRequestSchema, async (request) => createMessage(request.params));
    }
    const elicit = bridge.elicit;
    if (elicit) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => elicit(request.params));
    }
  }

  private async emitNotification(notification: Parameters<McpUpstreamNotificationHandler>[0]): Promise<void> {
    await Promise.all([...this.notificationHandlers].map((handler) => handler(notification)));
  }
}

function headersFrom(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(new Headers(headers).entries());
}

function unsupportedCapability(capability: "resources" | "prompts" | "completions" | "resource subscriptions"): Error {
  return new Error(`Upstream MCP server does not support ${capability}`);
}
