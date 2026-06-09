## Why

`@fentaris/core` is still small enough to reorganize before the public surface hardens, but it already shows pre-alpha scaling pressure: a mostly flat `src/`, large central files, shared types concentrated in one module, and test files mixed with runtime code. This change creates a domain-oriented internal architecture so future additions, including a plugin system, can grow without turning `McpProxy.ts` and `types.ts` into permanent bottlenecks.

## What Changes

- Reorganize `packages/core/src` around stable domains such as proxy, server, transports, governance, auth, plugins, registry, rate limiting, logging, isolation, naming, errors, and shared types.
- Move tests out of runtime source folders into a mirrored `packages/core/test` tree.
- Split large source files, especially `McpProxy.ts` and `types.ts`, into focused internal modules while preserving public exports from `src/index.ts`.
- Separate upstream MCP client transports from downstream proxy exposure transports.
- Establish a dedicated `plugins` domain with initial contracts and folder boundaries so plugin support can be added without coupling plugin loading to proxy orchestration.
- Preserve current runtime behavior, package entrypoint, and top-level imports from `@fentaris/core`.
- Avoid introducing plugin execution behavior in this change; only establish the architecture and extension points needed to support it later.

## Capabilities

### New Capabilities

- `core-domain-architecture`: Internal package architecture, module boundaries, public export compatibility, test placement, and plugin-ready extension boundaries for `@fentaris/core`.

### Modified Capabilities

## Impact

- Affected code: `packages/core/src`, `packages/core/test`, `packages/core/tsconfig.json`, `packages/core/package.json`, and any package-local test configuration.
- Public API impact: no intended breaking change; existing top-level imports from `@fentaris/core` must continue to work.
- Internal API impact: imports inside `packages/core` will be updated to use the new domain modules and compatibility barrels.
- Documentation impact: maintainers should be able to understand the core package layout and where new capabilities belong.
- Risk: file movement can create noisy diffs and import regressions, so implementation must be staged and verified with package tests/build after each major migration.
