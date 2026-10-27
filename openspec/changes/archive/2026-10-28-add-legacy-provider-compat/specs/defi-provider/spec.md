## ADDED Requirements

### Requirement: Narrow legacy provider compatibility
The injected provider SHALL support only the measured legacy enable and false-only autoRefreshOnNetworkChange surfaces while remaining frozen, retaining the exact-origin/main-frame permission path and all signing, read, transaction, epoch, timeout and uncertainty invariants. enable SHALL NOT be a new JSON-RPC method.

#### Scenario: Strict legacy render
- **WHEN** a strict script assigns primitive false to autoRefreshOnNetworkChange
- **THEN** it succeeds, the getter returns false, Object.isFrozen remains true, no binding/event is invoked, and any other assigned value throws TypeError without mutating authority or state.

#### Scenario: Legacy account request
- **WHEN** the page invokes enable() with zero arguments
- **THEN** the actual eth_requestAccounts handler governs authorization, rejection, held approval, trace and error data; the result is its account array, never implicit send/sign permission, including when called as an extracted function.

#### Scenario: Invalid legacy call or mutation
- **WHEN** enable receives any argument or page code tries to replace/delete protected members, redefine the accessor, add an unknown property or request the RPC method enable
- **THEN** arguments reject -32602 before any binding, strict object mutation refuses, and the unknown RPC remains 4200; no unintended submission, signature, grant or event occurs.

#### Scenario: Bounded browser verification
- **WHEN** a local legacy API fixture executes real injection, connect and a policy-approved transfer on an owned vanilla chain31337
- **THEN** real receipt and independent balances/nonce verify its one send, rejection/revocation controls send nothing, all owned runtime resources retire, and this evidence is not reported as third-party fork swap acceptance.
