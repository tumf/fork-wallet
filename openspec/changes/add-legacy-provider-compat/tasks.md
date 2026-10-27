## Implementation Tasks

- [ ] Add false-only accessor and async zero-argument enable alias inside src/index.js pageScript before existing freeze, with no changes to Node authority paths. Completion: actual installed provider satisfies strict write and permission semantics. (verification: unit - test/legacy-provider.test.js actual serialized production script; verification-id: legacy-local)
- [ ] Add offline regression tests and include test/legacy-provider.test.js in npm test; preserve discovery and immutable members, argument refusal, grant/reject/hold/revoke/disconnect and origin/frame behavior with binding/effect counts. Completion: behavioral failure on unchanged base and success after implementation, not a replacement provider fixture. (verification: unit - node --test test/unit.test.js test/provider.test.js test/legacy-provider.test.js; verification-id: legacy-local)
- [ ] Add bounded test/legacy-compat.test.js using actual browser injection and owned vanilla Anvil, strict legacy render/connect plus real transfer receipt/balance/nonce assertions and refusal/no-send controls; retain external-network denial and owned cleanup. Completion: nonzero real browser tests, no skip or fabricated chain effects. (verification: integration - node test/run-gate.js test/legacy-compat.test.js; verification-id: legacy-browser)
- [ ] Update README.md and ACCEPTANCE.md with exact legacy surface, unchanged safety limits, measured fixture-only scope and remaining third-party swap gate. Preserve existing product/SKD/signing/pack checks and run declared regression gate. Completion: documented claims match actual gate output, all declared commands successful. (verification: integration - npm test && npm run test:sdk && npm run test:pack; verification-id: legacy-regression)

## Future Work
Parent independently replays unchanged pinned Uniswapper after integration, with explicit fresh bounded public-fork budget and no source patches. UI quote and real swap remain unverified until receipt/events/balance evidence succeeds. Publication/push/release requires separate approval.

## Final Validation
Archive validation is authoritative: cflx openspec validate add-legacy-provider-compat --archive-gate. Strict authoring check: cflx openspec validate add-legacy-provider-compat --strict --evidence warn.
