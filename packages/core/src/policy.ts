import type {
  Policy,
  PolicyDecision,
  ToolCallRequest,
  ToolPermission,
} from "./types.js";
import type { UserContext } from "./types.js";

/**
 * Default policy implementation with RBAC-style permissions.
 * @pk
 */
export class SimplePolicy implements Policy {
  readonly name: string;
  readonly description?: string;
  private readonly permissionsByServer: Map<string, ToolPermission[]>;
  readonly metadata?: Policy["metadata"];

  /**
   * Create a new policy.
   * @pk
   */
  constructor(options: {
    name: string;
    description?: string;
    permissions: Record<string, ToolPermission[]>;
    metadata?: Policy["metadata"];
  }) {
    this.name = options.name;
    this.description = options.description;
    this.metadata = options.metadata;
    this.permissionsByServer = new Map(Object.entries(options.permissions));
  }

  /**
   * Get permissions for a server.
   * @pk
   */
  getPermissions(serverName: string): ToolPermission[] {
    return this.permissionsByServer.get(serverName) ?? [];
  }

  /**
   * Evaluate if a tool call is allowed.
   * @pk
   */
  async evaluate(request: ToolCallRequest, user: UserContext): Promise<PolicyDecision> {
    const permissions = this.getPermissions(request.serverName);

    // Check for wildcard permission
    const wildcardPerm = permissions.find((p) => p.tool === "*");
    if (wildcardPerm) {
      return { allowed: true };
    }

    // Check for specific tool permission
    const toolPerm = permissions.find((p) => p.tool === request.toolName);
    if (!toolPerm) {
      return { allowed: false, reason: `Tool "${request.toolName}" not permitted on server "${request.serverName}"` };
    }

    // Check approval if required
    if (toolPerm.approval) {
      const approved = await toolPerm.approval(request, { user, log: null as any, res: null as any });
      if (!approved) {
        return { allowed: false, reason: "Approval required but not granted" };
      }
    }

    return { allowed: true, metadata: toolPerm.metadata };
  }
}

/**
 * Filter tools by policy.
 * @pk
 */
export function filterToolsByPolicy(
  tools: Array<{ name: string }>,
  serverName: string,
  policy: Policy,
): Array<{ name: string }> {
  const permissions = policy.getPermissions(serverName);

  // If wildcard, return all
  if (permissions.some((p) => p.tool === "*")) {
    return tools;
  }

  // Filter to only permitted tools
  const permitted = new Set(permissions.map((p) => p.tool));
  return tools.filter((tool) => permitted.has(tool.name));
}
