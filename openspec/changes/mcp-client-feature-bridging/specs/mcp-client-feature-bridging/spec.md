## ADDED Requirements

### Requirement: Explicit client feature enablement
The proxy SHALL deny roots, sampling, and elicitation requests by default unless the feature is explicitly enabled for the upstream server and downstream session.

#### Scenario: Disabled sampling
- **WHEN** an upstream server sends `sampling/createMessage` and sampling is not enabled
- **THEN** Panther returns a structured MCP unsupported or policy error

#### Scenario: Disabled roots
- **WHEN** an upstream server sends `roots/list` and roots are not enabled
- **THEN** Panther returns a structured MCP unsupported or policy error

#### Scenario: Disabled elicitation
- **WHEN** an upstream server sends `elicitation/create` and elicitation is not enabled
- **THEN** Panther returns a structured MCP unsupported or policy error

### Requirement: Conditional upstream client capabilities
The proxy SHALL advertise upstream client capabilities only for features Panther can satisfy in the current session.

#### Scenario: Roots advertised
- **WHEN** roots are enabled through pass-through or a configured resolver for a session
- **THEN** Panther advertises the `roots` client capability to the upstream server for that session

#### Scenario: Sampling not advertised
- **WHEN** sampling is disabled for a session
- **THEN** Panther does not advertise the `sampling` client capability to the upstream server for that session

#### Scenario: Elicitation advertised
- **WHEN** elicitation is enabled through pass-through or a configured resolver for a session
- **THEN** Panther advertises the `elicitation` client capability to the upstream server for that session

### Requirement: Roots bridging
The proxy SHALL satisfy upstream `roots/list` requests through downstream pass-through or a configured Panther roots resolver.

#### Scenario: Roots pass-through
- **WHEN** an upstream server requests roots and downstream pass-through is enabled
- **THEN** Panther forwards `roots/list` to the downstream session and returns the downstream response upstream

#### Scenario: Configured roots
- **WHEN** an upstream server requests roots and a Panther roots resolver is configured
- **THEN** Panther returns roots from the configured resolver without contacting the downstream client

#### Scenario: Root response validation
- **WHEN** a roots response contains a non-`file://` root URI
- **THEN** Panther rejects or filters that root according to configuration before returning it upstream

### Requirement: Sampling bridging
The proxy SHALL satisfy upstream `sampling/createMessage` requests only after policy and approval checks pass.

#### Scenario: Sampling pass-through
- **WHEN** an upstream sampling request is allowed and downstream pass-through is enabled
- **THEN** Panther forwards the request to the downstream session and returns the downstream sampling response upstream

#### Scenario: Sampling resolver
- **WHEN** an upstream sampling request is allowed and a Panther sampling resolver is configured
- **THEN** Panther calls the resolver and returns its response upstream

#### Scenario: Sampling denied by approval
- **WHEN** approval denies an upstream sampling request
- **THEN** Panther returns a structured MCP error and does not call the downstream client or resolver

### Requirement: Elicitation bridging
The proxy SHALL satisfy upstream `elicitation/create` requests only after policy and approval checks pass.

#### Scenario: Elicitation pass-through
- **WHEN** an upstream elicitation request is allowed and downstream pass-through is enabled
- **THEN** Panther forwards the request to the downstream session and returns the downstream elicitation response upstream

#### Scenario: Elicitation resolver
- **WHEN** an upstream elicitation request is allowed and a Panther elicitation resolver is configured
- **THEN** Panther calls the resolver and returns its response upstream

#### Scenario: Elicitation denied by policy
- **WHEN** policy denies an upstream elicitation request
- **THEN** Panther returns a structured MCP error and does not call the downstream client or resolver

### Requirement: Client feature audit
The proxy SHALL audit every roots, sampling, and elicitation request with server, subject, feature, policy, approval, and fulfillment mode metadata.

#### Scenario: Sampling audit log
- **WHEN** an upstream sampling request completes
- **THEN** Panther logs the upstream server, subject id, policy outcome, approval outcome, fulfillment mode, and duration

#### Scenario: Roots audit log
- **WHEN** an upstream roots request completes
- **THEN** Panther logs the upstream server, subject id, fulfillment mode, and number of roots returned

### Requirement: Client feature timeout
The proxy SHALL enforce timeouts for downstream pass-through and resolver-based client feature requests.

#### Scenario: Downstream timeout
- **WHEN** a downstream client does not answer a bridged sampling request before the configured timeout
- **THEN** Panther returns a timeout error upstream and cleans up the pending request state
