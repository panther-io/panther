import { describe, expect, it, vi } from "vitest";
import { HttpTransport } from "./HttpTransport.js";

describe("HttpTransport", () => {
  it("posts listTools requests over HTTP with auth headers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ tools: [] }));
    const transport = new HttpTransport({
      baseUrl: "https://mcp.example/api",
      authToken: "secret",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await transport.listTools({ cursor: "next" });

    expect(result).toEqual({ tools: [] });
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://mcp.example/api/listTools"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({ params: { cursor: "next" } }),
    });
  });

  it("posts callTool requests and returns the upstream result", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
    const transport = new HttpTransport({
      baseUrl: "https://mcp.example/api/",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await transport.callTool({ name: "search", arguments: { q: "panther" } });

    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://mcp.example/api/callTool"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ params: { name: "search", arguments: { q: "panther" } } }),
    });
  });
});

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => value,
  } as Response;
}
