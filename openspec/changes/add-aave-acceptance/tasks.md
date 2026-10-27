## Implementation Tasks
- [ ] Promote pinned guarded spike into examples/aave with exact transaction and egress policies; add fail-closed aggregate outcomes, runner metadata, redaction and pin checks (verification: unit — verification-id: aave-logic)
- [ ] Add selfcheck outcome matrix and real local browser redirect-denial control, retain positive/negative policy and receipt tests (verification: unit — verification-id: aave-logic)
- [ ] Execute fresh unchanged-Aave fork UI acceptance, record route-specific results, diagnostic degradation and cleanup. A code4 needs explicit evidence inspection; code2/3 cannot complete (verification: e2e — verification-id: aave-runtime)
- [ ] Document pinned setup, exit statuses and incomplete product capabilities; retain existing unit/SDK/pack gates without skips and update OpenSpec canonical spec on archive (verification: integration — verification-id: aave-regression)

## Final Validation
cflx openspec validate add-aave-acceptance --strict; cflx openspec validate add-aave-acceptance --archive-gate. Keep runnable files outside change directory so archive paths remain valid. No push/release. Do not fabricate missing runtime evidence.
