import type {
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { FentarisTransport } from "../../types/transport.js";

/**
 * Options for HTTP transport.
 * @pk
 */
export type HttpTransportOptions = {
  baseUrl: string;
  headers?: Record<string, string>;
  authToken?: string;
  fetch?: typeof fetch;
};

/**
 * HTTP-based MCP transport adapter.
 * @pk
 */
export class HttpTransport implements FentarisTransport {
  private readonly options: HttpTransportOptions;
  private readonly fetchImpl: typeof fetch;

  /**
   * Create a new HTTP transport.
   * @pk
   */
  constructor(options: HttpTransportOptions) {
    if (!options.baseUrl.trim()) {
      throw new Error("HttpTransport baseUrl cannot be empty");
    }

    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * Return a copy with env-derived headers merged in.
   * @pk
   */
  withEnv(env: Record<string, string>): HttpTransport {
    const authorization = env.AUTHORIZATION ?? env.AUTH_TOKEN;
    return new HttpTransport({
      ...this.options,
      headers: {
        ...this.options.headers,
        ...env,
        ...(authorization ? { authorization } : {}),
      },
    });
  }

  async listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult> {
    return this.post<ListToolsResult>("listTools", { params });
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    return this.post<CallToolResult>("callTool", { params });
  }

  async close(): Promise<void> {
    return undefined;
  }

  private async post<TResult>(method: "listTools" | "callTool", body: unknown): Promise<TResult> {
    const response = await this.fetchImpl(new URL(method, ensureTrailingSlash(this.options.baseUrl)), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.options.headers,
        ...(this.options.authToken ? { authorization: `Bearer ${this.options.authToken}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP transport request failed with status ${response.status}`);
    }

    return response.json() as Promise<TResult>;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
