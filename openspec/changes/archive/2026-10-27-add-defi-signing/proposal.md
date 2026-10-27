---
change_type: implementation
priority: high
dependencies: []
verifications:
  - id: signing-unit
    requirement: Opt-in signing, exact input bounds, caller policy, epoch races and redacted error paths are fail closed
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: package.json
    evidence: npm test; nonzero signing positive and negative tests, zero skipped
    rerun: npm test
    prerequisites: []
    execution_class: repository-local
    completion_role: change-blocking
  - id: signing-browser
    requirement: Real browser SDKs sign against owned disposable vanilla Anvil and independent recovery matches signer without persisted signatures
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: package.json
    evidence: npm run test:sdk; test/signing-compat.test.js and existing SDK/integration gates, nonzero counts and no skips
    rerun: npm run test:sdk
    prerequisites: [Node >=22, Anvil 1.8.3, lsof, Playwright Chromium]
    execution_class: repository-local
    completion_role: change-blocking
  - id: signing-package
    requirement: 0.3.0 exports and both-module packed consumer preserve zero runtime dependency and default-disabled signing
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: test/pack-consumer.js
    evidence: npm run test:pack; separate directory CJS and ESM consumer
    rerun: npm run test:pack
    prerequisites: []
    execution_class: repository-local
    completion_role: change-blocking
---
# Add opt-in disposable-account signing

**Change Type**: implementation

## Context
Provider stage merged as ef821a7339e4cc90d0e68b2f35589dfa45bf63df (fork-wallet 0.2.0). Parent reran unit 16/SDK12/pack PASS on mini. Anvil 1.8.3 direct feasibility measured personal_sign([hex,address]) and eth_signTypedData_v4([address,JSON string or object]), ethers6.17.0 and viem2.57.12 recover match. That was RPC-only, not browser acceptance. The predecessor is already archived; dependencies is empty intentionally, base commit is the dependency.

## Solution and boundary
Add ONLY opt-in personal_sign and eth_signTypedData_v4 backed by owned Anvil RPC, no runtime crypto library. Reuse mandatory main-frame/origin, account permission, ownership/preflight, requestId/epoch and human-simulated approval controls. Changes confined to this repository src/types/tests/package/README/ACCEPTANCE/OpenSpec. Update version to 0.3.0; retain private/UNLICENSED and exact SDK dev pins. No publish, push, deployment, external RPC, P-256 migration or global settings. No unreviewed expansion to arbitrary signing APIs.

## Acceptance criteria
- Signing disabled by default (4200). Explicit signing policy enables only these two methods on configured owned local chains 31337/31338; all other chain IDs refused at install when signing enabled. This is deliberately not mainnet-ID fork support.
- Unauthorized 4100, wrong signer/params/domain -32602, unsupported methods 4200, rejection 4001. Read gateway NEVER signs. Impersonated addresses cannot sign; helper fresh unlocked accounts only in executed acceptance.
- Real Playwright browser ethers BrowserProvider, viem custom provider and wagmi-core discovered injected connector sign both methods; ethers and viem independently recover the returned signer. Wrong policy/chain/account and stale approvals produce zero signing dispatches.
- Approve/reject/hold/release, scope-change cancellation and parallel request refusal apply to signing. No automatic retry, no fake signatures. Response ambiguity never described as proof no signature was generated.
- Ordinary calls/errors/artifacts contain no personal message, full typed message or signature. Evidence is hashes, recovery booleans, method/signer/domain summary and counters. No trace/HAR/screenshots of signing payloads; assertions never print signature values on failure.
- All predecessor unit/SDK/integration/pack gates remain, nonzero, no skips; archive promotes canonical spec. Exact input shapes, callback contract and migration documented.

## Non-goals
Not ERC-2612/Permit2 contract consumption, live SIWE/auth server, real DeFi/fork or existing independent dApp acceptance. Not arbitrary web site safety or OS-level sandbox. No eth_sign, signing v1/v3, raw transactions, external key input, private key export, arbitrary chain addition, AA/5792/7702. Message signatures are real; local chain ID is a scope limiter, NOT cryptographic invalidation of personal_sign. Mainnet ID signing requires a later isolation design.
