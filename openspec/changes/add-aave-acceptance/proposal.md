---
change_type: implementation
priority: high
dependencies: []
verifications:
  - id: aave-logic
    requirement: Fail-closed receipt and policy checks, redirect guard, honest diagnostic outcome classification
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: package.json
    evidence: node examples/aave/selfcheck.js; nonzero tests with positive and negative coverage
    rerun: node examples/aave/selfcheck.js
    prerequisites: [Node >=22]
    execution_class: repository-local
    completion_role: change-blocking
  - id: aave-runtime
    requirement: Unchanged pinned Aave UI supplies ETH and withdraws WETH on owned fork; unlimited approval refused
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: package.json
    evidence: Real fresh fork UI receipts events independent balance reads and verified cleanup; no mocks or skipped steps
    rerun: env -i PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin HOME=$HOME SPIKE_RUNNER=conflux node examples/aave/harness.js
    prerequisites: [macOS sandbox-exec, Anvil 1.8.3, Playwright Chromium, pinned Aave checkout with installed lockfile dependencies, public Base read RPC]
    execution_class: repository-local
    completion_role: change-blocking
  - id: aave-regression
    requirement: Existing product contracts and package stay unchanged
    phase: pre-integration
    owner: conflux-acceptance
    trigger: pull-request-validation
    automation: package.json
    evidence: npm test; npm run test:sdk; npm run test:pack; no skips
    rerun: npm test && npm run test:sdk && npm run test:pack
    prerequisites: [Node >=22, Anvil 1.8.3, Playwright Chromium]
    execution_class: repository-local
    completion_role: change-blocking
---
# Add measured Aave acceptance example

**Change Type**: implementation

## Context and fixed inputs
fork-wallet main 2e53ea8 (0.3.0). Exploratory work preserved on branch spike-aave-acceptance commit eb01565 under spike/aave; use git show to read these exact files, not a moving worktree. The spike itself is NOT merged. Parent measured unchanged Aave interface 20fdc895a9e3925960b5cd111fe09535cf224085: UI supplies 0.5 ETH, withdraws 0.1 WETH (Unwrap OFF), native ETH route demands unlimited aWETH approve and is refused with zero sends. Evidence absolute path $HOME/work2/spike-aave-acceptance/spike/aave/artifacts/2026-10-27T12-25-23-366Z/evidence.json. Overall exit2 due to direct cold-read diagnostic exceeding60s, despite warm UI success. Do not call prior run overall PASS.
Fable 5.1 independent review job 0f1f3c29697b79d607d76e2437aa28cc confirmed actual transaction evidence and conditional acceptance, requiring diagnostic separation, no auto redirects, truthful runner metadata. Review log $HOME/.local/share/agent-exec/jobs/0f1f3c29697b79d607d76e2437aa28cc/stdout.log.

## Solution / changes allowed
Promote ONLY the reviewed guarded example to examples/aave/{harness.js,lib.js,selfcheck.js,README.md,.gitignore}; adjust relative product imports as needed. Use the committed spike as seed, not a new architecture. Add short README/ACCEPTANCE links and canonical OpenSpec delta. Add package scripts test:aave:logic and test:aave invoking the new selfcheck/harness; metadata automation package.json uses those scripts once implemented. No product src/types/package version/dependency/API/timeout changes. Retain private/UNLICENSED, signing disabled, capped approvals and owned disposable local chain31337. Do not merge the entire spike branch, import historical artifacts or retain dead alternative runtime paths beyond useful negative checks.

## Exact corrections
- Classify all diag.* failures independently as diagnostic-failed/diagnostic-timeout, retain their error classes/timings. Evidence.acceptance explicitly records supply, withdrawWETH, nativeRouteRefusal as passed/failed/blocked, diagnosticsDegraded boolean, overall status. Exit0 only all three runtime checks passed + diagnostics healthy; exit4 only all three passed but any diagnostic degraded; exit2 acceptance failure; exit3 blocked prerequisite/fatal launch. Missing/skipped/blocked runtime steps MUST NOT yield0 or4. Mark native-route capability blocked separately from its successful rejection-test result. Cleanup failure or leftover owned listener is acceptance failure. The native test not attempted due to budget fails acceptance rather than silent success.
- route.fetch({maxRedirects:0}) at BOTH browser HTTP proxy sites. Redirect response is returned without following; browser's next request re-enters route allowlist. Add a runnable local redirect negative control (owned ephemeral loopback servers, outside real Aave runtime): external-to-allowlist destination listener counts zero requests, browser redirect aborted. No public calls in that control.
- Replace fixed model attribution with runner from SPIKE_RUNNER or null. Authorship may be separately documented, never masquerades as current executor.
- Console/error redaction removes calldata-sized hex, not only >=65-byte signatures; no persisted keys/messages/signatures/calldata. Summaries use selectors, method, hashes, amounts and counts only.
- Refuse runtime if Aave commit != pinned commit or tracked dirty, before launching app/transactions. AAVE_DIR can supply installed pinned clone, default existing /tmp/fork-wallet-aave-interface-20261027. Do not auto fetch/install on every run. Document exact clone/pin and frozen install prerequisites and macOS scope. Recheck tracked clean after cleanup. No upstream source changes, no fake API/receipts/contract fixtures.

## Runtime gates
Keep genuine Aave UI transaction origins; supply exact0.5ETH to fixed gateway, withdraw exact0.1WETH from fixed Pool with recipient account/value0/calldata byte exact, route toggle OFF, no approval. Confirm mined status, Supply/Withdraw/Transfer event values+parties and independent aWETH/WETH changes; 1wei deposit rounding allowed, withdrawal interest tolerance bounded as spike. Native negative UI must yield exactly one MaxUint256 cap refusal, zero sends, unchanged balance. Positive routes zero policy refusals/unsupported dispatch. Real app server OS sandbox denies public RPC and management port and allows gateway; browser HTTP only app/gateway, exact local Next HMR websocket only. Prove controls, no reload during action; finally all owned process/listeners absent. No new timeouts/retries for submission or signing.
Run selfcheck including genuine/false-positive outcomes, HMR allowlist, amount/recipient/from/value/path deviations, classification matrix (including missing step and cleanup failure), redirect control and metadata/redaction sentinels. Run fresh E2E once with evidence. Code4 is explicitly DEGRADED success of warm path, never clean overallPASS: gate may accept4 ONLY after inspecting evidence of all three runtime assertions+cleanup, and document that limitation in tasks/ACCEPTANCE. Codes2/3 cannot complete change.

## Non-goals and authority
No exchange/swap, borrowing/repaying, SIWE, Permit2/ERC2612, nativeETH positive route, arbitrary dApp or production acceptance. No push/publish/deploy, other consumers, external signing, real keys/assets, mainnet send or global config. Anvil alone may read public mainnet.base.org for fork state. Distribution/user integration still separate remaining product work. This change delivers a reproducible measured lending supply/withdraw example, not entire product completion.
