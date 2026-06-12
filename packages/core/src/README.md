# Core source layout

New runtime code should live in a domain folder that owns the concern:

- `auth/`
- `config/`
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

## Config validation

`fentaris(config)` and `createProxy(config)` validate high-level configuration
before creating runtime state and throw `FentarisConfigError` for error
diagnostics.

Tooling and tests can use the explicit non-throwing path:

```ts
import {
  assertValidFentarisConfig,
  defineFentarisConfig,
  formatFentarisDiagnostics,
  validateFentarisConfig,
} from "@fentaris/core";

const config = defineFentarisConfig({
  servers: [],
});

const result = validateFentarisConfig(config);
console.log(formatFentarisDiagnostics(result.diagnostics, { format: "plain" }));
assertValidFentarisConfig(config);
```

The resolved runtime config shape remains internal for now; public consumers
should rely on input config, diagnostics, and formatter contracts.
