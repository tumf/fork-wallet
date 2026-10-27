## ADDED Requirements

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
