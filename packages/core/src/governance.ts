import type {
  MiddlewareContext,
  Policy as PolicyContract,
  PolicyDecision,
  ResolvedSubject,
  SubjectMetadata,
  ToolCallRequest,
  ToolPermission,
  UserContext,
} from "./types.js";
import { getToolPermission } from "./policy.js";

/**
 * First-class non-sensitive subject declaration.
 * @pk
 */
export class User {
  readonly id: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly tenantId?: string;
  readonly tenant?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;

  constructor(id: string, metadata: SubjectMetadata = {}) {
    if (!id.trim()) {
      throw new Error("User id cannot be empty");
    }

    this.id = id;
    this.displayName = metadata.displayName;
    this.email = metadata.email;
    this.tenantId = metadata.tenantId;
    this.tenant = metadata.tenant;
    this.metadata = metadata.metadata;
  }
}

/**
 * First-class group declaration that owns users and policy.
 * @pk
 */
export class Group {
  readonly id: string;
  readonly name?: string;
  readonly users: User[];
  readonly policy: PolicyContract;
  readonly metadata?: Record<string, unknown>;

  constructor(options: {
    id: string;
    name?: string;
    users: User[];
    policy: PolicyContract;
    metadata?: Record<string, unknown>;
  }) {
    if (!options.id.trim()) {
      throw new Error("Group id cannot be empty");
    }
    if (options.users.length === 0) {
      throw new Error(`Group "${options.id}" must include at least one user`);
    }

    this.id = options.id;
    this.name = options.name;
    this.users = [...options.users];
    this.policy = options.policy;
    this.metadata = options.metadata;
  }
}

/**
 * Fluent policy declaration.
 * @pk
 */
export class Policy implements PolicyContract {
  readonly name: string;
  readonly description?: string;
  readonly metadata?: PolicyContract["metadata"];
  private readonly permissionsByServer = new Map<string, ToolPermission[]>();

  constructor(options: { name: string; description?: string; metadata?: PolicyContract["metadata"] }) {
    if (!options.name.trim()) {
      throw new Error("Policy name cannot be empty");
    }

    this.name = options.name;
    this.description = options.description;
    this.metadata = options.metadata;
  }

  /**
   * Create an allow-all policy.
   * @pk
   */
  static allowAll(name = "allow-all"): Policy {
    return new Policy({ name }).server("*").allow("*");
  }

  /**
   * Select a server for fluent permission declarations.
   * @pk
   */
  server(serverName: string): PolicyServerBuilder {
    return new PolicyServerBuilder(this, serverName);
  }

  /**
   * Add an allow permission.
   * @pk
   */
  allow(serverName: string, toolName: string, options: ToolPermissionOptions = {}): this {
    return this.addPermission(serverName, { ...toToolPermission(toolName, options), effect: "allow" });
  }

  /**
   * Add a deny permission.
   * @pk
   */
  deny(serverName: string, toolName: string, options: ToolPermissionOptions = {}): this {
    return this.addPermission(serverName, { ...toToolPermission(toolName, options), effect: "deny" });
  }

  getPermissions(serverName: string): ToolPermission[] {
    return [
      ...(this.permissionsByServer.get(serverName) ?? []),
      ...(serverName === "*" ? [] : this.permissionsByServer.get("*") ?? []),
    ];
  }

  async evaluate(
    request: ToolCallRequest,
    user: UserContext,
    context?: MiddlewareContext,
  ): Promise<PolicyDecision> {
    const permission = getToolPermission(this.getPermissions(request.serverName), request.toolName);
    if (!permission) {
      return this.decision(false, request, user, undefined, "not-permitted");
    }

    if (permission.effect === "deny") {
      return this.decision(false, request, user, permission, `Tool "${request.toolName}" denied by policy "${this.name}"`);
    }

    if (permission.approval) {
      if (!context) {
        return this.decision(false, request, user, permission, "Approval requires middleware context");
      }

      const approved = await permission.approval(request, context);
      if (!approved) {
        return this.decision(false, request, user, permission, "Approval required but not granted");
      }
    }

    return this.decision(true, request, user, permission);
  }

  private addPermission(serverName: string, permission: ToolPermission): this {
    const existing = this.permissionsByServer.get(serverName) ?? [];
    this.permissionsByServer.set(serverName, [...existing, permission]);
    return this;
  }

  private decision(
    allowed: boolean,
    request: ToolCallRequest,
    user: UserContext,
    permission?: ToolPermission,
    reason?: string,
  ): PolicyDecision {
    return {
      allowed,
      reason,
      metadata: {
        policyName: this.name,
        matchedPermissions: permission
          ? [
              {
                policyName: this.name,
                serverName: request.serverName,
                toolName: request.toolName,
                effect: permission.effect ?? "allow",
                metadata: permission.metadata,
              },
            ]
          : [],
        denialReason: allowed ? undefined : reason,
        serverName: request.serverName,
        toolName: request.toolName,
        userId: user.id,
        permission: permission?.metadata,
        limiter: permission?.limiter,
        effect: permission?.effect ?? (allowed ? "allow" : "deny"),
      },
    };
  }
}

/**
 * Builder returned by `policy.server(name)`.
 * @pk
 */
export class PolicyServerBuilder {
  constructor(
    private readonly policy: Policy,
    private readonly serverName: string,
  ) {}

  allow(toolName: string, options: ToolPermissionOptions = {}): Policy {
    return this.policy.allow(this.serverName, toolName, options);
  }

  deny(toolName: string, options: ToolPermissionOptions = {}): Policy {
    return this.policy.deny(this.serverName, toolName, options);
  }
}

/**
 * Permission helper options.
 * @pk
 */
export type ToolPermissionOptions = {
  limiter?: ToolPermission["limiter"];
  approval?: ToolPermission["approval"];
  metadata?: Record<string, unknown>;
  sensitive?: boolean | Record<string, unknown>;
};

/**
 * Helper to declare a user.
 * @pk
 */
export function user(id: string, metadata: SubjectMetadata = {}): User {
  return new User(id, metadata);
}

/**
 * Helper to declare a group.
 * @pk
 */
export function group(options: ConstructorParameters<typeof Group>[0]): Group {
  return new Group(options);
}

/**
 * Helper to declare a policy.
 * @pk
 */
export function policy(name: string, options: { description?: string; metadata?: PolicyContract["metadata"] } = {}): Policy {
  return new Policy({ name, ...options });
}

/**
 * Helper to declare an allow permission.
 * @pk
 */
export function allow(toolName: string, options: ToolPermissionOptions = {}): ToolPermission {
  return { ...toToolPermission(toolName, options), effect: "allow" };
}

/**
 * Helper to declare a deny permission.
 * @pk
 */
export function deny(toolName: string, options: ToolPermissionOptions = {}): ToolPermission {
  return { ...toToolPermission(toolName, options), effect: "deny" };
}

/**
 * Helper to declare an allow-all policy.
 * @pk
 */
export function allowAll(name?: string): Policy {
  return Policy.allowAll(name);
}

/**
 * Permission helper for limiters.
 * @pk
 */
export function limit(limiter: ToolPermission["limiter"]): Pick<ToolPermissionOptions, "limiter"> {
  return { limiter };
}

/**
 * Permission helper for approval callbacks.
 * @pk
 */
export function approval(handler: ToolPermission["approval"]): Pick<ToolPermissionOptions, "approval"> {
  return { approval: handler };
}

/**
 * Permission helper for sensitive-operation metadata.
 * @pk
 */
export function sensitive(metadata: Record<string, unknown> = {}): Pick<ToolPermissionOptions, "sensitive"> {
  return { sensitive: metadata };
}

export type SubjectIndex = {
  resolve(userId: string): ResolvedSubject | null;
  groupsFor(userId: string): Group[];
};

export function buildSubjectIndex(groups: Group[]): SubjectIndex {
  const usersById = new Map<string, User>();
  const groupsByUserId = new Map<string, Group[]>();

  for (const group of groups) {
    if (group.users.length === 0) {
      throw new Error(`Group "${group.id}" must include at least one user`);
    }

    for (const user of group.users) {
      const existing = usersById.get(user.id);
      if (existing && !sameUser(existing, user)) {
        throw new Error(`User "${user.id}" has conflicting metadata across groups`);
      }

      usersById.set(user.id, user);
      groupsByUserId.set(user.id, [...(groupsByUserId.get(user.id) ?? []), group]);
    }
  }

  return {
    resolve(userId) {
      const subject = usersById.get(userId);
      const memberships = groupsByUserId.get(userId) ?? [];
      if (!subject || memberships.length === 0) {
        return null;
      }

      const tenant = subject.tenant ?? (subject.tenantId ? { id: subject.tenantId } : undefined);
      return {
        id: subject.id,
        displayName: subject.displayName,
        email: subject.email,
        metadata: subject.metadata,
        tenant,
        groups: memberships.map((membership) => ({
          id: membership.id,
          name: membership.name,
          metadata: membership.metadata,
        })),
        hasGroup(groupId: string): boolean {
          return memberships.some((membership) => membership.id === groupId);
        },
      };
    },
    groupsFor(userId) {
      return groupsByUserId.get(userId) ?? [];
    },
  };
}

export async function evaluateGroupPolicies(
  groups: Group[],
  request: ToolCallRequest,
  user: UserContext,
  context: MiddlewareContext,
): Promise<PolicyDecision> {
  const decisions = await Promise.all(groups.map((group) => group.policy.evaluate(request, user, context)));
  const denied = decisions.find((decision) => !decision.allowed && decision.metadata?.matchedPermissions?.some((permission) => permission.effect === "deny"));
  if (denied) {
    return mergeGroupDecisions(false, groups, decisions, denied.reason ?? "Tool call denied by group policy");
  }

  const allowed = decisions.some((decision) => decision.allowed);
  if (!allowed) {
    return mergeGroupDecisions(false, groups, decisions, `Tool "${request.toolName}" not permitted by effective group policies`);
  }

  return mergeGroupDecisions(true, groups, decisions);
}

export function filterToolsByGroupPolicies<TTool extends { name: string }>(
  tools: TTool[],
  serverName: string,
  groups: Group[],
): TTool[] {
  return tools.filter((tool) => {
    const toolName = unproxyToolName(tool.name, serverName);
    const permissions = groups.flatMap((group) =>
      group.policy.getPermissions(serverName).map((permission) => ({ group, permission })),
    );
    const matches = permissions
      .map(({ group, permission }) => ({ group, permission: permission.tool === toolName || permission.tool === "*" ? permission : undefined }))
      .filter((entry): entry is { group: Group; permission: ToolPermission } => Boolean(entry.permission));

    if (matches.some(({ permission }) => permission.effect === "deny")) {
      return false;
    }

    return matches.some(({ permission }) => permission.effect !== "deny");
  });
}

function mergeGroupDecisions(
  allowed: boolean,
  groups: Group[],
  decisions: PolicyDecision[],
  reason?: string,
): PolicyDecision {
  return {
    allowed,
    reason,
    metadata: {
      policyName: "effective-group-policy",
      matchedGroups: groups.map((group) => group.id),
      matchedPermissions: decisions.flatMap((decision, index) =>
        (decision.metadata?.matchedPermissions ?? []).map((permission) => ({
          ...permission,
          groupId: groups[index]?.id,
        })),
      ),
      denialReason: allowed ? undefined : reason,
    },
  };
}

function toToolPermission(toolName: string, options: ToolPermissionOptions): ToolPermission {
  return {
    tool: toolName,
    limiter: options.limiter,
    approval: options.approval,
    metadata: {
      ...options.metadata,
      ...(options.sensitive
        ? {
            sensitive: options.sensitive === true ? true : options.sensitive,
          }
        : {}),
    },
  };
}

function sameUser(left: User, right: User): boolean {
  return JSON.stringify(sortUser(left)) === JSON.stringify(sortUser(right));
}

function sortUser(user: User): Record<string, unknown> {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    tenantId: user.tenantId,
    tenant: sortRecord(user.tenant),
    metadata: sortRecord(user.metadata),
  };
}

function sortRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function unproxyToolName(toolName: string, serverName: string): string {
  const prefix = `${serverName}__`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}
