## ADDED Requirements

### Requirement: TypeScript user declaration
The system SHALL provide a first-class `User` declaration API for representing non-sensitive subject metadata in application code.

#### Scenario: Declare user metadata
- **WHEN** a developer declares a user with id, display name, email, tenant id, or metadata
- **THEN** Panther stores that metadata as non-sensitive subject information available after authentication

#### Scenario: User declaration excludes secrets
- **WHEN** a developer declares a `User`
- **THEN** Panther does not require or expose secret credential values on the `User` declaration

### Requirement: Groups own membership
The system SHALL provide a first-class `Group` declaration API where each group owns its user membership and policy assignment.

#### Scenario: Register groups in proxy
- **WHEN** a developer configures `McpProxy` with `groups: Group[]`
- **THEN** Panther builds the subject index from the users declared by those groups without requiring a separate proxy-level users list

#### Scenario: Resolve user groups
- **WHEN** an authenticated user belongs to one or more configured groups
- **THEN** Panther resolves the subject with all configured group memberships before evaluating policy

### Requirement: Multiple group membership
The system SHALL support a user belonging to multiple groups.

#### Scenario: User appears in multiple groups
- **WHEN** a declared user appears in more than one configured group
- **THEN** Panther includes all matching group memberships in the resolved subject

#### Scenario: Duplicate user declaration conflict
- **WHEN** the same user id is declared with conflicting metadata across groups
- **THEN** Panther reports a configuration error before serving requests

### Requirement: Subject lookup failure
The system SHALL reject authenticated user ids that are not declared by any configured group.

#### Scenario: API key resolves unknown user
- **WHEN** identity resolution returns a user id that is not present in the configured group graph
- **THEN** Panther returns an unauthorized or configuration error and does not call upstream servers
