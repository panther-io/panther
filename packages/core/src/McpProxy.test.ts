import { describe, expect, it, vi } from "vitest";
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "./logger.js";
import { McpProxy } from "./McpProxy.js";
import { McpServer } from "./McpServer.js";
import { fromProxyToolName, toProxyToolName } from "./nameMapping.js";
import type { LogEntry, LoggerDriver } from "./logger.js";
import type { PanterTransport } from "./types.js";

class MemoryLogDriver implements LoggerDriver {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

class MockTransport implements PanterTransport {
  readonly callTool = vi.fn(async (params: CallToolRequest["params"]): Promise<CallToolResult> => {
    return {
      content: [{ type: "text", text: `called:${params.name}` }],
    };
  });

  readonly listTools = vi.fn(async (): Promise<ListToolsResult> => {
    return {
      tools: [
        {
          name: "create_issue",
          description: "Create an issue",
          inputSchema: { type: "object" },
        },
      ],
    };
  });

  readonly close = vi.fn(async (): Promise<void> => {});
}

describe("proxied tool names", () => {
  it("round-trips server and tool names", () => {
    const proxyName = toProxyToolName("github", "create_issue");

    expect(proxyName).toBe("github__create_issue");
    expect(fromProxyToolName(proxyName)).toEqual({
      serverName: "github",
      toolName: "create_issue",
    });
  });

  it("rejects invalid server names and proxy tool names", () => {
    expect(() => toProxyToolName("bad__server", "tool")).toThrow(/cannot include/);
    expect(() => fromProxyToolName("missing-separator")).toThrow(/Invalid proxied tool name/);
  });
});

describe("McpProxy", () => {
  it("aggregates upstream tools with server namespaces", async () => {
    const githubTransport = new MockTransport();
    const notionTransport = new MockTransport();
    const proxy = new McpProxy({
      servers: [
        new McpServer({ name: "github", transport: githubTransport }),
        new McpServer({ name: "notion", displayName: "Notion API", transport: notionTransport }),
      ],
    });

    const result = await proxy.listTools();

    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((tool) => tool.name)).toEqual(["github__create_issue", "notion__create_issue"]);
    expect(result.tools[1]?.title).toBe("Notion API: create_issue");
    expect(result.tools[1]?.description).toBe("[Notion API] Create an issue");
  });

  it("routes namespaced tool calls to the original upstream tool name", async () => {
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    const result = await proxy.callTool({
      name: "github__create_issue",
      arguments: { title: "Bug" },
    });

    expect(result.content).toEqual([{ type: "text", text: "called:create_issue" }]);
    expect(transport.callTool).toHaveBeenCalledWith({
      name: "create_issue",
      arguments: { title: "Bug" },
    });
  });

  it("runs middleware before forwarding a tool call", async () => {
    const transport = new MockTransport();
    const driver = new MemoryLogDriver();
    const proxy = new McpProxy({
      logger: new Logger({ level: "debug", driver }),
      user: { id: "user-1" },
      servers: [new McpServer({ name: "github", transport })],
    });
    const seen: string[] = [];

    proxy.use(async (req, ctx, next) => {
      seen.push(`${ctx.user.id}:${req.serverName}:${req.toolName}`);
      ctx.log.info("observed");
      return next();
    });

    const result = await proxy.callTool({ name: "github__create_issue" }, { id: "user-1" });

    expect(result.isError).toBeUndefined();
    expect(seen).toEqual(["user-1:github:create_issue"]);
    expect(transport.callTool).toHaveBeenCalledOnce();
    expect(driver.entries[0]).toMatchObject({
      level: "info",
      message: "observed",
      context: {
        userId: "user-1",
        serverName: "github",
        toolName: "create_issue",
        proxyToolName: "github__create_issue",
      },
    });
  });

  it("lets middleware deny a tool call without touching the upstream", async () => {
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "prod-db", transport })],
    });

    proxy.use((_, ctx) => {
      return ctx.res.deny("blocked");
    });

    const result = await proxy.callTool({ name: "prod-db__drop_table" });

    expect(result).toEqual({
      content: [{ type: "text", text: "blocked" }],
      isError: true,
    });
    expect(transport.callTool).not.toHaveBeenCalled();
  });

  it("continues when middleware returns nothing", async () => {
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    proxy.use(() => undefined);

    const result = await proxy.callTool({ name: "github__create_issue" });

    expect(result.content).toEqual([{ type: "text", text: "called:create_issue" }]);
    expect(transport.callTool).toHaveBeenCalledOnce();
  });

  it("returns a tool error for unknown upstream servers", async () => {
    const transport = new MockTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport })],
    });

    const result = await proxy.callTool({ name: "notion__read_page" });

    expect(result).toEqual({
      content: [{ type: "text", text: 'Unknown MCP server "notion"' }],
      isError: true,
    });
    expect(transport.callTool).not.toHaveBeenCalled();
  });

  it("rejects duplicate server names", () => {
    expect(
      () =>
        new McpProxy({
          servers: [
            new McpServer({ name: "github", transport: new MockTransport() }),
            new McpServer({ name: "github", transport: new MockTransport() }),
          ],
        }),
    ).toThrow(/Duplicate MCP server name/);
  });
});
