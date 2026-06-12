# Core source layout

New runtime code should live in a domain folder that owns the concern:

- `auth/`
- `errors/`
- `governance/`
- `isolation/`
- `logging/`
- `naming/`
- `plugins/`
- `proxy/`
- `rate-limit/`
- `registry/`
- `server/`
- `transports/auth/`
- `transports/client/`
- `transports/exposure/`
- `types/`

Keep the existing flat source files as compatibility barrels until a later breaking-change migration.
Consumers should import supported APIs from `@fentaris/core` or documented
subpaths such as `@fentaris/core/extensions`; files under `src/` and generated
`dist/` implementation paths are internal package layout.
