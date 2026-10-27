## Implementation Tasks
- [x] Add explicit signing opt-in/types and exact bounded message/typed-input validation with policy/origin/account/domain gates and no runtime crypto dependency (verification: unit - npm test; verification-id: signing-unit)
- [x] Reuse approval/epoch state machine for signed/unknown/cancelled outcomes, no lost signing, no stale signature delivery, and strict trace/error redaction; add nonzero policy-race/sentinel/negative tests (verification: unit - npm test; verification-id: signing-unit)
- [x] Add true browser ethers/viem/wagmi-core signing paths on owned local Anvil with independent recovery booleans, both typed param forms, field structures and no payload/signature artifacts; preserve all previous browser/ownership/fault assertions (verification: e2e - npm run test:sdk; verification-id: signing-browser)
- [x] Update 0.3.0 package/lock/types/README/ACCEPTANCE, execute both-module external consumer and all predecessor gates, preserve private/UNLICENSED and keep the spec delta archive-gate valid so archive promotes it to the canonical spec (verification: integration - npm run test:pack; verification-id: signing-package)

## Final Validation
cflx openspec validate add-defi-signing --archive-gate. Runtime counts nonzero and zero skipped; no changing acceptance to hide failures. A missing browser/Anvil is FAIL, not skip. No push/release.

## Notes
- evidence signing-unit: `npm test` 24 passed, 0 failed, 0 skipped (new `test/signing.test.js` 8; stub results are labelled STUB and are not cryptographic evidence).
- evidence signing-browser: `npm run test:sdk` 20 passed, 0 failed, 0 skipped, 44.0 s of the unchanged 180 s bound; `test/signing-compat.test.js` 1 + 7 subtests, 14 counted signing dispatches, 13 signatures recovered by both ethers and viem, evidence redaction asserted before writing.
- evidence signing-package: `npm run test:pack` PASS for `fork-wallet-0.3.0.tgz` (sha256 848e3ea5136b7e52de72291d4b2a5fc103e42a22a24ed12bf4673196015ac6f9), CJS and ESM consumer, default-disabled and opt-in signing through installed exports.
- Canonical spec promotion of `specs/defi-signing/spec.md` is performed by archive (as for add-defi-provider); apply verified `cflx openspec validate add-defi-signing --strict` and `--archive-gate` pass.
- The 0.2.0 unit assertion listing `personal_sign` under reason `unsupported-method` now expects reason `signing-disabled`, as the design requires; the sdk-compat and integration default-disabled 4200 assertions are unchanged.
