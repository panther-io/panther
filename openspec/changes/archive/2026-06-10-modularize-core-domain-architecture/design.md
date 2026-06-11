## Context

`@fentaris/core` currently exposes a stable public entrypoint through `src/index.ts`, but its internal layout is still pre-alpha and mostly flat. Runtime modules, public contracts, implementation helpers, and tests sit close together. The largest pressure points are `src/McpProxy.ts`, which combines orchestration, context creation, middleware dispatch, policy enforcement, MCP operation forwarding, SDK server creation, routing, events, lifecycle, and logging; and `src/types.ts`, which aggregates many unrelated contracts.

The package is expected to grow with more MCP capabilities and a future plugin system. The architecture should make new domains obvious without forcing every new capability into the proxy class or the global types file.

## Goals / Non-Goals

**Goals:**

- Move the core package to a domain-oriented folder layout.
- Preserve the public top-level API from `@fentaris/core`.
- Move tests into a dedicated mirrored `test` tree.
- Split `types.ts` into focused type modules with a compatibility barrel.
- Split `McpProxy.ts` into focused internal modules while keeping `McpProxy` as the public orchestration class.
- Separate upstream client transports from downstream exposure transports.
- Add a plugin-ready internal domain boundary without implementing plugin loading/execution behavior.
- Keep the migration incremental and verifiable with tests/build after each major step.

**Non-Goals:**

- Do not introduce plugin manifest semantics, installation, discovery, runtime loading, or third-party execution in this change.
- Do not change public import paths from `@fentaris/core`.
- Do not rename public classes or types for aesthetic reasons.
- Do not rewrite proxy behavior, governance behavior, auth behavior, or transport protocols beyond import/layout changes.
- Do not remove compatibility barrels until a later explicit breaking-change proposal.

## Decisions

### Keep `src/index.ts` as the only public package facade

All public symbols continue to be exported from `src/index.ts`, even when their implementation moves under deeper domain folders. Consumers should still write:

```ts
import { McpProxy, McpServer, Policy, FentarisAuth } from "@fentaris/core";
```

Internal files may import from domain-local modules to avoid cycles and reduce reliance on the global facade.

Alternative considered: expose new public subpath exports such as `@fentaris/core/proxy` immediately. That can be useful later, but adding subpath API during a structural cleanup expands the compatibility surface unnecessarily.

### Organize by product domain, not generic technical layer

The target layout groups code by capability ownership:

```txt
src/
  proxy/
  server/
  transports/
    client/
    exposure/
    auth/
  governance/
  auth/
  plugins/
  registry/
  rate-limit/
  logging/
  isolation/
  naming/
  errors/
  types/
```

This makes future additions easier to place. For example, plugin support belongs in `plugins/`, not inside `proxy/`, even though the proxy may consume registered plugin capabilities.

Alternative considered: split into `runtime/`, `contracts/`, `utils/`, and `adapters/`. That keeps folders generic but does not answer where new feature work belongs and tends to recreate large mixed modules inside each layer.

### Use compatibility barrels during migration

Existing modules such as `src/types.ts`, `src/governance.ts`, `src/policy.ts`, `src/auth.ts`, `src/transportAuth.ts`, `src/logger.ts`, and `src/nameMapping.ts` may temporarily remain as barrels that re-export from the new domain modules. This reduces migration risk and keeps public documentation stable while internal imports are updated incrementally.

Alternative considered: move files directly and update every import in one pass. That creates a large, noisy diff and makes regressions harder to isolate.

### Decompose `McpProxy.ts` around private responsibilities

`McpProxy.ts` should remain the public class and high-level coordinator. The implementation details should move into internal modules:

- `proxy/options.ts`: public and internal proxy options.
- `proxy/context.ts`: `ProxyContext` construction and contextual logger setup.
- `proxy/routes.ts`: tool pattern compilation, matching, and route entry contracts.
- `proxy/middleware.ts`: middleware dispatch and legacy middleware adapter logic.
- `proxy/operations.ts`: MCP operation forwarding and result rewriting.
- `proxy/capabilities.ts`: capability policy context and enforcement helpers.
- `proxy/events.ts`: call hooks and generic proxy event dispatch.
- `proxy/lifecycle.ts`: lifecycle hooks.
- `proxy/runtime.ts`: `ProxyRuntime` construction.
- `proxy/sdkServer.ts`: downstream SDK server handler registration.
- `proxy/errors.ts`: proxy-internal error types.

Alternative considered: split `McpProxy` into several public classes. That would be premature; the current public model can stay simple while internals become maintainable.

### Treat plugins as an internal architecture boundary first

This change creates a `plugins/` domain with placeholder contracts and module boundaries only when needed by code organization. The plugin system itself should be a later feature change with its own requirements for manifests, loading, lifecycle, security, and capability registration.

Alternative considered: implement the plugin system as part of the restructure. That would mix a behavior feature with a large mechanical migration and make review harder.

## Risks / Trade-offs

- File movement can cause import regressions -> Preserve compatibility barrels and run `@fentaris/core` test/build after each phase.
- Compatibility barrels can hide poor internal boundaries -> Track follow-up tasks to move internal imports to domain-local modules after the first green migration.
- Splitting `McpProxy.ts` can introduce circular dependencies -> Keep extracted modules mostly pure and pass required dependencies explicitly instead of importing the class back.
- Test movement can break Vitest discovery or TypeScript resolution -> Update package scripts/config first and verify tests before deeper refactors.
- Plugin placeholders can be mistaken for implemented plugin support -> Keep names and docs explicit: plugin-ready architecture only, no plugin runtime behavior.

## Migration Plan

1. Move tests into `packages/core/test` with a folder structure mirroring the new domains, then update test configuration and verify behavior is unchanged.
2. Introduce domain folders and compatibility barrels without moving complex logic yet.
3. Split shared contracts from `src/types.ts` into `src/types/*` and keep `src/types.ts` re-exporting all public type symbols.
4. Move transports into `transports/client`, `transports/exposure`, and `transports/auth`, preserving public exports from `src/index.ts`.
5. Move simple domains such as logging, errors, naming, registry, rate limiting, isolation, auth, and governance behind compatibility barrels.
6. Extract `McpProxy.ts` internals one responsibility at a time, running tests/build after each meaningful extraction.
7. Add plugin-ready folder boundaries and minimal contracts only if required by the architecture spec; defer executable plugin behavior.
8. Remove obsolete internal imports from compatibility barrels where practical, but keep public barrels in place.

Rollback is straightforward for each phase because it is structural: revert the last phase and keep compatibility barrels. No data migration or external dependency rollback is expected.

## Open Questions

- Should public subpath exports be introduced later, once the internal domain boundaries stabilize?
- Should compatibility barrels be kept indefinitely for source-level stability, or removed before a future `1.0`?
- Should plugin contracts live entirely in `@fentaris/core`, or should executable plugin loading eventually be owned by a separate package?
