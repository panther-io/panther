## Context

The basic proxy path handles one downstream request at a time. MCP sessions also support notifications and utilities that rely on session state: list changes, resource subscriptions, progress tokens, cancellation, ping, and logging. Panther's HTTP and SSE exposure transports already maintain downstream session maps, which are the natural place to attach this state.

## Goals / Non-Goals

**Goals:**
- Support MCP list-change and resource-update notifications.
- Support resource subscribe/unsubscribe.
- Forward progress and cancellation where possible.
- Add ping and timeout handling.
- Bridge structured MCP logs to downstream clients with per-session log level filtering.

**Non-Goals:**
- Adding request/response resource or prompt support.
- Bridging roots, sampling, or elicitation.
- Persisting subscription state beyond a live MCP session.
- Guaranteeing notifications from upstream transports that cannot emit them.

## Decisions

### Store utility state per downstream session

Each downstream session will track resource subscriptions, active request ids, progress tokens, cancellation mappings, and desired log level.

Alternative considered: keep utility state globally on `McpProxy`. That risks cross-session leakage and makes cleanup harder.

### Normalize notification routing in the proxy runtime

Exposure transports will provide a way for proxy code to send downstream notifications through the active SDK server/transport. Upstream transports will surface relevant notifications through callbacks or event emitters.

Alternative considered: have every transport directly know downstream sessions. That would couple upstream clients to exposure transports.

### Treat unsupported upstream notifications as best-effort

When an upstream transport cannot observe a notification type, Panther will still support the downstream request where possible and document that no update notifications will be emitted.

Alternative considered: fail subscriptions unless upstream notification forwarding is proven. That is stricter but prevents useful read/list behavior with simple transports.

### Enforce cancellation and timeout locally

Panther will forward cancellation to upstream transports that support it and stop waiting locally. Timeout behavior should return a structured MCP error to the downstream client and free in-flight state.

Alternative considered: rely entirely on SDK defaults. Panther needs consistent behavior across transports and visible audit logs.

## Risks / Trade-offs

- Notification support may depend on SDK internals -> isolate SDK-specific code behind runtime helpers.
- Progress forwarding can flood clients -> rate limit progress notifications per request/session.
- Cancellation races are normal -> ignore late upstream responses after local cancellation.
- Log forwarding can leak secrets -> run all MCP log notifications through existing redaction/safe logging rules.

## Migration Plan

1. Add session utility state to downstream exposure transports.
2. Add downstream notification send helpers to runtime.
3. Implement resource subscribe/unsubscribe and notification routing.
4. Add progress/cancellation/ping support.
5. Implement logging set level and downstream message notifications.
6. Add tests for session cleanup and cross-session isolation.

## Open Questions

- Should Panther synthesize list-changed notifications after policy changes, or only forward upstream changes?
- What default request timeout should apply if none is configured?
- Should log forwarding be opt-in even when `logging` capability is declared?
