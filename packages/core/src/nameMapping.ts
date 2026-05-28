const SEPARATOR = "__";

export function assertValidServerName(name: string): void {
  if (!name.trim()) {
    throw new Error("MCP server name cannot be empty");
  }

  if (name.includes(SEPARATOR)) {
    throw new Error(`MCP server name "${name}" cannot include "${SEPARATOR}"`);
  }
}

export function toProxyToolName(serverName: string, toolName: string): string {
  assertValidServerName(serverName);
  return `${serverName}${SEPARATOR}${toolName}`;
}

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
