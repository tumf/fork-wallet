# fork-wallet

A **test-only EIP-1193 / EIP-6963 wallet** for Playwright. It injects one provider into the main frame of one
explicitly allowed loopback page origin, asks your test script to approve every connection, chain switch and
transaction, and submits approved transactions through **your own loopback Anvil node** using that node's unlocked
account. Reads are forwarded only from a bounded allowlist. The dApp under test sees real transaction hashes,
receipts, revert data and state changes on a disposable local EVM.

It is not MetaMask, not a production wallet, holds no key and computes no signature itself. Version 0.3.0 adds
**opt-in** `personal_sign` and `eth_signTypedData_v4` for disposable local accounts: when you install it with a
signing policy, approved requests are signed by the owned node's unlocked account on local chains 31337/31338 only
(see [Signing](#signing-opt-in)). It is **not** general DeFi, mainnet-fork, real-wallet, SIWE or arbitrary-dApp
support (see [Limitations](#trust-boundaries-and-limitations)).

## Quickstart

```sh
npm install --save-dev ./fork-wallet-0.3.0.tgz   # local tarball; the package is private and not published
```

```js
const { chromium } = require('playwright');
const { installForkWallet } = require('fork-wallet');
const { startAnvil } = require('fork-wallet/anvil');

const node = await startAnvil({ chainId: 31337 });   // owned vanilla Anvil 1.8.3 child + read gateway
node.configureOrigin('http://127.0.0.1:3000');        // the only origin allowed to use node.publicEndpoint
// Serve your dApp on http://127.0.0.1:3000 and give it node.publicEndpoint as its public read RPC URL.
const browser = await chromium.launch();
const context = await browser.newContext({ serviceWorkers: 'block' });
const wallet = await installForkWallet(context, {
  endpoint: node.endpoint,          // private management URL: never give it to the page
  origin: 'http://127.0.0.1:3000',
  chainId: node.chainId,
  account: node.account,
  beforeSend: node.beforeSend,      // ownership guard (owned child alive and sole listener)
  validateTransaction(tx) {         // mandatory content policy
    if (tx.to !== EXPECTED_TO) throw new Error('unexpected transaction');
  },
});
const page = await context.newPage();
await page.goto('http://127.0.0.1:3000/');
// The dApp connects (eth_requestAccounts / wallet_requestPermissions) and sends; each is an approval request.
wallet.setMode('approve');          // default decision; or nextRequest({method, mode}) for one request
console.log(wallet.calls, wallet.submitted);
await browser.close();
await node.stop();                  // stops only the child this helper started
```

## API: `fork-wallet`

`installForkWallet(context, options) → Promise<ForkWallet>`. `context` is a Playwright `BrowserContext` (only
`exposeBinding`, `addInitScript` and `pages` are used). Install once per context.

| Option | Required | Meaning |
| --- | --- | --- |
| `endpoint` | yes | `http://127.0.0.1:<port>` management endpoint of your node. Anything else is refused. |
| `origin` | yes | Exact `http://127.0.0.1:<port>` origin. Only that origin's **main frame** gets `window.ethereum` and may call the binding; subframes (even same-origin) and other origins get 4200. |
| `chainId` | yes | Positive integer or canonical hex. The node must report it. No default. |
| `account` | yes | Account unlocked on that node. |
| `validateTransaction(tx)` | yes | Called with the frozen normalized transaction before admission and again right before dispatch (after preflight). Throw to refuse (-32603). |
| `beforeSend()` | yes | Ownership guard. Called before every forwarded read and twice per preflight. Throw when the node is no longer yours (4901). |
| `chains` | no | Additional pre-registered chains `[{endpoint, chainId, account, beforeSend}]`, unique chain IDs, not repeating the initial chain. No other chain can ever be added. |
| `clientVersion` | no | RegExp for `web3_clientVersion`. Default `/^anvil\//i`. |
| `timeoutMs` | no | Per-RPC timeout 1–15000. Default 15000. |
| `signing` | no | Exactly `{validateSignature(request)}`. Absent (default): `personal_sign` and `eth_signTypedData_v4` are 4200. Present: every configured chain must be 31337 or 31338, otherwise install fails -32602. `validateTransaction` never implies a signing policy. See [Signing](#signing-opt-in). |

### Page methods

| Method | Behaviour |
| --- | --- |
| `eth_accounts` | `[]` until authorized, then `[activeAccount]`. Never the node's account list. |
| `eth_requestAccounts` | If unauthorized: approval request; on approve grants permission and emits `accountsChanged([account])` once. If already authorized: returns immediately. |
| `wallet_requestPermissions` | Params exactly `[{eth_accounts: {}}]`. Always an approval request. Returns `[descriptor]`. |
| `wallet_getPermissions` | `[]` or exactly `[{invoker: origin, parentCapability: 'eth_accounts', caveats: [{type: 'restrictReturnedAccounts', value: [account]}]}]`. |
| `wallet_revokePermissions` | Params exactly `[{eth_accounts: {}}]`. Returns `null`, clears permission, invalidates pending requests, emits `accountsChanged([])`. Not a disconnect. |
| `wallet_switchEthereumChain` | Params exactly `[{chainId}]`. Requires authorization (4100). Unregistered target 4902. Same chain: `null` without approval. Otherwise approval, then target preflight, then switch: `chainChanged(chainId)` and, when the account differs, `accountsChanged([account])`. |
| `eth_sendTransaction` | Requires authorization (4100). See [Transactions](#transactions). |
| `personal_sign`, `eth_signTypedData_v4` | 4200 unless installed with `signing` (recorded with reason `signing-disabled`). With a policy: requires authorization (4100) and is an approval request. See [Signing](#signing-opt-in). |
| Reads | `eth_chainId` (answered locally), `net_version`, `eth_blockNumber`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`, `eth_call`, `eth_estimateGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_feeHistory`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getLogs`. Available without account permission. Forwarded to the active node after the ownership guard and per-method validation. |
| Everything else | 4200 and recorded in `wallet.unsupported`: `eth_sign`, `eth_signTypedData` / `_v1` / `_v3`, `eth_signTransaction`, `wallet_sendTransaction`, `wallet_sendCalls`, `wallet_addEthereumChain`, `eth_sendRawTransaction`, `eth_subscribe`, filters, `anvil_*`, `evm_*`, `debug_*`, `admin_*`, … There is no passthrough. |

Request shape: an object with only `method` (string) and optional `params` (array), at most 1 MiB serialized
(otherwise -32600). Zero-argument methods accept omitted params or `[]` only.

### Read validation

Every read has an exact parameter count and field allowlist. Validators build fresh values; untrusted objects are
never forwarded as received. Addresses are 20 bytes, hashes 32 bytes, storage slots a canonical quantity or 32-byte
word, quantities canonical hex (no leading zeros), bytes even-length hex, block references
`latest/earliest/pending/safe/finalized` or a quantity (no EIP-1898 objects).

- `eth_call` / `eth_estimateGas`: `[call]` or `[call, block]`; call fields `from` (caller-chosen, never the wallet
  account implicitly), `to`, `data`, `value`, `gas`, fee fields, `type`, `nonce`, `chainId`, `accessList`. **No state
  override parameter.**
- `eth_getLogs`: `blockHash` exclusively, or a `fromBlock`/`toBlock` range of at most 10 000 blocks; tags are
  resolved to explicit heights before forwarding. `address` one or up to 20; `topics` at most 4 positions with up to
  20 alternatives each.
- `eth_feeHistory`: 1–1024 blocks, at most 100 finite ascending percentiles in [0, 100].
- Responses are bounded to 16 MiB (Content-Length and streamed body), upstream error `data` is kept only if it
  serializes within 64 KiB. Upstream `code`/`message`/`data` (for example ABI revert data, code 3) are preserved to the
  page `Error`.

### Transactions

One object. `from` is required and must be the active account (case-insensitive). `to` is optional only for a
deployment with non-empty `data`. Optional: `value`, `data`, `chainId` (must equal the active chain), `gas`,
`gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `nonce`, `type` (`0x0`, `0x1`, `0x2`), `accessList`
(`[{address, storageKeys}]`, at most 1024 entries+keys). Refused with -32602: unknown fields and aliases (`gasLimit`,
`input`), numbers or non-canonical hex, `gasPrice` mixed with EIP-1559 fields, fee fields contradicting `type`,
`accessList` on type `0x0`, `maxPriorityFeePerGas > maxFeePerGas`. Values are never rewritten: no automatic nonce,
fee or gas changes. The node fills what you omit.

Flow: shape → authorization → `validateTransaction` → **admission** (`calls` entry with `requestId`, epoch, origin,
account, chain and endpoint binding, `inputHash` = sha256 of the exact JSON the page sent) → decision (mode / held
release) → preflight (`beforeSend`, `eth_chainId`, `web3_clientVersion`, `eth_accounts`, `beforeSend`) →
`validateTransaction` → synchronous stale check and `dispatching` transition → one `eth_sendTransaction` on the bound
node → hash check → enrichment by `eth_getTransactionByHash` (`sender`, `nonce`, `type`).

### Signing (opt-in)

```js
const wallet = await installForkWallet(context, {
  endpoint: node.endpoint, origin, chainId: 31337, account: node.account, beforeSend: node.beforeSend,
  validateTransaction() {},
  signing: {
    // Mandatory. Called with a deep-frozen SignatureRequest before admission and again right before dispatch.
    validateSignature(request) {
      if (request.method === 'eth_signTypedData_v4' && request.typedData.primaryType !== 'TestNote') throw new Error('refused');
    },
  },
});
```

Only for **disposable** accounts: the packaged `startAnvil` uses `--mnemonic-random` and accepts no key. If you
register your own node, you are responsible for its accounts being throwaway. Signing is limited to chain IDs 31337
and 31338; the chain ID is a scope limiter, **not** a cryptographic invalidation (a `personal_sign` signature is valid
for that key on any chain). Mainnet-ID or fork signing would need a separate isolation design and is refused.

Exact inputs (anything else is -32602, and messages never echo your data):

- `personal_sign`: exactly `[message, address]`. `message` is even-length `0x` hex bytes, at most 65 536 bytes (empty
  `0x` is structurally allowed and forwarded unchanged; Anvil decides). No plain UTF-8 string, no address-first alias.
  `address` must equal the active authorized account (case-insensitive); no other unlocked or impersonated address.
  Forwarded as `[message, activeAccount]`.
- `eth_signTypedData_v4`: exactly `[address, typedData]`, `typedData` a JSON string or a plain object, at most 65 536
  UTF-8 bytes (both as received and as re-serialized). JSON text is parsed exactly once with `JSON.parse` (duplicate
  keys: last wins); the parsed value is what the policy sees and what is forwarded, as
  `[activeAccount, JSON.stringify(typedData)]`. Only own plain objects/arrays, strings, booleans, `null` and
  `Number.isSafeInteger` numbers; no floats, unsafe integers, `undefined`, functions, bigint, getters, sparse arrays or
  `__proto__` / `prototype` / `constructor` keys; depth ≤ 32, ≤ 4096 values. Large integers must be decimal or hex
  strings. Top-level keys exactly `types`, `primaryType`, `domain`, `message`. `types`: ≤ 64 types, each ≤ 64 unique
  `{name, type}` fields (1–128 characters), must define `EIP712Domain`; `primaryType` names another defined type.
  `domain` keys only `name`, `version` (strings), `chainId` (mandatory: safe integer, decimal string or canonical hex,
  must equal the active chain), `verifyingContract` (20 bytes), `salt` (32 bytes), and `EIP712Domain` declares exactly
  those keys with their standard types. `message` is an object. Type syntax and value encoding are left to Anvil:
  invalid nested values fail there (sanitized error), never with a fake success.

Order: caller frame → request shape → opt-in (4200) → params array → transport (4900) → authorization (4100) →
input (-32602) → lost check (-32602) → `validateSignature` → **admission** → decision (mode / held release) →
preflight → `validateSignature` → synchronous stale check and `dispatching` → one RPC on the bound node → result must
be exactly 65 bytes of hex → synchronous recheck of epoch, connection, authorization, active chain and account →
the actual Anvil signature is returned.

Signing records in `calls` contain `requestId`, `method`, `account`, `chainId`, `endpoint`, `epoch`, `mode`, times,
`outcome`, `inputHash` (sha256 of the normalized request), `domain` (`{chainId, verifyingContract}` for typed data),
`signatureReturned` (a well-formed signature came back from the node) and `delivered` (it was returned to the page).
They **never** contain the message, the typed data or the signature, and `submitted` stays transaction hashes only.
Errors on signing paths carry a fixed message and the numeric code only: no upstream message or `data` (Anvil echoes
payload values in its errors), no text thrown by your policy (refusal is -32603 `signature refused by policy`).

| Signing `outcome` | Meaning |
| --- | --- |
| `signed` | The node signed; the page got the signature. |
| `signed-discarded` | The node returned a signature, but the scope changed after dispatch (revoke/account 4100, chain 4901, disconnect 4900). Attribution stays with the original epoch/account/chain; the signature is dropped, not delivered. Generation cannot be undone. |
| `unknown` | Timeout, transport or integrity failure after dispatch, or a malformed result (-32603). **A signature may have been generated**; this is never proof that none was. |
| `failed` | Before dispatch, or the node answered with a JSON-RPC error (its numeric code is kept, its message dropped). |
| `rejected` / `cancelled` | 4001 / invalidated before dispatch. Nothing was sent to the node. |

Signing has no `lost` mode: while `setMode('lost')` is active a signing request fails -32602 before the policy and
before admission (no one-shot override is consumed), `nextRequest({method: <signing>, mode: 'lost'})` throws -32602,
and `release(id, 'lost')` on a held signing request throws and leaves it held. There are no retries.

Do not record Playwright traces, HAR files, videos or screenshots of contexts that sign, and do not log page values
that hold signatures; keep signatures in the page and return booleans (for example an in-page recovery check).

### Modes and approvals

Approval requests are `eth_requestAccounts`, `wallet_requestPermissions`, `wallet_switchEthereumChain`,
`eth_sendTransaction` and, when enabled, `personal_sign` / `eth_signTypedData_v4`. Exactly one may be outstanding at a time (including while dispatching); another gets -32002.
Reads run in parallel.

| Mode | Next approval request |
| --- | --- |
| `approve` (default) | Approved. |
| `reject` | 4001, nothing changes, nothing is submitted. |
| `hold` | Waits for `release(requestId, outcome)`. |
| `lost` | Transactions only: submitted, hash recorded in `submitted`, then -32603 to the page. Connection, permission and switch requests treat a global `lost` as `approve`; signing requests fail -32602. |

`nextRequest({method, mode})` queues a one-shot decision for the next request of that approval method (reads never
consume it; `lost` is valid only for `eth_sendTransaction`). `whenHeld()` resolves with the held `requestId`.
`release(requestId, outcome)` releases exactly that request once; a wrong ID, a second release or an already
invalidated request fails.

### Epochs, invalidation and outcomes

Any scope change — `revoke()` / `wallet_revokePermissions` (4100), `setAccount()` (4100), a chain switch (4901),
`disconnect()` (4900) — increments the epoch and cancels the outstanding request if it has not reached
`dispatching`. A continuation that returns later from `validateTransaction` or `beforeSend` sees the stale epoch and
stops before dispatch. A write that is already dispatching is never "cancelled": it stays attributed to its original
chain and finishes as one of:

| `outcome` | Meaning |
| --- | --- |
| `submitted` | Node returned a hash; the page got it. |
| `response-lost` | Node returned a hash (recorded); the page got -32603. |
| `unknown` | Timeout, transport or integrity failure after dispatch, or a malformed hash. **The node may have executed it.** |
| `failed` | Before dispatch (preflight etc.), or the node answered with a JSON-RPC error (code/message/data preserved). |
| `rejected` / `cancelled` | Decision 4001 / invalidated by a scope change. Nothing was sent. |
| `approved` | A non-transaction approval that completed. |
| `signed` / `signed-discarded` | Signing only; see [Signing](#signing-opt-in). |

There are no internal retries and no same-calldata deduplication. Exactly-once is not claimed: reconcile with the
node (`eth_getTransactionCount`, receipts by hash) before any retry of your own.

### Handle

- `calls`, `submitted`, `unsupported`, `info` (frozen EIP-6963 info), `chainId`, `account`, `chains`, `mode`,
  `signing` (installed with a signing policy), `connected`, `authorized`, `epoch`, `held`, `heldRequestId`.
- `setMode(mode)`, `nextRequest({method, mode})`, `whenHeld()`, `release(requestId, outcome = 'approve')`.
- `revoke()`: clears permission, emits `accountsChanged([])`.
- `disconnect()`: transport loss; pending request fails 4900; later requests 4900 (`eth_accounts` returns `[]`,
  `wallet_getPermissions`/`wallet_revokePermissions` still work); emits `disconnect({code: 4900})` once. Permission is
  kept.
- `reconnect()`: preflights the active node, restores transport and emits `connect({chainId})` once. Never regrants
  a revoked permission.
- `setAccount(address)`: only an account unlocked on the active owned node.
- `switchChain(chainId)`: Node-side switch to a registered chain after target preflight (no approval).

These controls are Node-only; nothing is exposed to the page. Events reach every current page whose main frame is
on the allowed origin; a closed page or a throwing listener cannot block the others. Permission is per wallet
install (one origin), shared across pages and reloads; a fresh context starts unapproved; a reload replays nothing.

### Page provider and EIP-6963

`window.ethereum` is a frozen object with `request`, `on`, `removeListener`, `off` and `isForkWallet: true` (no
`isMetaMask`). Errors carry `code`, `message` and, when present, `data`. The same object is announced with
`eip6963:announceProvider` during initialization and on every `eip6963:requestProvider`, with frozen info
`{uuid (UUIDv4, stable per install), name: 'Fork Wallet', rdns: 'dev.forkwallet.test', icon: <constant data: SVG>}`.
`connect({chainId})` is emitted once per page initialization (after the announce, in a microtask once the provider
state is known) and after `reconnect()`; never per request.

### Error codes

| Code | When |
| --- | --- |
| 4001 | Rejected decision. |
| 4100 | Not authorized (send/switch/sign before connect), or the request was invalidated by revoke / account change. |
| 4200 | Unsupported method, signing without a signing policy, or a caller that is not the allowed origin's main frame. |
| 4900 | Disconnected. |
| 4901 | Selected node unavailable: ownership guard, chain, client or account preflight failed, or invalidated by a chain switch. |
| 4902 | `wallet_switchEthereumChain` to an unregistered chain. |
| -32002 | Another approval is outstanding. |
| -32600 | Malformed request object (not an object, extra keys, non-string method, > 1 MiB). |
| -32602 | Malformed params / transaction / read / signing input, wrong signer or typed-data domain, signing in lost mode, or invalid install options. |
| -32603 | Policy refusal, lost response, unknown outcome, RPC integrity failure. |
| other | Upstream JSON-RPC errors from the node are passed through (e.g. 3 with revert `data`). |

Other exports: `createLoopbackRpc(endpoint, {timeoutMs, maxResponseBytes})` (strict, bounded, never retries; errors
carry `kind`: `upstream`, `transport` or `integrity`), `validateReadRequest`, `checkTransaction`,
`checkSignatureRequest(method, params, account, chainId)`, `requireLoopbackEndpoint`, `requireOrigin`,
`normalizeChainId`, `ForkWalletError(code, message, data?)`, `MODES`, `RELEASE_OUTCOMES`, `METHODS`, `READ_METHODS`,
`WALLET_METHODS`, `APPROVAL_METHODS`, `SIGNING_METHODS`, `SIGNING_CHAINS`, `TRANSACTION_FIELDS`, `TRANSACTION_TYPES`,
`STATES`, `CODES`, `LIMITS`, `PROVIDER_INFO`. `METHODS` and `APPROVAL_METHODS` are static supported-capability lists
that include the signing methods; they say nothing about whether a given install enabled signing.

## API: `fork-wallet/anvil`

`startAnvil({chainId = 31337, anvil = 'anvil', timeoutMs = 10000}) → Promise<OwnedAnvil>`. No other options: no CLI
arguments, mnemonic, key or fork URL can be passed.

- Refuses credential-like environment variables (`PRIVATE_KEY`, `MNEMONIC`, `SEED_PHRASE`, `KEYSTORE`, `ETH_FROM`,
  `ETH_PASSWORD`, `FOUNDRY_*`, `ANVIL_*`, `CAST_*`, `DEPLOYER`). The child gets only `PATH` and `HOME`.
- Runs `anvil --host 127.0.0.1 --port <free> --chain-id <id> --mnemonic-random --silent --no-cors` with stdio ignored:
  random disposable accounts, never the well-known default mnemonic. Only `anvil/v1.8.3` is accepted.
- Returns only after the client version, chain ID, unlocked accounts and **exclusive listener PID** (`lsof`) are
  verified within `timeoutMs`. Any startup failure stops the child it started.
- Result `{endpoint, publicEndpoint, chainId, account, pid, beforeSend, configureOrigin, stop}` (frozen; no RPC
  function). `endpoint` is the private management URL. `beforeSend()` throws unless the owned child is alive and is the
  only listener on its port. `stop()` is idempotent: closes the gateway, sends TERM to that `ChildProcess` only, KILL
  after 5 s if needed, waits for exit and listener release, and throws on failure. It never signals a guessed PID or
  a foreign listener. There is no process-global exit handler.

**Read gateway** (`publicEndpoint`, also `startReadGateway({endpoint, beforeSend})`): a loopback HTTP server in your
test process. Exact path `/`, `POST` and `OPTIONS` only, `Content-Type: application/json`, request ≤ 1 MiB (413),
response ≤ 16 MiB, JSON-RPC 2.0 objects with an `id` (string/number/null; notifications get -32600), batches of 1–20.
Every item runs the ownership guard first, then the same read allowlist and validators as the provider; `eth_accounts`,
writes, signing, `anvil_*`/`evm_*`/`debug_*`/`admin_*` and unknown methods get 4200 per item, including inside a batch.
CORS is granted only to the origin set by `configureOrigin(origin)` (once; a different origin later throws); requests
carrying any other `Origin`, or any `Origin` before configuration, get 403. Requests without an `Origin` (your Node
test runner) are served without CORS headers.

## Migration from 0.2.0

0.3.0 is additive for installs without `signing`: both signing methods stay 4200 (now recorded with reason
`signing-disabled` instead of `unsupported-method`) and every other behaviour is unchanged.

| 0.2.0 | 0.3.0 |
| --- | --- |
| `METHODS` / `APPROVAL_METHODS` / `ApprovalMethod` without signing. | They include `personal_sign` and `eth_signTypedData_v4` (static capability). Filter `calls` by `method` if you only want transactions. |
| `CallState` had no signing states. | Adds `signed` and `signed-discarded`; `Call` adds `domain`, `signatureReturned`, `delivered`. `inputHash` of a signing record hashes the normalized request. |
| `UnsupportedRecord.reason`: `unsupported-method` / `caller-frame`. | Adds `signing-disabled`. |
| No `signing` option. | `signing: {validateSignature}` enables signing on chains 31337/31338 only. |
| `LIMITS` had no signing bounds. | Adds `signMessageBytes`, `typedDataBytes`, `typedDataDepth`, `typedDataNodes`, `typedDataTypes`, `typedDataFields`, `typedDataNameChars`. |

## Migration from 0.1.1

0.2.0 is a breaking release.

| 0.1.1 | 0.2.0 |
| --- | --- |
| Connected and authorized at install; `eth_accounts` returned the account. | Starts unauthorized. The page must call `eth_requestAccounts` or `wallet_requestPermissions`, which is an approval request (approve by default). Sends and switches before that fail 4100. |
| `release(outcome)` | `release(requestId, outcome)`; get the ID from `await whenHeld()`. |
| `whenHeld()` resolved `undefined`. | Resolves the `requestId`. |
| `disconnect()` emitted `accountsChanged([])` + `disconnect`. | Emits only `disconnect`; permission is kept. Use `revoke()` for `accountsChanged([])`. New `reconnect()`. |
| `calls[i].outcome`: `pending/submitted/rejected/lost/failed`. | `outcome` is the request state (see table above); `lost` → `response-lost`; timeouts after dispatch are `unknown`, not `failed`. Records include `requestId`, `method`, `epoch`, `chainId`, `endpoint`, `account`, `inputHash`, `sender`, `nonce`, `type`. Non-transaction approvals are recorded too: filter by `method`. |
| Only `from/to/value/data/chainId`; `gas` etc. were -32602. | Legacy, 2930 and 1559 fields, deployments, `nonce` and `accessList` are accepted with strict validation. Use `gasLimit` (still unknown) if you need a -32602 control. |
| Four methods; `eth_call` was 4200. | Bounded read allowlist, permission methods, registered-chain switching. |
| Preflight failures were -32603. | Preflight/ownership failures are 4901; policy refusals stay -32603. |
| Errors had `code`/`message`. | Upstream `data` is preserved (`ForkWalletError(code, message, data)`). |
| Example harness owned Anvil. | `fork-wallet/anvil` (`startAnvil`, read gateway) is packaged; `examples/local-anvil/harness.js` only serves files. |
| No EIP-6963, no `connect`/`chainChanged`. | EIP-6963 announce, `connect`, `chainChanged`, `accountsChanged` on grant/switch/account change. |
| `timeoutMs` unbounded. | 1–15000. |

## Trust boundaries and limitations

- **Adapter proof only.** Passing tests prove that a dApp drives an EIP-1193/EIP-6963 provider correctly and that its
  transactions execute on your local node. They prove nothing about MetaMask, WalletConnect, hardware wallets or any
  real user approval.
- **Executed coverage is exact, not general.** The SDK gate runs ethers 6.17.0, viem 2.57.12 and @wagmi/core 2.22.1
  (bundled with esbuild 0.28.2) in Playwright 1.56.1 Chromium against Anvil 1.8.3 vanilla chains 31337/31338 on the
  host recorded in ACCEPTANCE.md. Other versions, other SDK paths, React layers, mainnet/Polygon forks, Permit2 and
  existing third-party dApps are not claimed.
- **Signing is opt-in, local and disposable only.** Only `personal_sign` and `eth_signTypedData_v4`, only with a
  signing policy, only on chains 31337/31338, only by the active authorized node account. Signatures are real: a
  local chain ID does not make a `personal_sign` signature unusable elsewhere, so never sign with a key that matters.
  No ERC-2612/Permit2 consumption, SIWE or authentication server is exercised or claimed. `eth_sign`,
  `eth_signTypedData` v1/v3, `eth_signTransaction`, raw submission, external key input, key export, account
  abstraction (`wallet_sendCalls`, EIP-5792/7702), `wallet_sendTransaction` and `wallet_addEthereumChain` are honest
  4200 responses. The read gateway never signs.
- **`beforeSend`, `validateTransaction` and `validateSignature` are trusted harness callbacks**, not cryptographic
  proofs (`beforeSend` is not proof that a key is fresh). The packaged
  `beforeSend` checks the owned child and its exclusive listener with `lsof`; a hostile privileged local process is out
  of scope. An empty validator submits any well-formed transaction on your node.
- **Not a sandbox.** Exact-origin binding, main-frame checks, CSP and Playwright route deny lists in the tests are
  protection against accidental network use, not OS-level isolation. Nothing stops a malicious same-origin page from
  replacing its own JS objects. The management endpoint is unauthenticated loopback HTTP.
- **Anvil accounts are disposable.** `startAnvil` uses `--mnemonic-random`; never fund such accounts on a real chain.
- **Ambiguous submission.** `unknown` and transport failures are not proof of no send, and for signing not proof that
  no signature was generated. Reconcile on the node before retrying.
- Node >= 22. No runtime dependencies. Playwright is an optional peer (>= 1.40). `lsof` is required by
  `fork-wallet/anvil`. macOS is the executed platform; Linux portability is not certified.

## Tests

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm test` | `test/unit.test.js`, `test/provider.test.js`, `test/signing.test.js`: option/request/frame refusals, transaction and read schemas, RPC integrity and bounds, preflight, modes, permissions, registered chains, epochs and late policy races, outcomes, events, page provider and EIP-6963 in a VM; signing opt-in, exact input bounds, handle order, approvals, pre/post-dispatch scope races and sentinel redaction (synthetic stub results, labelled as such; not cryptographic evidence). In-memory doubles only (stubbed `fetch`, fake context). | Node |
| `npm run test:sdk` | Bounded runner (`test/run-gate.js`, 180 s total) for `test/anvil.test.js` (owned lifecycle, fake-binary failures, foreign listener, gateway rules), `test/sdk-compat.test.js` (real Chromium + bundled ethers/viem/wagmi-core on two owned chains, receipts and state, revert data, logs, lost/fallback, switch, reload/reconnect, negative routing; signing stays 4200 there), `test/signing-compat.test.js` (own policy-enabled context: ethers/viem/wagmi-core sign both methods, ethers and viem recover in-page, refusals and races with dispatch counters, read gateway refusal, redaction of the evidence file) and `test/integration.test.js` (generic dApp regression). Evidence: `artifacts/sdk/<ts>/evidence.json`, `artifacts/signing/<ts>/evidence.json`, `artifacts/local-anvil/<ts>/`. | Anvil 1.8.3, Playwright Chromium (`PLAYWRIGHT_BROWSERS_PATH` honoured), `lsof` |
| `npm run test:integration` | Only the generic dApp regression, same bounded runner. | same |
| `npm run test:pack` | `npm pack`, install into a throwaway consumer outside the repo, load `fork-wallet` and `fork-wallet/anvil` from CJS and ESM, check that private paths are not exported, that there are no runtime dependencies and that signing is default-disabled and opt-in through the installed exports. | Node, npm |

Missing tools are failures, never skips. No test contacts anything beyond 127.0.0.1.

## Packaging

`npm pack` produces `fork-wallet-<version>.tgz` with `src/index.js`, `src/anvil.js`, `index.d.ts`, `anvil.d.ts`,
`README.md` and `package.json`. The package is `private` and `UNLICENSED`: a local release candidate consumed as a
pinned tarball, not a publication. Consumers should record the tarball SHA-256 in their evidence. Existing 0.1.1
consumers (the P-256 Signer test suite) keep their pinned 0.1.1 tarball until they migrate explicitly.
