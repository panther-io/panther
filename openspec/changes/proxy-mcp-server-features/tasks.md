## 1. Protocol Types And Mapping

- [x] 1.1 Add optional resource, prompt, resource-template, and completion methods to `PanterTransport`
- [x] 1.2 Add SDK request/result type imports and public type aliases for new MCP server feature operations
- [x] 1.3 Implement prompt name mapping helpers that round-trip `<server>__<prompt>` to server and upstream prompt name
- [x] 1.4 Implement proxied resource URI and resource template URI mapping helpers with round-trip validation
- [x] 1.5 Add unit tests for prompt and resource mapping collisions, invalid names, and malformed proxy URIs

## 2. Upstream Transport Support

- [x] 2.1 Implement resource list/read/template-list methods in `StdioTransport`
- [x] 2.2 Implement prompt list/get methods in `StdioTransport`
- [x] 2.3 Implement completion forwarding in `StdioTransport`
- [x] 2.4 Implement the same feature methods in `StreamableHttpMcpTransport`
- [x] 2.5 Implement the same feature methods in `SseMcpTransport`
- [x] 2.6 Add capability checks so unsupported upstream capabilities return empty list responses or unsupported errors as appropriate
- [x] 2.7 Add native MCP transport tests for resource, prompt, and completion forwarding

## 3. Server Wrapper

- [x] 3.1 Add `McpServer` methods for listing resources, reading resources, listing resource templates, listing prompts, getting prompts, and completing arguments
- [x] 3.2 Ensure all new `McpServer` methods use existing per-user env and user-aware transport resolution
- [x] 3.3 Add tests proving env/user-specific transports apply to non-tool operations

## 4. Proxy Aggregation And Routing

- [ ] 4.1 Implement `McpProxy.listResources` with per-upstream aggregation and proxied resource URIs
- [ ] 4.2 Implement `McpProxy.readResource` with proxy URI parsing and upstream URI restoration
- [ ] 4.3 Implement `McpProxy.listResourceTemplates` with proxied URI templates
- [ ] 4.4 Implement `McpProxy.listPrompts` with proxied prompt names
- [ ] 4.5 Implement `McpProxy.getPrompt` with prompt name parsing and upstream prompt restoration
- [ ] 4.6 Implement `McpProxy.complete` for proxied prompt and resource template references
- [ ] 4.7 Preserve upstream metadata and payload content except for documented routing rewrites

## 5. Downstream MCP Server Exposure

- [ ] 5.1 Register downstream SDK request handlers for resources, resource templates, prompts, and completion
- [ ] 5.2 Compute downstream `resources`, `prompts`, and `completions` capabilities from configured upstream support
- [ ] 5.3 Keep `tools` capability and existing tool handlers unchanged
- [ ] 5.4 Add integration tests using an MCP client against Panther for list/read/get/complete flows

## 6. Documentation And Verification

- [ ] 6.1 Update reference docs for `PanterTransport`, `McpServer`, and `McpProxy`
- [ ] 6.2 Update guide docs to describe proxied resources, prompts, and completion naming
- [ ] 6.3 Run `pnpm --filter @panther/core test`
- [ ] 6.4 Run `pnpm --filter @panther/core build`
