import { describe, expect, it, vi } from "vitest";
import type {
  CallToolRequest,
  CallToolResult,
  CompleteRequest,
  CompleteResult,
  GetPromptRequest,
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "./McpServer.js";
import type { Isolation, PanterTransport } from "./types.js";

class EnvAwareTransport implements PanterTransport {
  readonly callToolMock = vi.fn(async (params: CallToolRequest["params"], env: Record<string, string>): Promise<CallToolResult> => {
    return { content: [{ type: "text", text: `${params.name}:${env.TOKEN ?? "none"}` }] };
  });
  readonly readResourceMock = vi.fn(
    async (params: ReadResourceRequest["params"], env: Record<string, string>): Promise<ReadResourceResult> => {
      return { contents: [{ uri: params.uri, text: `resource:${env.TOKEN ?? "none"}` }] };
    },
  );
  readonly getPromptMock = vi.fn(
    async (params: GetPromptRequest["params"], env: Record<string, string>): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: `${params.name}:${env.TOKEN ?? "none"}` },
          },
        ],
      };
    },
  );
  readonly completeMock = vi.fn(
    async (params: CompleteRequest["params"], env: Record<string, string>): Promise<CompleteResult> => {
      return { completion: { values: [`${params.argument.name}:${env.TOKEN ?? "none"}`] } };
    },
  );
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

  async listResources(): Promise<ListResourcesResult> {
    return { resources: [{ uri: "file:///readme.md", name: `resource:${this.env.TOKEN ?? "none"}` }] };
  }

  async readResource(params: ReadResourceRequest["params"]): Promise<ReadResourceResult> {
    return this.readResourceMock(params, this.env);
  }

  async listPrompts(): Promise<ListPromptsResult> {
    return { prompts: [{ name: `prompt:${this.env.TOKEN ?? "none"}` }] };
  }

  async getPrompt(params: GetPromptRequest["params"]): Promise<GetPromptResult> {
    return this.getPromptMock(params, this.env);
  }

  async complete(params: CompleteRequest["params"]): Promise<CompleteResult> {
    return this.completeMock(params, this.env);
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

  it("applies per-user env-aware transports to non-tool operations", async () => {
    const transport = new EnvAwareTransport();
    const server = new McpServer({
      name: "github",
      transport,
      env: (user) => ({ TOKEN: String(user.tokens?.github ?? "none") }),
    });
    const user = { id: "alice", tokens: { github: "alice-token" } };

    await expect(server.listResources(undefined, user)).resolves.toMatchObject({
      resources: [{ name: "resource:alice-token" }],
    });
    await expect(server.readResource({ uri: "file:///readme.md" }, user)).resolves.toMatchObject({
      contents: [{ text: "resource:alice-token" }],
    });
    await expect(server.listPrompts(undefined, user)).resolves.toMatchObject({
      prompts: [{ name: "prompt:alice-token" }],
    });
    await expect(server.getPrompt({ name: "summarize" }, user)).resolves.toMatchObject({
      messages: [{ content: { text: "summarize:alice-token" } }],
    });
    await expect(
      server.complete(
        {
          ref: { type: "ref/prompt", name: "summarize" },
          argument: { name: "topic", value: "m" },
        },
        user,
      ),
    ).resolves.toMatchObject({ completion: { values: ["topic:alice-token"] } });

    expect(transport.children).toHaveLength(1);
    expect(transport.children[0]?.readResourceMock).toHaveBeenCalledOnce();
    expect(transport.children[0]?.getPromptMock).toHaveBeenCalledOnce();
    expect(transport.children[0]?.completeMock).toHaveBeenCalledOnce();
  });

  it("returns empty lists and unsupported errors for missing optional server features", async () => {
    const transport: PanterTransport = {
      listTools: vi.fn(async () => ({ tools: [] })),
      callTool: vi.fn(async () => ({ content: [] })),
      close: vi.fn(async () => undefined),
    };
    const server = new McpServer({ name: "github", transport });

    await expect(server.listResources()).resolves.toEqual({ resources: [] });
    await expect(server.listResourceTemplates()).resolves.toEqual({ resourceTemplates: [] });
    await expect(server.listPrompts()).resolves.toEqual({ prompts: [] });
    await expect(server.readResource({ uri: "file:///readme.md" })).rejects.toThrow(/does not support resources/);
    await expect(server.getPrompt({ name: "summarize" })).rejects.toThrow(/does not support prompts/);
    await expect(
      server.complete({
        ref: { type: "ref/prompt", name: "summarize" },
        argument: { name: "topic", value: "m" },
      }),
    ).rejects.toThrow(/does not support completions/);
  });
});
