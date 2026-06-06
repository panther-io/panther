import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpTransport } from "./HttpTransport.js";
import { SseMcpTransport } from "./SseMcpTransport.js";
import { StreamableHttpMcpTransport } from "./StreamableHttpMcpTransport.js";
import { MissingHttpTransportCredentialError } from "../transportAuth.js";

const fakes = vi.hoisted(() => {
  const clientInstances: FakeClient[] = [];
  const streamableTransports: FakeStreamableTransport[] = [];
  const sseTransports: FakeSseTransport[] = [];

  class FakeClient {
    readonly close = vi.fn(async () => undefined);
    readonly connect = vi.fn(async (transport: unknown) => {
      this.transport = transport;
    });
    transport: unknown;

    constructor(
      readonly clientInfo: unknown,
      readonly options: unknown,
    ) {
      clientInstances.push(this);
    }

    getServerCapabilities(): { tools: object } {
      return { tools: {} };
    }

    async listTools(params: unknown): Promise<unknown> {
      return { tools: [{ name: `listed:${JSON.stringify(params ?? {})}`, inputSchema: { type: "object" } }] };
    }

    async callTool(params: unknown): Promise<unknown> {
      return { content: [{ type: "text", text: `called:${JSON.stringify(params)}` }] };
    }
  }

  class FakeStreamableTransport {
    readonly close = vi.fn(async () => undefined);

    constructor(
      readonly url: URL,
      readonly options: { requestInit?: RequestInit },
    ) {
      streamableTransports.push(this);
    }
  }

  class FakeSseTransport {
    readonly close = vi.fn(async () => undefined);

    constructor(
      readonly url: URL,
      readonly options: { requestInit?: RequestInit },
    ) {
      sseTransports.push(this);
    }
  }

  return {
    FakeClient,
    FakeStreamableTransport,
    FakeSseTransport,
    clientInstances,
    streamableTransports,
    sseTransports,
  };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: fakes.FakeClient,
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: fakes.FakeStreamableTransport,
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: fakes.FakeSseTransport,
}));

describe("native MCP upstream transports", () => {
  beforeEach(() => {
    fakes.clientInstances.length = 0;
    fakes.streamableTransports.length = 0;
    fakes.sseTransports.length = 0;
  });

  it("lists tools over native Streamable HTTP with resolved auth headers", async () => {
    const transport = new StreamableHttpMcpTransport({
      url: "http://mcp.example/mcp",
      auth: {
        headers: { "x-static": "1" },
        bearerToken: ({ user }) => user.tokens?.github,
      },
    }).withUser({ tokens: { github: "token" } });

    await expect(transport.listTools({ cursor: "next" })).resolves.toMatchObject({
      tools: [{ name: 'listed:{"cursor":"next"}' }],
    });
    expect(fakes.streamableTransports[0]?.url.href).toBe("http://mcp.example/mcp");
    expect(fakes.streamableTransports[0]?.options.requestInit?.headers).toEqual({
      "x-static": "1",
      authorization: "Bearer token",
    });
  });

  it("calls tools over native HTTPS Streamable HTTP and closes client resources", async () => {
    const transport = new StreamableHttpMcpTransport({ url: "https://mcp.example/mcp" });

    await expect(transport.callTool({ name: "search", arguments: { q: "panther" } })).resolves.toMatchObject({
      content: [{ text: 'called:{"name":"search","arguments":{"q":"panther"}}' }],
    });
    await transport.close();

    expect(fakes.streamableTransports[0]?.url.protocol).toBe("https:");
    expect(fakes.clientInstances[0]?.close).toHaveBeenCalledOnce();
    expect(fakes.streamableTransports[0]?.close).toHaveBeenCalledOnce();
  });

  it("lists and calls tools over native SSE with shared auth", async () => {
    const transport = new SseMcpTransport({
      url: "https://mcp.example/sse",
      auth: {
        apiKey: { header: "x-api-key", resolve: ({ user }) => user.secrets?.apiKey },
      },
    }).withUser({ secrets: { apiKey: "secret" } });

    await expect(transport.listTools()).resolves.toMatchObject({ tools: [{ name: "listed:{}" }] });
    await expect(transport.callTool({ name: "read" })).resolves.toMatchObject({
      content: [{ text: 'called:{"name":"read"}' }],
    });
    await transport.close();

    expect(fakes.sseTransports[0]?.options.requestInit?.headers).toEqual({ "x-api-key": "secret" });
    expect(fakes.sseTransports[0]?.close).toHaveBeenCalledOnce();
  });

  it("fails before upstream requests when required credentials are missing", async () => {
    const transport = new SseMcpTransport({
      url: "https://mcp.example/sse",
      auth: {
        apiKey: { header: "x-api-key", resolve: ({ user }) => user.secrets?.apiKey },
      },
    }).withUser({ secrets: {} });

    await expect(transport.listTools()).rejects.toBeInstanceOf(MissingHttpTransportCredentialError);
    expect(fakes.sseTransports).toHaveLength(0);
  });

  it("keeps the simple REST-like HttpTransport distinct from native MCP Streamable HTTP", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ tools: [] }) }) as Response);
    const transport = new HttpTransport({ baseUrl: "https://api.example/simple", fetch: fetchMock as unknown as typeof fetch });

    await transport.listTools();

    expect(fetchMock).toHaveBeenCalledWith(new URL("https://api.example/simple/listTools"), expect.any(Object));
    expect(fakes.streamableTransports).toHaveLength(0);
  });
});
