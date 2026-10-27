## Implementation Tasks

- [ ] Make the real legacy browser fixture observe one initial connect independently of module-listener timing, then compare legacy operations against a validated baseline. Keep strict module render and all forbidden-write/refusal/event/receipt/cleanup controls. Completion: missing/wrong/duplicate initialization and any unexpected later connect fail without altering src. (verification: integration - npm run test:legacy && npm run test:legacy && npm run test:legacy; verification-id: legacy-event)
- [ ] Run the three fresh legacy gates and existing unit/SDK/pack regression, record executed evidence and narrowly update ACCEPTANCE; no source or dependency change. Completion: nonzero pass counts, zero skips and no owned listeners remain. (verification: integration - npm test && npm run test:sdk && npm run test:pack; verification-id: event-regression)

## Final Validation
cflx openspec validate fix-legacy-init-event-test --strict --evidence warn
cflx openspec validate fix-legacy-init-event-test --archive-gate
