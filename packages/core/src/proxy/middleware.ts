import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolCallRequest, ProxyOperationResult } from "../types/mcp-operation.js";
import type { Middleware, LegacyMiddleware, ProxyMiddleware } from "../types/middleware.js";
import type { ProxyContext, ProxyToolHandler, ProxyOperationHandler } from "../types/proxy.js";

export function isLegacyMiddleware(handler: Middleware | ProxyToolHandler): handler is LegacyMiddleware {
  return handler.length >= 3;
}

export function isLikelyLegacyTwoArgMiddlewareError(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }

  return /reading '(res|deny|fail|continue|inject|error|user|subject|identity|log|policy|policyDecision|credentialSources)'/.test(error.message);
}

export async function dispatchRouteHandler(
  handler: Middleware | ProxyToolHandler | ProxyOperationHandler,
  request: ToolCallRequest,
  context: ProxyContext,
  next: () => Promise<ProxyOperationResult>,
): Promise<ProxyOperationResult | void> {
  if (isLegacyMiddleware(handler as Middleware | ProxyToolHandler)) {
    return (handler as LegacyMiddleware)(request, context, next as () => Promise<CallToolResult>);
  }

  try {
    return await (handler as ProxyMiddleware)(context, next);
  } catch (error) {
    if (handler.length === 2 && isLikelyLegacyTwoArgMiddlewareError(error)) {
      return (handler as unknown as LegacyMiddleware)(request, context, next as () => Promise<CallToolResult>);
    }

    throw error;
  }
}
