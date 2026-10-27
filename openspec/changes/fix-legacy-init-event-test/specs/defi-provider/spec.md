## ADDED Requirements

### Requirement: Deterministic legacy fixture initialization evidence
The legacy browser test SHALL explicitly observe the production provider initial connect event before establishing a baseline for legacy-operation side effects, without requiring a module listener to win a race, masking duplicate events, fabricating events or altering production semantics.

#### Scenario: Initial event before or after module listener
- **WHEN** a fresh context executes the actual injected provider and strict module fixture
- **THEN** the test captures exactly one genuine initial connect with the local chain ID under a bounded wait, permits either module-listener timing, and retains all real-effect and no-effect checks against a validated event baseline.

#### Scenario: Missing or unexpected event
- **WHEN** initial connect is absent, duplicated, has wrong chain, or a later legacy property/invalid-call operation emits an unexpected connect
- **THEN** the browser gate fails rather than filtering the event, clearing evidence, sleeping speculatively or claiming third-party app acceptance.
