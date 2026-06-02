## 1. Core scaffolding

- [x] 1.1 Add new core types/interfaces for Policy, ToolPermission, Registry, RateLimiter, IdentityStrategy, Isolation, and ErrorMapper
- [ ] 1.2 Extend middleware context to expose policy evaluation results and identity metadata
- [ ] 1.3 Export new types and classes from packages/core/src/index.ts

## 2. Policy engine

- [ ] 2.1 Implement Policy evaluation logic with allow/deny and metadata
- [ ] 2.2 Add ToolPermission filters for listTools and callTool decisions
- [ ] 2.3 Integrate policy evaluation into McpProxy middleware flow and listTools pipeline

## 3. Registry and secrets

- [ ] 3.1 Implement Registry interface and MemoryRegistry
- [ ] 3.2 Implement RedisRegistry with connection and get/set semantics
- [ ] 3.3 Wire Registry into identity/policy resolution and env injection

## 4. Rate limiting and quotas

- [ ] 4.1 Implement RateLimitStore interface and in-memory store
- [ ] 4.2 Implement RateLimiter with sliding window and daily quota support
- [ ] 4.3 Add middleware helpers to enforce limits and return policy errors

## 5. Identity and auth

- [ ] 5.1 Add identity resolver configuration on McpProxy (strategy-based)
- [ ] 5.2 Implement header/token strategies with unauthorized error handling
- [ ] 5.3 Ensure UserContext is populated consistently across hooks and middleware

## 6. Transports and isolation runtime

- [ ] 6.1 Implement HttpTransport adapter and add tests
- [ ] 6.2 Add Isolation interface and default in-process queue implementation
- [ ] 6.3 Integrate isolation runtime with McpServer execution path

## 7. Logging and observability

- [ ] 7.1 Add Logger auto-log pipeline for request/response/timing with user context
- [ ] 7.2 Implement Redis logger driver and update docs
- [ ] 7.3 Add lifecycle hooks for session start/end and tool failures

## 8. Error mapping and docs

- [ ] 8.1 Implement standardized error mapping and middleware error injection API
- [ ] 8.2 Update docs/guides to reflect new governance syntax
- [ ] 8.3 Add tests for policy, rate limiting, identity, and error mapping
