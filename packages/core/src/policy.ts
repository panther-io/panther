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
export function filterToolsByPolicy<TTool extends { name: string }>(
  tools: TTool[],
  serverName: string,
  policy: Policy,
): TTool[] {
  const permissions = policy.getPermissions(serverName);
  return tools.filter((tool) => isToolAllowedByPermissions(permissions, unproxyToolName(tool.name, serverName)));
}

function findMatchingPermission(permissions: ToolPermission[], toolName: string): ToolPermission | undefined {
  return getToolPermission(permissions, toolName);
}

/**
 * Return the effective permission for a tool, preferring exact matches over wildcard permissions.
 * @pk
 */
export function getToolPermission(permissions: ToolPermission[], toolName: string): ToolPermission | undefined {
  return (
    permissions.find((permission) => permission.tool === toolName) ??
    permissions.find((permission) => permission.tool === "*")
  );
}

/**
 * Check whether a tool is allowed by a permission set.
 * @pk
 */
export function isToolAllowedByPermissions(permissions: ToolPermission[], toolName: string): boolean {
  const permission = getToolPermission(permissions, toolName);
  return permission?.effect !== "deny" && Boolean(permission);
}

function unproxyToolName(toolName: string, serverName: string): string {
  const prefix = `${serverName}__`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}
