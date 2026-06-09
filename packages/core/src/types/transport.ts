import type { CallToolRequest, CallToolResult, ListToolsRequest, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  CompleteParams,
  CompleteResponse,
  GetPromptParams,
  GetPromptResponse,
  ListPromptsParams,
  ListPromptsResponse,
  ListResourcesParams,
  ListResourcesResponse,
  ListResourceTemplatesParams,
  ListResourceTemplatesResponse,
  ReadResourceParams,
  ReadResourceResponse,
} from "./mcp-operation.js";

/**
 * Transport interface for MCP client interactions.
 * @pk
 */
export type FentarisTransport = {
  listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult>;
  callTool(params: CallToolRequest["params"]): Promise<CallToolResult>;
  listResources?(params?: ListResourcesParams): Promise<ListResourcesResponse>;
  readResource?(params: ReadResourceParams): Promise<ReadResourceResponse>;
  listResourceTemplates?(params?: ListResourceTemplatesParams): Promise<ListResourceTemplatesResponse>;
  listPrompts?(params?: ListPromptsParams): Promise<ListPromptsResponse>;
  getPrompt?(params: GetPromptParams): Promise<GetPromptResponse>;
  complete?(params: CompleteParams): Promise<CompleteResponse>;
  close(): Promise<void>;
};
