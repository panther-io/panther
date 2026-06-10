## 1. Baseline And Test Layout

- [x] 1.1 Run baseline `pnpm --filter @fentaris/core test` and record any existing failures before moving files
- [x] 1.2 Run baseline `pnpm --filter @fentaris/core build` and record any existing failures before moving files
- [x] 1.3 Create `packages/core/test` with folders mirroring the target domains
- [x] 1.4 Move root-level core tests from `packages/core/src` into matching `packages/core/test` folders
- [x] 1.5 Move transport tests from `packages/core/src/transports` into matching `packages/core/test/transports` folders
- [x] 1.6 Update package test configuration or script so Vitest discovers tests under `packages/core/test`
- [x] 1.7 Update test imports after the move without changing test assertions
- [x] 1.8 Run `pnpm --filter @fentaris/core test`
- [x] 1.9 Run `pnpm --filter @fentaris/core build`

## 2. Domain Folder Skeleton And Compatibility Barrels

- [x] 2.1 Create target source domain folders under `packages/core/src`
- [x] 2.2 Add or preserve compatibility barrels for existing public source-level modules
- [x] 2.3 Ensure `packages/core/src/index.ts` remains the package public facade
- [x] 2.4 Add a short internal architecture note or README describing where new core code belongs
- [x] 2.5 Run `pnpm --filter @fentaris/core build`

## 3. Shared Types Split

- [x] 3.1 Create focused type modules for shared, MCP operation, proxy, middleware, policy, and transport contracts
- [x] 3.2 Move type declarations from `packages/core/src/types.ts` into the focused modules
- [x] 3.3 Keep `packages/core/src/types.ts` as a compatibility barrel re-exporting the moved type declarations
- [x] 3.4 Update internal imports that can safely target focused type modules
- [x] 3.5 Run `pnpm --filter @fentaris/core test`
- [x] 3.6 Run `pnpm --filter @fentaris/core build`

## 4. Transport Domain Split

- [x] 4.1 Move upstream MCP client transports into `packages/core/src/transports/client`
- [x] 4.2 Move downstream proxy exposure transports into `packages/core/src/transports/exposure`
- [x] 4.3 Move shared HTTP-family transport auth helpers into `packages/core/src/transports/auth`
- [x] 4.4 Add transport compatibility barrels or update `src/index.ts` so public exports remain unchanged
- [x] 4.5 Update internal imports and moved transport tests
- [x] 4.6 Run `pnpm --filter @fentaris/core test`
- [x] 4.7 Run `pnpm --filter @fentaris/core build`

## 5. Simple Domain Moves

- [x] 5.1 Move logging implementation into `packages/core/src/logging`
- [x] 5.2 Move error mapping and error codes into `packages/core/src/errors`
- [x] 5.3 Move naming helpers into `packages/core/src/naming`
- [x] 5.4 Move registry implementations into `packages/core/src/registry`
- [x] 5.5 Move rate limiting implementations into `packages/core/src/rate-limit`
- [x] 5.6 Move isolation implementations into `packages/core/src/isolation`
- [x] 5.7 Preserve compatibility barrels and public exports for all moved domains
- [x] 5.8 Update internal imports and matching tests
- [x] 5.9 Run `pnpm --filter @fentaris/core test`
- [x] 5.10 Run `pnpm --filter @fentaris/core build`

## 6. Auth And Governance Domain Split

- [x] 6.1 Move local auth store, credential resolution, and API-key strategy code into `packages/core/src/auth`
- [x] 6.2 Move identity strategy helpers into the auth domain or an explicit identity submodule
- [x] 6.3 Split governance DSL, subjects/groups, approval helpers, policy declarations, and evaluation helpers into `packages/core/src/governance`
- [x] 6.4 Move policy engine and permission matching helpers into the governance domain or an explicit policy submodule
- [x] 6.5 Preserve compatibility barrels and public exports for existing auth, identity, governance, and policy imports
- [x] 6.6 Update internal imports and matching tests
- [x] 6.7 Run `pnpm --filter @fentaris/core test`
- [x] 6.8 Run `pnpm --filter @fentaris/core build`

## 7. Proxy Decomposition

- [x] 7.1 Create focused proxy modules for options, context, routes, middleware, operations, capabilities, events, lifecycle, runtime, SDK server setup, and internal errors
- [x] 7.2 Extract route entry types, pattern compilation, validation, and matching into `proxy/routes`
- [x] 7.3 Extract proxy context construction and contextual logger creation into `proxy/context`
- [x] 7.4 Extract middleware dispatch and legacy middleware adapter behavior into `proxy/middleware`
- [ ] 7.5 Extract MCP operation forwarding and proxied name/URI rewriting into `proxy/operations`
- [x] 7.6 Extract capability policy context and enforcement helpers into `proxy/capabilities`
- [ ] 7.7 Extract call hook, proxy event, and lifecycle dispatch into `proxy/events` and `proxy/lifecycle`
- [ ] 7.8 Extract downstream SDK server registration into `proxy/sdkServer`
- [ ] 7.9 Keep `proxy/McpProxy.ts` as the public orchestration class with the same public methods
- [ ] 7.10 Update tests only where imports or file paths changed
- [ ] 7.11 Run `pnpm --filter @fentaris/core test`
- [ ] 7.12 Run `pnpm --filter @fentaris/core build`

## 8. Plugin-Ready Boundary

- [ ] 8.1 Create `packages/core/src/plugins` with module boundaries for manifest, registry, loader, lifecycle, capabilities, and types
- [ ] 8.2 Add only structural contracts needed to reserve plugin ownership boundaries
- [ ] 8.3 Ensure no executable plugin loading, installation, discovery, sandboxing, or third-party code execution is introduced
- [ ] 8.4 Add placeholder tests or type-level assertions only if concrete contracts are added
- [ ] 8.5 Run `pnpm --filter @fentaris/core test`
- [ ] 8.6 Run `pnpm --filter @fentaris/core build`

## 9. Final Verification

- [ ] 9.1 Verify existing public exports from `@fentaris/core` still resolve through `packages/core/src/index.ts`
- [ ] 9.2 Inspect the final `packages/core/src` tree for domain ownership and remove accidental flat leftover implementation files
- [ ] 9.3 Inspect the final `packages/core/test` tree for mirrored test placement
- [ ] 9.4 Run `pnpm --filter @fentaris/core test`
- [ ] 9.5 Run `pnpm --filter @fentaris/core build`
- [ ] 9.6 Update task notes or architecture docs with any deviations from the proposed target layout
