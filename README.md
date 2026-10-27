# fork-wallet

A **test-only EIP-1193 wallet** for Playwright. It injects `window.ethereum` into one explicitly allowed loopback
page origin and submits `eth_sendTransaction` through **your own loopback Anvil node** using that node's unlocked
account. The dApp under test sees real transaction hashes, receipts and state changes on a disposable local EVM
(a vanilla Anvil chain or an Anvil fork of a public network) while your test script controls approval.

It is not MetaMask, not a production wallet and holds no key. Use it to drive DeFi/dApp integration tests that
need an automated wallet with approve / reject / hold / lost / disconnect behaviour.

## Quickstart

```sh
npm install --save-dev ./fork-wallet-0.1.1.tgz   # local tarball; the package is not published
```

```js
const { chromium } = require('playwright');
const { installForkWallet } = require('fork-wallet');

// 1. Start your own node on 127.0.0.1 (for example `anvil --host 127.0.0.1 --port 8545 --chain-id 31337`).
// 2. Serve the dApp on 127.0.0.1 and open it with Playwright.
const browser = await chromium.launch();
const context = await browser.newContext();
const wallet = await installForkWallet(context, {
  endpoint: 'http://127.0.0.1:8545',          // exact loopback HTTP JSON-RPC endpoint
  origin: 'http://127.0.0.1:3000',            // exact page origin allowed to use the wallet
  chainId: 31337,                             // explicit; the node must report the same chain
  account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // an account unlocked on that node
  validateTransaction(tx) {                   // mandatory: refuse anything but the exact expected bytes
    if (tx.to !== EXPECTED_TO || tx.data !== EXPECTED_DATA) throw new Error('unexpected transaction');
  },
  beforeSend() {                              // mandatory: assert the node/listener is still yours
    if (anvil.exitCode !== null) throw new Error('anvil is gone');
  },
});
const page = await context.newPage();
await page.goto('http://127.0.0.1:3000/');
// ... drive the dApp; the page calls window.ethereum.request({method: 'eth_sendTransaction', ...})
wallet.setMode('reject');                     // next send fails with 4001 and nothing is submitted
wallet.setMode('approve');                    // next send is submitted and the hash returned
console.log(wallet.submitted);                // real transaction hashes on your node
```

The repository-only runnable example `test/integration.test.js` starts a vanilla Anvil (chain 31337), serves the generic dApp in
`examples/local-anvil/dapp/` from an ephemeral loopback HTTP server and asserts receipts, balances and nonces for
every mode. Run it with `npm run test:integration` (requires `anvil`, Playwright Chromium and `lsof`).

## API

`installForkWallet(context, options) → Promise<ForkWallet>`

`context` is a Playwright `BrowserContext` (only `exposeBinding`, `addInitScript` and `pages` are used). Install
once per context; a second install fails because the binding name is already taken.

| Option | Required | Meaning |
| --- | --- | --- |
| `endpoint` | yes | `http://127.0.0.1:<port>` (optional trailing slash). HTTPS, `localhost`, other hosts, paths, queries, fragments and credentials are refused. |
| `origin` | yes | Exact `http://127.0.0.1:<port>` page origin. Requests from any other frame origin fail with 4200; other origins never get `window.ethereum`. |
| `chainId` | yes | Positive integer or canonical hex (`0x7a69`). Reported by `eth_chainId`; every preflight checks the node reports the same value. No default. |
| `account` | yes | Address that must be listed by the node's `eth_accounts` (an Anvil unlocked dev account). `from` must equal it. |
| `validateTransaction(tx)` | yes | Called with a frozen copy of exactly what the page sent, before admission and again just before submission. Throw to refuse. |
| `beforeSend()` | yes | Called twice per preflight (before and after the chain checks). Throw when the node or listener is no longer yours. |
| `clientVersion` | no | RegExp for `web3_clientVersion`. Default `/^anvil\//i`. |
| `timeoutMs` | no | Per-RPC timeout. Default 15000. |

Each `eth_sendTransaction` runs: shape check → `validateTransaction` → preflight (`beforeSend`, `eth_chainId`,
`web3_clientVersion`, `eth_accounts`, `beforeSend`) → admission (`calls` entry) → mode → `validateTransaction` →
preflight → `eth_sendTransaction` on the node → hash check.

### Supported page methods

Exactly `eth_accounts`, `eth_requestAccounts`, `eth_chainId` and `eth_sendTransaction`. Everything else
(`personal_sign`, `eth_signTypedData_v4`, `wallet_switchEthereumChain`, `eth_sendRawTransaction`, `eth_call`,
`anvil_*`, …) fails with 4200. There is no passthrough. Read methods must go to your RPC directly, not through the
injected provider.

### Transaction shape

One object with `from` and `to` (required) and optional `value` (canonical hex quantity), `data` (hex bytes) and
`chainId` (must equal the configured chain). Any other field (`gas`, `gasPrice`, `nonce`, `maxFeePerGas`, `type`,
`accessList`, …) fails with -32602. Contract creation (no `to`) is not supported. The node picks nonce, gas and fees.

### Modes

| Mode | Behaviour of the next `eth_sendTransaction` |
| --- | --- |
| `approve` (default) | Submit on the node and return the hash. |
| `reject` | Fail with 4001; nothing is submitted. |
| `hold` | Keep the request pending until `release(outcome)`. A second request while one is held fails with -32002. |
| `lost` | Submit on the node, record the hash in `submitted`, then fail with -32603 so the page never learns the hash. |

`release(outcome)` accepts `'approve'`, `'reject'` (cancellation, nothing submitted) or `'lost'`. The mode in
force at admission is what the request follows; changing the mode later does not alter a held request.

### Handle

- `calls`: `{mode, transaction, outcome, hash?, error?}` per admitted request; `outcome` is `pending`,
  `submitted`, `rejected`, `lost` or `failed`. Requests refused before admission (bad shape, validator, preflight)
  are not listed.
- `submitted`: every hash the node returned, including `lost` ones.
- `mode`, `connected`, `held`, `chainId`, `account`: current state.
- `setMode(mode)`, `whenHeld()` (resolves when a request is held), `release(outcome)`.
  `whenHeld()` has no timeout: race it with your request result and a bounded test deadline, because admission may fail.
  A release clears `held` synchronously; a second release fails.
- `disconnect()`: later requests fail with 4900 (`eth_accounts` returns `[]`), a held request fails with 4900 without
  submission, and `accountsChanged([])` then `disconnect({code: 4900})` are attempted on same-origin pages initialized
  after installation. Closed or navigating pages cannot prevent delivery to the remaining pages.

### Page provider

`window.ethereum` has `request`, `on`, `removeListener` and `isForkWallet: true`. Errors thrown to the page carry
`code` and `message`. No EIP-6963 announcement, `chainChanged` or `connect` events are emitted.

### Error codes

| Code | When |
| --- | --- |
| 4001 | Mode `reject`, or `release('reject')`. |
| 4200 | Unsupported method, or a caller frame on another origin. |
| 4900 | Disconnected. |
| -32002 | A held request is already pending. |
| -32602 | Malformed request/params/transaction, or invalid install options (thrown by `installForkWallet`). |
| -32603 | Validator or `beforeSend` threw, preflight mismatch, RPC integrity failure, bad hash, or mode `lost`. |

Node-side exports: `createLoopbackRpc(endpoint)`, `requireLoopbackEndpoint`, `requireOrigin`, `normalizeChainId`,
`checkTransaction`, `ForkWalletError`, `MODES`, `METHODS`, `TRANSACTION_FIELDS`, `CODES`.

## Trust boundaries and limitations

- **Adapter proof only.** Passing tests prove that your dApp drives an EIP-1193 provider correctly and that the
  resulting transactions execute on your local node. They prove nothing about MetaMask, WalletConnect, hardware
  wallets or any real user approval.
- **`beforeSend` is a trusted harness assertion.** The wallet calls your function and trusts its verdict. It is not
  cryptographic proof that the node or listener is yours; make it check the owned child process and port.
- **`validateTransaction` is the only content policy.** The wallet refuses malformed requests, but which `to`,
  `data` and `value` are acceptable is entirely your validator's decision. An empty validator means any well-formed
  transaction to any address is submitted on your node.
- **RPC integrity** is checked per response (HTTP 2xx, no redirects, JSON-RPC 2.0, matching id, exactly one of
  result/error, 32-byte hash), always on `127.0.0.1` over plain HTTP. The endpoint is not authenticated; anything
  that can reach your loopback port can also reach it.
- **No keys, no signing.** The node's unlocked account signs. Nothing here exports or imports private keys and no
  message signing method exists. Anvil's default dev accounts are public knowledge; never fund them on a real chain.
- **Scope of a "fork".** The package does not start Anvil. Whether your node is a vanilla chain or a fork of a public
  network at a pinned block is your harness's responsibility, as is reverting snapshots and stopping the child.
- **Single account, single chain, single wallet per context.** No account switching, chain switching or multiple
  injected providers.
- **Ambiguous submission.** A transport timeout, malformed response or `failed` outcome is not proof of no send.
  Do not retry blindly: reconcile sender nonce and transactions on the node, even when `submitted` has no hash.
- **Library compatibility.** Only the four listed methods and transaction fields are supported. Libraries that
  estimate gas or add fee/nonce fields (including default ethers BrowserProvider send paths) need an adapter;
  general ethers/viem compatibility is not claimed.
- **Lost-response reconciliation** is the harness's job: compare `wallet.submitted` with the node (`eth_getTransactionReceipt`,
  `eth_getTransactionCount`) to prove no duplicate.
- Node >= 22 (global `fetch`, `AbortSignal.timeout`, `structuredClone`). No runtime dependencies. Playwright is an
  optional peer dependency (>= 1.40); the handle is duck-typed, so any object with the same three methods works.

## Tests

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm test` | `test/unit.test.js`: option refusals, method/params/field allowlists, preflight and RPC-integrity refusals (chain, client, account, redirect, wrong id, HTTP error, ambiguous, non-JSON), every mode including concurrent hold, cancellation, ownership loss during a hold, repeated lifecycle, disconnect, and the page provider script in a VM sandbox. Uses a scripted HTTP double and a fake context. | Node only |
| `npm run test:integration` | `test/integration.test.js`: real Chromium + vanilla Anvil (chain 31337) + the example dApp. Reject (no submission), approve (receipt, exact balance and gas accounting), fail-closed through the real page, hold with a refused concurrent request, cancellation, release, lost response reconciled by hash and nonce (no duplicate), disconnect events. Writes `artifacts/local-anvil/<timestamp>/evidence.json` and `final.png`. Verifies port ownership with `lsof`, runs Anvil with a scrubbed environment and stops only its own child. | `anvil`, Playwright Chromium (`PLAYWRIGHT_BROWSERS_PATH` honoured), `lsof` |
| `npm run test:pack` | `test/pack-consumer.js`: `npm pack`, install the tarball into a throwaway consumer outside the repo, load it from CommonJS and ESM. Pass a path argument to keep the tarball. | Node, npm |

Missing tools are failures, never skips.

## Packaging

`npm pack` produces `fork-wallet-<version>.tgz` containing `src/index.js`, `index.d.ts`, `README.md` and
`package.json`. The package is `private` and `UNLICENSED`: it is a local release candidate for consumption as a
pinned tarball (`"fork-wallet": "file:path/to/fork-wallet-0.1.1.tgz"`), not for publication. Consumers should record
the tarball SHA-256 and the installed `src/index.js` SHA-256 in their evidence.

