import type {
  MiddlewareContext,
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
  async evaluate(
    request: ToolCallRequest,
    user: UserContext,
    context?: MiddlewareContext,
  ): Promise<PolicyDecision> {
    const permissions = this.getPermissions(request.serverName);
    const permission = findMatchingPermission(permissions, request.toolName);

    if (!permission) {
      return this.decision(false, request, user, undefined, {
        reason: `Tool "${request.toolName}" not permitted on server "${request.serverName}"`,
      });
    }

    if (permission.effect === "deny") {
      return this.decision(false, request, user, permission, {
        reason: `Tool "${request.toolName}" denied by policy "${this.name}"`,
      });
    }

    if (permission.approval) {
      if (!context) {
        return this.decision(false, request, user, permission, {
          reason: "Approval requires middleware context",
        });
      }

      const approved = await permission.approval(request, context);
      if (!approved) {
        return this.decision(false, request, user, permission, {
          reason: "Approval required but not granted",
        });
      }
    }

    return this.decision(true, request, user, permission);
  }

  private decision(
    allowed: boolean,
    request: ToolCallRequest,
    user: UserContext,
    permission?: ToolPermission,
    options: { reason?: string } = {},
  ): PolicyDecision {
    return {
      allowed,
      reason: options.reason,
      metadata: {
        policyName: this.name,
        serverName: request.serverName,
        toolName: request.toolName,
        userId: user.id,
        permission: permission?.metadata,
        effect: permission?.effect ?? (allowed ? "allow" : "deny"),
      },
    };
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
  const permitted = new Set(permissions.filter((p) => p.effect !== "deny").map((p) => p.tool));
  return tools.filter((tool) => permitted.has(tool.name));
}

function findMatchingPermission(permissions: ToolPermission[], toolName: string): ToolPermission | undefined {
  return permissions.find((permission) => permission.tool === toolName) ?? permissions.find((permission) => permission.tool === "*");
}
