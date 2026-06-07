## Why

MCP client features let upstream servers ask the client for roots, sampling, and elicitation. In a proxy architecture Panther sits between the upstream server and downstream client, so it must decide whether to bridge these requests, handle them locally, or deny them with clear policy.

These features are security-sensitive because they can expose filesystem boundaries, ask the host model to generate text, or request user input.

## What Changes

- Add explicit support for upstream-to-downstream `roots/list` requests and root list change handling.
- Add controlled bridging for `sampling/createMessage`, including approval and policy checks.
- Add controlled bridging for `elicitation/create`, including approval and policy checks.
- Allow deployments to configure Panther-managed resolvers as an alternative to downstream pass-through.
- Declare client capabilities upstream only when Panther can actually satisfy them for the current downstream session.
- Add security defaults that deny client feature requests unless explicitly enabled.

## Capabilities

### New Capabilities
- `mcp-client-feature-bridging`: Safe bridging and local handling for MCP roots, sampling, and elicitation requests.

### Modified Capabilities

## Impact

- Affected code: upstream client initialization, downstream session runtime, auth/policy integration, approval hooks, docs, tests.
- Security impact: requires explicit consent, policy, and audit behavior for potentially sensitive client-provided data or model access.
- Compatibility impact: upstream transports must be able to advertise client capabilities conditionally per session.
- Dependency: should follow generalized governance so client feature requests can be authorized consistently.
