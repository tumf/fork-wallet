---
change_type: implementation
priority: high
dependencies: []
verifications:
  - id: legacy-local
    requirement: Narrow legacy aliases retain provider immutability and authorization
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: package.json
    evidence: node --test test/unit.test.js test/provider.test.js test/legacy-provider.test.js; nonzero executed tests and no skips
    rerun: node --test test/unit.test.js test/provider.test.js test/legacy-provider.test.js
    prerequisites: [Node >=22]
    execution_class: repository-local
    completion_role: change-blocking
  - id: legacy-browser
    requirement: Actual injected provider supports strict legacy render and connect before real local send
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: package.json
    evidence: node test/run-gate.js test/legacy-compat.test.js; real Chromium and owned vanilla Anvil receipts, no external network
    rerun: node test/run-gate.js test/legacy-compat.test.js
    prerequisites: [Node >=22, Anvil 1.8.3, Playwright Chromium]
    execution_class: repository-local
    completion_role: change-blocking
  - id: legacy-regression
    requirement: Existing SDK signing isolation and package contracts remain intact
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: package.json
    evidence: npm test && npm run test:sdk && npm run test:pack
    rerun: npm test && npm run test:sdk && npm run test:pack
    prerequisites: [Node >=22, Anvil 1.8.3, Playwright Chromium]
    execution_class: repository-local
    completion_role: change-blocking
---
# Add narrow legacy injected-provider compatibility

**Change Type**: implementation
**Requested Artifact**: implementation (not spec-only).

## Context
Base main edb1420, fork-wallet 0.3.0. On the unchanged scaffold-eth-examples/uniswapper app at 6f12543441991a99e906ab81c3568ab8b13fd7a8, App.jsx:63 assigns window.ethereum.autoRefreshOnNetworkChange=false while React renders in strict mode. Current src/index.js pageScript freezes the provider without that property, so rendering throws TypeError. Installed web3modal 1.9.1 then uses window.ethereum.enable(), which is absent. Parent reproduced the actual serialized pageScript failure offline. Spike commit c4ff8d0 is diagnostic evidence only, never to be merged wholesale. Full fork runs failed (exit2) and submitted zero transactions; independent reserve quote is not UI swap acceptance.

## Proposed solution and boundary
Implement precisely the two page-side compatibility members in design.md, leaving the provider frozen. Touch only src/index.js pageScript, requirement-specific tests, package.json test wiring if needed, README.md, ACCEPTANCE.md and this change's specification. No dependency, lockfile, package version, Node RPC validation, signing policy, timeout, chain registration, external application, Aave example or Anvil helper changes. No new configuration switch or broad legacy shim. No send/sendAsync/isMetaMask aliases.

## Acceptance criteria
- A strict-mode false assignment succeeds on the frozen injected provider, yields false, emits no events and invokes no binding/RPC; invalid writes fail and cannot change behavior.
- enable() is a Promise-returning alias of the existing eth_requestAccounts path, with zero accepted arguments; all grant/reject/hold/disconnect/revoke/origin/frame/epoch semantics remain those of request, with the same error code/data and call traces. It does not grant transaction or signing authority.
- Existing frozen object identity, EIP-6963 discovery, protected members and unsupported methods remain unchanged except for the two deliberate additions.
- A real local browser executes the actual installForkWallet pageScript, performs strict legacy assignment and enable connect then one policy-approved local transfer; receipt and independent balances/nonce agree. Rejection and revoked send produce no new submission. Tests require real behavior, not property-name scans or fabricated receipts.
- All declared local gates pass with nonzero executed tests, no skip, no remaining owned processes/listeners. No unconditional tracked precommit exists; explicit verification remains required.

## Explicit completion conditions
Implement and run all three declared gates. Record commands/counts/exit and cleanup in tasks.md after execution; update honest scope in README/ACCEPTANCE. Strict and archive validation are structural gates, not runtime proof. Conflux implementation completes only this compatibility contract. A later parent-run unchanged Uniswapper fork UI quote and swap with receipt/events/balance changes is still required for swap acceptance; do not represent local synthetic HTML as the third-party app.

## Out of scope
No broad dApp compatibility, external application patching, quote mocks, real assets/keys, production chain-ID signing, fork read acceleration, public RPC provider adoption, retry policy, release/push/publication. No removal of freeze or input/security bounds. Real Uniswapper replay is a separate operational investigation after local product verification, not a Conflux checkbox requiring external RPC.
