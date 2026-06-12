import type { ProxyContext, ProxyOperationHandler, ProxyToolHandler, ProxyToolPattern } from "../types/proxy.js";
import type { Middleware } from "../types/middleware.js";
import type { ToolCallRequest } from "../types/mcp-operation.js";

export type CompiledToolPattern = {
  original: string;
  server?: RegExp;
  tool: RegExp;
  scopedServer?: string;
};

export type RouteEntry = {
  kind: "middleware" | "tool" | "operation";
  scopeServer?: string;
  scopeGroup?: string;
  operation?: ProxyContext["operation"];
  pattern?: CompiledToolPattern;
  handler: Middleware | ProxyToolHandler | ProxyOperationHandler;
};

export function compileToolPattern(pattern: ProxyToolPattern, scopedServer?: string): CompiledToolPattern {
  if (!pattern.trim()) {
    throw new Error("Tool pattern cannot be empty");
  }
  if (pattern.includes("__")) {
    throw new Error(`Tool pattern "${pattern}" must use public dot notation, not internal "__" names`);
  }

  const parts = pattern.split(".");
  if (scopedServer) {
    if (parts.length > 2) {
      throw new Error(`Invalid server-scoped tool pattern "${pattern}"`);
    }
    if (parts.length === 2 && parts[0] !== scopedServer && parts[0] !== "*") {
      throw new Error(`Server-scoped tool pattern "${pattern}" cannot target server "${parts[0]}" from handle "${scopedServer}"`);
    }
    const tool = parts.length === 2 ? parts[1] : parts[0];
    validatePatternSegment(tool, "tool", pattern);
    return {
      original: pattern,
      scopedServer,
      tool: wildcardRegex(tool),
    };
  }

  if (parts.length !== 2) {
    throw new Error(`Tool pattern "${pattern}" must use "server.tool" dot notation`);
  }

  const [server, tool] = parts;
  validatePatternSegment(server, "server", pattern);
  validatePatternSegment(tool, "tool", pattern);
  return {
    original: pattern,
    server: wildcardRegex(server),
    tool: wildcardRegex(tool),
  };
}

function validatePatternSegment(segment: string | undefined, label: string, pattern: string): asserts segment is string {
  if (!segment) {
    throw new Error(`Invalid ${label} segment in tool pattern "${pattern}"`);
  }
}

export function matchesToolPattern(pattern: CompiledToolPattern, request: ToolCallRequest): boolean {
  if (pattern.scopedServer && pattern.scopedServer !== request.serverName) {
    return false;
  }
  if (pattern.server && !pattern.server.test(request.serverName)) {
    return false;
  }
  return pattern.tool.test(request.toolName);
}

function wildcardRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}
