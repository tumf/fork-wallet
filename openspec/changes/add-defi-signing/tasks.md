## Implementation Tasks
- [ ] Add explicit signing opt-in/types and exact bounded message/typed-input validation with policy/origin/account/domain gates and no runtime crypto dependency (verification: unit - npm test; verification-id: signing-unit)
- [ ] Reuse approval/epoch state machine for signed/unknown/cancelled outcomes, no lost signing, no stale signature delivery, and strict trace/error redaction; add nonzero policy-race/sentinel/negative tests (verification: unit - npm test; verification-id: signing-unit)
- [ ] Add true browser ethers/viem/wagmi-core signing paths on owned local Anvil with independent recovery booleans, both typed param forms, field structures and no payload/signature artifacts; preserve all previous browser/ownership/fault assertions (verification: e2e - npm run test:sdk; verification-id: signing-browser)
- [ ] Update 0.3.0 package/lock/types/README/ACCEPTANCE, execute both-module external consumer and all predecessor gates, preserve private/UNLICENSED and promote canonical spec (verification: integration - npm run test:pack; verification-id: signing-package)

## Final Validation
cflx openspec validate add-defi-signing --archive-gate. Runtime counts nonzero and zero skipped; no changing acceptance to hide failures. A missing browser/Anvil is FAIL, not skip. No push/release.
