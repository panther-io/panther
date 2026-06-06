## 1. Session Utility State

- [x] 1.1 Add per-session state for resource subscriptions, active requests, progress tokens, cancellations, and log level
- [x] 1.2 Ensure HTTP Streamable exposure cleans session utility state on close
- [x] 1.3 Ensure SSE exposure cleans session utility state on close
- [x] 1.4 Add cross-session isolation tests for utility state

## 2. Notification Transport Plumbing

- [x] 2.1 Add runtime helpers for sending downstream MCP notifications to a specific session
- [x] 2.2 Add upstream transport notification hooks or event emitters for tools/resources/prompts list changes
- [x] 2.3 Add upstream transport notification hooks or event emitters for resource updates and progress
- [x] 2.4 Add tests for notification routing through HTTP Streamable and SSE exposure transports

## 3. Resource Subscriptions

- [x] 3.1 Register downstream handlers for `resources/subscribe` and `resources/unsubscribe`
- [x] 3.2 Route subscribe/unsubscribe to the owning upstream resource URI
- [x] 3.3 Coalesce upstream subscriptions when multiple downstream sessions subscribe to the same upstream resource
- [x] 3.4 Route upstream resource update notifications only to subscribed downstream sessions
- [x] 3.5 Add tests for subscribe, unsubscribe, unsupported upstreams, and update delivery

## 4. List Change Notifications

- [x] 4.1 Forward upstream tool list change notifications downstream
- [x] 4.2 Forward upstream resource list change notifications downstream
- [x] 4.3 Forward upstream prompt list change notifications downstream
- [x] 4.4 Ensure notifications never expose upstream-only unproxied names or URIs
- [x] 4.5 Add tests for each list change notification type

## 5. Progress, Cancellation, And Ping

- [x] 5.1 Track downstream `_meta.progressToken` values and upstream request mappings
- [x] 5.2 Forward progress notifications to the originating downstream session
- [x] 5.3 Handle downstream `notifications/cancelled` for active proxied requests
- [x] 5.4 Forward cancellation upstream where supported and ignore late upstream results
- [x] 5.5 Add downstream ping request support
- [x] 5.6 Add configurable request timeout behavior and cleanup
- [x] 5.7 Add tests for progress, cancellation races, ping, and timeout cleanup

## 6. MCP Logging

- [ ] 6.1 Register downstream handler for `logging/setLevel`
- [ ] 6.2 Store log level per downstream session
- [ ] 6.3 Send `notifications/message` for Panther and upstream MCP logs at or above the session level
- [ ] 6.4 Redact known credential and token fields before downstream log notification delivery
- [ ] 6.5 Add tests for log level filtering and redaction

## 7. Documentation And Verification

- [ ] 7.1 Document subscriptions, list-change notifications, progress, cancellation, ping, and logging behavior
- [ ] 7.2 Document best-effort behavior for transports that cannot observe upstream notifications
- [ ] 7.3 Run `pnpm --filter @panther/core test`
- [ ] 7.4 Run `pnpm --filter @panther/core build`
