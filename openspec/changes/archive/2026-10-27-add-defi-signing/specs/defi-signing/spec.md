## ADDED Requirements
### Requirement: Signing is explicit and local disposable-account only
The wallet SHALL disable signing by default. Opt-in requires a separate mandatory signature policy and configured local chain IDs31337/31338. Only personal_sign and eth_signTypedData_v4 for the active authorized unlocked account SHALL be forwarded to owned Anvil; the public read gateway SHALL never sign.
#### Scenario: Disabled or unauthorized signing
- WHEN signing is absent or account permission missing
- THEN return4200 or4100 respectively without dispatch.
#### Scenario: Wrong signer or domain
- WHEN the signer differs from active account or typed domain chain differs from active local chain
- THEN return -32602 without signing.
### Requirement: Approval lifecycle and secret-free diagnostics
Signing SHALL use request IDs, scope epochs, per-request policy and the existing single approval slot. Stale requests SHALL not dispatch or deliver a signature after a scope change. Signing SHALL not retry and SHALL reject lost mode. Logs, calls, evidence and returned signing errors SHALL contain no signature or raw message.
#### Scenario: Pending policy invalidated
- WHEN revoke/account/chain/transport changes before signing dispatch
- THEN cancel with scope error and zero signature RPC calls.
#### Scenario: Signing succeeds
- WHEN an approved valid request is signed
- THEN return actual Anvil signature to caller, mark signed with safe metadata and do not append a transaction hash.
#### Scenario: Response uncertain or upstream echoes payload
- WHEN response fails after dispatch or upstream errors echo the message
- THEN record unknown when generation cannot be ruled out and expose only sanitized signing diagnostics, not raw echoed data.
### Requirement: Actual browser SDK evidence
Both signing methods SHALL execute through ethers, viem and wagmi-core in real Chromium and recover through two independent libraries to the active account; predecessor gates SHALL remain. Evidence SHALL contain booleans/hashes/counters only, never signatures or full messages.
#### Scenario: Independent recovery
- WHEN each SDK requests personal and typed signatures from owned local Anvil
- THEN ethers and viem recovery both match the active account; the test uses no fake connector/signature.
