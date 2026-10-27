## Implementation Tasks

- [x] Add opt-in installed-runtime mode and fail-closed CLI/resolution/child handling to pack-consumer; preserve current pack behavior and test the negative paths (verification: integration: npm run test:pack:runtime via test/pack-consumer.js; verification-id: installed-runtime).
- [x] Reuse the generic real integration suite and server helper with test-only installed-export selection, correct evidence sources and verified cleanup, without duplicating assertions or source fallback (verification: e2e: npm run test:pack:runtime via test/integration.test.js; verification-id: installed-runtime).
- [x] Wire the package script, document prerequisites and runnable usage, run focused source/import regressions, and record actual installed-runtime evidence in ACCEPTANCE.md (verification: e2e: npm run test:pack:runtime via test/pack-consumer.js; verification-id: installed-runtime).

## Final Validation

`cflx openspec validate verify-installed-wallet-runtime --archive-gate`. The gate metadata must refer only to permanent paths, including after archive.

## Future Work

Push/publication requires separate approval; this change does not publish. Third-party app compatibility and Aave cold reads are independent and not blockers for this installed generic-runtime proof.
