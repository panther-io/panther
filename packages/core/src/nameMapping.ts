/**
 * Naming helpers for MCP proxy tool names.
 * @pk
 */

const SEPARATOR = "__";

/**
 * Validate that a server name is safe to use in proxied tool names.
 * @pk
 */
export function assertValidServerName(name: string): void {
  if (!name.trim()) {
    throw new Error("MCP server name cannot be empty");
  }

  if (name.includes(SEPARATOR)) {
    throw new Error(`MCP server name "${name}" cannot include "${SEPARATOR}"`);
  }
}

/**
 * Combine server and tool names into a proxied tool name.
 * @pk
 */
export function toProxyToolName(serverName: string, toolName: string): string {
  assertValidServerName(serverName);
  return `${serverName}${SEPARATOR}${toolName}`;
}

/**
 * Split a proxied tool name into server and tool parts.
 * @pk
 */
export function fromProxyToolName(proxyToolName: string): {
  serverName: string;
  toolName: string;
} {
  const index = proxyToolName.indexOf(SEPARATOR);
  if (index <= 0 || index === proxyToolName.length - SEPARATOR.length) {
    throw new Error(`Invalid proxied tool name "${proxyToolName}". Expected "<server>${SEPARATOR}<tool>".`);
  }

  return {
    serverName: proxyToolName.slice(0, index),
    toolName: proxyToolName.slice(index + SEPARATOR.length),
  };
}
