import type { Group, SubjectIndex } from "../governance.js";
import type { McpServer } from "../server/McpServer.js";
import type { ResolvedSubject, UserContext } from "../types/shared.js";

export type ServerScope =
  | { kind: "global" }
  | { kind: "group"; groupId: string };

export type ServerBinding = {
  server: McpServer;
  scope: ServerScope;
};

export type ServerResolutionContext = {
  user?: UserContext;
  subject?: ResolvedSubject;
  operation?: string;
};

export class ServerCatalog {
  private readonly bindings: ServerBinding[];
  private readonly globalByName = new Map<string, McpServer>();
  private readonly groupBindingsByName = new Map<string, ServerBinding[]>();

  constructor(options: { servers: McpServer[]; groups: Group[]; subjectIndex?: SubjectIndex }) {
    this.bindings = [
      ...options.servers.map((server) => ({ server, scope: { kind: "global" } as const })),
      ...options.groups.flatMap((group) =>
        group.servers.map((server) => ({ server, scope: { kind: "group", groupId: group.id } as const })),
      ),
    ];
    this.validate(options.groups);

    for (const binding of this.bindings) {
      if (binding.scope.kind === "global") {
        this.globalByName.set(binding.server.name, binding.server);
        continue;
      }

      this.groupBindingsByName.set(binding.server.name, [
        ...(this.groupBindingsByName.get(binding.server.name) ?? []),
        binding,
      ]);
    }
  }

  allServers(): McpServer[] {
    return uniqueServers(this.bindings.map((binding) => binding.server));
  }

  addGlobalServer(server: McpServer): void {
    if (this.globalByName.has(server.name)) {
      throw new Error(`Duplicate MCP server name "${server.name}"`);
    }

    const binding = { server, scope: { kind: "global" } as const };
    this.bindings.push(binding);
    this.globalByName.set(server.name, server);
  }

  resolve(context: ServerResolutionContext = {}): ServerBinding[] {
    const subjectGroups = new Set(context.subject?.groups.map((group) => group.id) ?? []);
    const visible = this.bindings.filter((binding) => {
      if (binding.scope.kind === "global") {
        return true;
      }

      return subjectGroups.has(binding.scope.groupId);
    });

    return dedupeBindings(visible, context);
  }

  resolveServer(name: string, context: ServerResolutionContext = {}): ServerBinding | undefined {
    const matches = this.resolve(context).filter((binding) => binding.server.name === name);
    if (matches.length === 0) {
      return undefined;
    }

    return dedupeBindings(matches, context)[0];
  }

  hasServer(name: string): boolean {
    return this.globalByName.has(name) || this.groupBindingsByName.has(name);
  }

  serverForContext(name: string, context: ServerResolutionContext = {}): McpServer | undefined {
    return this.resolveServer(name, context)?.server;
  }

  private validate(groups: Group[]): void {
    const groupIds = new Set(groups.map((group) => group.id));
    const seenGlobal = new Set<string>();
    for (const binding of this.bindings) {
      if (!binding.server.name.trim()) {
        throw new Error("MCP server name cannot be empty");
      }

      if (binding.scope.kind === "global") {
        if (seenGlobal.has(binding.server.name)) {
          throw new Error(`Duplicate MCP server name "${binding.server.name}"`);
        }
        seenGlobal.add(binding.server.name);
        continue;
      }

      if (!groupIds.has(binding.scope.groupId)) {
        throw new Error(`MCP server "${binding.server.name}" references unknown group "${binding.scope.groupId}"`);
      }

      const global = this.bindings.find((candidate) =>
        candidate.scope.kind === "global" && candidate.server.name === binding.server.name,
      );
      if (global && global.server !== binding.server) {
        throw new Error(`Ambiguous MCP server "${binding.server.name}" is declared in both global and group scopes`);
      }
    }

    for (const group of groups) {
      const names = new Set<string>();
      for (const server of group.servers) {
        if (names.has(server.name)) {
          throw new Error(`Duplicate MCP server name "${server.name}" in group "${group.id}"`);
        }
        names.add(server.name);
      }
    }

    for (const left of groups) {
      for (const right of groups) {
        if (left === right || !groupsOverlap(left, right)) {
          continue;
        }

        for (const leftServer of left.servers) {
          const rightServer = right.servers.find((server) => server.name === leftServer.name);
          if (rightServer && rightServer !== leftServer) {
            throw new Error(`Ambiguous MCP server "${leftServer.name}" is declared for overlapping groups "${left.id}" and "${right.id}"`);
          }
        }
      }
    }
  }
}

function groupsOverlap(left: Group, right: Group): boolean {
  const rightUserIds = new Set(right.users.map((user) => user.id));
  return left.users.some((user) => rightUserIds.has(user.id));
}

function dedupeBindings(bindings: ServerBinding[], context: ServerResolutionContext): ServerBinding[] {
  const byName = new Map<string, ServerBinding>();
  for (const binding of bindings) {
    const existing = byName.get(binding.server.name);
    if (!existing) {
      byName.set(binding.server.name, binding);
      continue;
    }

    if (existing.server === binding.server) {
      continue;
    }

    throw new Error(
      `Ambiguous MCP server "${binding.server.name}" for ${describeResolutionContext(context)}; declare unique server names or share the same server instance`,
    );
  }

  return [...byName.values()];
}

function uniqueServers(servers: McpServer[]): McpServer[] {
  const result: McpServer[] = [];
  for (const server of servers) {
    if (!result.includes(server)) {
      result.push(server);
    }
  }
  return result;
}

function describeResolutionContext(context: ServerResolutionContext): string {
  return context.subject?.id ?? context.user?.id ?? context.operation ?? "request context";
}
