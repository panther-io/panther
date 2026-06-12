import { buildSubjectIndex, type Group, type SubjectIndex } from "../governance/index.js";
import type { McpServer } from "../server/index.js";
import type { McpProxyOptions } from "../proxy/McpProxy.js";
import type { CredentialSourceMap } from "../credentials/index.js";

export type ResolvedFentarisServerBinding =
  | { server: McpServer; scope: { kind: "global" } }
  | { server: McpServer; scope: { kind: "group"; groupId: string } };

export type ResolvedFentarisConfig = McpProxyOptions & {
  servers: McpServer[];
  groups: Group[];
  defaults: {
    credentials: CredentialSourceMap;
  };
  subjectIndex?: SubjectIndex;
  serverBindings: ResolvedFentarisServerBinding[];
};

/**
 * Internal resolver only. The public API intentionally exposes input config and diagnostics, not this runtime shape.
 */
export function resolveFentarisConfig(config: McpProxyOptions): ResolvedFentarisConfig {
  const servers = [...(config.servers ?? [])];
  const groups = [...(config.groups ?? [])];
  const defaults = {
    credentials: { ...(config.defaults?.credentials ?? {}) },
  };
  const subjectIndex = groups.length > 0 ? buildSubjectIndex(groups) : undefined;
  const serverBindings: ResolvedFentarisServerBinding[] = [
    ...servers.map((server) => ({ server, scope: { kind: "global" } as const })),
    ...groups.flatMap((group) =>
      group.servers.map((server) => ({ server, scope: { kind: "group", groupId: group.id } as const })),
    ),
  ];

  return {
    ...config,
    servers,
    groups,
    defaults,
    subjectIndex,
    serverBindings,
  };
}
