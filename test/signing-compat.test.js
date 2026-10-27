'use strict';
// E2E signing gate: real Chromium (Playwright) runs the locally bundled pinned ethers / viem / @wagmi/core through the
// injected provider of a policy-enabled wallet on two owned vanilla Anvil 1.8.3 children (31337, 31338, random
// mnemonic: disposable helper accounts only, no known key, no impersonated signer). Signatures are real Anvil
// signatures; they stay inside the page, where ethers and viem independently recover them. Node receives booleans,
// counters and hashes only. A loopback counting proxy in front of each management endpoint counts signing
// dispatches independently of the wallet trace and keeps returned signatures in memory solely to prove that no
// artifact contains them. No trace, HAR, video or screenshot is recorded. Missing anvil/Chromium/lsof is a FAIL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const { installForkWallet, createLoopbackRpc, CODES } = require('../src/index.js');
const { startAnvil } = require('../src/anvil.js');
const { startStaticServer } = require('../examples/local-anvil/harness.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts/signing', new Date().toISOString().replace(/[:.]/g, '-'));
const SENTINEL = 'SENTINEL_policy_7f3a1c';
const VERIFYING = '0x' + '7e57'.repeat(10); // local fixture verifyingContract, no code
const NOTE = 'fork-wallet local TestNote: not an authentication message';
const SIGNING = ['personal_sign', 'eth_signTypedData_v4'];
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Loopback proxy to one owned management endpoint that counts signing dispatches. Signatures are never written. */
async function countingProxy(upstream) {
  const stats = { personal_sign: 0, eth_signTypedData_v4: 0, wellFormedReturned: 0 };
  const signatures = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    let method = null;
    try { method = JSON.parse(body).method; } catch { /* forwarded unchanged; the node answers */ }
    const signing = SIGNING.includes(method);
    if (signing) stats[method]++;
    try {
      const reply = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error' });
      const text = await reply.text();
      if (signing) {
        try {
          const { result } = JSON.parse(text);
          if (typeof result === 'string' && /^0x[0-9a-f]{130}$/i.test(result)) { stats.wellFormedReturned++; signatures.add(result.slice(2).toLowerCase()); }
        } catch { /* not a result */ }
      }
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(text);
    } catch {
      res.writeHead(502);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`, stats, signatures,
    dispatched: () => stats.personal_sign + stats.eth_signTypedData_v4,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

// Page-side fixture: TestNote with arrays, bytes, nested and array-of-struct fields (catches digest mutation), the
// in-page recovery check through both libraries, and an error-code extractor. Never returns a signature.
const PAGE_FIXTURE = `(() => {
  const { ethers, viem } = window.sdk;
  const text = ${JSON.stringify(NOTE)};
  const types = {
    TestNote: [{ name: 'id', type: 'uint256' }, { name: 'note', type: 'string' }, { name: 'tags', type: 'string[]' }, { name: 'blob', type: 'bytes' },
      { name: 'amounts', type: 'uint256[]' }, { name: 'inner', type: 'Inner' }, { name: 'items', type: 'Inner[]' }],
    Inner: [{ name: 'flag', type: 'bool' }, { name: 'amount', type: 'uint256' }, { name: 'who', type: 'address' }],
  };
  const domain = (chainId) => ({ name: 'fork-wallet TestNote', version: '1', chainId, verifyingContract: ${JSON.stringify(VERIFYING)} });
  const message = { id: 7n, note: 'local only', tags: ['alpha', 'beta'], blob: '0x00ff10', amounts: [1n, 2n ** 200n],
    inner: { flag: true, amount: 2n ** 255n, who: ${JSON.stringify(VERIFYING)} },
    items: [{ flag: false, amount: 3n, who: ${JSON.stringify(VERIFYING)} }, { flag: true, amount: 0n, who: '0x' + '00'.repeat(20) }] };
  const domainType = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
  const payload = (chainId) => JSON.parse(JSON.stringify({ types: { EIP712Domain: domainType, ...types }, primaryType: 'TestNote', domain: domain(chainId), message },
    (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const eq = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const verify = async (kind, signature, expected, chainId) => {
    if (!(typeof signature === 'string' && /^0x[0-9a-f]{130}$/i.test(signature))) return { wellFormed: false, ethers: false, viem: false };
    try {
      if (kind === 'message') {
        return { wellFormed: true, ethers: eq(ethers.verifyMessage(text, signature), expected), viem: eq(await viem.recoverMessageAddress({ message: text, signature }), expected) };
      }
      return { wellFormed: true, ethers: eq(ethers.verifyTypedData(domain(chainId), types, message, signature), expected),
        viem: eq(await viem.recoverTypedDataAddress({ domain: domain(chainId), types, primaryType: 'TestNote', message, signature }), expected) };
    } catch { return { wellFormed: true, ethers: false, viem: false }; }
  };
  const rpcCode = (error) => {
    let current = error;
    for (let i = 0; i < 8 && current; i++) {
      if (typeof current.code === 'number') return current.code;
      current = current.cause || current.error || (current.info && current.info.error);
    }
    return null;
  };
  /** Runs fn; returns only {ok} or {code, name, message} (message checked for sentinel leaks), never the value. */
  const outcome = async (fn) => {
    try { await fn(); return { ok: true }; } catch (error) {
      let inner = error; for (let i = 0; i < 8 && inner && typeof inner.code !== 'number'; i++) inner = inner.cause || inner.error || (inner.info && inner.info.error);
      return { ok: false, code: rpcCode(error), name: error && error.name, sdkCode: error && typeof error.code === 'string' ? error.code : null, message: inner && typeof inner.message === 'string' ? inner.message : null };
    }
  };
  window.__fx = { text, hexText: viem.toHex(text), types, domain, message, payload, verify, outcome };
  return true;
})()`;

test('real browser SDK signing on owned local Anvil: ethers/viem/wagmi-core, independent recovery, lifecycle, redaction', async (t) => {
  const started = Date.now();
  const evidence = { scope: 'Opt-in signing on vanilla local Anvil x2 (31337/31338, random mnemonic) + Playwright Chromium + bundled pinned SDKs. '
    + 'Local TestNote and text note only: not Permit/Permit2/SIWE, not a fork, real-wallet or arbitrary-dApp acceptance.', result: 'UNKNOWN', steps: {} };
  const step = (name, data) => { evidence.steps[name] = data; };
  let a, b, proxyA, proxyB, server, browser;
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-wallet-signing-'));
  t.after(async () => {
    try { if (browser) await browser.close(); } catch (error) { evidence.cleanupError = String(error.message); }
    await Promise.allSettled([server && server.close(), proxyA && proxyA.close(), proxyB && proxyB.close()]);
    const stops = await Promise.allSettled([a && a.stop(), b && b.stop()]);
    evidence.childrenStopped = stops.every((s) => s.status === 'fulfilled');
    if (!evidence.childrenStopped) evidence.result = 'FAIL';
    fs.rmSync(build, { recursive: true, force: true });
    evidence.elapsedMs = Date.now() - started;
    const text = JSON.stringify(evidence, null, 2) + '\n';
    // Redaction of the written artifact: no signature, note text, its hex or the policy sentinel.
    const secrets = [...(proxyA ? proxyA.signatures : []), ...(proxyB ? proxyB.signatures : []), NOTE, Buffer.from(NOTE).toString('hex'), SENTINEL];
    const leaked = secrets.filter((s) => text.toLowerCase().includes(s.toLowerCase())).length;
    if (leaked === 0) {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, 'evidence.json'), text);
    }
    console.log(evidence.result + ': ' + (leaked === 0 ? path.join(OUT, 'evidence.json') : 'evidence NOT written (redaction failure)'));
    assert.equal(leaked, 0, 'evidence contains no signature, message or sentinel');
    assert.ok(evidence.childrenStopped, 'owned anvil children stopped');
  });

  [a, b] = await Promise.all([startAnvil({ chainId: 31337 }), startAnvil({ chainId: 31338 })]);
  [proxyA, proxyB] = await Promise.all([countingProxy(a.endpoint), countingProxy(b.endpoint)]);
  const rpcA = createLoopbackRpc(a.endpoint);
  const rpcB = createLoopbackRpc(b.endpoint);
  evidence.anvil = { version: await rpcA('web3_clientVersion'), a: { chainId: a.chainId, account: a.account }, b: { chainId: b.chainId, account: b.account } };
  assert.equal(evidence.anvil.version, 'anvil/v1.8.3');
  const dispatched = () => proxyA.dispatched() + proxyB.dispatched();

  const bundled = await esbuild.build({ entryPoints: [path.join(__dirname, 'sdk/entry.mjs')], bundle: true, format: 'iife', globalName: 'sdk',
    platform: 'browser', target: 'es2022', outfile: path.join(build, 'bundle.js'), logLevel: 'silent', metafile: true });
  for (const file of ['index.html', 'frame.html', 'discovery.js']) fs.copyFileSync(path.join(__dirname, 'sdk', file), path.join(build, file));
  evidence.bundle = { sha256: sha256(fs.readFileSync(path.join(build, 'bundle.js'))), inputs: Object.keys(bundled.metafile.inputs).length };
  const gateways = [a.publicEndpoint, b.publicEndpoint];
  server = await startStaticServer(build, { csp: `default-src 'self'; script-src 'self'; connect-src ${gateways.join(' ')}; frame-src 'self'; img-src data:; base-uri 'none'; form-action 'none'` });
  const { origin } = server;
  a.configureOrigin(origin);
  b.configureOrigin(origin);

  browser = await chromium.launch({ headless: true });
  evidence.browser = browser.version();
  // Own policy-enabled context: no recordHar/recordVideo, no tracing, service workers blocked, egress limited.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const blocked = [];
  await context.routeWebSocket('**/*', (socket) => { blocked.push('ws'); socket.close(); });
  await context.route('**/*', (route) => {
    const target = new URL(route.request().url()).origin;
    if (target === origin || gateways.includes(target)) return route.continue();
    blocked.push(target);
    return route.abort();
  });
  const policy = { refuse: false, seen: [] };
  const wallet = await installForkWallet(context, {
    endpoint: proxyA.endpoint, origin, chainId: 31337, account: a.account, beforeSend: a.beforeSend,
    chains: [{ endpoint: proxyB.endpoint, chainId: 31338, account: b.account, beforeSend: b.beforeSend }],
    // Permissive so a parallel send reaches the single approval slot (-32002); no send is ever approved here.
    validateTransaction() {},
    signing: {
      validateSignature(request) {
        // Summary only: the policy itself keeps no message or typed data.
        policy.seen.push({ method: request.method, account: request.account, frozen: Object.isFrozen(request),
          domainChainId: request.typedData ? String(request.typedData.domain.chainId) : null });
        if (policy.refuse) throw new Error('refused ' + SENTINEL);
      },
    },
  });
  assert.equal(wallet.signing, true);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(origin + '/');
  await page.waitForFunction(() => window.sdk && window.ethereum);
  assert.equal(await page.evaluate(PAGE_FIXTURE), true);
  const signs = () => wallet.calls.filter((c) => SIGNING.includes(c.method));
  const lastSigns = (n) => signs().slice(-n).map((c) => [c.method, c.outcome, c.signatureReturned, c.delivered]);
  let failed = false;
  const subtest = (name, fn) => t.test(name, async (st) => { try { await fn(st); } catch (error) { failed = true; throw error; } });

  await subtest('connect is not signature permission: 4100 before connect, zero dispatch; subframe refused', async () => {
    const out = await page.evaluate(async (from) => {
      const fx = window.__fx;
      return {
        personal: await fx.outcome(() => window.ethereum.request({ method: 'personal_sign', params: [fx.hexText, from] })),
        typed: await fx.outcome(() => window.ethereum.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(fx.payload(31337))] })),
      };
    }, a.account);
    assert.deepEqual([out.personal.code, out.typed.code], [CODES.UNAUTHORIZED, CODES.UNAUTHORIZED]);
    const frame = page.frames().find((f) => f !== page.mainFrame());
    const sub = await frame.evaluate(async (from) => ({ ethereum: typeof window.ethereum,
      code: (await window.__forkWalletRequest({ method: 'personal_sign', params: ['0x00', from] })).error.code }), a.account);
    assert.deepEqual(sub, { ethereum: 'undefined', code: CODES.UNSUPPORTED_METHOD });
    assert.equal(dispatched(), 0);
    assert.equal(signs().length, 0);
    step('unauthorized', { codes: [out.personal.code, out.typed.code], subframe: sub.code, dispatched: dispatched() });
  });

  await subtest('ethers BrowserProvider: signMessage and signTypedData recover to the active account via ethers and viem', async () => {
    const before = dispatched();
    const out = await page.evaluate(async () => {
      const fx = window.__fx;
      const provider = new window.sdk.ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      const message = await fx.verify('message', await signer.signMessage(fx.text), address);
      const typed = await fx.verify('typed', await signer.signTypedData(fx.domain(31337), fx.types, fx.message), address, 31337);
      return { address, message, typed };
    });
    assert.equal(out.address.toLowerCase(), a.account.toLowerCase());
    assert.deepEqual([out.message, out.typed], [{ wellFormed: true, ethers: true, viem: true }, { wellFormed: true, ethers: true, viem: true }]);
    assert.equal(dispatched() - before, 2);
    assert.deepEqual(lastSigns(2), [['personal_sign', 'signed', true, true], ['eth_signTypedData_v4', 'signed', true, true]]);
    assert.deepEqual(signs().at(-1).domain, { chainId: '0x7a69', verifyingContract: VERIFYING });
    assert.deepEqual(wallet.submitted, [], 'signing never appends a transaction hash');
    step('ethers', { recovered: out, dispatched: dispatched() - before, inputHashes: signs().slice(-2).map((c) => c.inputHash) });
  });

  await subtest('viem custom(injected) wallet client: signMessage and signTypedData recover via ethers and viem', async () => {
    const before = dispatched();
    const out = await page.evaluate(async () => {
      const fx = window.__fx;
      const v = window.sdk.viem;
      const walletClient = v.createWalletClient({ transport: v.custom(window.ethereum) });
      const [address] = await walletClient.requestAddresses();
      const message = await fx.verify('message', await walletClient.signMessage({ account: address, message: fx.text }), address);
      const typed = await fx.verify('typed', await walletClient.signTypedData({ account: address, domain: fx.domain(31337), types: fx.types, primaryType: 'TestNote', message: fx.message }), address, 31337);
      return { address, message, typed };
    });
    assert.equal(out.address.toLowerCase(), a.account.toLowerCase());
    assert.deepEqual([out.message, out.typed], [{ wellFormed: true, ethers: true, viem: true }, { wellFormed: true, ethers: true, viem: true }]);
    assert.equal(dispatched() - before, 2);
    assert.deepEqual(lastSigns(2), [['personal_sign', 'signed', true, true], ['eth_signTypedData_v4', 'signed', true, true]]);
    step('viem', { recovered: out, dispatched: dispatched() - before });
  });

  await subtest('direct provider: hex personal_sign, typed JSON string and plain object forms give the same recovered digest', async () => {
    const before = dispatched();
    const out = await page.evaluate(async (from) => {
      const fx = window.__fx;
      const request = (method, params) => window.ethereum.request({ method, params });
      const personal = await request('personal_sign', [fx.hexText, from]);
      const asString = await request('eth_signTypedData_v4', [from, JSON.stringify(fx.payload(31337))]);
      const asObject = await request('eth_signTypedData_v4', [from, fx.payload(31337)]);
      return { personal: await fx.verify('message', personal, from), string: await fx.verify('typed', asString, from, 31337),
        object: await fx.verify('typed', asObject, from, 31337), sameSignature: asString === asObject };
    }, a.account);
    const ok = { wellFormed: true, ethers: true, viem: true };
    assert.deepEqual(out, { personal: ok, string: ok, object: ok, sameSignature: true });
    assert.equal(dispatched() - before, 3);
    assert.equal(signs().at(-1).inputHash, signs().at(-2).inputHash, 'string and object normalize to the same request');
    assert.ok(policy.seen.every((s) => s.frozen && s.account === a.account));
    step('direct', { recovered: out, dispatched: dispatched() - before });
  });

  await subtest('refusals: wrong signer/domain/input, reject, policy, lost, hold/revoke/switch races, single slot, impersonation', async () => {
    const before = { dispatched: dispatched(), returned: proxyA.stats.wellFormedReturned + proxyB.stats.wellFormedReturned };
    const invalid = await page.evaluate(async ({ from, stranger }) => {
      const fx = window.__fx;
      const req = (method, params) => fx.outcome(() => window.ethereum.request({ method, params }));
      return {
        wrongSigner: await req('personal_sign', [fx.hexText, stranger]),
        addressFirst: await req('personal_sign', [from, fx.hexText]),
        utf8: await req('personal_sign', [fx.text, from]),
        wrongDomain: await req('eth_signTypedData_v4', [from, JSON.stringify(fx.payload(31338))]),
        wrongTypedSigner: await req('eth_signTypedData_v4', [stranger, fx.payload(31337)]),
        float: await req('eth_signTypedData_v4', [from, JSON.stringify(fx.payload(31337)).replace('"id":"7"', '"id":7.5')]),
        ethSign: await req('eth_sign', [from, fx.hexText]),
        v3: await req('eth_signTypedData_v3', [from, JSON.stringify(fx.payload(31337))]),
      };
    }, { from: a.account, stranger: b.account });
    assert.deepEqual(Object.fromEntries(Object.entries(invalid).map(([k, v]) => [k, v.code])), {
      wrongSigner: -32602, addressFirst: -32602, utf8: -32602, wrongDomain: -32602, wrongTypedSigner: -32602, float: -32602, ethSign: 4200, v3: 4200 });
    // User rejection surfaces as the SDKs' rejection errors.
    wallet.nextRequest({ method: 'personal_sign', mode: 'reject' });
    wallet.nextRequest({ method: 'eth_signTypedData_v4', mode: 'reject' });
    const rejected = await page.evaluate(async () => {
      const fx = window.__fx;
      const signer = await new window.sdk.ethers.BrowserProvider(window.ethereum).getSigner();
      const v = window.sdk.viem;
      const walletClient = v.createWalletClient({ transport: v.custom(window.ethereum) });
      const [address] = await walletClient.requestAddresses();
      return { ethers: await fx.outcome(() => signer.signMessage(fx.text)),
        viem: await fx.outcome(() => walletClient.signTypedData({ account: address, domain: fx.domain(31337), types: fx.types, primaryType: 'TestNote', message: fx.message })) };
    });
    assert.deepEqual([rejected.ethers.code, rejected.ethers.sdkCode, rejected.viem.code, rejected.viem.name], [4001, 'ACTION_REJECTED', 4001, 'UserRejectedRequestError']);
    // Policy refusal: fixed -32603, the thrown sentinel never reaches the page.
    policy.refuse = true;
    const refused = await page.evaluate((from) => window.__fx.outcome(() => window.ethereum.request({ method: 'personal_sign', params: [window.__fx.hexText, from] })), a.account);
    policy.refuse = false;
    assert.deepEqual([refused.code, refused.message], [CODES.INTERNAL, 'signature refused by policy']);
    // Lost is not supported for signing.
    wallet.setMode('lost');
    const lost = await page.evaluate((from) => window.__fx.outcome(() => window.ethereum.request({ method: 'personal_sign', params: [window.__fx.hexText, from] })), a.account);
    wallet.setMode('approve');
    assert.equal(lost.code, CODES.INVALID_PARAMS);
    assert.throws(() => wallet.nextRequest({ method: 'personal_sign', mode: 'lost' }), (e) => e.code === CODES.INVALID_PARAMS);
    assert.equal(dispatched(), before.dispatched, 'no refusal dispatched a signing request');
    // Hold then approve through viem: one real signature.
    const viemSign = () => page.evaluate(async () => {
      const fx = window.__fx;
      const v = window.sdk.viem;
      const walletClient = v.createWalletClient({ transport: v.custom(window.ethereum) });
      const [address] = await v.createWalletClient({ transport: v.custom(window.ethereum) }).getAddresses();
      const result = await fx.outcome(async () => { window.__held = await fx.verify('message', await walletClient.signMessage({ account: address, message: fx.text }), address); });
      return { ...result, recovered: window.__held || null };
    });
    wallet.nextRequest({ method: 'personal_sign', mode: 'hold' });
    const heldApprove = viemSign();
    const heldId = await wallet.whenHeld();
    assert.throws(() => wallet.release(heldId, 'lost'), (e) => e.code === CODES.INVALID_PARAMS);
    assert.throws(() => wallet.release(crypto.randomUUID()), (e) => e.code === CODES.INVALID_PARAMS);
    // Single approval slot: a parallel send or sign is -32002 while the signature is held.
    const parallel = await page.evaluate((from) => Promise.all([
      window.__fx.outcome(() => window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to: from, value: '0x1' }] })),
      window.__fx.outcome(() => window.ethereum.request({ method: 'eth_signTypedData_v4', params: [from, window.__fx.payload(31337)] }))]), a.account);
    assert.deepEqual(parallel.map((p) => p.code), [CODES.REQUEST_PENDING, CODES.REQUEST_PENDING]);
    wallet.release(heldId, 'approve');
    assert.throws(() => wallet.release(heldId, 'approve'), (e) => e.code === CODES.INTERNAL, 'double release');
    const approved = await heldApprove;
    assert.deepEqual([approved.ok, approved.recovered], [true, { wellFormed: true, ethers: true, viem: true }]);
    assert.equal(dispatched(), before.dispatched + 1);
    // Hold then revoke / chain switch / account change: cancelled with the scope error and no dispatch.
    const helperA = (await rpcA('eth_accounts'))[1];
    for (const [race, expected, restore] of [
      [() => wallet.revoke(), CODES.UNAUTHORIZED, () => page.evaluate(() => window.ethereum.request({ method: 'eth_requestAccounts' }))],
      [() => wallet.switchChain(31338), CODES.CHAIN_DISCONNECTED, () => wallet.switchChain(31337)],
      [() => wallet.setAccount(helperA), CODES.UNAUTHORIZED, () => wallet.setAccount(a.account)],
    ]) {
      wallet.nextRequest({ method: 'eth_signTypedData_v4', mode: 'hold' });
      const pending = page.evaluate((from) => window.__fx.outcome(() => window.ethereum.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(window.__fx.payload(31337))] })), a.account);
      const id = await wallet.whenHeld();
      await race();
      assert.equal((await pending).code, expected);
      assert.equal(signs().at(-1).outcome, 'cancelled');
      assert.throws(() => wallet.release(id));
      await restore();
    }
    assert.equal(dispatched(), before.dispatched + 1, 'stale approvals produced zero signing dispatches');
    // An impersonated (keyless) address on the owned node cannot sign: Anvil refuses, the reply is sanitized.
    const impersonated = '0x' + crypto.randomBytes(20).toString('hex');
    await rpcA('anvil_impersonateAccount', [impersonated]);
    await wallet.setAccount(impersonated);
    const keyless = await page.evaluate((from) => window.__fx.outcome(() => window.ethereum.request({ method: 'personal_sign', params: [window.__fx.hexText, from] })), impersonated);
    await rpcA('anvil_stopImpersonatingAccount', [impersonated]);
    await wallet.setAccount(a.account);
    assert.deepEqual([keyless.code, keyless.message], [CODES.INVALID_PARAMS, 'node refused the signing request']);
    assert.deepEqual(lastSigns(1), [['personal_sign', 'failed', false, false]]);
    const returned = proxyA.stats.wellFormedReturned + proxyB.stats.wellFormedReturned - before.returned;
    assert.equal(dispatched(), before.dispatched + 2);
    assert.equal(returned, 1, 'only the approved held request produced a signature');
    const leaks = [invalid, rejected, refused, lost, parallel, keyless].map((o) => JSON.stringify(o)).join('').includes(SENTINEL);
    assert.equal(leaks, false, 'no page-visible error carries the policy sentinel');
    step('refusals', { codes: { ...Object.fromEntries(Object.entries(invalid).map(([k, v]) => [k, v.code])), rejected: [rejected.ethers.code, rejected.viem.code],
      policy: refused.code, lost: lost.code, parallel: parallel.map((p) => p.code), impersonated: keyless.code },
    dispatched: dispatched() - before.dispatched, signaturesReturned: returned, policyCalls: policy.seen.length });
  });

  await subtest('wagmi core discovered connector: signMessage/signTypedData, chain 31338 domain and account switch', async () => {
    const before = dispatched();
    await page.evaluate(`(() => {
      const w = window.sdk.wagmi, v = window.sdk.viem;
      const mk = (id, url) => v.defineChain({ id, name: 'Owned ' + id, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
      window.__wagmi = w.createConfig({ chains: [mk(31337, ${JSON.stringify(a.publicEndpoint)}), mk(31338, ${JSON.stringify(b.publicEndpoint)})],
        multiInjectedProviderDiscovery: true, connectors: [],
        transports: { 31337: w.http(${JSON.stringify(a.publicEndpoint)}), 31338: w.http(${JSON.stringify(b.publicEndpoint)}) } });
      return true;
    })()`);
    await page.waitForFunction(() => window.sdk.wagmi.getConnectors(window.__wagmi).some((c) => c.id === 'dev.forkwallet.test'));
    await wallet.revoke();
    const out = await page.evaluate(async () => {
      const fx = window.__fx;
      const w = window.sdk.wagmi;
      const config = window.__wagmi;
      const connector = w.getConnectors(config).find((c) => c.id === 'dev.forkwallet.test');
      const connected = await w.connect(config, { connector });
      const address = connected.accounts[0];
      const message = await fx.verify('message', await w.signMessage(config, { message: fx.text }), address);
      const typed = await fx.verify('typed', await w.signTypedData(config, { domain: fx.domain(31337), types: fx.types, primaryType: 'TestNote', message: fx.message }), address, 31337);
      await w.switchChain(config, { chainId: 31338 });
      const addressB = w.getAccount(config).address;
      const typedB = await fx.verify('typed', await w.signTypedData(config, { domain: fx.domain(31338), types: fx.types, primaryType: 'TestNote', message: fx.message }), addressB, 31338);
      const staleDomain = await fx.outcome(() => window.ethereum.request({ method: 'eth_signTypedData_v4', params: [addressB, fx.payload(31337)] }));
      return { connector: connector.type, address, message, typed, addressB, typedB, staleDomain: staleDomain.code };
    });
    const ok = { wellFormed: true, ethers: true, viem: true };
    assert.equal(out.connector, 'injected');
    assert.equal(out.address.toLowerCase(), a.account.toLowerCase());
    assert.equal(out.addressB.toLowerCase(), b.account.toLowerCase(), 'per-chain account after switch');
    assert.deepEqual([out.message, out.typed, out.typedB], [ok, ok, ok]);
    assert.equal(out.staleDomain, CODES.INVALID_PARAMS, 'domain of the previous chain is refused');
    assert.equal(proxyB.stats.eth_signTypedData_v4, 1, 'chain-B typed signature went to chain B only');
    // Node-side account switch to another random helper account on chain B: SDK signatures recover to it.
    const helperB = (await rpcB('eth_accounts'))[1];
    await wallet.setAccount(helperB);
    const switched = await page.evaluate(async (expected) => {
      const fx = window.__fx;
      const v = window.sdk.viem;
      const walletClient = v.createWalletClient({ transport: v.custom(window.ethereum) });
      const [address] = await walletClient.getAddresses();
      return { same: address.toLowerCase() === expected.toLowerCase(),
        message: await fx.verify('message', await walletClient.signMessage({ account: address, message: fx.text }), expected),
        typed: await fx.verify('typed', await walletClient.signTypedData({ account: address, domain: fx.domain(31338), types: fx.types, primaryType: 'TestNote', message: fx.message }), expected, 31338) };
    }, helperB);
    assert.deepEqual(switched, { same: true, message: ok, typed: ok });
    assert.equal(dispatched() - before, 5);
    assert.ok(signs().slice(-2).every((c) => c.account === helperB && c.chainId === '0x7a6a' && c.outcome === 'signed'));
    step('wagmi', { recovered: { ...out, address: undefined, addressB: undefined }, switched, dispatched: dispatched() - before });
  });

  await subtest('read gateway never signs, even inside a batch', async () => {
    const before = dispatched();
    const out = await page.evaluate(async ({ gateway, from }) => {
      const fx = window.__fx;
      const batch = [['personal_sign', [fx.hexText, from]], ['eth_signTypedData_v4', [from, JSON.stringify(fx.payload(31337))]], ['eth_sign', [from, fx.hexText]], ['eth_chainId', []]]
        .map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
      const reply = await fetch(gateway, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch) });
      return (await reply.json()).map((r) => (r.error ? r.error.code : 'ok'));
    }, { gateway: a.publicEndpoint, from: a.account });
    assert.deepEqual(out, [4200, 4200, 4200, 'ok']);
    assert.equal(dispatched(), before);
    step('gateway', { batch: out });
  });

  // Totals: every well-formed signature the node returned is accounted for by a signed record (delivered).
  const totals = { dispatched: dispatched(), proxy: { a: { ...proxyA.stats }, b: { ...proxyB.stats } },
    signed: signs().filter((c) => c.outcome === 'signed').length, discarded: signs().filter((c) => c.outcome === 'signed-discarded').length };
  assert.equal(proxyA.stats.wellFormedReturned + proxyB.stats.wellFormedReturned, totals.signed + totals.discarded);
  assert.ok(signs().filter((c) => c.outcome === 'signed').every((c) => c.signatureReturned && c.delivered));
  assert.ok(signs().every((c) => !['message', 'typedData', 'signature', 'params'].some((k) => k in c)));
  assert.deepEqual(wallet.submitted, [], 'no transaction was submitted by the signing gate');
  assert.equal(BigInt(await rpcA('eth_getTransactionCount', [a.account, 'latest'])) + BigInt(await rpcB('eth_getTransactionCount', [b.account, 'latest'])), 0n);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blocked, []);
  assert.equal(failed, false, 'all signing subtests passed');
  evidence.totals = totals;
  evidence.walletCalls = wallet.calls;
  evidence.unsupported = wallet.unsupported;
  evidence.policyCalls = policy.seen.length;
  evidence.result = 'PASS';
});
