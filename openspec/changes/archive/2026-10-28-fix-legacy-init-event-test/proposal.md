---
change_type: implementation
priority: high
dependencies: []
verifications:
  - id: legacy-event
    requirement: Initial connect event is bounded and distinct from effects of legacy operations
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: package.json
    evidence: npm run test:legacy passes three fresh contexts in separate executions; actual receipt/balance/nonce and cleanup assertions retained
    rerun: npm run test:legacy && npm run test:legacy && npm run test:legacy
    prerequisites: [Node >=22, Anvil 1.8.3, Playwright Chromium]
    execution_class: repository-local
    completion_role: change-blocking
  - id: event-regression
    requirement: Existing product contracts remain unchanged
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
# Fix legacy fixture initialization-event race

**Change Type**: implementation
**Requested Artifact**: implementation, not spec-only.

## Reproduced failure
Parent independently ran main e9b9ff0 on Node24.18/Anvil1.8.3/Chromium1194. npm test30 PASS. test:legacy FAILED at test/legacy-compat.test.js:123: actual ['connect'], expected []. Cleanup no leftover listeners. Separate test:sdk20 and pack passed. The production pageScript legitimately schedules its initial connect from the asynchronous __forkWalletInit result (src/index.js:617-618); module fixture app.js attaches a connect listener before that result may arrive. Conflux's Node26 run happened to miss that initial event. This is a test-order assumption, not proof of a product error. No product behavior changes allowed.

## Minimal solution
Touch only test/legacy-compat.test.js and if necessary test/fixtures/legacy-api/app.js, plus truthful README/ACCEPTANCE evidence and this spec delta. No src/types/dependencies/package scripts/timeouts/Anvil helpers/security/control/API changes.
Pin initialization before testing legacy operations. The strict assignment still runs during module render and must not throw. Ensure the fixture captures the legitimate one-time initial connect even if it emitted before the module listener: if necessary use a test-only context.addInitScript recorder that registers an EIP-6963 announce listener; when window.ethereum already exists, dispatch eip6963:requestProvider to obtain the same provider synchronously regardless of addInitScript execution order. Follow the existing test/sdk-compat.test.js:93-106 pattern. Guard window.top !== window and absent provider on about:blank. Attach one initial connect listener before production init resolves; its callback must not throw. That listener stores the exact event payload/count; bounded page.waitForFunction (max 10s) requires exactly one initial connect with chainId0x7a69. Never fabricate a connect, call internal bindings, or mutate the production script. Snapshot the module legacy-event array AFTER that observed initialization; subsequent no-effect checks compare against this baseline, including chainId payload. Later expected accountsChanged sequences include the baseline or use validated deltas. Do not delete connect from event capture, filter all connect events, clear events silently, weaken to arbitrary event count, or insert sleeps/polling without a condition. Unexpected second connect fails. Explicit initialization observation must work in fresh contexts regardless of whether the module listener sees the initial event.

Retain strict false-only assignment/refusal, immutable members, invalid args, unsupported enableRPC, exact policy, rejection/revoke zero-send controls, actual receipt gas/balance/nonce, no external egress and all-owned cleanup. Missing initialization is fail, not skip. No change to production event ordering or wallet connect/revoke semantics. No third-party swap claim.

## Validation and completion
Run separate test:legacy invocations three times, each with fresh context/random vanilla Anvil. Require nonzero tests, no skips, cleanup and same real-effect checks. Run npm test/test:sdk/test:pack. Record honest commands/counts/evidence in tasks and ACCEPTANCE (mention parent's prior failed gate is superseded only after execution). No new broad assertions/files/dependencies. Strict and archive gate are structural only. Integration and parent rerun are required before accepting the fix.

## Out of scope
Product/API change, source patch to Uniswapper, external fork run, swap blocker, public RPC adoption, lifecycle changes to exploratory harness, release/push/publish. Parent is investigating Uniswapper separately; its quote/connect success is not swap acceptance.
