## Why

MCP includes session-scoped behavior beyond simple request/response calls: list-change notifications, resource subscriptions, progress, cancellation, ping, and structured logging. Panther needs these utilities to behave like a real MCP gateway for long-lived downstream sessions and dynamic upstream servers.

## What Changes

- Forward or synthesize list-change notifications for tools, resources, and prompts.
- Support resource subscriptions and route `notifications/resources/updated` to subscribed downstream sessions.
- Track progress tokens and forward `notifications/progress` across the proxy when supported.
- Forward cancellation notifications and enforce request timeout behavior.
- Implement ping handling across downstream exposure and upstream transports.
- Complete MCP logging support with `logging/setLevel` and `notifications/message` delivery to downstream clients.
- Maintain per-session state needed for subscriptions, notification routing, cancellation, and log level preferences.

## Capabilities

### New Capabilities
- `mcp-session-utilities`: Session-scoped MCP notifications, subscriptions, progress, cancellation, ping, and logging behavior.

### Modified Capabilities

## Impact

- Affected code: downstream exposure transports, upstream MCP transports, session runtime state, logger bridge, error handling, tests, docs.
- Runtime impact: Panther must maintain per-session subscription and in-flight request state.
- Security impact: notifications and logs must redact sensitive data and avoid cross-session leakage.
- Dependency: should follow basic server feature proxying so resources/prompts exist before their notifications are handled.
