'use strict';
// Runnable example: real Chromium (Playwright), a vanilla loopback Anvil (chain 31337, no network fork) and the
// generic dApp in examples/local-anvil/dapp. Native transfers are really submitted and checked by receipt and balance.
// Requirements: `anvil` on PATH, Playwright Chromium (PLAYWRIGHT_BROWSERS_PATH is honoured), lsof. Missing tools fail.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { installForkWallet, CODES } = require('../src/index.js');
const harness = require('../examples/local-anvil/harness.js');

const DAPP = path.join(__dirname, '../examples/local-anvil/dapp');
const OUT = path.join(__dirname, '../artifacts/local-anvil', new Date().toISOString().replace(/[:.]/g, '-'));
const ONE_ETHER = 10n ** 18n;
const hex = (value) => '0x' + value.toString(16);
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('generic dApp on vanilla Anvil: approve, reject, hold/cancel/release, lost reconciliation, disconnect', async (t) => {
  const evidence = { scope: 'Vanilla local Anvil (no network fork) + Playwright Chromium + loopback static dApp. Adapter proof only, not a production wallet.',
    result: 'UNKNOWN', steps: [], sources: Object.fromEntries(['src/index.js', 'examples/local-anvil/harness.js', 'examples/local-anvil/dapp/index.html',
      'examples/local-anvil/dapp/app.js', 'test/integration.test.js'].map((p) => [p, digest(path.join(__dirname, '..', p))])) };
  fs.mkdirSync(OUT, { recursive: true });
  const write = () => fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  let anvil, server, browser;
  t.after(async () => {
    try { if (browser) await browser.close(); } catch (error) { evidence.cleanupError = String(error.message); }
    if (server) await server.close();
    const stopped = anvil ? await anvil.stop() : true;
    evidence.childrenStopped = stopped;
    if (!stopped) evidence.result = 'FAIL';
    write();
    console.log(evidence.result + ': ' + path.join(OUT, 'evidence.json'));
    assert.equal(stopped, true, 'owned anvil did not stop');
  });
  const step = (name, data) => { evidence.steps.push({ name, ...data }); };

  anvil = await harness.startAnvil({ chainId: 31337 });
  const { rpc, endpoint } = anvil;
  const [account] = await rpc('eth_accounts');
  const recipient = '0x' + crypto.randomBytes(20).toString('hex');
  assert.equal(await rpc('eth_getBalance', [recipient, 'latest']), '0x0');
  evidence.chain = { version: anvil.version, chainId: anvil.chainId, endpoint, account, recipient, anvilPid: anvil.child.pid, args: anvil.args };

  server = await harness.startStaticServer(DAPP);
  const { origin } = server;
  evidence.dapp = { origin, serverPid: process.pid };

  browser = await chromium.launch({ headless: true });
  evidence.browser = browser.version();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));

  let expectedValue = hex(ONE_ETHER);
  const wallet = await installForkWallet(context, {
    endpoint, origin, chainId: 31337, account,
    validateTransaction(tx) {
      assert.deepEqual(tx, { from: account, to: recipient, value: expectedValue }, 'exact transaction bytes');
    },
    beforeSend() {
      harness.ownsPort(anvil.child, anvil.port);
      harness.requireOwnedPort(process.pid, server.port);
    },
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/');
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.body.dataset.connected === 'true');
  assert.equal(await page.locator('#account').innerText(), account);
  assert.equal(await page.locator('#chain').innerText(), '0x7a69');
  await page.locator('#to').fill(recipient);
  await page.locator('#value').fill(expectedValue);
  const status = () => page.locator('#status').innerText();
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
  step('reject', { status: await status(), submitted: 0, calls: wallet.calls.length });

  // 2. Approve: real receipt and balance movement.
  wallet.setMode('approve');
  before = await snapshot();
  id = await submit();
  await settled(id);
  assert.equal(await status(), 'submitted ' + id);
  assert.equal(wallet.submitted.length, 1);
  assert.equal(await page.locator('#hash').innerText(), wallet.submitted[0]);
  step('approve', await verifyTransfer(wallet.submitted[0], before));

  // 3. Fail-closed through the real page: unknown field and unsupported method, zero submissions.
  const refused = await page.evaluate(async ([from, to]) => {
    const attempt = (request) => window.ethereum.request(request).then(() => null, (e) => e.code);
    return {
      gas: await attempt({ method: 'eth_sendTransaction', params: [{ from, to, value: '0x1', gas: '0x5208' }] }),
      sign: await attempt({ method: 'personal_sign', params: ['0x00', from] }),
      raw: await attempt({ method: 'eth_sendRawTransaction', params: ['0x00'] }),
      admin: await attempt({ method: 'anvil_setBalance', params: [from, '0x1'] }),
      wrongFrom: await attempt({ method: 'eth_sendTransaction', params: [{ from: to, to: from, value: '0x1' }] }),
    };
  }, [account, recipient]);
  assert.deepEqual(refused, { gas: CODES.INVALID_PARAMS, sign: CODES.UNSUPPORTED_METHOD, raw: CODES.UNSUPPORTED_METHOD, admin: CODES.UNSUPPORTED_METHOD, wrongFrom: CODES.INVALID_PARAMS });
  assert.equal(wallet.submitted.length, 1);
  step('fail-closed', refused);

  // 4. Hold: a second concurrent request is refused; cancellation submits nothing; release really submits.
  wallet.setMode('hold');
  before = await snapshot();
  id = await submit();
  await wallet.whenHeld();
  const concurrent = await page.evaluate(([from, to, value]) => window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to, value }] }).then(() => null, (e) => e.code), [account, recipient, expectedValue]);
  assert.equal(concurrent, CODES.REQUEST_PENDING);
  assert.equal(wallet.held, true);
  wallet.release('reject');
  await settled(id);
  assert.match(await status(), new RegExp('^error ' + id + ' 4001 '));
  assert.equal(wallet.submitted.length, 1);
  assert.deepEqual(await snapshot(), before);
  step('hold-cancel', { concurrent, status: await status(), submitted: wallet.submitted.length });
  id = await submit();
  await wallet.whenHeld();
  assert.equal(wallet.submitted.length, 1, 'held request has not been submitted');
  wallet.release('approve');
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
  step('lost-reconciled', { ...lost, pageStatus: await status(), nonce: 3 });

  // 6. Disconnect: events reach the page, later requests are refused, nothing more is submitted.
  wallet.setMode('approve');
  await wallet.disconnect();
  await page.waitForFunction(() => document.body.dataset.connected === 'false');
  assert.equal(await page.locator('#send').isDisabled(), true);
  const disconnected = await page.evaluate(async ([from, to]) => ({
    accounts: await window.ethereum.request({ method: 'eth_accounts' }),
    connect: await window.ethereum.request({ method: 'eth_requestAccounts' }).then(() => null, (e) => e.code),
    send: await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to, value: '0x1' }] }).then(() => null, (e) => e.code),
    events: [...document.querySelectorAll('#events li')].map((li) => li.textContent),
  }), [account, recipient]);
  assert.deepEqual(disconnected, { accounts: [], connect: CODES.DISCONNECTED, send: CODES.DISCONNECTED, events: ['accountsChanged []', 'disconnect 4900'] });
  assert.equal(wallet.submitted.length, 3);
  assert.equal(await nonce(), 3n);
  step('disconnect', disconnected);

  await page.screenshot({ path: path.join(OUT, 'final.png'), fullPage: true });
  assert.deepEqual(errors, []);
  evidence.walletCalls = wallet.calls;
  evidence.submitted = wallet.submitted;
  assert.equal(wallet.calls.filter((c) => c.outcome === 'submitted' || c.outcome === 'lost').length, 3);
  evidence.result = 'PASS';
});
