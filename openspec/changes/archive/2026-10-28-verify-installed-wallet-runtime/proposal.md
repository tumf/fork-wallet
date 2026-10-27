---
change_type: implementation
priority: medium
verifications:
  - id: installed-runtime
    requirement: Installed tarball executes the real wallet regression without importing repository source
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: test/pack-consumer.js
    evidence: npm run test:pack:runtime
    rerun: npm run test:pack:runtime
    prerequisites: [Node >=22, Anvil 1.8.3, Playwright Chromium, lsof, installed development dependencies]
    execution_class: repository-local
    completion_role: change-blocking
---
# Verify installed wallet runtime

**Change Type**: implementation

## Problem / Context
The user wants a reusable standalone development wallet, not a third-party sample app.
`test/pack-consumer.js` proves archive contents and CJS/ESM imports but does not exercise a real browser or EVM from the installed package. The existing generic local integration test exercises real behavior only through repository source imports.
A parent throwaway experiment on main 56e5177 installed its tgz outside the repo and ran that integration test with installed exports: PASS, actual exit 0, 14.06 s. This validates the approach, not a tracked repeatable product gate.

## Proposed Solution
Add `npm run test:pack:runtime` as an explicit opt-in heavy pack gate. Reuse the existing generic integration regression without duplicating its assertions. Resolve wallet/helper implementations from an installed external consumer only in that mode; retain current source mode by default. Report archive digest and actual child outcome. Add concrete prerequisites and the command to README and the executed evidence to ACCEPTANCE only after running it.

## Acceptance Criteria
- The packed tarball is installed in a fresh directory outside the repo. Only `fork-wallet` and `fork-wallet/anvil` public entry points supply production code; no source fallback is possible.
- The current generic local dApp test passes against that installation: authorization, rejection, exact receipt/balances/gas, hold/cancel/release, response loss without resend, revoke, disconnect and reconnect. Missing tools, child failure and timeout fail, never skip.
- Existing pack import mode, source SDK tests, authority policy, package contents and runtime API are unchanged.
- The new gate reports actual outcome and archive SHA-256, preserves runtime evidence outside its temporary consumer before deletion, and cleans its consumer plus owned child resources.

## Explicit Completion Conditions
`npm run test:pack:runtime` completes within 180 s for its real runtime child, returns nonzero on any failed assertion/prerequisite, and independently demonstrates the installed exports were selected. Run `npm test`, `npm run test:pack`, and `npm run test:integration` once as focused regressions; record exact results. No tracked commit hook runs these gates.

## Out of Scope
No new wallet feature, signing authority, dependencies, version/license/private changes, third-party application example, fork upstream, Aave repair, public-site compatibility, publishing or push. Local package reuse is the outcome. Publication remains a separate approval boundary.
