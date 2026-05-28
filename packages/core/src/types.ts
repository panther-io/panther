import type {
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "./logger.js";

/**
 * Maybe a promise for async compatibility.
 * @pk
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * User context passed through requests.
 * @pk
 */
export type UserContext = {
  id?: string;
  [key: string]: unknown;
};

/**
 * Normalized tool call details for middleware.
 * @pk
 */
export type ToolCallRequest = {
  serverName: string;
  toolName: string;
  proxyToolName: string;
  arguments: CallToolRequest["params"]["arguments"];
  raw: CallToolRequest["params"];
};

/**
 * Helper for returning allow/deny responses from middleware.
 * @pk
 */
export class ResponseController {
  /**
   * Deny a tool call with a message.
   * @pk
   */
  deny(message: string): CallToolResult {
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }

  /**
   * Allow middleware to continue without overriding the response.
   * @pk
   */
  continue(): undefined {
    return undefined;
  }
}

/**
 * Middleware execution context.
 * @pk
 */
export type MiddlewareContext = {
  user: UserContext;
  log: Logger;
  res: ResponseController;
};

/**
 * Next middleware handler.
 * @pk
 */
export type Next = () => Promise<CallToolResult>;

/**
 * Middleware function signature.
 * @pk
 */
export type Middleware = (
  request: ToolCallRequest,
  context: MiddlewareContext,
  next: Next,
) => MaybePromise<CallToolResult | void>;

/**
 * Transport interface for MCP client interactions.
 * @pk
 */
export type PanterTransport = {
  listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult>;
  callTool(params: CallToolRequest["params"]): Promise<CallToolResult>;
  close(): Promise<void>;
};
