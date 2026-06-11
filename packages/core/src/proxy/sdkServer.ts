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
import type { IdentityMetadata, ResolvedSubject, UserContext } from "../types/shared.js";
import type { McpServer } from "../server/McpServer.js";

export interface SdkServerDeps {
  name: string;
  version: string;
  servers: McpServer[];
  listTools(params?: ListToolsRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject): Promise<ListToolsResult>;
  callTool(params: CallToolRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject): Promise<CallToolResult>;
  listResources(params?: ListResourcesRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject): Promise<ListResourcesResult>;
  readResource(params: ReadResourceRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject): Promise<ReadResourceResult>;
  listResourceTemplates(params?: ListResourceTemplatesRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject): Promise<ListResourceTemplatesResult>;
  listPrompts(params?: ListPromptsRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject): Promise<ListPromptsResult>;
  getPrompt(params: GetPromptRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject): Promise<GetPromptResult>;
  complete(params: CompleteRequest["params"], user?: UserContext, identity?: IdentityMetadata, subject?: ResolvedSubject): Promise<CompleteResult>;
}

export function createServerCapabilities(servers: McpServer[]): {
  tools: object;
  logging: object;
  resources?: object;
  prompts?: object;
  completions?: object;
} {
  return {
    tools: {},
    logging: {},
    ...(servers.some((server) => server.supportsResources()) ? { resources: {} } : {}),
    ...(servers.some((server) => server.supportsPrompts()) ? { prompts: {} } : {}),
    ...(servers.some((server) => server.supportsCompletions()) ? { completions: {} } : {}),
  };
}

export function createSdkServer(deps: SdkServerDeps, user: UserContext = {}, identity?: IdentityMetadata, subject?: ResolvedSubject): McpSdkServer {
  const capabilities = createServerCapabilities(deps.servers);
  const server = new McpSdkServer(
    { name: deps.name, version: deps.version },
    {
      capabilities,
      instructions: "Fentaris MCP proxy. Tool and prompt names are prefixed as <server>__<name>; resources use fentaris:// proxy URIs.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => deps.listTools(request.params, user, identity, subject));
  server.setRequestHandler(CallToolRequestSchema, async (request) => deps.callTool(request.params, user, identity, subject));
  if (capabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => deps.listResources(request.params, user, identity, subject));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => deps.readResource(request.params, user, identity, subject));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => deps.listResourceTemplates(request.params, user, identity, subject));
  }
  if (capabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => deps.listPrompts(request.params, user, identity, subject));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => deps.getPrompt(request.params, user, identity, subject));
  }
  if (capabilities.completions) {
    server.setRequestHandler(CompleteRequestSchema, async (request) => deps.complete(request.params, user, identity, subject));
  }

  return server;
}
