## ADDED Requirements

### Requirement: Local dev command
The CLI SHALL provide `panther dev` to run the current Panther project locally.

#### Scenario: Dev inside project
- **WHEN** a developer runs `panther dev` inside a generated Panther project
- **THEN** the CLI starts the project and exposes the proxy at the configured local endpoint

#### Scenario: Dev outside project
- **WHEN** a developer runs `panther dev` outside a Panther project
- **THEN** the CLI exits with a clear error explaining that no Panther project was found

### Requirement: Project discovery
The CLI SHALL discover Panther project metadata from the current directory or an ancestor directory before running project-scoped commands.

#### Scenario: Command in nested source directory
- **WHEN** a developer runs `panther dev` from `my-app/src`
- **THEN** the CLI resolves the project root and runs the project from that root

### Requirement: Local build artifact
The CLI SHALL provide `panther build` to create a local deterministic build artifact without deploying it.

#### Scenario: Build succeeds
- **WHEN** a developer runs `panther build` inside a valid Panther project
- **THEN** the CLI validates the project, compiles or packages the configured entrypoint, and writes build output under `.panther/build`

### Requirement: Build output description
The CLI SHALL report the build output path and runtime entrypoint after a successful build.

#### Scenario: Build summary
- **WHEN** `panther build` succeeds
- **THEN** the CLI prints the output directory and the entrypoint that a future deploy or Docker workflow can consume

### Requirement: Deploy excluded
The CLI SHALL not expose a working `panther deploy` implementation as part of this change.

#### Scenario: Developer runs deploy
- **WHEN** a developer runs `panther deploy`
- **THEN** the CLI reports that deploy is not available yet and points to build output as the current packaging step
