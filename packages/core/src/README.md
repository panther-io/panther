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
