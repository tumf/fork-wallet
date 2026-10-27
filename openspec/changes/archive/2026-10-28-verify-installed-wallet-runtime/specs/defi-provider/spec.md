## ADDED Requirements

### Requirement: Installed package runtime acceptance
The package SHALL provide an explicit opt-in bounded local gate that installs its actual tarball outside the repository and executes the existing generic browser and owned-Anvil regression using only its public installed production exports. It SHALL retain digest, implementation selection, actual runtime result and cleanup evidence without claiming third-party or production acceptance.

#### Scenario: Real installed behavior
- **WHEN** the developer runs npm run test:pack:runtime with required local tools
- **THEN** authorization, rejection, approved transactions, held cancellation/release, response loss reconciliation, revoke, disconnect and reconnect execute in Chromium against owned chain 31337 with real receipts, balances and nonce checks, then owned resources and temporary consumer retire.

#### Scenario: Missing or failing installed runtime
- **WHEN** installed selection is invalid, tools are absent, a child fails or times out, evidence is missing, or cleanup fails
- **THEN** the gate exits nonzero without source fallback, skipping, fabricated success or automatic transaction retry.

#### Scenario: Existing import acceptance
- **WHEN** the developer runs npm run test:pack without runtime mode
- **THEN** its archive allowlist and external CJS/ESM import acceptance retain their existing behavior with no mandatory browser execution.
