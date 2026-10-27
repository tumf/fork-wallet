## Implementation Tasks

- [ ] Implement per-method bounded read/transaction validation and data-preserving RPC error path in src/index.js and types, including caller frame/origin guards; add nonzero unit negative/positive schema cases (verification: unit - npm test; test/unit.test.js and test/provider.test.js; verification-id: provider-unit)
- [ ] Implement permission/discovery/registered chain controls and requestId/epoch state transitions exactly as design.md, including late policy races, lost/unknown distinctions and no retry; update unit and event contract tests (verification: unit - npm test; test/provider.test.js; verification-id: provider-unit)
- [ ] Extract owned Anvil lifecycle plus restricted public read gateway into packaged fork-wallet/anvil with startup/timeout/ownership/stop/CORS/batch tests; retain no runtime dependency and only kill owned children (verification: integration - npm run test:sdk; test/sdk-compat.test.js and src/anvil.js; verification-id: provider-browser)
- [ ] Pin SDKs and bundle true browser ethers/viem/wagmi-core injected flows against owned local Anvil, asserting real receipts/state/revert data, discovery and negative routing; no mock connectors, SKIP or Node-only SDK substitution (verification: e2e - npm run test:sdk; test/sdk-compat.test.js; verification-id: provider-browser)
- [ ] Migrate existing example/integration tests to 0.2.0 authorization/release semantics without weakening old fault/ownership assertions; include this real browser regression in test:sdk or run its focused runner from sdk gate with total bound 180s (verification: e2e - npm run test:sdk; test/integration.test.js; verification-id: provider-browser)
- [ ] Update package 0.2.0 exports/types/lock, both-module external tgz consumer, README migration/limits and measured ACCEPTANCE evidence; keep P-256 and private/UNLICENSED unchanged (verification: integration - npm run test:pack; test/pack-consumer.js; verification-id: provider-package)

## Final Validation

Run cflx openspec validate add-defi-provider --archive-gate. Archive must promote canonical spec without depending on a live active-change path. Structural validation alone is not runtime PASS.

## Future Work

Separate dependent signing implementation, then pinned protocol fork and independent dApp acceptance. No release, push or deployment authorized by this change.
