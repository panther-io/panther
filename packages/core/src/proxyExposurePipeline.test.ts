import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpProxy } from "./McpProxy.js";
import { McpServer } from "./McpServer.js";
import type { ProxyExposureHandle, ProxyExposureTransport, ProxyRuntime } from "./types.js";
import type { CallToolRequest, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { PanterTransport } from "./types.js";

class MockTransport implements PanterTransport {
  readonly callTool = vi.fn(async (params: CallToolRequest["params"]): Promise<CallToolResult> => {
    return { content: [{ type: "text", text: `called:${params.name}` }] };
  });

  readonly listTools = vi.fn(async (): Promise<ListToolsResult> => {
    return { tools: [{ name: "read", inputSchema: { type: "object" } }] };
  });

  async close(): Promise<void> {}
}

class InMemoryTransport implements Transport {
  peer?: InMemoryTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

class PipelineProbeExposure implements ProxyExposureTransport<PipelineProbeHandle> {
  constructor(
    private readonly label: string,
    private readonly userId: string,
  ) {}

  async listen(runtime: ProxyRuntime): Promise<PipelineProbeHandle> {
    const clientTransport = new InMemoryTransport();
    const serverTransport = new InMemoryTransport();
    clientTransport.peer = serverTransport;
    serverTransport.peer = clientTransport;

    const sdkServer = runtime.createSdkServer({ id: this.userId }) as { connect(transport: Transport): Promise<void>; close(): Promise<void> };
    const client = new Client({ name: `probe-${this.label}`, version: "0.1.0" }, { capabilities: {} });

    await sdkServer.connect(serverTransport);
    await client.connect(clientTransport);

    return {
      client,
      close: async () => {
        await client.close();
        await sdkServer.close();
      },
    };
  }
}

type PipelineProbeHandle = ProxyExposureHandle & {
  client: Client;
};

describe("proxy exposure pipeline", () => {
  it("uses the same listTools and callTool pipeline for HTTP, stdio, and SSE exposure transports", async () => {
    const upstream = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: upstream })],
    });
    const seenUsers: string[] = [];

    proxy.use((request, context, next) => {
      seenUsers.push(`${context.user.id}:${request.proxyToolName}`);
      return next();
    });

    const handles = await Promise.all([
      proxy.listen(new PipelineProbeExposure("http", "http-user")),
      proxy.listen(new PipelineProbeExposure("stdio", "stdio-user")),
      proxy.listen(new PipelineProbeExposure("sse", "sse-user")),
    ]);

    for (const handle of handles) {
      await expect(handle.client.listTools()).resolves.toMatchObject({
        tools: [{ name: "github__read" }],
      });
      await expect(handle.client.callTool({ name: "github__read" })).resolves.toMatchObject({
        content: [{ text: "called:read" }],
      });
    }

    expect(seenUsers).toEqual(["http-user:github__read", "stdio-user:github__read", "sse-user:github__read"]);
    await proxy.close();
  });
});
