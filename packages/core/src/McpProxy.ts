import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsRequest,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "./logger.js";
import { McpServer } from "./McpServer.js";
import { fromProxyToolName, toProxyToolName } from "./nameMapping.js";
import { ResponseController, type Middleware, type MiddlewareContext, type ToolCallRequest, type UserContext } from "./types.js";

/**
 * Options for creating an MCP proxy server.
 * @pk
 */
export type McpProxyOptions = {
  servers: McpServer[];
  port?: number;
  path?: string;
  logger?: Logger;
  user?: UserContext | ((request: IncomingMessage) => UserContext | Promise<UserContext>);
  name?: string;
  version?: string;
};

/**
 * Optional start overrides for the MCP proxy.
 * @pk
 */
export type McpProxyStartOptions = {
  port?: number;
  path?: string;
};

/**
 * Active MCP session state.
 * @pk
 */
type SessionState = {
  transport: StreamableHTTPServerTransport;
  server: McpSdkServer;
};

/**
 * HTTP proxy for multiple MCP servers.
 * @pk
 */
export class McpProxy {
  private readonly servers: McpServer[];
  private readonly serverByName = new Map<string, McpServer>();
  private readonly middleware: Middleware[] = [];
  private readonly logger: Logger;
  private readonly userResolver?: McpProxyOptions["user"];
  private readonly name: string;
  private readonly version: string;
  private readonly defaultPort?: number;
  private readonly defaultPath: string;
  private httpServer: HttpServer | null = null;

  /**
   * Create a new MCP proxy instance.
   * @pk
   */
  constructor(options: McpProxyOptions) {
    this.servers = options.servers;
    this.logger = options.logger ?? new Logger();
    this.userResolver = options.user;
    this.name = options.name ?? "panther-core-proxy";
    this.version = options.version ?? "0.1.0";
    this.defaultPort = options.port;
    this.defaultPath = options.path ?? "/mcp";

    for (const server of this.servers) {
      if (this.serverByName.has(server.name)) {
        throw new Error(`Duplicate MCP server name "${server.name}"`);
      }
      this.serverByName.set(server.name, server);
    }
  }

  /**
   * Register a middleware handler.
   * @pk
   */
  use(middleware: Middleware): this {
    this.middleware.push(middleware);
    return this;
  }

  /**
   * Start the HTTP server.
   * @pk
   */
  async start(onStarted?: () => void): Promise<HttpServer>;
  /**
   * Start the HTTP server with optional overrides.
   * @pk
   */
  async start(options?: McpProxyStartOptions, onStarted?: () => void): Promise<HttpServer>;
  async start(
    optionsOrCallback: McpProxyStartOptions | (() => void) = {},
    onStarted?: () => void,
  ): Promise<HttpServer> {
    if (this.httpServer) {
      return this.httpServer;
    }

    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : onStarted;
    const port = options.port ?? this.defaultPort ?? 3000;
    const path = options.path ?? this.defaultPath;
    const sessions = new Map<string, SessionState>();

    this.httpServer = createServer(async (req, res) => {
      if (req.url?.split("?")[0] !== path) {
        sendText(res, 404, "Not Found");
        return;
      }

      if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
        sendText(res, 405, "Method Not Allowed", { Allow: "GET, POST, DELETE" });
        return;
      }

      try {
        const user = await this.resolveUser(req);
        await this.handleMcpRequest(req, res, sessions, user);
      } catch (error) {
        this.logger.error("Error handling MCP proxy request", { error: safeErrorMessage(error) });
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, -32603, "Internal server error");
        }
      }
    });

    await new Promise<void>((resolve) => {
      this.httpServer?.listen(port, () => {
        this.printStartupBanner(port, path);
        callback?.();
        resolve();
      });
    });

    return this.httpServer;
  }

  /**
   * Close the HTTP server and all backends.
   * @pk
   */
  async close(): Promise<void> {
    const closeHttpServer = this.httpServer
      ? new Promise<void>((resolve, reject) => {
          this.httpServer?.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        })
      : Promise.resolve();

    await closeHttpServer;
    this.httpServer = null;
    await Promise.all(this.servers.map((server) => server.close()));
  }

  /**
   * List tools across all configured servers.
   * @pk
   */
  async listTools(params?: ListToolsRequest["params"], user: UserContext = {}): Promise<ListToolsResult> {
    const results = await Promise.all(
      this.servers.map(async (server) => {
        const result = await server.listTools(params, user);
        return result.tools.map((tool) => ({
          ...tool,
          name: toProxyToolName(server.name, tool.name),
          title: tool.title ?? `${server.displayName}: ${tool.name}`,
          description: annotateDescription(server.displayName, tool.description),
        }));
      }),
    );

    return { tools: results.flat() };
  }

  /**
   * Call a proxied tool with middleware dispatch.
   * @pk
   */
  async callTool(params: CallToolRequest["params"], user: UserContext = {}): Promise<CallToolResult> {
    const { serverName, toolName } = fromProxyToolName(params.name);
    const request: ToolCallRequest = {
      serverName,
      toolName,
      proxyToolName: params.name,
      arguments: params.arguments,
      raw: params,
    };
    const log = this.logger.child({
      userId: user.id,
      serverName,
      toolName,
      proxyToolName: params.name,
    });
    const context: MiddlewareContext = {
      user,
      log,
      res: new ResponseController(),
    };

    return this.dispatchMiddleware(0, request, context, () => this.forwardToolCall(params, user));
  }

  /**
   * Handle an MCP HTTP request for session setup or routing.
   * @pk
   */
  private async handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    sessions: Map<string, SessionState>,
    user: UserContext,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        sendJsonRpcError(res, 404, -32001, "Session not found");
        return;
      }

      await session.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== "POST") {
      sendJsonRpcError(res, 400, -32000, "A new MCP session must start with POST initialize");
      return;
    }

    const sdkServer = this.createSdkServer(user);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, { transport, server: sdkServer });
        this.logger.debug("MCP proxy session initialized", { sessionId: newSessionId, userId: user.id });
      },
    });

    transport.onclose = async () => {
      const initializedSessionId = transport.sessionId;
      if (initializedSessionId) {
        sessions.delete(initializedSessionId);
      }
      await sdkServer.close();
    };

    await sdkServer.connect(transport);
    await transport.handleRequest(req, res);
  }

  /**
   * Create the MCP SDK server and attach handlers.
   * @pk
   */
  private createSdkServer(user: UserContext): McpSdkServer {
    const server = new McpSdkServer(
      { name: this.name, version: this.version },
      {
        capabilities: {
          tools: {},
          logging: {},
        },
        instructions: "Panther MCP proxy. Tool names are prefixed as <server>__<tool>.",
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async (request) => this.listTools(request.params, user));
    server.setRequestHandler(CallToolRequestSchema, async (request) => this.callTool(request.params, user));

    return server;
  }

  /**
   * Execute middleware in sequence.
   * @pk
   */
  private async dispatchMiddleware(
    index: number,
    request: ToolCallRequest,
    context: MiddlewareContext,
    terminal: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const middleware = this.middleware[index];
    if (!middleware) {
      return terminal();
    }

    let nextCalled = false;
    let nextResult: CallToolResult | undefined;
    const result = await middleware(request, context, async () => {
      if (nextCalled) {
        throw new Error("Middleware next() called multiple times");
      }

      nextCalled = true;
      nextResult = await this.dispatchMiddleware(index + 1, request, context, terminal);
      return nextResult;
    });

    if (result) {
      return result;
    }

    if (nextCalled && nextResult) {
      return nextResult;
    }

    return this.dispatchMiddleware(index + 1, request, context, terminal);
  }

  /**
   * Print the startup banner to stderr.
   * @pk
   */
  private printStartupBanner(port: number, path: string): void {
    const art = [
      "██████╗  █████╗ ███╗   ██╗████████╗██╗  ██╗███████╗██████╗",
      "██╔══██╗██╔══██╗████╗  ██║╚══██╔══╝██║  ██║██╔════╝██╔══██╗",
      "██████╔╝███████║██╔██╗ ██║   ██║   ███████║█████╗  ██████╔╝",
      "██╔═══╝ ██╔══██║██║╚██╗██║   ██║   ██╔══██║██╔══╝  ██╔══██╗",
      "██║     ██║  ██║██║ ╚████║   ██║   ██║  ██║███████╗██║  ██║",
      "╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝",
    ];

    const width = Math.max(...art.map((line) => line.length));
    const top = ` ╭${"─".repeat(width + 4)}╮`;
    const bottom = ` ╰${"─".repeat(width + 4)}╯`;
    const empty = ` │${" ".repeat(width + 4)}│`;

    const gradientLine = (text: string): string => {
      let output = "";
      for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (char === " ") {
          output += char;
          continue;
        }

        const ratio = i / Math.max(1, text.length - 1);
        const red = Math.round(79 + ratio * (6 - 79));
        const green = Math.round(70 + ratio * (182 - 70));
        const blue = Math.round(229 + ratio * (212 - 229));
        output += `\x1b[38;2;${red};${green};${blue}m${char}`;
      }

      return `${output}\x1b[0m`;
    };

    console.error();
    console.error(gradientLine(top));
    console.error(gradientLine(empty));
    for (const line of art) {
      const padded = ` │  ${line}${" ".repeat(width - line.length)}  │`;
      console.error(gradientLine(padded));
    }
    console.error(gradientLine(empty));
    console.error(gradientLine(bottom));
    console.error();
    console.error(" \x1b[38;2;6;182;212m🐾 Panther Proxy\x1b[0m \x1b[90mv0.1.0\x1b[0m");
    console.error(" \x1b[32m\x1b[1m🚀 Proxy ready\x1b[0m");
    console.error(` \x1b[36m⚡ Listening on:\x1b[0m  http://localhost:${port}${path}`);
    console.error();
  }

  /**
   * Forward a tool call to the selected server.
   * @pk
   */
  private async forwardToolCall(params: CallToolRequest["params"], user: UserContext): Promise<CallToolResult> {
    const { serverName, toolName } = fromProxyToolName(params.name);
    const server = this.serverByName.get(serverName);
    if (!server) {
      return new ResponseController().deny(`Unknown MCP server "${serverName}"`);
    }

    return server.callTool(
      {
        ...params,
        name: toolName,
      },
      user,
    );
  }

  /**
   * Resolve the user context from the incoming request.
   * @pk
   */
  private async resolveUser(req: IncomingMessage): Promise<UserContext> {
    if (typeof this.userResolver === "function") {
      return this.userResolver(req);
    }

    return this.userResolver ?? {};
  }
}

/**
 * Prefix tool descriptions with the server name.
 * @pk
 */
function annotateDescription(serverName: string, description: string | undefined): string {
  return description ? `[${serverName}] ${description}` : `Proxied from ${serverName}`;
}

/**
 * Send a JSON-RPC error response.
 * @pk
 */
function sendJsonRpcError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
  res.writeHead(httpStatus, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Send a plain text response.
 * @pk
 */
function sendText(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain", ...headers });
  res.end(body);
}

/**
 * Get a safe error message for logging.
 * @pk
 */
function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
