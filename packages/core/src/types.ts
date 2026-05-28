import type {
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "./logger.js";

export type MaybePromise<T> = T | Promise<T>;

export type UserContext = {
  id?: string;
  [key: string]: unknown;
};

export type ToolCallRequest = {
  serverName: string;
  toolName: string;
  proxyToolName: string;
  arguments: CallToolRequest["params"]["arguments"];
  raw: CallToolRequest["params"];
};

export class ResponseController {
  deny(message: string): CallToolResult {
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }

  continue(): undefined {
    return undefined;
  }
}

export type MiddlewareContext = {
  user: UserContext;
  log: Logger;
  res: ResponseController;
};

export type Next = () => Promise<CallToolResult>;

export type Middleware = (
  request: ToolCallRequest,
  context: MiddlewareContext,
  next: Next,
) => MaybePromise<CallToolResult | void>;

export type PanterTransport = {
  listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult>;
  callTool(params: CallToolRequest["params"]): Promise<CallToolResult>;
  close(): Promise<void>;
};
