import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CallToolRequest, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import {
  PantherAuth,
  Policy,
  approval,
  group,
  http,
  mcp,
  panther,
  policy,
  rateLimit,
  sse,
  stdio,
  user,
  zodInput,
} from "./index.js";
import type { PanterTransport } from "./types.js";

class MemoryTransport implements PanterTransport {
  readonly callTool = vi.fn(async (params: CallToolRequest["params"]): Promise<CallToolResult> => ({
    content: [{ type: "text", text: JSON.stringify(params) }],
  }));

  async listTools(): Promise<ListToolsResult> {
    return {
      tools: [
        { name: "create_issue", inputSchema: { type: "object" } },
        { name: "delete_repo", inputSchema: { type: "object" } },
      ],
    };
  }

  async close(): Promise<void> {}
}

describe("high-level proxy DX", () => {
  it("supports panther factory, direct transport registration, zod input, rate limits, and new operation names", async () => {
    const transport = new MemoryTransport();
    const proxy = panther({
      groups: [
        group({
          id: "admins",
          users: [user("alice", { email: "alice@example.com", tenant: { id: "acme" } })],
          policy: Policy.allowAll("admins"),
        }),
      ],
      defaults: { autoLog: true },
    });
    const seen: unknown[] = [];

    proxy.server("github", transport);
    proxy.use(rateLimit.fixedWindow({ limit: 1, windowMs: 60_000, key: (ctx) => `${ctx.subject?.id}:${ctx.tool?.name}` }));
    proxy.use((ctx, next) => {
      seen.push({
        operation: ctx.operation,
        subject: ctx.subject?.id,
        email: ctx.subject?.email,
        tenant: ctx.subject?.tenant,
        canDelete: ctx.policy.can("github", "delete_repo"),
      });
      return next();
    });
    proxy.server("github").tool("create_issue", zodInput(z.object({ title: z.string().min(3) })));
    proxy.server("github").tool("create_issue", (ctx, next) => {
      ctx.args.title = `[${ctx.subject?.tenant?.id}] ${ctx.args.title}`;
      return next();
    });

    const ok = await proxy.callTool({ name: "github__create_issue", arguments: { title: "Bug" } }, { id: "alice" });
    const limited = await proxy.callTool({ name: "github__create_issue", arguments: { title: "Bug" } }, { id: "alice" });

    expect(ok.isError).toBeUndefined();
    expect(limited.isError).toBe(true);
    expect(seen).toEqual([
      {
        operation: "tools/call",
        subject: "alice",
        email: "alice@example.com",
        tenant: { id: "acme" },
        canDelete: true,
      },
    ]);
    expect(transport.callTool).toHaveBeenCalledWith({
      name: "create_issue",
      arguments: { title: "[acme] Bug" },
    });
  });

  it("supports approval.manual as a route middleware", async () => {
    const proxy = panther({
      servers: [],
      groups: [group({ id: "admins", users: [user("alice")], policy: policy("admins").server("github").allow("*") })],
    });

    proxy.server("github", new MemoryTransport());
    proxy.server("github").tool("delete_repo", approval.manual({ reason: "Needs approval" }));

    const result = await proxy.callTool({ name: "github__delete_repo" }, { id: "alice" });

    expect(result).toMatchObject({ isError: true, content: [{ text: "Needs approval" }] });
  });

  it("creates mcp and exposure helper objects", () => {
    expect(mcp.stdio({ command: "github-mcp-server" })).toMatchObject({ __pantherMcpTransport: true });
    expect(mcp.http({ url: "https://mcp.example.test/mcp" })).toMatchObject({ __pantherMcpTransport: true });
    expect(mcp.sse({ url: "https://mcp.example.test/sse" })).toMatchObject({ __pantherMcpTransport: true });
    expect(http({ port: 3000, path: "/mcp" })).toBeTruthy();
    expect(sse({ port: 3001, path: "/sse" })).toBeTruthy();
    expect(stdio({ subject: "alice" })).toBeTruthy();
  });

  it("loads PantherAuth synchronously and exposes apiKey, bearer, and env helpers", async () => {
    const auth = await createAuth({
      users: {
        alice: {
          apiKeys: ["alice-key"],
          credentials: { "github.token": "user-token" },
        },
      },
      groups: {},
      defaults: { "linear.token": "default-token" },
    });
    const subject = {
      id: "alice",
      groups: [],
      hasGroup: () => false,
    };

    expect(auth.apiKey({ header: "x-panther-api-key" }).resolve({ headers: { "x-panther-api-key": "alice-key" } })).toEqual({ id: "alice" });
    expect(auth.env({ GITHUB_TOKEN: "github.token" })({ id: "alice", __pantherSubject: subject })).toEqual({ GITHUB_TOKEN: "user-token" });
    await expect(Promise.resolve(auth.bearer("linear.token").bearerToken?.({ user: { id: "alice" } }))).resolves.toBe("default-token");
  });
});

async function createAuth(credentials: Parameters<typeof PantherAuth.encryptCredentials>[0]): Promise<PantherAuth> {
  const dir = await mkdtemp(join(tmpdir(), "panther-dx-auth-"));
  const key = "test-key";
  await writeFile(join(dir, "credentials.enc.json"), JSON.stringify(PantherAuth.encryptCredentials(credentials, key)));
  await writeFile(join(dir, "upstream-auth.json"), JSON.stringify({ servers: {} }));
  return PantherAuth.local({ dir, key });
}
