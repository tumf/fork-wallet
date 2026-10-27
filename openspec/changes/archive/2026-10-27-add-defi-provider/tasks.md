## Implementation Tasks

- [x] Implement per-method bounded read/transaction validation and data-preserving RPC error path in src/index.js and types, including caller frame/origin guards; add nonzero unit negative/positive schema cases (verification: unit - npm test; test/unit.test.js and test/provider.test.js; verification-id: provider-unit)
- [x] Implement permission/discovery/registered chain controls and requestId/epoch state transitions exactly as design.md, including late policy races, lost/unknown distinctions and no retry; update unit and event contract tests (verification: unit - npm test; test/provider.test.js; verification-id: provider-unit)
- [x] Extract owned Anvil lifecycle plus restricted public read gateway into packaged fork-wallet/anvil with startup/timeout/ownership/stop/CORS/batch tests; retain no runtime dependency and only kill owned children (verification: integration - npm run test:sdk; test/sdk-compat.test.js and src/anvil.js; verification-id: provider-browser)
- [x] Pin SDKs and bundle true browser ethers/viem/wagmi-core injected flows against owned local Anvil, asserting real receipts/state/revert data, discovery and negative routing; no mock connectors, SKIP or Node-only SDK substitution (verification: e2e - npm run test:sdk; test/sdk-compat.test.js; verification-id: provider-browser)
- [x] Migrate existing example/integration tests to 0.2.0 authorization/release semantics without weakening old fault/ownership assertions; include this real browser regression in test:sdk or run its focused runner from sdk gate with total bound 180s (verification: e2e - npm run test:sdk; test/integration.test.js; verification-id: provider-browser)
- [x] Update package 0.2.0 exports/types/lock, both-module external tgz consumer, README migration/limits and measured ACCEPTANCE evidence; keep P-256 and private/UNLICENSED unchanged (verification: integration - npm run test:pack; test/pack-consumer.js; verification-id: provider-package)

## Final Validation

Run cflx openspec validate add-defi-provider --archive-gate. Archive must promote canonical spec without depending on a live active-change path. Structural validation alone is not runtime PASS.

## Future Work

Separate dependent signing implementation, then pinned protocol fork and independent dApp acceptance. No release, push or deployment authorized by this change.

## Notes

- evidence (provider-unit): `npm test` 16 passed / 0 failed / 0 skipped. Unit tests use an in-memory `fetch` stub and fake BrowserContext (test/helpers.js); no sockets, processes, filesystem state or browser.
- evidence (provider-browser): `npm run test:sdk` 12 passed / 0 failed / 0 skipped in 36.9 s (bound 180 s, test/run-gate.js); evidence artifacts/sdk/2026-10-27T09-13-05-518Z/evidence.json and artifacts/local-anvil/2026-10-27T09-12-54-969Z/evidence.json (ignored by git).
- evidence (provider-package): `npm run test:pack` PASS, fork-wallet-0.2.0.tgz sha256 71cd9f5135410b7c8eb3eced1e7c53c67fbe6cf1fc92af261955554d70131a3a, CJS+ESM for fork-wallet and fork-wallet/anvil.
- decision: the registered chain set is the initial chain plus `chains` entries; repeating the initial chain ID in `chains` is rejected as a duplicate.
- decision: preflight and ownership failures map to 4901; revoke/account-change invalidation to 4100; chain-switch invalidation to 4901; disconnect to 4900; policy refusal stays -32603.
- decision: non-transaction approvals are recorded in `calls` with final state `approved`; README documents the versioned state set and migration.
- remediation (acceptance attempt 1): pre-admission scope changes now fail with the last bumpEpoch cause (4900 disconnect, 4901 chain switch, 4100 revoke/account change) via `lastScopeChange` in src/index.js; package-lock.json root version synced to 0.2.0 with dependency entries unchanged; evidence above re-measured after the fix.
- decision: `startAnvil` also returns the owned child `pid` (read-only) for evidence; no RPC function is returned.

