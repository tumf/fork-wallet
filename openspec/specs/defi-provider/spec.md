### Requirement: Owned DeFi provider compatibility
The package SHALL provide EIP-1193 and EIP-6963 injection with explicit account permissions, bounded allowlisted reads, standard legacy/type2 transaction fields and preserved upstream error data, with the exact public control and validation contract in design.md. It SHALL NOT fake unsupported methods or broaden a caller's policy.

#### Scenario: SDK browser success
- **WHEN** the pinned ethers, viem and wagmi-core fixtures use actual injected discovery and owned read gateway
- **THEN** real local EVM sends produce receipts and expected state changes, reads agree, and unsupported/admin/sign calls fail without upstream side effects.

#### Scenario: Authorization and stale approvals
- **WHEN** an unapproved account requests send, or a held request's origin/account/chain/epoch changes
- **THEN** no send occurs, the correct permission or stale-request error is returned, revoke is not transport disconnect and a repeated release cannot dispatch twice.

### Requirement: Owned runtime and read boundary
The package SHALL start and stop only its own vanilla Anvil child with bounded lifecycle and identity checks, expose a loopback read-only public URL, and reject admin, signature and write requests even inside batches. No runtime cryptographic dependency or caller secret import is introduced.

#### Scenario: Ownership failure
- **WHEN** readiness, child identity, exclusive listener, chain, client or input bounds fail
- **THEN** dispatch is refused, startup cleans up its own resources, and a foreign listener is never killed.

### Requirement: Observable write uncertainty
The wallet SHALL bind approvals to immutable requests and epochs, record dispatch before invoking RPC, never automatically retry writes, and preserve submitted versus unknown outcomes.

#### Scenario: Response loss
- **WHEN** Anvil returns a hash but the controlled response is lost
- **THEN** the browser sees an error and the trace retains the actual single submission on its original chain; an RPC timeout without known hash instead remains unknown, not proof of zero effects.

### Requirement: Honest product acceptance
The release SHALL document a breaking 0.2.0 migration and exact executed SDK/OS/Anvil coverage. Browser-only vanilla fixtures SHALL NOT be represented as public DeFi fork, OS-isolated signature or real-wallet acceptance.

#### Scenario: Package installation
- **WHEN** an external directory installs the tgz and imports CJS or ESM
- **THEN** the documented provider and owned helper are usable without private file imports, copied ownership code or P-256 dependencies.

### Requirement: Narrow legacy provider compatibility
The injected provider SHALL support only the measured legacy enable and false-only autoRefreshOnNetworkChange surfaces while remaining frozen, retaining the exact-origin/main-frame permission path and all signing, read, transaction, epoch, timeout and uncertainty invariants. enable SHALL NOT be a new JSON-RPC method.

#### Scenario: Strict legacy render
- **WHEN** a strict script assigns primitive false to autoRefreshOnNetworkChange
- **THEN** it succeeds, the getter returns false, Object.isFrozen remains true, no binding/event is invoked, and any other assigned value throws TypeError without mutating authority or state.

#### Scenario: Legacy account request
- **WHEN** the page invokes enable() with zero arguments
- **THEN** the actual eth_requestAccounts handler governs authorization, rejection, held approval, trace and error data; the result is its account array, never implicit send/sign permission, including when called as an extracted function.

#### Scenario: Invalid legacy call or mutation
- **WHEN** enable receives any argument or page code tries to replace/delete protected members, redefine the accessor, add an unknown property or request the RPC method enable
- **THEN** arguments reject -32602 before any binding, strict object mutation refuses, and the unknown RPC remains 4200; no unintended submission, signature, grant or event occurs.

#### Scenario: Bounded browser verification
- **WHEN** a local legacy API fixture executes real injection, connect and a policy-approved transfer on an owned vanilla chain31337
- **THEN** real receipt and independent balances/nonce verify its one send, rejection/revocation controls send nothing, all owned runtime resources retire, and this evidence is not reported as third-party fork swap acceptance.

### Requirement: Deterministic legacy fixture initialization evidence
The legacy browser test SHALL explicitly observe the production provider initial connect event before establishing a baseline for legacy-operation side effects, without requiring a module listener to win a race, masking duplicate events, fabricating events or altering production semantics.

#### Scenario: Initial event before or after module listener
- **WHEN** a fresh context executes the actual injected provider and strict module fixture
- **THEN** the test captures exactly one genuine initial connect with the local chain ID under a bounded wait, permits either module-listener timing, and retains all real-effect and no-effect checks against a validated event baseline.

#### Scenario: Missing or unexpected event
- **WHEN** initial connect is absent, duplicated, has wrong chain, or a later legacy property/invalid-call operation emits an unexpected connect
- **THEN** the browser gate fails rather than filtering the event, clearing evidence, sleeping speculatively or claiming third-party app acceptance.

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
