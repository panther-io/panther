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
 * Filter for proxy call hooks.
 * @pk
 */
export type ToolCallHookFilter = {
  server?: string;
  tool?: string;
  proxyTool?: string;
};

/**
 * Event names supported by the proxy hook system.
 * @pk
 */
export type ProxyHookEvent = "call";

/**
 * Hook invoked for matched tool calls.
 * @pk
 */
export type ToolCallHook = (
  request: ToolCallRequest,
  context: MiddlewareContext,
) => MaybePromise<void | CallToolResult>;

/**
 * Hook invoked after upstream tool discovery and before returning tools to the client.
 * @pk
 */
export type ListToolsHook = (
  tools: ListToolsResult["tools"],
  context: ListToolsContext,
) => MaybePromise<ListToolsResult["tools"] | ListToolsResult | void>;

/**
 * Context passed to list tool hooks.
 * @pk
 */
export type ListToolsContext = {
  user: UserContext;
  log: Logger;
};

/**
 * Helper for returning allow/deny responses from middleware.
 * @pk
 */
export class ResponseController {
  private readonly agentMessages: string[] = [];
  private readonly errorHandlers: Array<(error: Error) => MaybePromise<void>> = [];

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

  /**
   * Add guidance for the calling agent to the eventual tool response.
   * @pk
   */
  injectToAgent(message: string): void {
    if (message.trim()) {
      this.agentMessages.push(message);
    }
  }

  /**
   * Register a response event handler.
   * @pk
   */
  on(event: "error", handler: (error: Error) => MaybePromise<void>): void {
    this.errorHandlers.push(handler);
  }

  /**
   * Run registered error handlers.
   * @internal
   */
  async notifyError(error: Error): Promise<void> {
    for (const handler of this.errorHandlers) {
      await handler(error);
    }
  }

  /**
   * Apply queued agent guidance to a tool result.
   * @internal
   */
  applyInjections(result: CallToolResult): CallToolResult {
    if (this.agentMessages.length === 0) {
      return result;
    }

    return {
      ...result,
      content: [
        ...result.content,
        ...this.agentMessages.map((text) => ({
          type: "text" as const,
          text,
        })),
      ],
    };
  }

  /**
   * Return queued agent guidance as an error result.
   * @internal
   */
  injectedErrorResult(): CallToolResult | undefined {
    if (this.agentMessages.length === 0) {
      return undefined;
    }

    return {
      content: this.agentMessages.map((text) => ({
        type: "text" as const,
        text,
      })),
      isError: true,
    };
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
