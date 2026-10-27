---
change_type: implementation
priority: high
dependencies: []
verifications:
  - id: provider-unit
    requirement: Strict read/transaction/permission/request lifecycle contracts work without browser or external RPC
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: package.json
    evidence: npm test; test/unit.test.js and test/provider.test.js nonzero cases
    rerun: npm test
    prerequisites: []
    execution_class: repository-local
    completion_role: change-blocking
  - id: provider-browser
    requirement: Real Chromium SDK clients execute against owned vanilla Anvil with consistent public reads and negative controls
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: package.json
    evidence: npm run test:sdk; test/sdk-compat.test.js actual receipt and state assertions, no skips
    rerun: npm run test:sdk
    prerequisites: [Node >=22, Anvil 1.8.3, lsof, installed Playwright Chromium]
    execution_class: repository-local
    completion_role: change-blocking
  - id: provider-package
    requirement: Published-file boundary supports both module forms and owned helper without private imports
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: test/pack-consumer.js
    evidence: npm run test:pack; separate-directory tgz consumer
    rerun: npm run test:pack
    prerequisites: []
    execution_class: repository-local
    completion_role: change-blocking
---
# Add a usable DeFi provider and owned local runtime

**Change Type**: implementation

## Problem / Context
At 2b33f33215bf086e2e3f691a11f70d08f0760133, fork-wallet 0.1.1 supports four methods, five transaction fields, no error.data propagation across binding, no connection authorization, no EIP-6963 discovery and no packaged node lifecycle/public RPC. Common SDK send/estimate/read paths cannot use it without custom mocks. User approved implementation of the DeFi expansion design and monitoring on 2026-10-27.

## Proposed Solution
Implement design.md as the first bounded, repository-local delivery. Keep Playwright injection, owned loopback Anvil and caller policy callbacks; add strictly bounded read/transaction schemas, explicit permission state, request IDs and epochs, owned vanilla node/read gateway, EIP-6963 and three actual browser SDK consumer fixtures. No wallet emulation framework or runtime dependency. Provider, ownership helper and SDK acceptance ship together: a provider-only change could claim success while public reads or discovery still use a different chain, so these surfaces are coupled.

## Boundary
Only this repository's src/, index.d.ts, tests, examples, package files, README.md and ACCEPTANCE.md and OpenSpec. Leave P-256 repo, other worktrees, machine settings and global cflx config unchanged. No external push, release, npm publish or production/fork RPC. Maintain private/UNLICENSED. Package becomes 0.2.0 with explicit migration; existing P-256 tgz remains untouched.

## Acceptance Criteria
- Real browser ethers 6.17.0, viem 2.57.12 and wagmi/core 2.22.1 injected-discovery fixtures use the injected provider/public read URL, not a mock connector or Node SDK substitute.
- Connect/reject/revoke/reconnect and pre-registered two-chain switching have exact account/error/event semantics. Only main frame at configured origin may bind.
- Legacy and EIP-1559 real sends, gas estimate, calls, reads, logs and ABI revert data work; receipt, sender/nonce/balance and side-effect counts are checked.
- Held approvals cannot outlive account/chain/permission epoch; duplicate release/parallel approvals fail. Lost is recorded submission, timeout unknown is never rewritten as failure-before-send. No internal automatic write retries.
- Owned helper refuses wrong owner/chain/client and cleans up only its child. Gateway never forwards admin/send/sign RPC, including batches. Input and output bounds, redirects and timeout fail closed.
- Package consumer and documented 0.1.1 migration work. Unsupported signatures/AA/addChain/raw submission remain honest 4200 responses.

## Explicit Completion Conditions
All active task gates execute with nonzero counts, no skips and no external network dependence; update README/API types/ACCEPTANCE.md with exact measured versions and limitations. Existing regression cases must be adapted to documented 0.2.0 semantics, not removed to hide failures. Preserve approved send/reject/hold/lost/disconnect evidence with real receipt and state checks. Archive delta into canonical spec. The archived rerun must not reference an active openspec change path.

## Out of Scope / Remaining Design Work
This is stage one, NOT completion of general DeFi support. A separate dependent signing change will cover personal_sign/EIP-712 with fresh keys. Mainnet/Polygon protocol fork acceptance, Permit2, independent existing dApp, OS-level egress sandbox, macOS+Linux portability certification, live SIWE/backend and P-256 migration remain later acceptance/deliveries; do not advertise them. No signature generation in this change, no all-public-site compatibility. Local vanilla fixture success is never a fork or arbitrary dApp PASS.

## Reference precedence
roadmap.md is historical design reference only, NOT an implementation contract. This proposal/design/tasks/spec delta take precedence; future signing/fork instructions and the old execution directives in roadmap.md are not executable tasks here.

## Rejected Alternatives
A generic Synpress wrapper adds dependency/browser framework coupling and does not replace this package's mandatory ownership and exact policy gates. Reuse EVM/SDK implementations, not a second wallet UI. No broad RPC passthrough, fake receipts, implicit MetaMask flags or compatibility bypass for old preauthorized semantics.
