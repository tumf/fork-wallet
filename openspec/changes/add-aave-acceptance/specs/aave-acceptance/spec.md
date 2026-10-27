## ADDED Requirements

### Requirement: Reproducible unchanged Aave lending acceptance
The repository SHALL include an explicitly macOS-scoped example for pinned unchanged Aave interface 20fdc895a9e3925960b5cd111fe09535cf224085 against an owned disposable Base fork on chain31337 with signing disabled. It SHALL prove UI-origin supply of0.5ETH and withdrawal of0.1WETH by mined receipts, exact events and independently read balances, not success text alone.

#### Scenario: Wrapped withdrawal succeeds
- **WHEN** the user-facing Aave unwrap toggle is OFF and exact Pool.withdraw calldata is approved by the harness policy
- **THEN** exactly one transaction succeeds, WETH user balance increases by0.1 and aWETH decreases within bounded interest tolerance

#### Scenario: Unlimited native-route approval is refused
- **WHEN** unchanged Aave requests MaxUint256 aWETH approval for nativeETH withdrawal
- **THEN** the harness refuses it with zero transactions and unchanged balance and reports native withdrawal capability blocked separately from the passed refusal check

### Requirement: Honest bounded acceptance evidence
The example SHALL separate diagnostic degradation from runtime acceptance failure, emit explicit per-route results and fail closed on absent checks, leftover owned processes, unpinned/dirty Aave or failed isolation. Exit0 SHALL mean runtime checks and diagnostics healthy, exit4 all runtime checks passed but diagnostics degraded, exit2 acceptance failed and exit3 prerequisites blocked. It SHALL record current runner identity truthfully and avoid secret or calldata artifacts.

#### Scenario: Cold diagnostic timeout followed by successful warm flows
- **WHEN** a read-only diagnostic exceeds its bounded timeout but supply, WETH withdrawal, native rejection and cleanup are all proven
- **THEN** evidence retains the diagnostic error and exit4 identifies DEGRADED rather than cleanPASS

#### Scenario: Proxy redirect attempts to escape allowlist
- **WHEN** an allowed local server returns a redirect to a disallowed destination
- **THEN** proxy fetch does not follow and the browser's redirected request is blocked with zero destination requests
