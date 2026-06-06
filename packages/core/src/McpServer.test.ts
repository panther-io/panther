import { describe, expect, it, vi } from "vitest";
import type { CallToolRequest, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "./McpServer.js";
import type { Isolation, PanterTransport } from "./types.js";

class EnvAwareTransport implements PanterTransport {
  readonly callToolMock = vi.fn(async (params: CallToolRequest["params"], env: Record<string, string>): Promise<CallToolResult> => {
    return { content: [{ type: "text", text: `${params.name}:${env.TOKEN ?? "none"}` }] };
  });
  readonly close = vi.fn(async () => undefined);
  readonly children: EnvAwareTransport[];

  constructor(
    readonly env: Record<string, string> = {},
    children?: EnvAwareTransport[],
  ) {
    this.children = children ?? [];
  }

  withEnv(env: Record<string, string>): EnvAwareTransport {
    const child = new EnvAwareTransport({ ...this.env, ...env }, this.children);
    this.children.push(child);
    return child;
  }

  async listTools(): Promise<ListToolsResult> {
    return { tools: [{ name: "read", inputSchema: { type: "object" } }] };
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    return this.callToolMock(params, this.env);
  }
}

describe("McpServer", () => {
  it("reuses per-user env-aware upstream transports for identical resolved stdio auth env", async () => {
    const transport = new EnvAwareTransport();
    const server = new McpServer({
      name: "github",
      transport,
      env: (user) => ({ TOKEN: String(user.tokens?.github ?? "none") }),
    });

    await expect(server.callTool({ name: "read" }, { id: "alice", tokens: { github: "alice-token" } })).resolves.toMatchObject({
      content: [{ text: "read:alice-token" }],
    });
    await server.callTool({ name: "write" }, { id: "alice", tokens: { github: "alice-token" } });
    await server.callTool({ name: "read" }, { id: "bob", tokens: { github: "bob-token" } });

    expect(transport.children).toHaveLength(2);
    expect(transport.children[0]?.callToolMock).toHaveBeenCalledTimes(2);
    expect(transport.children[1]?.callToolMock).toHaveBeenCalledTimes(1);
  });

  it("queues isolated stdio upstream calls by user identity", async () => {
    const transport = new EnvAwareTransport();
    const isolation: Isolation = {
      queue: vi.fn(async (_userId, fn) => fn()),
      close: vi.fn(async () => undefined),
    };
    const server = new McpServer({
      name: "github",
      transport,
      isolation,
    });

    await server.callTool({ name: "read" }, { id: "alice" });
    await server.callTool({ name: "read" }, { id: "bob" });
    await server.callTool({ name: "read" }, {});

    expect(isolation.queue).toHaveBeenNthCalledWith(1, "alice", expect.any(Function), undefined);
    expect(isolation.queue).toHaveBeenNthCalledWith(2, "bob", expect.any(Function), undefined);
    expect(isolation.queue).toHaveBeenNthCalledWith(3, "anonymous", expect.any(Function), undefined);
  });
});
