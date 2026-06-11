import type { CompleteRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fromProxyPromptName, fromProxyResourceTemplateUri } from "../nameMapping.js";
import type { ProxyContext } from "../types/proxy.js";
import type { ToolCallRequest, ProxyOperationResult } from "../types/mcp-operation.js";

export function routeCompletion(params: CompleteRequest["params"]): {
  serverName: string;
  params: CompleteRequest["params"];
} {
  if (params.ref.type === "ref/prompt") {
    const { serverName, promptName } = fromProxyPromptName(params.ref.name);
    return {
      serverName,
      params: {
        ...params,
        ref: {
          ...params.ref,
          name: promptName,
        },
      },
    };
  }

  const { serverName, uriTemplate } = fromProxyResourceTemplateUri(params.ref.uri);
  return {
    serverName,
    params: {
      ...params,
      ref: {
        ...params.ref,
        uri: uriTemplate,
      },
    },
  };
}

export function completionTarget(params: CompleteRequest["params"]): string {
  return params.ref.type === "ref/prompt" ? params.ref.name : params.ref.uri;
}

export function capabilityToolRequest(context: ProxyContext): ToolCallRequest {
  return {
    serverName: context.server?.name ?? "",
    toolName: context.operation,
    proxyToolName: context.operation,
    arguments: undefined,
    raw: { name: context.operation },
  };
}

export function isStructuredPolicyErrorResult(result: ProxyOperationResult): result is CallToolResult {
  return "isError" in result && result.isError === true && Boolean(result._meta?.error);
}

export function toStructuredError(error: unknown): { code?: number; message?: string } | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return error as { code?: number; message?: string };
}
