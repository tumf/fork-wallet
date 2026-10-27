## Implementation Tasks
- [ ] Promote pinned guarded spike into examples/aave with exact transaction and egress policies; add fail-closed aggregate outcomes, runner metadata, redaction and pin checks (verification: unit - npm run test:aave:logic; verification-id: aave-logic)
- [ ] Add selfcheck outcome matrix and real local browser redirect-denial control, retain positive/negative policy and receipt tests (verification: unit - npm run test:aave:logic; verification-id: aave-logic)
- [ ] Execute fresh unchanged-Aave fork UI acceptance, record route-specific results, diagnostic degradation and cleanup. A code4 needs explicit evidence inspection; code2/3 cannot complete (verification: e2e - npm run test:aave; verification-id: aave-runtime)
- [ ] Document pinned setup, exit statuses and incomplete product capabilities; retain existing unit/SDK/pack gates without skips and update OpenSpec canonical spec on archive (verification: integration - npm test && npm run test:sdk && npm run test:pack; verification-id: aave-regression)

## Final Validation
cflx openspec validate add-aave-acceptance --strict; cflx openspec validate add-aave-acceptance --archive-gate. Keep runnable files outside change directory so archive paths remain valid. No push/release. Do not fabricate missing runtime evidence.

## Notes
When accepting exit4, record the evidence.json path, three runtime route results, diagnosticsDegraded and close results here. Exit4 remains DEGRADED, never clean PASS.
[Evidence is filled after execution; proposal-only stage has none.]
