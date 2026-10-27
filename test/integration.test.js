'use strict';
// E2E regression: real Chromium (Playwright), an owned vanilla loopback Anvil (fork-wallet/anvil, chain 31337, no
// network fork) and the generic dApp in examples/local-anvil/dapp, migrated to 0.2.0 semantics (explicit connect
// approval, ID-bound release, revoke vs disconnect, reconnect). Native transfers are really submitted and checked by
// receipt, balance and nonce. Requirements: Anvil 1.8.3, Playwright Chromium, lsof. Missing tools fail.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { installForkWallet, createLoopbackRpc, CODES } = require('../src/index.js');
const { startAnvil, requireOwnedPort } = require('../src/anvil.js');
const harness = require('../examples/local-anvil/harness.js');

const DAPP = path.join(__dirname, '../examples/local-anvil/dapp');
const OUT = path.join(__dirname, '../artifacts/local-anvil', new Date().toISOString().replace(/[:.]/g, '-'));
const ONE_ETHER = 10n ** 18n;
const hex = (value) => '0x' + value.toString(16);
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('generic dApp on vanilla Anvil: connect approval, approve, reject, hold/cancel/release, lost, revoke, disconnect, reconnect', async (t) => {
  const evidence = { scope: 'Vanilla local Anvil (no network fork) + Playwright Chromium + loopback static dApp. Adapter proof only, not a production wallet.',
    result: 'UNKNOWN', steps: [], sources: Object.fromEntries(['src/index.js', 'src/anvil.js', 'examples/local-anvil/harness.js', 'examples/local-anvil/dapp/index.html',
      'examples/local-anvil/dapp/app.js', 'test/integration.test.js'].map((p) => [p, digest(path.join(__dirname, '..', p))])) };
  fs.mkdirSync(OUT, { recursive: true });
  const write = () => fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  let anvil, server, browser;
  t.after(async () => {
    try { if (browser) await browser.close(); } catch (error) { evidence.cleanupError = String(error.message); }
    if (server) await server.close();
    let stopped = true;
    try { if (anvil) await anvil.stop(); } catch (error) { stopped = false; evidence.stopError = error.message; }
    evidence.childrenStopped = stopped;
    if (!stopped) evidence.result = 'FAIL';
    write();
    console.log(evidence.result + ': ' + path.join(OUT, 'evidence.json'));
    assert.equal(stopped, true, 'owned anvil did not stop');
  });
  const step = (name, data) => { evidence.steps.push({ name, ...data }); };

  anvil = await startAnvil({ chainId: 31337 });
  const { endpoint, account } = anvil;
  const rpc = createLoopbackRpc(endpoint);
  const recipient = '0x' + crypto.randomBytes(20).toString('hex');
  assert.equal(await rpc('eth_getBalance', [recipient, 'latest']), '0x0');
  evidence.chain = { version: await rpc('web3_clientVersion'), chainId: anvil.chainId, endpoint, account, recipient, anvilPid: anvil.pid };

  server = await harness.startStaticServer(DAPP);
  const { origin } = server;
  evidence.dapp = { origin, serverPid: process.pid };

  browser = await chromium.launch({ headless: true });
  evidence.browser = browser.version();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));

  const expectedValue = hex(ONE_ETHER);
  const wallet = await installForkWallet(context, {
    endpoint, origin, chainId: 31337, account,
    validateTransaction(tx) {
      assert.deepEqual(tx, { from: account, to: recipient, value: expectedValue }, 'exact transaction bytes');
    },
    beforeSend() {
      anvil.beforeSend();
      requireOwnedPort(process.pid, server.port);
    },
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/');
  const status = () => page.locator('#status').innerText();
  const events = () => page.evaluate(() => [...document.querySelectorAll('#events li')].map((li) => li.textContent));
  const sendCalls = () => wallet.calls.filter((c) => c.method === 'eth_sendTransaction');

  // 0. Connect needs an explicit approval: rejected first (no permission, no send), then approved.
  assert.deepEqual(await page.evaluate(() => window.ethereum.request({ method: 'eth_accounts' })), []);
  const unauthorized = await page.evaluate(([from, to]) => window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to, value: '0x1' }] }).then(() => null, (e) => e.code), [account, recipient]);
  assert.equal(unauthorized, CODES.UNAUTHORIZED);
  wallet.nextRequest({ method: 'eth_requestAccounts', mode: 'reject' });
  await page.locator('#connect').click();
  await page.waitForFunction(() => /^error 4001 /.test(document.getElementById('status').textContent));
  assert.equal(wallet.authorized, false);
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.body.dataset.connected === 'true');
  assert.equal(await page.locator('#account').innerText(), account);
  assert.equal(await page.locator('#chain').innerText(), '0x7a69');
  assert.deepEqual(wallet.calls.map((c) => [c.method, c.outcome]), [['eth_requestAccounts', 'rejected'], ['eth_requestAccounts', 'approved']]);
  step('connect', { unauthorized, calls: wallet.calls.map((c) => c.outcome) });

  await page.locator('#to').fill(recipient);
  await page.locator('#value').fill(expectedValue);
  const submit = async () => {
    const id = Number((await page.locator('body').getAttribute('data-request')) || 0) + 1;
    await page.locator('#send').click();
    await page.waitForFunction((n) => document.body.dataset.request === String(n), id);
    return id;
  };
  const settled = (id) => page.waitForFunction((n) => /^(submitted|error) (\d+)/.exec(document.getElementById('status').textContent)?.[2] === String(n), id);
  const balance = (address) => rpc('eth_getBalance', [address, 'latest']).then(BigInt);
  const nonce = () => rpc('eth_getTransactionCount', [account, 'latest']).then(BigInt);
  const receipt = async (hash) => {
    for (let i = 0; i < 100; i++) {
      const rc = await rpc('eth_getTransactionReceipt', [hash]);
      if (rc) return rc;
      await harness.sleep(100);
    }
    throw new Error('receipt timeout ' + hash);
  };
  const verifyTransfer = async (hash, before) => {
    const rc = await receipt(hash);
    const transaction = await rpc('eth_getTransactionByHash', [hash]);
    assert.equal(rc.status, '0x1');
    assert.equal(rc.transactionHash, hash);
    assert.equal(transaction.from.toLowerCase(), account.toLowerCase());
    assert.equal(transaction.to.toLowerCase(), recipient);
    assert.equal(BigInt(transaction.value), ONE_ETHER);
    const after = { sender: await balance(account), recipient: await balance(recipient) };
    assert.equal(after.recipient - before.recipient, ONE_ETHER, 'recipient received exactly the value');
    assert.equal(before.sender - after.sender, ONE_ETHER + BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice), 'sender paid value plus gas');
    return { hash, receipt: rc, transaction, before, after };
  };
  const snapshot = async () => ({ sender: await balance(account), recipient: await balance(recipient) });

  // 1. Reject: nothing is submitted, balances unchanged.
  wallet.setMode('reject');
  let before = await snapshot();
  let id = await submit();
  await settled(id);
  assert.match(await status(), new RegExp('^error ' + id + ' 4001 '));
  assert.deepEqual(wallet.submitted, []);
  assert.deepEqual(await snapshot(), before);
  assert.equal(await nonce(), 0n);
  step('reject', { status: await status(), submitted: 0, calls: sendCalls().length });

  // 2. Approve: real receipt and balance movement.
  wallet.setMode('approve');
  before = await snapshot();
  id = await submit();
  await settled(id);
  assert.equal(await status(), 'submitted ' + id);
  assert.equal(wallet.submitted.length, 1);
  assert.equal(await page.locator('#hash').innerText(), wallet.submitted[0]);
  step('approve', await verifyTransfer(wallet.submitted[0], before));

  // 3. Fail-closed through the real page: unknown field (gas is valid in 0.2.0, gasLimit is not), conflicting fees,
  //    unsupported methods including viem's wallet_sendTransaction fallback, wrong from. Zero submissions.
  const refused = await page.evaluate(async ([from, to]) => {
    const attempt = (request) => window.ethereum.request(request).then(() => null, (e) => e.code);
    return {
      unknownField: await attempt({ method: 'eth_sendTransaction', params: [{ from, to, value: '0x1', gasLimit: '0x5208' }] }),
      mixedFees: await attempt({ method: 'eth_sendTransaction', params: [{ from, to, value: '0x1', gasPrice: '0x1', maxFeePerGas: '0x1' }] }),
      sign: await attempt({ method: 'personal_sign', params: ['0x00', from] }),
      raw: await attempt({ method: 'eth_sendRawTransaction', params: ['0x00'] }),
      admin: await attempt({ method: 'anvil_setBalance', params: [from, '0x1'] }),
      walletSend: await attempt({ method: 'wallet_sendTransaction', params: [{ from, to, value: '0x1' }] }),
      wrongFrom: await attempt({ method: 'eth_sendTransaction', params: [{ from: to, to: from, value: '0x1' }] }),
    };
  }, [account, recipient]);
  assert.deepEqual(refused, { unknownField: CODES.INVALID_PARAMS, mixedFees: CODES.INVALID_PARAMS, sign: CODES.UNSUPPORTED_METHOD, raw: CODES.UNSUPPORTED_METHOD, admin: CODES.UNSUPPORTED_METHOD, walletSend: CODES.UNSUPPORTED_METHOD, wrongFrom: CODES.INVALID_PARAMS });
  assert.equal(wallet.submitted.length, 1);
  assert.deepEqual(wallet.unsupported.map((u) => u.method), ['personal_sign', 'eth_sendRawTransaction', 'anvil_setBalance', 'wallet_sendTransaction']);
  step('fail-closed', refused);

  // 4. Hold: a second concurrent request is refused; cancellation submits nothing; release really submits once.
  wallet.setMode('hold');
  before = await snapshot();
  id = await submit();
  let heldId = await wallet.whenHeld();
  const concurrent = await page.evaluate(([from, to, value]) => window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to, value }] }).then(() => null, (e) => e.code), [account, recipient, expectedValue]);
  assert.equal(concurrent, CODES.REQUEST_PENDING);
  assert.equal(wallet.held, true);
  wallet.release(heldId, 'reject');
  assert.throws(() => wallet.release(heldId, 'approve'), (e) => e.code === CODES.INTERNAL, 'duplicate release cannot dispatch');
  await settled(id);
  assert.match(await status(), new RegExp('^error ' + id + ' 4001 '));
  assert.equal(wallet.submitted.length, 1);
  assert.deepEqual(await snapshot(), before);
  step('hold-cancel', { concurrent, status: await status(), submitted: wallet.submitted.length });
  id = await submit();
  heldId = await wallet.whenHeld();
  assert.equal(wallet.submitted.length, 1, 'held request has not been submitted');
  assert.throws(() => wallet.release('00000000-0000-4000-8000-000000000000', 'approve'), (e) => e.code === CODES.INVALID_PARAMS, 'wrong request ID');
  wallet.release(heldId, 'approve');
  await settled(id);
  assert.equal(await status(), 'submitted ' + id);
  assert.equal(wallet.submitted.length, 2);
  step('hold-release', await verifyTransfer(wallet.submitted[1], before));

  // 5. Lost: the page sees an error, yet the chain has exactly one more transaction; reconcile by hash and nonce.
  wallet.setMode('lost');
  before = await snapshot();
  id = await submit();
  await settled(id);
  assert.match(await status(), new RegExp('^error ' + id + ' -32603 '));
  assert.equal(wallet.submitted.length, 3);
  const lost = await verifyTransfer(wallet.submitted[2], before);
  assert.equal(await nonce(), 3n, 'exactly one transaction per real submission, no duplicate');
  const lostCall = sendCalls().at(-1);
  assert.equal(lostCall.outcome, 'response-lost');
  assert.equal(lostCall.sender.toLowerCase(), account.toLowerCase());
  assert.equal(lostCall.nonce, '0x2');
  step('lost-reconciled', { ...lost, pageStatus: await status(), nonce: 3 });

  // 6. Revoke during a hold: the held request fails 4100 with nothing sent; accountsChanged([]) is not a disconnect.
  wallet.setMode('hold');
  before = await snapshot();
  id = await submit();
  heldId = await wallet.whenHeld();
  const eventsBeforeRevoke = (await events()).length;
  await wallet.revoke();
  await settled(id);
  assert.match(await status(), new RegExp('^error ' + id + ' 4100 '));
  assert.throws(() => wallet.release(heldId, 'approve'), (e) => e.code === CODES.INTERNAL, 'a revoked request cannot be released');
  await page.waitForFunction(() => document.body.dataset.connected === 'false');
  assert.deepEqual((await events()).slice(eventsBeforeRevoke), ['accountsChanged []']);
  assert.equal(wallet.connected, true);
  assert.deepEqual(await snapshot(), before);
  assert.equal(await nonce(), 3n);
  wallet.setMode('approve');
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.body.dataset.connected === 'true');
  step('revoke', { status: await status(), events: (await events()).slice(eventsBeforeRevoke) });

  // 7. Disconnect: only a disconnect event; later requests refused; nothing more is submitted; permission is kept.
  const eventsBeforeDisconnect = (await events()).length;
  await wallet.disconnect();
  await page.waitForFunction(() => document.body.dataset.connected === 'false');
  assert.equal(await page.locator('#send').isDisabled(), true);
  const disconnected = await page.evaluate(async ([from, to]) => ({
    accounts: await window.ethereum.request({ method: 'eth_accounts' }),
    connect: await window.ethereum.request({ method: 'eth_requestAccounts' }).then(() => null, (e) => e.code),
    send: await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to, value: '0x1' }] }).then(() => null, (e) => e.code),
    read: await window.ethereum.request({ method: 'eth_blockNumber' }).then(() => null, (e) => e.code),
  }), [account, recipient]);
  assert.deepEqual(disconnected, { accounts: [], connect: CODES.DISCONNECTED, send: CODES.DISCONNECTED, read: CODES.DISCONNECTED });
  assert.deepEqual((await events()).slice(eventsBeforeDisconnect), ['disconnect 4900']);
  assert.equal(wallet.authorized, true);
  assert.equal(wallet.submitted.length, 3);
  assert.equal(await nonce(), 3n);
  step('disconnect', disconnected);

  // 8. Reconnect: preflight, one connect event, the kept permission is reflected, and a real send works again.
  await wallet.reconnect();
  await page.waitForFunction(() => document.body.dataset.connected === 'true');
  assert.deepEqual((await events()).slice(eventsBeforeDisconnect), ['disconnect 4900', 'connect 0x7a69']);
  before = await snapshot();
  id = await submit();
  await settled(id);
  assert.equal(await status(), 'submitted ' + id);
  assert.equal(wallet.submitted.length, 4);
  step('reconnect-send', await verifyTransfer(wallet.submitted[3], before));
  assert.equal(await nonce(), 4n);

  await page.screenshot({ path: path.join(OUT, 'final.png'), fullPage: true });
  assert.deepEqual(errors, []);
  evidence.walletCalls = wallet.calls;
  evidence.submitted = wallet.submitted;
  evidence.unsupported = wallet.unsupported;
  assert.equal(sendCalls().filter((c) => c.outcome === 'submitted' || c.outcome === 'response-lost').length, 4);
  assert.deepEqual(sendCalls().map((c) => c.outcome), ['rejected', 'submitted', 'rejected', 'submitted', 'response-lost', 'cancelled', 'submitted']);
  evidence.result = 'PASS';
});
