# ForkWallet

**Test how your dApp handles wallet approvals, interruptions and uncertain transaction results.**

ForkWallet is a test-only browser wallet for Playwright. It exposes an EIP-1193 / EIP-6963 provider to your dApp,
while your test controls approval, rejection, pending requests, account/chain changes and disconnects.
Approved transactions execute on your own local Anvil node, so you can check real receipts, balances and contract state
rather than relying on a mocked success response.

It tests **your dApp's reaction to wallet behaviour**, not MetaMask or any other real wallet's implementation.
EIP-1193 is the common interface, not the distinguishing feature: the useful part is controlling failure timing and
checking what actually reached the local chain.

## What can I test?

| Situation to reproduce | ForkWallet control | What your dApp test should check |
| --- | --- | --- |
| The user refuses connection or a transaction | `nextRequest({ method, mode: 'reject' })` | Show a useful result, leave the pending state, submit nothing. |
| Approval remains open | `hold`, `whenHeld()`, `release(requestId, outcome)` | Keep the UI consistent and prevent conflicting requests. |
| Permission/account/chain changes during approval | `revoke()`, `setAccount()`, `switchChain()` | Discard stale work; do not send on the old account or chain. |
| The wallet disconnects | `disconnect()`, `reconnect()` | Recover without confusing transport availability with account permission. |
| The node accepts a transaction, but the dApp does not receive its hash | `nextRequest({ method: 'eth_sendTransaction', mode: 'lost' })` | Reconcile chain state before retrying; avoid duplicate application actions. |
| A page reloads or another tab acts | One wallet shared by the allowed origin's pages in a context | Restore application state without silently replaying a transaction. |

These are controls, **not a complete ready-made test suite for every dApp**. You still write the UI actions,
transaction policy and assertions for your application. ForkWallet neither retries nor deduplicates transactions.

## Quickstart

- Node **>= 22**, Playwright, Anvil **1.8.3**, and `lsof` for the packaged Anvil helper.
- A dApp served at an exact `http://127.0.0.1:<port>` origin. `localhost` is not accepted.
- Disposable local accounts only. Do not provide a real private key, use funded accounts or point at a public RPC.

Install from npm in your test project:

```sh
npm install --save-dev fork-wallet playwright@1.56.1
npx playwright install chromium
```

This Quickstart targets the upcoming **0.3.0** npm release. The currently published **0.1.1** does not provide all APIs used below.

## Runnable example: a successful send with a lost response

Save this as `wallet-check.cjs` in your test project and run `node wallet-check.cjs`. It serves a minimal local page,
connects through the injected provider, sends **one test wei**, and checks the real receipt and recipient balance.
This uses a direct provider call to demonstrate the controls; replace it with your dApp's UI actions in your own test.
Anvil must already be installed on `PATH`. Run from a shell without credential-related environment variables.

```js
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { chromium } = require('playwright');
const { installForkWallet, createLoopbackRpc } = require('fork-wallet');
const { startAnvil } = require('fork-wallet/anvil');

async function main() {
  let node, server, browser;
  try {
    node = await startAnvil({ chainId: 31337 }); // random disposable accounts; no network fork
    const rpc = createLoopbackRpc(node.endpoint);
    const recipient = '0x' + randomBytes(20).toString('hex');
    server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': "default-src 'none'; connect-src 'none'",
      });
      res.end('<!doctype html><title>Wallet test</title>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    node.configureOrigin(origin);
    browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const wallet = await installForkWallet(context, {
      endpoint: node.endpoint, origin, chainId: node.chainId, account: node.account,
      beforeSend: node.beforeSend,
      validateTransaction(tx) {
        assert.deepEqual(tx, { from: node.account, to: recipient, value: '0x1', data: '0x' });
      },
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(() => window.ethereum.request({ method: 'eth_requestAccounts' }));
    wallet.nextRequest({ method: 'eth_sendTransaction', mode: 'lost' });
    const code = await page.evaluate(async ({ from, to }) => {
      try {
        await window.ethereum.request({
          method: 'eth_sendTransaction', params: [{ from, to, value: '0x1', data: '0x' }],
        });
        return null;
      } catch (error) { return error.code; }
    }, { from: node.account, to: recipient });
    assert.equal(code, -32603); // the page saw an error, not a transaction hash
    assert.equal(wallet.submitted.length, 1);
    let receipt;
    for (let i = 0; i < 50; i++) {
      receipt = await rpc('eth_getTransactionReceipt', [wallet.submitted[0]]);
      if (receipt) break;
      await sleep(100);
    }
    assert.equal(receipt?.status, '0x1'); // nevertheless, the local chain executed it
    assert.equal(await rpc('eth_getBalance', [recipient, 'latest']), '0x1');
    assert.equal(await rpc('eth_getTransactionCount', [node.account, 'latest']), '0x1');
    console.log('PASS: response lost, one real local transaction confirmed');
  } finally {
    try { if (browser) await browser.close(); }
    finally {
      try {
        if (server?.listening) await new Promise((resolve) => {
          server.closeAllConnections(); server.close(resolve);
        });
      } finally { if (node) await node.stop(); }
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
```

The test runner knows the hash from `wallet.submitted`; the dApp does not. **Do not give the test-only handle to your
application or treat it as a production recovery mechanism.** Your dApp needs its own reconciliation strategy.

For a real app, configure its public read RPC as `node.publicEndpoint`, never `node.endpoint`. The former is a
restricted read gateway; the latter is the private, unauthenticated management RPC. Adapt browser routing/CSP to allow
only your owned app and read gateway. These restrictions are not an OS sandbox.

## Controlling a pending request

After connecting, queue a decision **before** the UI action starts the request:

```js
wallet.nextRequest({ method: 'eth_sendTransaction', mode: 'hold' });
// Start the dApp action without waiting for its transaction request to finish.
// Bound your test: admission may fail, in which case whenHeld() will not resolve.
const requestId = await wallet.whenHeld();
wallet.release(requestId, 'reject'); // 4001; no transaction submitted
// Alternatively disconnect/revoke/switch account or chain, then assert the dApp's recovery.
```

`release` applies once to exactly that request ID. A wrong, already released or invalidated ID fails.
Account changes are limited to unlocked accounts on the owned node; chain changes are limited to registrations
supplied at installation. A write already dispatched to a node cannot be undone by cancelling or disconnecting.

## API and compatibility

- [API reference](docs/api.md): installation options, methods, events, errors, transactions, signing,
  lifecycle records, Anvil/read gateway, and migration from 0.1.1/0.2.0.
- Public TypeScript declarations: [index.d.ts](index.d.ts) and [anvil.d.ts](anvil.d.ts).

The core provider includes bounded reads, permissions, registered-chain switching and EIP-6963 discovery.
`personal_sign` and `eth_signTypedData_v4` are disabled unless explicitly enabled with a signing policy, and then
only for disposable accounts on chains 31337/31338. See the API reference before enabling them.
Approval is automatic by default (`approve`); this is a test decision, not evidence of a human approval.

Measured SDK paths use ethers 6.17.0, viem 2.57.12 and @wagmi/core 2.22.1 with Playwright 1.56.1 Chromium and Anvil 1.8.3
on macOS. These specific tests do not establish compatibility with every SDK version, React connector, dApp or wallet.
There are no runtime dependencies; Playwright is an optional peer.

## Safety boundaries and non-goals

- **Test-only.** No production assets, real user keys, public-chain writes or real user approvals. The package holds
  no key; Anvil signs. `startAnvil` starts only a vanilla local chain and accepts no fork URL or key input. A custom
  owned-fork harness has additional isolation responsibilities; the name is not a general fork-support guarantee.
- **Not a real-wallet emulator.** Tests establish behaviour against this provider, not MetaMask, WalletConnect,
  hardware wallets, browser extensions or mobile relays. Differences among real wallets still need separate testing.
- **Your policy matters.** `validateTransaction` must check the exact intended destination, calldata, value and any
  fee/nonce constraints. An empty policy accepts every structurally valid transaction. `beforeSend` checks ownership;
  callbacks are trusted, not cryptographic proofs. The page must not access the management endpoint.
- **No exactly-once guarantee.** `lost` means a hash was received by the runner but not delivered to the page.
  `unknown` means execution may have occurred without a usable response. Never retry blindly. ForkWallet does not
  implement your app's reload recovery, cross-tab coordination or duplicate-action prevention.
- **Limited methods.** No arbitrary RPC passthrough, raw transaction submission, `wallet_addEthereumChain`,
  `wallet_sendCalls`, `eth_sign`, SIWE server, Permit2 or ERC-2612 acceptance guarantee. Unsupported methods fail 4200.
- **Real signatures need care.** Local chain IDs do not make signatures harmless elsewhere. Never sign with a key
  that matters, and do not record signing payloads/signatures in logs, Playwright traces, HAR, video or screenshots.

## Contributing

For development setup, tests, packaging and release boundaries, see [CONTRIBUTING.md](CONTRIBUTING.md).
