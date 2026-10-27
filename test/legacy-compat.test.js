'use strict';
// Bounded browser gate for the narrow legacy provider surface: real Chromium (Playwright) runs the actual
// installForkWallet page script against a synthetic legacy API fixture (test/fixtures/legacy-api, a strict module
// script, NOT web3modal or Uniswapper) and an owned vanilla loopback Anvil (fork-wallet/anvil, chain 31337, no
// network fork). The fixture assigns autoRefreshOnNetworkChange = false during render and connects through enable();
// one policy-approved native transfer is really submitted and checked by receipt, balances and nonce. Rejection and
// revocation controls must submit nothing. External HTTP/WS and service workers are blocked. Requirements: Anvil
// 1.8.3, Playwright Chromium, lsof (checked by test/run-gate.js; missing tools fail, never skip).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { installForkWallet, createLoopbackRpc, CODES } = require('../src/index.js');
const { startAnvil, requireOwnedPort, listenerPids } = require('../src/anvil.js');
const { startStaticServer, sleep } = require('../examples/local-anvil/harness.js');

const FIXTURE = path.join(__dirname, 'fixtures/legacy-api');
const VALUE = 10n ** 15n; // 0.001 ether
const hex = (value) => '0x' + value.toString(16);

test('legacy API fixture on vanilla Anvil: strict render, enable connect, one real transfer, refusal and revoke controls', async (t) => {
  let anvil, server, browser;
  const ports = {};
  t.after(async () => {
    const failures = [];
    try { if (browser) await browser.close(); } catch (error) { failures.push('browser: ' + error.message); }
    try { if (server) await server.close(); } catch (error) { failures.push('server: ' + error.message); }
    try { if (anvil) await anvil.stop(); } catch (error) { failures.push('anvil: ' + error.message); }
    for (const [name, port] of Object.entries(ports)) {
      const pids = listenerPids(port);
      if (pids.length) failures.push(`${name} port ${port} still has listeners ${JSON.stringify(pids)}`);
    }
    console.log('legacy-compat cleanup ' + JSON.stringify({ ports, failures }));
    assert.deepEqual(failures, [], 'all owned processes and listeners retired');
  });

  anvil = await startAnvil({ chainId: 31337 });
  const { endpoint, account, publicEndpoint } = anvil;
  ports.anvil = Number(new URL(endpoint).port);
  ports.gateway = Number(new URL(publicEndpoint).port);
  const rpc = createLoopbackRpc(endpoint);
  const recipient = '0x' + crypto.randomBytes(20).toString('hex');
  assert.equal(await rpc('eth_getBalance', [recipient, 'latest']), '0x0');

  server = await startStaticServer(FIXTURE, { csp: `default-src 'self'; script-src 'self'; connect-src ${publicEndpoint}; base-uri 'none'; form-action 'none'` });
  const { origin } = server;
  ports.server = server.port;
  anvil.configureOrigin(origin);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const blocked = [];
  await context.routeWebSocket('**/*', (socket) => { blocked.push('ws:' + socket.url()); socket.close(); });
  await context.route('**/*', (route) => {
    const target = new URL(route.request().url()).origin;
    if (target === origin || target === new URL(publicEndpoint).origin) return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  // Test-only recorder for the production initial connect, which is scheduled from the asynchronous __forkWalletInit
  // result and may fire before or after the module fixture attaches its own listener. It subscribes through the
  // EIP-6963 announce (same pattern as sdk-compat) regardless of whether it runs before or after the wallet script.
  await context.addInitScript(() => {
    if (window.top !== window) return;
    const connects = [];
    window.__initConnects = connects;
    let hooked = false;
    const hook = (event) => {
      if (hooked) return;
      hooked = true;
      event.detail.provider.on('connect', (info) => connects.push(info));
    };
    window.addEventListener('eip6963:announceProvider', hook);
    if (!window.ethereum) return; // wallet script not yet run (or about:blank): its own announce reaches the listener
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  });

  const policy = [];
  const wallet = await installForkWallet(context, {
    endpoint, origin, chainId: 31337, account,
    validateTransaction(tx) {
      policy.push(tx);
      assert.deepEqual(tx, { from: account, to: recipient, value: hex(VALUE) }, 'exact transaction policy');
    },
    beforeSend() {
      anvil.beforeSend();
      requireOwnedPort(process.pid, server.port);
    },
  });
  assert.equal(wallet.signing, false, 'signing stays disabled');

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/');
  const balance = (address) => rpc('eth_getBalance', [address, 'latest']).then(BigInt);
  const nonce = () => rpc('eth_getTransactionCount', [account, 'latest']).then(BigInt);
  const snapshot = async () => ({ sender: await balance(account), recipient: await balance(recipient), nonce: await nonce() });
  const status = () => page.locator('#status').innerText();
  const act = async (selector) => {
    const next = Number((await page.locator('body').getAttribute('data-done')) || 0) + 1;
    await page.locator(selector).click();
    await page.waitForFunction((n) => document.body.dataset.done === String(n), next, { timeout: 20000 });
    return status();
  };
  const legacyEvents = () => page.evaluate(() => window.legacyEvents.map(([name]) => name));
  const initConnects = () => page.evaluate(() => window.__initConnects);
  const sends = () => wallet.calls.filter((c) => c.method === 'eth_sendTransaction');

  // 1. Strict legacy render succeeded on the actual injected (frozen) provider.
  await page.waitForFunction(() => document.body.dataset.rendered !== undefined);
  assert.equal(await page.locator('body').getAttribute('data-rendered'), 'false');
  assert.deepEqual(errors, [], 'strict render threw no page error');
  // Initialization is pinned before any legacy operation: exactly one genuine initial connect on the local chain
  // (missing within the bound fails). The module listener may or may not have seen it depending on timing, so its
  // event log after initialization is validated and taken as the baseline for every later comparison.
  await page.waitForFunction(() => window.__initConnects && window.__initConnects.length > 0, null, { timeout: 10000 });
  assert.deepEqual(await initConnects(), [{ chainId: '0x7a69' }], 'exactly one initial connect with the local chain');
  const baseline = await page.evaluate(() => JSON.parse(JSON.stringify(window.legacyEvents)));
  assert.ok([0, 1].includes(baseline.length), 'module saw at most the one initial event: ' + JSON.stringify(baseline));
  if (baseline.length) assert.deepEqual(baseline, [['connect', { chainId: '0x7a69' }]]);
  const base = baseline.map(([name]) => name);
  const surface = await page.evaluate(() => ({
    frozen: Object.isFrozen(window.ethereum), isForkWallet: window.ethereum.isForkWallet, keys: Object.keys(window.ethereum),
    send: typeof window.ethereum.send, sendAsync: typeof window.ethereum.sendAsync, isMetaMask: window.ethereum.isMetaMask,
  }));
  assert.deepEqual(surface, { frozen: true, isForkWallet: true, keys: ['isForkWallet', 'on', 'removeListener', 'request', 'enable', 'off'],
    send: 'undefined', sendAsync: 'undefined', isMetaMask: undefined });
  // Invalid writes and member replacement are refused in strict page code, with no event and no binding call.
  const refusals = await page.evaluate(() => {
    'use strict';
    const out = {};
    const attempt = (name, fn) => { try { fn(); out[name] = 'accepted'; } catch (error) { out[name] = error.name; } };
    attempt('true', () => { window.ethereum.autoRefreshOnNetworkChange = true; });
    attempt('undefined', () => { window.ethereum.autoRefreshOnNetworkChange = undefined; });
    attempt('enable', () => { window.ethereum.enable = async () => []; });
    attempt('request', () => { window.ethereum.request = async () => []; });
    attempt('unknown', () => { window.ethereum.legacyFlag = 1; });
    attempt('redefine', () => Object.defineProperty(window.ethereum, 'autoRefreshOnNetworkChange', { value: true }));
    out.value = window.ethereum.autoRefreshOnNetworkChange;
    return out;
  });
  assert.deepEqual(refusals, { true: 'TypeError', undefined: 'TypeError', enable: 'TypeError', request: 'TypeError', unknown: 'TypeError', redefine: 'TypeError', value: false });
  const enableRpc = await page.evaluate(() => window.ethereum.request({ method: 'enable' }).then(() => 'resolved', (e) => e.code));
  assert.equal(enableRpc, CODES.UNSUPPORTED_METHOD, 'enable is not a JSON-RPC method');
  const badArgs = await page.evaluate(() => window.ethereum.enable(undefined).then(() => 'resolved', (e) => e.code));
  assert.equal(badArgs, CODES.INVALID_PARAMS);
  assert.equal(wallet.calls.length, 0, 'no approval admitted by render, refusals or bad arguments');
  assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(window.legacyEvents))), baseline, 'no event from refusals or bad arguments');

  // 2. Unauthorized: a send is refused; a rejected enable grants nothing and submits nothing.
  const start = await snapshot();
  assert.equal(start.nonce, 0n);
  await page.locator('#from').fill(account);
  await page.locator('#to').fill(recipient);
  await page.locator('#value').fill(hex(VALUE));
  assert.equal(await act('#send'), `error 1 ${CODES.UNAUTHORIZED}`);
  wallet.nextRequest({ method: 'eth_requestAccounts', mode: 'reject' });
  assert.equal(await act('#connect'), `error 2 ${CODES.USER_REJECTED}`);
  assert.equal(wallet.authorized, false);
  assert.deepEqual(await snapshot(), start);

  // 3. enable() connect through the eth_requestAccounts approval; account, chain and read gateway agree.
  assert.equal(await act('#connect'), `ok 3 ${account}`);
  assert.equal(wallet.authorized, true);
  assert.deepEqual(wallet.calls.map((c) => [c.method, c.outcome]), [['eth_requestAccounts', 'rejected'], ['eth_requestAccounts', 'approved']]);
  assert.deepEqual(await legacyEvents(), [...base, 'accountsChanged']);
  const reads = await page.evaluate(async ([gateway, who]) => {
    const viaGateway = async (method, params) => (await (await fetch(gateway, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
    return {
      accounts: await window.ethereum.request({ method: 'eth_accounts' }),
      chainId: await window.ethereum.request({ method: 'eth_chainId' }),
      balance: await window.ethereum.request({ method: 'eth_getBalance', params: [who, 'latest'] }),
      gatewayChainId: await viaGateway('eth_chainId', []),
      gatewayBalance: await viaGateway('eth_getBalance', [who, 'latest']),
    };
  }, [publicEndpoint, account]);
  assert.deepEqual(reads.accounts, [account]);
  assert.equal(reads.chainId, '0x7a69');
  assert.equal(reads.gatewayChainId, '0x7a69');
  assert.equal(BigInt(reads.balance), start.sender);
  assert.equal(BigInt(reads.gatewayBalance), start.sender);

  // 4. One policy-approved transfer: real receipt, balances and nonce + 1.
  const sent = await act('#send');
  const match = /^ok 4 (0x[0-9a-f]{64})$/.exec(sent);
  assert.ok(match, sent);
  const hash = match[1];
  let receipt = null;
  for (let i = 0; i < 100 && !receipt; i++) {
    receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (!receipt) await sleep(100);
  }
  assert.ok(receipt, 'receipt for ' + hash);
  assert.equal(receipt.status, '0x1');
  const transaction = await rpc('eth_getTransactionByHash', [hash]);
  assert.equal(transaction.from.toLowerCase(), account.toLowerCase());
  assert.equal(transaction.to.toLowerCase(), recipient);
  assert.equal(BigInt(transaction.value), VALUE);
  const afterSend = await snapshot();
  assert.equal(afterSend.recipient - start.recipient, VALUE);
  assert.equal(start.sender - afterSend.sender, VALUE + BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice));
  assert.equal(afterSend.nonce, start.nonce + 1n);
  assert.deepEqual(wallet.submitted, [hash]);
  assert.equal(policy.length, 2, 'policy checked before admission and again before dispatch of the one send');

  // 5. Revoke: the next send is refused with no new submission, nonce or balance change.
  await wallet.revoke();
  assert.equal(await act('#send'), `error 5 ${CODES.UNAUTHORIZED}`);
  assert.deepEqual(await snapshot(), afterSend);
  assert.equal(wallet.submitted.length, 1);
  assert.equal(sends().length, 1, 'only the approved send was admitted');
  assert.equal(policy.length, 2, 'refused sends never reached the policy');
  assert.deepEqual(await legacyEvents(), [...base, 'accountsChanged', 'accountsChanged']);
  assert.deepEqual(await initConnects(), [{ chainId: '0x7a69' }], 'no later connect was emitted');
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, [], 'no external HTTP or WebSocket request was attempted');
  console.log('legacy-compat evidence ' + JSON.stringify({ scope: 'synthetic legacy API fixture on owned vanilla Anvil 31337; not third-party app or fork swap acceptance',
    initConnects: 1, moduleSawInitialConnect: base.length === 1, hash, receiptStatus: receipt.status, nonce: { before: String(start.nonce), after: String(afterSend.nonce) },
    recipientDelta: String(afterSend.recipient - start.recipient), submitted: wallet.submitted.length, calls: wallet.calls.map((c) => [c.method, c.outcome]) }));
});
