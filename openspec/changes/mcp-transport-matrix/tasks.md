## 1. API Shape And Compatibility

- [ ] 1.1 Audit current MCP SDK transport exports and decide exact class names for native HTTP, SSE, and proxy exposure transports
- [ ] 1.2 Define upstream HTTP-family auth option types for static headers, bearer tokens, API keys, and async user-aware resolvers
- [ ] 1.3 Define a downstream proxy exposure transport interface separate from `PanterTransport`
- [ ] 1.4 Refactor `McpProxy` internals so MCP SDK server creation and list/call handling can be reused outside the Node HTTP listener
- [ ] 1.5 Preserve `McpProxy.start()` as the backward-compatible default HTTP exposure API

## 2. Shared Transport Auth

- [ ] 2.1 Implement a helper that resolves HTTP-family outbound headers from static headers and auth options
- [ ] 2.2 Support user-aware auth resolution using resolved `UserContext`, including registry-provided secrets and tokens
- [ ] 2.3 Normalize missing required upstream credentials into mapped MCP errors before upstream requests are sent
- [ ] 2.4 Add unit tests for headers, bearer token, API key, resolver success, and resolver failure cases

## 3. Native Upstream Transports

- [ ] 3.1 Implement native MCP Streamable HTTP upstream transport for `http://` and `https://` MCP server URLs
- [ ] 3.2 Add lifecycle handling for HTTP upstream initialize/session reuse and close behavior
- [ ] 3.3 Implement native MCP SSE upstream transport with event-stream lifecycle and request/response correlation
- [ ] 3.4 Ensure HTTP and SSE upstream transports support the shared auth resolver
- [ ] 3.5 Keep or rename the current simple REST-like `HttpTransport` with clear compatibility exports and documentation
- [ ] 3.6 Add tests for HTTP listTools, HTTPS callTool, SSE listTools, SSE callTool, close cleanup, and simple HTTP adapter distinction

## 4. Proxy Exposure Transports

- [ ] 4.1 Extract current HTTP Streamable MCP exposure into an explicit HTTP proxy exposure transport
- [ ] 4.2 Wire `McpProxy.start()` to the HTTP proxy exposure transport without changing existing defaults
- [ ] 4.3 Implement stdio proxy exposure so Panther can run as a local MCP server process
- [ ] 4.4 Implement SSE proxy exposure with session and stream cleanup
- [ ] 4.5 Ensure HTTP and SSE exposure resolve downstream identity at the proxy edge
- [ ] 4.6 Define and implement stdio exposure user context behavior for non-HTTP identity
- [ ] 4.7 Add tests proving listTools and callTool use the same proxy pipeline across HTTP, stdio, and SSE exposure

## 5. Stdio Upstream Behavior

- [ ] 5.1 Add regression tests for stdio upstream per-user env transport reuse
- [ ] 5.2 Add regression tests for stdio upstream isolation queueing by user identity
- [ ] 5.3 Document stdio auth as env/secrets configuration rather than protocol-level headers or OAuth

## 6. Documentation And Exports

- [ ] 6.1 Export new transport classes, option types, and auth types from `packages/core/src/index.ts`
- [ ] 6.2 Update transport docs with the supported upstream and downstream transport matrix
- [ ] 6.3 Document HTTP-family auth examples for headers, bearer tokens, API keys, OAuth access tokens, and per-user resolvers
- [ ] 6.4 Document backward compatibility and migration guidance for the existing simple HTTP adapter and `McpProxy.start()`
- [ ] 6.5 Regenerate typed reference docs if required by the existing docs workflow

## 7. Verification

- [ ] 7.1 Run `pnpm --filter @panther/core test`
- [ ] 7.2 Run `pnpm --filter @panther/core build`
- [ ] 7.3 Run repository lint/typecheck commands required by the project
- [ ] 7.4 Verify `openspec status --change "mcp-transport-matrix"` reports the change as apply-ready
