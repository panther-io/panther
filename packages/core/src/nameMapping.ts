/**
 * Naming helpers for MCP proxy names and resource URIs.
 * @pk
 */

const SEPARATOR = "__";
const RESOURCE_URI_PREFIX = "panther://resources";
const RESOURCE_TEMPLATE_URI_PREFIX = "panther://resource-templates";

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
  const { serverName, upstreamName } = fromProxyName(proxyToolName, "tool");
  return { serverName, toolName: upstreamName };
}

/**
 * Combine server and prompt names into a proxied prompt name.
 * @pk
 */
export function toProxyPromptName(serverName: string, promptName: string): string {
  return toProxyName(serverName, promptName, "prompt");
}

/**
 * Split a proxied prompt name into server and upstream prompt parts.
 * @pk
 */
export function fromProxyPromptName(proxyPromptName: string): {
  serverName: string;
  promptName: string;
} {
  const { serverName, upstreamName } = fromProxyName(proxyPromptName, "prompt");
  return { serverName, promptName: upstreamName };
}

/**
 * Build a Panther-owned URI for routing a proxied MCP resource.
 * @pk
 */
export function toProxyResourceUri(serverName: string, uri: string): string {
  return toProxyUri(RESOURCE_URI_PREFIX, serverName, uri, "resource URI");
}

/**
 * Parse a Panther-owned resource URI back to its upstream owner and URI.
 * @pk
 */
export function fromProxyResourceUri(proxyUri: string): {
  serverName: string;
  uri: string;
} {
  const { serverName, upstreamValue } = fromProxyUri(RESOURCE_URI_PREFIX, proxyUri, "resource URI");
  return { serverName, uri: upstreamValue };
}

/**
 * Build a Panther-owned URI template for routing a proxied MCP resource template.
 * @pk
 */
export function toProxyResourceTemplateUri(serverName: string, uriTemplate: string): string {
  return toProxyUri(RESOURCE_TEMPLATE_URI_PREFIX, serverName, uriTemplate, "resource template URI");
}

/**
 * Parse a Panther-owned resource template URI back to its upstream owner and template.
 * @pk
 */
export function fromProxyResourceTemplateUri(proxyUriTemplate: string): {
  serverName: string;
  uriTemplate: string;
} {
  const { serverName, upstreamValue } = fromProxyUri(
    RESOURCE_TEMPLATE_URI_PREFIX,
    proxyUriTemplate,
    "resource template URI",
  );
  return { serverName, uriTemplate: upstreamValue };
}

function toProxyName(serverName: string, upstreamName: string, kind: string): string {
  assertValidServerName(serverName);
  if (!upstreamName.trim()) {
    throw new Error(`MCP ${kind} name cannot be empty`);
  }

  return `${serverName}${SEPARATOR}${upstreamName}`;
}

function fromProxyName(proxyName: string, kind: string): {
  serverName: string;
  upstreamName: string;
} {
  const index = proxyName.indexOf(SEPARATOR);
  if (index <= 0 || index === proxyName.length - SEPARATOR.length) {
    throw new Error(`Invalid proxied ${kind} name "${proxyName}". Expected "<server>${SEPARATOR}<${kind}>".`);
  }

  const serverName = proxyName.slice(0, index);
  assertValidServerName(serverName);
  return {
    serverName,
    upstreamName: proxyName.slice(index + SEPARATOR.length),
  };
}

function toProxyUri(prefix: string, serverName: string, upstreamValue: string, kind: string): string {
  assertValidServerName(serverName);
  if (!upstreamValue.trim()) {
    throw new Error(`MCP ${kind} cannot be empty`);
  }

  return `${prefix}/${encodeURIComponent(serverName)}/${encodeURIComponent(upstreamValue)}`;
}

function fromProxyUri(prefix: string, proxyValue: string, kind: string): {
  serverName: string;
  upstreamValue: string;
} {
  const expectedPrefix = `${prefix}/`;
  if (!proxyValue.startsWith(expectedPrefix)) {
    throw new Error(`Invalid proxied ${kind} "${proxyValue}". Expected "${expectedPrefix}<server>/<encoded>".`);
  }

  const rest = proxyValue.slice(expectedPrefix.length);
  const separatorIndex = rest.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === rest.length - 1) {
    throw new Error(`Invalid proxied ${kind} "${proxyValue}". Expected "${expectedPrefix}<server>/<encoded>".`);
  }

  const extraSeparatorIndex = rest.indexOf("/", separatorIndex + 1);
  if (extraSeparatorIndex !== -1) {
    throw new Error(`Invalid proxied ${kind} "${proxyValue}". Encoded value must not contain raw path separators.`);
  }

  try {
    const serverName = decodeURIComponent(rest.slice(0, separatorIndex));
    const upstreamValue = decodeURIComponent(rest.slice(separatorIndex + 1));
    assertValidServerName(serverName);
    if (!upstreamValue.trim()) {
      throw new Error(`MCP ${kind} cannot be empty`);
    }

    return { serverName, upstreamValue };
  } catch (error) {
    if (error instanceof URIError) {
      throw new Error(`Invalid proxied ${kind} "${proxyValue}". Encoded segments are malformed.`, { cause: error });
    }

    throw error;
  }
}
