import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { CallToolRequest, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import {
  Group,
  McpProxy,
  McpServer,
  PantherAuth,
  Policy,
  User,
  allow,
  apiKeyIdentityStrategy,
  group,
  policy,
  sensitive,
  user,
} from "./index.js";
import type { PanterTransport } from "./types.js";

class EnvTransport implements PanterTransport {
  readonly env: Record<string, string>;
  readonly callToolMock = vi.fn(async (params: CallToolRequest["params"], env: Record<string, string>): Promise<CallToolResult> => ({
    content: [{ type: "text", text: `${params.name}:${env.AUTHORIZATION ?? env.GITHUB_TOKEN ?? env["x-api-key"] ?? "none"}` }],
  }));

  constructor(env: Record<string, string> = {}) {
    this.env = env;
  }

  withEnv(env: Record<string, string>): EnvTransport {
    return new EnvTransport({ ...this.env, ...env });
  }

  async listTools(): Promise<ListToolsResult> {
    return {
      tools: [
        { name: "read", inputSchema: { type: "object" } },
        { name: "write", inputSchema: { type: "object" } },
        { name: "delete", inputSchema: { type: "object" } },
      ],
    };
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    return this.callToolMock(params, this.env);
  }

  async close(): Promise<void> {}
}

describe("governance auth DX", () => {
  it("declares users and groups, resolves multi-group subjects, and validates conflicts", async () => {
    const alice = user("alice", { displayName: "Alice", tenantId: "tenant-1", metadata: { role: "admin" } });
    const admins = group({ id: "admins", users: [alice], policy: Policy.allowAll("admins") });
    const auditors = group({ id: "auditors", users: [alice], policy: Policy.allowAll("auditors") });
    const proxy = new McpProxy({
      groups: [admins, auditors],
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });
    let seenGroups: string[] = [];

    proxy.use((_, ctx, next) => {
      seenGroups = ctx.subject?.groups.map((membership) => membership.id) ?? [];
      expect(ctx.subject?.hasGroup("admins")).toBe(true);
      expect(ctx.subject?.tenant).toEqual({ id: "tenant-1" });
      return next();
    });

    await proxy.callTool({ name: "github__read" }, { id: "alice" });
    expect(seenGroups).toEqual(["admins", "auditors"]);

    expect(
      () =>
        new McpProxy({
          groups: [
            group({ id: "first", users: [user("alice", { displayName: "Alice" })], policy: Policy.allowAll() }),
            group({ id: "second", users: [user("alice", { displayName: "Other Alice" })], policy: Policy.allowAll() }),
          ],
          servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
        }),
    ).toThrow(/conflicting metadata/);

    await expect(proxy.callTool({ name: "github__read" }, { id: "unknown" })).rejects.toThrow(/not declared/);
    expect(() => new Group({ id: "empty", users: [], policy: Policy.allowAll() })).toThrow(/at least one user/);
  });

  it("applies fluent group policies with wildcard allows, denies, approval, limiter, and sensitive metadata", async () => {
    const limiter = {
      metadata: { maxPerWindow: 1 },
      checkLimit: vi.fn(async () => true),
      recordCall: vi.fn(async () => undefined),
      getRemainingCalls: vi.fn(async () => 1),
    };
    const approval = vi.fn(async () => true);
    const allowPolicy = policy("writers")
      .server("github")
      .allow("*", { limiter, metadata: { scope: "repo" }, ...sensitive({ reason: "destructive" }) })
      .server("github")
      .deny("delete");
    const denyPolicy = policy("blocked").server("github").deny("write");
    const proxy = new McpProxy({
      groups: [
        group({ id: "writers", users: [user("alice")], policy: allowPolicy }),
        group({ id: "blocked", users: [user("alice")], policy: denyPolicy }),
        group({ id: "approvers", users: [user("alice")], policy: policy("approvers").server("github").allow("read", { approval }) }),
      ],
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });

    const tools = await proxy.listTools(undefined, { id: "alice" });
    expect(tools.tools.map((tool) => tool.name)).toEqual(["github__read"]);

    await proxy.callTool({ name: "github__read" }, { id: "alice" });
    expect(approval).toHaveBeenCalledOnce();

    const denied = await proxy.callTool({ name: "github__write" }, { id: "alice" });
    expect(denied.isError).toBe(true);
    expect(denied._meta?.error).toMatchObject({ message: expect.stringMatching(/denied/) });
  });

  it("loads encrypted local auth, resolves API keys, and keeps raw keys out of context", async () => {
    const auth = await createAuth({
      users: {
        alice: {
          apiKeys: ["old-key", "new-key"],
          credentials: { "github.token": "user-token" },
        },
      },
      groups: {},
      defaults: {},
    });
    const strategy = apiKeyIdentityStrategy({ auth });

    await expect(Promise.resolve(strategy.resolve({ headers: { "x-panther-api-key": "old-key" } }))).resolves.toEqual({ id: "alice" });
    await expect(Promise.resolve(strategy.resolve({ headers: { "x-panther-api-key": "new-key" } }))).resolves.toEqual({ id: "alice" });
    await expect(Promise.resolve(strategy.resolve({ headers: { "x-panther-api-key": "bad-key" } }))).resolves.toBeNull();
  });

  it("resolves credential precedence and injects upstream auth without exposing secrets", async () => {
    const auth = await createAuth({
      users: {
        alice: { apiKeys: ["key"], credentials: { "github.token": "user-token" } },
        bob: { apiKeys: ["bob-key"], credentials: {} },
        carol: { apiKeys: ["carol-key"], credentials: {} },
      },
      groups: {
        developers: { "github.token": "group-token" },
      },
      defaults: { "github.token": "default-token" },
    });
    const transport = new EnvTransport();
    const proxy = new McpProxy({
      auth,
      groups: [
        group({ id: "developers", users: [user("alice"), user("bob")], policy: Policy.allowAll("developers") }),
        group({ id: "guests", users: [user("carol")], policy: Policy.allowAll("guests") }),
      ],
      servers: [new McpServer({ name: "github", transport })],
    });
    const seen: Array<{ userSecret?: unknown; credentialReference?: string }> = [];

    proxy.use((_, ctx, next) => {
      seen.push({
        userSecret: ctx.user.secrets,
        credentialReference: ctx.credentialSources?.[0]?.reference,
      });
      return next();
    });

    await expect(proxy.callTool({ name: "github__read" }, { id: "alice" })).resolves.toMatchObject({
      content: [{ text: "read:Bearer user-token" }],
    });
    await expect(proxy.callTool({ name: "github__read" }, { id: "bob" })).resolves.toMatchObject({
      content: [{ text: "read:Bearer group-token" }],
    });
    await expect(proxy.callTool({ name: "github__read" }, { id: "carol" })).resolves.toMatchObject({
      content: [{ text: "read:Bearer default-token" }],
    });
    expect(seen).toEqual([
      { userSecret: undefined, credentialReference: "github.token" },
      { userSecret: undefined, credentialReference: "github.token" },
      { userSecret: undefined, credentialReference: "github.token" },
    ]);
  });

  it("reports local auth validation and missing credential errors without secret values", async () => {
    await expect(createAuth({ users: {}, groups: {}, defaults: {} }, { servers: { github: { type: "unknown" } } })).rejects.toThrow(
      /Invalid upstream auth bindings file/,
    );

    const auth = await createAuth({ users: { alice: { apiKeys: ["key"], credentials: {} } }, groups: {}, defaults: {} });
    const proxy = new McpProxy({
      auth,
      groups: [group({ id: "users", users: [new User("alice")], policy: Policy.allowAll("users") })],
      servers: [new McpServer({ name: "github", transport: new EnvTransport() })],
    });
    const result = await proxy.callTool({ name: "github__read" }, { id: "alice" });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("github.token");
    expect(JSON.stringify(result)).not.toContain("key");
  });

  it("supports permission helper objects", () => {
    expect(allow("read", { metadata: { scope: "repo" } })).toMatchObject({ tool: "read", effect: "allow" });
    expect(policy("named").server("github").allow("read").name).toBe("named");
  });
});

async function createAuth(
  credentials: Parameters<typeof PantherAuth.encryptCredentials>[0],
  upstreamAuth: unknown = { servers: { github: { type: "bearer", credential: "github.token" } } },
): Promise<PantherAuth> {
  const dir = await mkdtemp(join(tmpdir(), "panther-auth-"));
  const key = "test-key";
  await writeFile(join(dir, "credentials.enc.json"), JSON.stringify(PantherAuth.encryptCredentials(credentials, key)));
  await writeFile(join(dir, "upstream-auth.json"), JSON.stringify(upstreamAuth));
  return PantherAuth.local({ dir, key });
}
