## Context

MCP client features invert the normal request direction: upstream servers can ask their client for roots, sampling, and elicitation. In Panther's architecture the upstream server's client is Panther, but the real user-facing MCP client is downstream. Panther must either bridge those requests to the downstream session or answer them through configured local resolvers.

These features are more sensitive than server features. Roots can reveal filesystem boundaries, sampling grants model access, and elicitation asks the user for structured input.

## Goals / Non-Goals

**Goals:**
- Add explicit, opt-in bridging for `roots/list`, `sampling/createMessage`, and `elicitation/create`.
- Support Panther-managed resolvers as an alternative to downstream pass-through.
- Advertise upstream client capabilities only when the current session can satisfy them.
- Apply policy, approval, timeout, and audit controls to client feature requests.
- Return clear MCP errors when a feature is disabled or unsupported.

**Non-Goals:**
- Implementing general server feature proxying.
- Designing UI flows in downstream clients.
- Persisting elicitation/sampling results across sessions.
- Allowing these features by default.

## Decisions

### Default deny client features

Panther will not advertise roots, sampling, or elicitation upstream unless explicitly configured for the server/session.

Alternative considered: pass through whatever the downstream client supports. That maximizes compatibility but exposes sensitive behavior without Panther-level consent.

### Support two fulfillment modes

Each client feature can be fulfilled by downstream pass-through or by a Panther-configured resolver. Pass-through is appropriate when the downstream client has UI and consent flows. Resolvers are useful for server-side deployments with fixed roots or controlled sampling providers.

Alternative considered: pass-through only. That would make non-interactive deployments unable to support roots or sampling safely.

### Bind upstream client capabilities to downstream session

Upstream transports that can issue client feature requests need a session-aware client capability configuration. Panther should not reuse one upstream client capability set across users if roots/sampling/elicitation differ by session.

Alternative considered: one global upstream client. That risks leaking capabilities or responses across subjects.

### Apply governance before bridging

Every upstream client feature request will create a governed operation context before any downstream request or resolver call occurs.

Alternative considered: rely on downstream client consent only. Panther must still enforce server-level policy and audit decisions.

## Risks / Trade-offs

- Session-aware upstream client creation may increase connection count -> reuse per subject/session only when capability configuration matches.
- Sampling can be abused for prompt injection or data exfiltration -> require explicit enablement, approval, and audit logs.
- Elicitation schemas can request sensitive data -> validate schema and enforce allowlists where configured.
- Downstream clients may not support pass-through requests -> return method-not-found or capability-not-supported errors clearly.

## Migration Plan

1. Add configuration types for roots, sampling, and elicitation modes.
2. Add session-aware upstream client capability advertisement.
3. Implement roots resolver/pass-through.
4. Implement sampling resolver/pass-through with approval hooks.
5. Implement elicitation resolver/pass-through with approval hooks.
6. Add governance integration and audit logging.
7. Add docs with secure defaults and examples.

## Open Questions

- Should roots be global per proxy, per user, or per downstream session by default?
- Should Panther support sampling only through downstream pass-through initially, avoiding local model provider integration?
- Which elicitation modes from latest MCP should be supported first if SDK support differs by version?
