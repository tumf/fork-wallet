## Implementation Tasks

- [x] Make the real legacy browser fixture observe one initial connect independently of module-listener timing, then compare legacy operations against a validated baseline. Keep strict module render and all forbidden-write/refusal/event/receipt/cleanup controls. Completion: missing/wrong/duplicate initialization and any unexpected later connect fail without altering src. (verification: integration - npm run test:legacy && npm run test:legacy && npm run test:legacy; verification-id: legacy-event)
- [x] Run the three fresh legacy gates and existing unit/SDK/pack regression, record executed evidence and narrowly update ACCEPTANCE; no source or dependency change. Completion: nonzero pass counts, zero skips and no owned listeners remain. (verification: integration - npm test && npm run test:sdk && npm run test:pack; verification-id: event-regression)

## Notes
- evidence: only `test/legacy-compat.test.js` changed (test-only EIP-6963 `addInitScript` connect recorder, bounded 10 s wait for exactly one `{chainId:'0x7a69'}`, validated module-event baseline, final no-later-connect check); `src/` and the fixture are unchanged.
- evidence: `npm run test:legacy` x3 separate invocations after `npm ci`: 1 pass / 0 fail / 0 skip each, receipt `0x1`, nonce 0 -> 1, cleanup `failures:[]`; module listener missed the initial connect in all three runs, recorder saw exactly one.
- evidence: `npm test` 30 pass, `npm run test:sdk` 20 pass, `npm run test:pack` PASS; 0 fail, 0 skip. ACCEPTANCE.md section `fix-legacy-init-event-test` records details.
- note: the first three legacy invocations in this worktree failed at prerequisite check (`Cannot find module 'playwright'`, no `node_modules`) before any test ran; recovered with `npm ci`.

## Final Validation
cflx openspec validate fix-legacy-init-event-test --strict --evidence warn
cflx openspec validate fix-legacy-init-event-test --archive-gate
