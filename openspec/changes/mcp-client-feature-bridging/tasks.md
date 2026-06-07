## 1. Configuration And Capability Model

- [x] 1.1 Add configuration types for roots, sampling, and elicitation enablement per upstream server
- [x] 1.2 Add fulfillment mode configuration for downstream pass-through and Panther-managed resolvers
- [x] 1.3 Add default-deny behavior for all client feature requests
- [x] 1.4 Add session-aware upstream client capability calculation
- [x] 1.5 Add tests that disabled features are not advertised upstream

## 2. Runtime Request Bridging

- [x] 2.1 Add runtime support for upstream-to-downstream client feature requests
- [x] 2.2 Correlate bridged requests with the originating upstream server and downstream session
- [x] 2.3 Enforce timeouts and cleanup for pending bridged requests
- [x] 2.4 Return structured MCP errors when a downstream client or resolver cannot satisfy a request

## 3. Roots

- [ ] 3.1 Implement `roots/list` through downstream pass-through
- [ ] 3.2 Implement `roots/list` through a configured Panther roots resolver
- [ ] 3.3 Validate root responses and reject or filter non-`file://` roots according to configuration
- [ ] 3.4 Support root list changed notifications when downstream pass-through supports them
- [ ] 3.5 Add tests for roots pass-through, resolver mode, disabled mode, and invalid roots

## 4. Sampling

- [ ] 4.1 Implement policy and approval checks for upstream sampling requests
- [ ] 4.2 Implement `sampling/createMessage` downstream pass-through
- [ ] 4.3 Implement `sampling/createMessage` through a Panther sampling resolver
- [ ] 4.4 Ensure denied sampling requests do not reach downstream clients or resolvers
- [ ] 4.5 Add tests for allowed, denied, timed-out, and resolver-based sampling

## 5. Elicitation

- [ ] 5.1 Implement policy and approval checks for upstream elicitation requests
- [ ] 5.2 Implement `elicitation/create` downstream pass-through
- [ ] 5.3 Implement `elicitation/create` through a Panther elicitation resolver
- [ ] 5.4 Validate elicitation request schemas before forwarding or resolving
- [ ] 5.5 Add tests for allowed, denied, timed-out, and resolver-based elicitation

## 6. Audit And Security

- [ ] 6.1 Add audit logging for roots, sampling, and elicitation requests
- [ ] 6.2 Include server, subject, feature, policy, approval, fulfillment mode, and duration metadata in audit logs
- [ ] 6.3 Ensure sampling prompts and elicitation payloads are not logged by default
- [ ] 6.4 Add tests for audit metadata and sensitive payload redaction

## 7. Documentation And Verification

- [ ] 7.1 Document secure defaults and explicit enablement requirements
- [ ] 7.2 Document pass-through and resolver modes for each client feature
- [ ] 7.3 Document examples for roots, sampling approval, and elicitation approval
- [ ] 7.4 Run `pnpm --filter @panther/core test`
- [ ] 7.5 Run `pnpm --filter @panther/core build`
