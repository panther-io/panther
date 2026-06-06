## ADDED Requirements

### Requirement: Resource subscriptions
The proxy SHALL support downstream resource subscribe and unsubscribe requests for proxied resources when the owning upstream supports resource subscriptions.

#### Scenario: Subscribe to proxied resource
- **WHEN** a downstream client subscribes to a proxied resource URI
- **THEN** Panther subscribes to the original upstream resource and records the subscription for the downstream session

#### Scenario: Unsubscribe from proxied resource
- **WHEN** a downstream client unsubscribes from a proxied resource URI
- **THEN** Panther removes the downstream session subscription and unsubscribes upstream when no downstream sessions remain subscribed

#### Scenario: Unsupported subscription
- **WHEN** the owning upstream does not support resource subscriptions
- **THEN** Panther returns a structured MCP unsupported error

### Requirement: Resource update notifications
The proxy SHALL route upstream resource update notifications only to downstream sessions subscribed to the corresponding proxied resource.

#### Scenario: Subscribed client notified
- **WHEN** an upstream emits `notifications/resources/updated` for a subscribed resource
- **THEN** Panther sends a downstream update notification using the proxied resource URI

#### Scenario: Unsubscribed client not notified
- **WHEN** an upstream emits a resource update for a resource with no downstream subscription in a session
- **THEN** Panther does not send that session a resource update notification

### Requirement: List change notifications
The proxy SHALL forward or synthesize list-change notifications for tools, resources, and prompts without leaking upstream-only names.

#### Scenario: Tool list change
- **WHEN** an upstream emits `notifications/tools/list_changed`
- **THEN** Panther emits a downstream tool list changed notification

#### Scenario: Resource list change
- **WHEN** an upstream emits `notifications/resources/list_changed`
- **THEN** Panther emits a downstream resource list changed notification

#### Scenario: Prompt list change
- **WHEN** an upstream emits `notifications/prompts/list_changed`
- **THEN** Panther emits a downstream prompt list changed notification

### Requirement: Progress forwarding
The proxy SHALL track downstream progress tokens and forward upstream progress notifications to the requesting downstream session.

#### Scenario: Progress token forwarded
- **WHEN** a downstream request includes `_meta.progressToken`
- **THEN** Panther associates that token with the upstream request it creates

#### Scenario: Progress notification returned
- **WHEN** an upstream sends progress for an active proxied request
- **THEN** Panther sends `notifications/progress` to the originating downstream session with the downstream progress token

#### Scenario: Unknown progress ignored
- **WHEN** Panther receives progress for an unknown or completed request
- **THEN** Panther ignores the notification and does not send it downstream

### Requirement: Cancellation forwarding
The proxy SHALL handle downstream cancellation notifications for active proxied requests.

#### Scenario: Active request cancelled
- **WHEN** a downstream client sends `notifications/cancelled` for an active request
- **THEN** Panther forwards cancellation upstream when supported and stops delivering the eventual upstream result downstream

#### Scenario: Unknown request cancellation
- **WHEN** a downstream client cancels an unknown request
- **THEN** Panther ignores the cancellation notification

### Requirement: Ping support
The proxy SHALL support MCP ping behavior for downstream sessions and upstream health checks.

#### Scenario: Downstream ping
- **WHEN** a downstream client sends a ping request
- **THEN** Panther returns a successful ping response

#### Scenario: Upstream ping failure
- **WHEN** an upstream ping check fails
- **THEN** Panther logs the failure with server and session context

### Requirement: MCP logging
The proxy SHALL support MCP structured logging with per-session log level controls.

#### Scenario: Set log level
- **WHEN** a downstream client sends `logging/setLevel`
- **THEN** Panther stores the requested log level for that downstream session

#### Scenario: Forward allowed log message
- **WHEN** Panther or an upstream emits an MCP log message at or above the session log level
- **THEN** Panther sends `notifications/message` to that downstream session

#### Scenario: Redact sensitive log data
- **WHEN** a log message contains known credential or token fields
- **THEN** Panther redacts those fields before sending the message downstream

### Requirement: Session cleanup
The proxy SHALL clean up subscriptions, progress tokens, cancellation mappings, and log level state when a downstream session closes.

#### Scenario: Session closes
- **WHEN** a downstream MCP session closes
- **THEN** Panther removes all utility state associated with that session
