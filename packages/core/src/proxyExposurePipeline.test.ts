import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpProxy } from "./McpProxy.js";
import { McpServer } from "./McpServer.js";
import type { McpUpstreamNotificationHandler, ProxyExposureHandle, ProxyExposureTransport, ProxyRuntime } from "./types.js";
import type {
  CallToolRequest,
  CallToolResult,
  CompleteRequest,
  CompleteResult,
  GetPromptRequest,
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { PanterTransport } from "./types.js";

class MockTransport implements PanterTransport {
  readonly callTool = vi.fn(async (params: CallToolRequest["params"]): Promise<CallToolResult> => {
    return { content: [{ type: "text", text: `called:${params.name}` }] };
  });

  readonly listTools = vi.fn(async (): Promise<ListToolsResult> => {
    return { tools: [{ name: "read", inputSchema: { type: "object" } }] };
  });

  readonly listResources = vi.fn(async (): Promise<ListResourcesResult> => {
    return { resources: [{ uri: "file:///readme.md", name: "readme" }] };
  });

  readonly readResource = vi.fn(async (params: ReadResourceRequest["params"]): Promise<ReadResourceResult> => {
    return { contents: [{ uri: params.uri, text: "readme" }] };
  });

  readonly listResourceTemplates = vi.fn(async (): Promise<ListResourceTemplatesResult> => {
    return { resourceTemplates: [{ uriTemplate: "file:///{path}", name: "file" }] };
  });

  readonly listPrompts = vi.fn(async (): Promise<ListPromptsResult> => {
    return { prompts: [{ name: "summarize", arguments: [{ name: "topic" }] }] };
  });

  readonly getPrompt = vi.fn(async (params: GetPromptRequest["params"]): Promise<GetPromptResult> => {
    return { messages: [{ role: "user", content: { type: "text", text: `prompt:${params.name}` } }] };
  });

  readonly complete = vi.fn(async (params: CompleteRequest["params"]): Promise<CompleteResult> => {
    return { completion: { values: [`complete:${"name" in params.ref ? params.ref.name : params.ref.uri}`] } };
  });

  async close(): Promise<void> {}
}

class SubscribableTransport extends MockTransport {
  private readonly notificationHandlers = new Set<McpUpstreamNotificationHandler>();

  readonly subscribeResource = vi.fn(async (): Promise<{ _meta?: Record<string, unknown> }> => ({}));
  readonly unsubscribeResource = vi.fn(async (): Promise<{ _meta?: Record<string, unknown> }> => ({}));
  readonly cancelRequest = vi.fn(async (): Promise<void> => {});

  onNotification(handler: McpUpstreamNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  async emitResourceUpdated(uri: string): Promise<void> {
    await Promise.all([...this.notificationHandlers].map((handler) => handler({ type: "resources:updated", uri })));
  }

  async emitProgress(progressToken: string | number, progress: number): Promise<void> {
    await Promise.all([...this.notificationHandlers].map((handler) => handler({ type: "progress", progressToken, progress })));
  }

  async emitListChanged(type: "tools:list-changed" | "resources:list-changed" | "prompts:list-changed"): Promise<void> {
    await Promise.all([...this.notificationHandlers].map((handler) => handler({ type })));
  }
}

class ControlledToolTransport extends SubscribableTransport {
  private resolveCall: ((value: CallToolResult) => void) | undefined;

  readonly callTool = vi.fn(async (): Promise<CallToolResult> => {
    return new Promise<CallToolResult>((resolve) => {
      this.resolveCall = resolve;
    });
  });

  finish(result: CallToolResult = { content: [{ type: "text", text: "done" }] }): void {
    this.resolveCall?.(result);
  }
}

class ToolOnlyTransport implements PanterTransport {
  readonly callTool = vi.fn(async (): Promise<CallToolResult> => {
    return { content: [{ type: "text", text: "ok" }] };
  });

  readonly listTools = vi.fn(async (): Promise<ListToolsResult> => {
    return { tools: [] };
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

class SessionUtilityProbeExposure implements ProxyExposureTransport<SessionUtilityProbeHandle> {
  async listen(runtime: ProxyRuntime): Promise<SessionUtilityProbeHandle> {
    const first = runtime.sessionUtilities.ensure("session-a");
    const second = runtime.sessionUtilities.ensure("session-b");

    first.resourceSubscriptions.add("panther://resources/github/a");
    first.activeRequests.set("request-a", {
      downstreamRequestId: "request-a",
      upstreamRequestId: "upstream-a",
      progressToken: "progress-a",
      cancelled: false,
      startedAt: 1,
    });
    first.progressTokens.set("upstream-a", "progress-a");
    first.cancellations.add("request-a");
    first.logLevel = "debug";

    second.resourceSubscriptions.add("panther://resources/github/b");
    second.logLevel = "warning";

    return {
      first,
      second,
      size: () => runtime.sessionUtilities.size(),
      close: async () => {
        runtime.sessionUtilities.delete("session-a");
        runtime.sessionUtilities.delete("session-b");
      },
    };
  }
}

type SessionUtilityProbeHandle = ProxyExposureHandle & {
  first: ReturnType<ProxyRuntime["sessionUtilities"]["ensure"]>;
  second: ReturnType<ProxyRuntime["sessionUtilities"]["ensure"]>;
  size(): number;
};

class NotificationProbeExposure implements ProxyExposureTransport<NotificationProbeHandle> {
  async listen(runtime: ProxyRuntime): Promise<NotificationProbeHandle> {
    const sent = new Map<string, JSONRPCMessage[]>();
    runtime.sessionUtilities.ensure("session-a");
    runtime.sessionUtilities.ensure("session-b");
    const unregisterA = runtime.registerSessionNotificationSender("session-a", (notification) => {
      sent.set("session-a", [...(sent.get("session-a") ?? []), { jsonrpc: "2.0", ...notification }]);
    });
    const unregisterB = runtime.registerSessionNotificationSender("session-b", (notification) => {
      sent.set("session-b", [...(sent.get("session-b") ?? []), { jsonrpc: "2.0", ...notification }]);
    });

    return {
      sent,
      send: (sessionId, notification) => runtime.sendSessionNotification(sessionId, notification),
      close: async () => {
        unregisterA();
        unregisterB();
        runtime.sessionUtilities.delete("session-a");
        runtime.sessionUtilities.delete("session-b");
      },
    };
  }
}

type NotificationProbeHandle = ProxyExposureHandle & {
  sent: Map<string, JSONRPCMessage[]>;
  send(sessionId: string, notification: { method: string; params?: Record<string, unknown> }): Promise<boolean>;
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
      await expect(handle.client.ping()).resolves.toEqual({});
      expect(handle.client.getServerCapabilities()).toMatchObject({
        tools: {},
        resources: {},
        prompts: {},
        completions: {},
      });
      await expect(handle.client.listResources()).resolves.toMatchObject({
        resources: [{ uri: "panther://resources/github/file%3A%2F%2F%2Freadme.md", name: "readme" }],
      });
      await expect(
        handle.client.readResource({ uri: "panther://resources/github/file%3A%2F%2F%2Freadme.md" }),
      ).resolves.toMatchObject({
        contents: [{ uri: "panther://resources/github/file%3A%2F%2F%2Freadme.md", text: "readme" }],
      });
      await expect(handle.client.listResourceTemplates()).resolves.toMatchObject({
        resourceTemplates: [{ uriTemplate: "panther://resource-templates/github/file%3A%2F%2F%2F%7Bpath%7D" }],
      });
      await expect(handle.client.listPrompts()).resolves.toMatchObject({
        prompts: [{ name: "github__summarize" }],
      });
      await expect(handle.client.getPrompt({ name: "github__summarize" })).resolves.toMatchObject({
        messages: [{ content: { text: "prompt:summarize" } }],
      });
      await expect(
        handle.client.complete({
          ref: { type: "ref/prompt", name: "github__summarize" },
          argument: { name: "topic", value: "m" },
        }),
      ).resolves.toMatchObject({
        completion: { values: ["complete:summarize"] },
      });
    }

    expect(seenUsers).toEqual([
      "http-user:github__read",
      "http-user:resources:list",
      "http-user:resource:read",
      "http-user:resource-templates:list",
      "http-user:prompts:list",
      "http-user:prompt:get",
      "http-user:completion:complete",
      "stdio-user:github__read",
      "stdio-user:resources:list",
      "stdio-user:resource:read",
      "stdio-user:resource-templates:list",
      "stdio-user:prompts:list",
      "stdio-user:prompt:get",
      "stdio-user:completion:complete",
      "sse-user:github__read",
      "sse-user:resources:list",
      "sse-user:resource:read",
      "sse-user:resource-templates:list",
      "sse-user:prompts:list",
      "sse-user:prompt:get",
      "sse-user:completion:complete",
    ]);
    await proxy.close();
  });

  it("hides downstream server feature capabilities for tool-only upstream transports", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new ToolOnlyTransport() })],
    });
    const handle = await proxy.listen(new PipelineProbeExposure("tool-only", "user"));

    expect(handle.client.getServerCapabilities()).toMatchObject({ tools: {} });
    expect(handle.client.getServerCapabilities()).not.toHaveProperty("resources");
    expect(handle.client.getServerCapabilities()).not.toHaveProperty("prompts");
    expect(handle.client.getServerCapabilities()).not.toHaveProperty("completions");

    await proxy.close();
  });

  it("keeps downstream session utility state isolated and removes it on close", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
    });
    const handle = await proxy.listen(new SessionUtilityProbeExposure());

    expect(handle.size()).toBe(2);
    expect([...handle.first.resourceSubscriptions]).toEqual(["panther://resources/github/a"]);
    expect([...handle.second.resourceSubscriptions]).toEqual(["panther://resources/github/b"]);
    expect(handle.first.activeRequests.get("request-a")).toMatchObject({
      downstreamRequestId: "request-a",
      upstreamRequestId: "upstream-a",
      progressToken: "progress-a",
    });
    expect(handle.second.activeRequests.size).toBe(0);
    expect(handle.first.progressTokens.get("upstream-a")).toBe("progress-a");
    expect(handle.first.cancellations.has("request-a")).toBe(true);
    expect(handle.first.logLevel).toBe("debug");
    expect(handle.second.logLevel).toBe("warning");

    await proxy.close();

    expect(handle.size()).toBe(0);
  });

  it("routes downstream MCP notifications to the selected session sender", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
    });
    const handle = await proxy.listen(new NotificationProbeExposure());

    await expect(handle.send("session-b", { method: "notifications/tools/list_changed" })).resolves.toBe(true);
    await expect(handle.send("missing", { method: "notifications/tools/list_changed" })).resolves.toBe(false);

    expect(handle.sent.get("session-a")).toBeUndefined();
    expect(handle.sent.get("session-b")).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      },
    ]);

    await proxy.close();
  });

  it("coalesces resource subscriptions and routes updates only to subscribed sessions", async () => {
    const upstream = new SubscribableTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: upstream })],
    });
    const handle = await proxy.listen(new NotificationProbeExposure());
    const proxyUri = "panther://resources/github/file%3A%2F%2F%2Freadme.md";

    await proxy.subscribeResource({ uri: proxyUri }, {}, undefined, undefined, "session-a");
    await proxy.subscribeResource({ uri: proxyUri }, {}, undefined, undefined, "session-b");

    expect(upstream.subscribeResource).toHaveBeenCalledTimes(1);
    expect(upstream.subscribeResource).toHaveBeenCalledWith({ uri: "file:///readme.md" });

    await upstream.emitResourceUpdated("file:///readme.md");

    expect(handle.sent.get("session-a")).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: proxyUri },
      },
    ]);
    expect(handle.sent.get("session-b")).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: proxyUri },
      },
    ]);

    handle.sent.clear();
    await proxy.unsubscribeResource({ uri: proxyUri }, {}, undefined, undefined, "session-a");
    expect(upstream.unsubscribeResource).not.toHaveBeenCalled();

    await upstream.emitResourceUpdated("file:///readme.md");
    expect(handle.sent.get("session-a")).toBeUndefined();
    expect(handle.sent.get("session-b")).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: proxyUri },
      },
    ]);

    await proxy.unsubscribeResource({ uri: proxyUri }, {}, undefined, undefined, "session-b");
    expect(upstream.unsubscribeResource).toHaveBeenCalledTimes(1);
    expect(upstream.unsubscribeResource).toHaveBeenCalledWith({ uri: "file:///readme.md" });

    await proxy.close();
  });

  it("rejects resource subscriptions when the owning upstream does not support them", async () => {
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: new MockTransport() })],
    });

    await expect(
      proxy.subscribeResource(
        { uri: "panther://resources/github/file%3A%2F%2F%2Freadme.md" },
        {},
        undefined,
        undefined,
        "session-a",
      ),
    ).rejects.toThrow(/resource subscriptions/);
  });

  it("forwards upstream list-change notifications without upstream-only names or URIs", async () => {
    const upstream = new SubscribableTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: upstream })],
    });
    const handle = await proxy.listen(new NotificationProbeExposure());

    await upstream.emitListChanged("tools:list-changed");
    await upstream.emitListChanged("resources:list-changed");
    await upstream.emitListChanged("prompts:list-changed");

    const expected = [
      { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
      { jsonrpc: "2.0", method: "notifications/resources/list_changed" },
      { jsonrpc: "2.0", method: "notifications/prompts/list_changed" },
    ];
    expect(handle.sent.get("session-a")).toEqual(expected);
    expect(handle.sent.get("session-b")).toEqual(expected);
    expect(JSON.stringify(handle.sent.get("session-a"))).not.toContain("file:///readme.md");
    expect(JSON.stringify(handle.sent.get("session-a"))).not.toContain("read");

    await proxy.close();
  });

  it("forwards progress to the originating session and ignores it after cleanup", async () => {
    const upstream = new ControlledToolTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: upstream })],
    });
    const handle = await proxy.listen(new NotificationProbeExposure());

    const result = proxy.callTool(
      { name: "github__read", _meta: { progressToken: "progress-a" } } as never,
      {},
      undefined,
      undefined,
      "session-a",
      "request-a",
    );
    await vi.waitFor(() => expect(upstream.callTool).toHaveBeenCalled());
    await upstream.emitProgress("progress-a", 0.5);

    expect(handle.sent.get("session-a")).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: "progress-a", progress: 0.5 },
      },
    ]);
    expect(handle.sent.get("session-b")).toBeUndefined();

    upstream.finish();
    await expect(result).resolves.toMatchObject({ content: [{ text: "done" }] });
    handle.sent.clear();
    await upstream.emitProgress("progress-a", 1);
    expect(handle.sent.size).toBe(0);

    await proxy.close();
  });

  it("marks active requests cancelled, forwards cancellation upstream, and drops late results", async () => {
    const upstream = new ControlledToolTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: upstream })],
    });
    await proxy.listen(new NotificationProbeExposure());

    const result = proxy.callTool(
      { name: "github__read" },
      {},
      undefined,
      undefined,
      "session-a",
      "request-a",
    );
    await vi.waitFor(() => expect(upstream.callTool).toHaveBeenCalled());
    await (proxy as unknown as { cancelDownstreamRequest(sessionId: string, requestId: string, reason: string, user: object): Promise<void> })
      .cancelDownstreamRequest("session-a", "request-a", "no longer needed", {});
    upstream.finish();

    await expect(result).resolves.toMatchObject({
      isError: true,
      _meta: { error: { code: -32800 } },
    });
    expect(upstream.cancelRequest).toHaveBeenCalledWith("request-a", "no longer needed");

    await proxy.close();
  });

  it("returns timeout errors and cleans active request progress state", async () => {
    const upstream = new ControlledToolTransport();
    const proxy = new McpProxy({
      servers: [new McpServer({ name: "github", transport: upstream })],
      requestTimeoutMs: 1,
    });
    const handle = await proxy.listen(new NotificationProbeExposure());

    const result = await proxy.callTool(
      { name: "github__read", _meta: { progressToken: "progress-timeout" } } as never,
      {},
      undefined,
      undefined,
      "session-a",
      "request-timeout",
    );

    expect(result).toMatchObject({
      isError: true,
      _meta: { error: { message: "MCP request timed out after 1ms" } },
    });
    await upstream.emitProgress("progress-timeout", 1);
    expect(handle.sent.size).toBe(0);

    await proxy.close();
  });
});
