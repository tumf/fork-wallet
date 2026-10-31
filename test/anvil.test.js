'use strict';
// Integration: fork-wallet/anvil lifecycle and read gateway against real Anvil 1.8.3 child processes, generated fake
// "anvil" executables for failure paths, real loopback sockets and lsof. Missing anvil/lsof is a failure, not a skip.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { startAnvil, startReadGateway, listenerPids, requireNoCredentials } = require('../src/anvil.js');
const { createLoopbackRpc, CODES, LIMITS } = require('../src/index.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const post = async (url, body, headers = {}) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
};

/** Writes an executable fake "anvil" (a node script) that records its pid/args into a report file first. */
function fakeAnvil(t, behaviour) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-wallet-fake-anvil-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = path.join(dir, 'report.json');
  const file = path.join(dir, 'anvil');
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs'); const http = require('node:http');
const args = process.argv.slice(2); const port = Number(args[args.indexOf('--port') + 1]);
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, args, env: Object.keys(process.env) }));
const serve = (answers) => http.createServer((req, res) => { let t = ''; req.on('data', (c) => { t += c; }); req.on('end', () => {
  const q = JSON.parse(t); res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: answers[q.method] ?? null })); }); }).listen(port, '127.0.0.1');
${behaviour}
`);
  fs.chmodSync(file, 0o755);
  const read = () => (fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null);
  return { file, read };
}

const ANSWERS = (version, chain) => `{ web3_clientVersion: ${JSON.stringify(version)}, eth_chainId: ${JSON.stringify(chain)}, eth_accounts: ['0x${'11'.repeat(20)}'] }`;

test('startAnvil refuses bad options, credential environment and missing or silent binaries, and cleans up', async (t) => {
  for (const options of [{ args: ['--fork-url', 'x'] }, { mnemonic: 'x' }, { chainId: 0 }, { chainId: '1' }, { anvil: '' }, { anvil: '--help' }, { timeoutMs: 5 }, null]) {
    await assert.rejects(startAnvil(options), (e) => e.code === CODES.INVALID_PARAMS, JSON.stringify(options));
  }
  assert.throws(() => requireNoCredentials({ PRIVATE_KEY: '0x1' }), /credential-like/);
  assert.throws(() => requireNoCredentials({ ANVIL_IP_ADDR: '0.0.0.0' }), /credential-like/);
  requireNoCredentials({ PATH: '/bin', HOME: '/tmp', PRIVATE_KEY: '' });
  process.env.DEPLOYER_MNEMONIC = 'test words';
  try {
    await assert.rejects(startAnvil({ anvil: '/nonexistent' }), /credential-like environment: DEPLOYER_MNEMONIC/);
  } finally { delete process.env.DEPLOYER_MNEMONIC; }
  await assert.rejects(startAnvil({ anvil: path.join(os.tmpdir(), 'no-such-anvil-binary') }), /cannot start|exited during startup/);
  // Never listens: bounded readiness, then the owned child is stopped.
  const silent = fakeAnvil(t, 'setInterval(() => {}, 1000);');
  const started = Date.now();
  await assert.rejects(startAnvil({ anvil: silent.file, timeoutMs: 800 }), /did not become ready within 800ms/);
  assert.ok(Date.now() - started < 8000, 'startup is bounded');
  const report = silent.read();
  assert.ok(report && report.pid);
  assert.equal(alive(report.pid), false, 'the owned child was stopped');
  // macOS injects __CF_USER_TEXT_ENCODING into every process; everything else must come from scrubbedEnv().
  assert.deepEqual(report.env.filter((k) => !k.startsWith('__CF_')).sort(), ['HOME', 'PATH'], 'child environment is PATH/HOME only');
  assert.deepEqual(report.args.filter((a) => a.startsWith('--')), ['--host', '--port', '--chain-id', '--mnemonic-random', '--silent', '--no-cors']);
  assert.equal(report.args[report.args.indexOf('--host') + 1], '127.0.0.1');
});

test('startAnvil refuses unsupported client, wrong chain and a foreign listener without killing it', async (t) => {
  for (const [label, behaviour, pattern] of [
    ['old anvil', `serve(${ANSWERS('anvil/v1.7.0', '0x7a69')});`, /unsupported client "anvil\/v1\.7\.0"/],
    ['other client', `serve(${ANSWERS('Geth/v1.13.0', '0x7a69')});`, /unsupported client/],
    ['wrong chain', `serve(${ANSWERS('anvil/v1.8.3-stable', '0x1')});`, /anvil chain 0x1 is not 31337/],
  ]) {
    const fake = fakeAnvil(t, behaviour);
    await assert.rejects(startAnvil({ anvil: fake.file, timeoutMs: 5000 }), pattern, label);
    assert.equal(alive(fake.read().pid), false, `${label}: owned child stopped`);
  }
  // Foreign listener: the fake child does not listen; this test process grabs the port and answers like Anvil.
  const fake = fakeAnvil(t, 'setInterval(() => {}, 1000);');
  let foreign = null;
  const watcher = (async () => {
    for (let i = 0; i < 200 && !fake.read(); i++) await sleep(10);
    const { args } = fake.read();
    const port = Number(args[args.indexOf('--port') + 1]);
    foreign = http.createServer((req, res) => {
      let text = '';
      req.on('data', (c) => { text += c; });
      req.on('end', () => {
        const q = JSON.parse(text);
        const answers = { web3_clientVersion: 'anvil/v1.8.3', eth_chainId: '0x7a69', eth_accounts: ['0x' + '11'.repeat(20)] };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: answers[q.method] }));
      });
    });
    await new Promise((resolve) => foreign.listen(port, '127.0.0.1', resolve));
    return port;
  })();
  await assert.rejects(startAnvil({ anvil: fake.file, timeoutMs: 5000 }), /listener on \d+ is \[\d+\], not owned pid/);
  const port = await watcher;
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  assert.equal(alive(fake.read().pid), false, 'own child stopped');
  assert.deepEqual(listenerPids(port), [process.pid], 'the foreign listener was not killed');
  assert.equal(await createLoopbackRpc(`http://127.0.0.1:${port}`)('eth_chainId'), '0x7a69');
});

test('real Anvil: distinct owned instances, ownership guard, idempotent stop, TERM-ignoring child is KILLed', async (t) => {
  const [a, b] = await Promise.all([startAnvil({ chainId: 31337 }), startAnvil({ chainId: 31338 })]);
  t.after(async () => { await a.stop(); await b.stop(); });
  assert.notEqual(a.pid, b.pid);
  assert.notEqual(a.endpoint, b.endpoint);
  assert.notEqual(a.publicEndpoint, b.publicEndpoint);
  assert.notEqual(a.account.toLowerCase(), '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', 'random mnemonic, not the known default');
  assert.notEqual(a.account, b.account);
  assert.deepEqual([a.chainId, b.chainId], ['0x7a69', '0x7a6a']);
  assert.ok(Object.isFrozen(a));
  assert.equal(typeof a.rpc, 'undefined', 'no management rpc function is returned');
  a.beforeSend();
  const port = Number(new URL(a.endpoint).port);
  assert.deepEqual(listenerPids(port), [a.pid]);
  assert.equal(await createLoopbackRpc(a.endpoint)('web3_clientVersion'), 'anvil/v1.8.3');
  await Promise.all([a.stop(), a.stop()]);
  await a.stop();
  assert.equal(alive(a.pid), false);
  assert.deepEqual(listenerPids(port), []);
  assert.throws(() => a.beforeSend(), /not running/);
  await assert.rejects(fetch(a.publicEndpoint, { method: 'POST' }), 'gateway closed with the child');
  b.beforeSend();
  assert.equal(alive(b.pid), true, 'stopping one instance leaves the other alone');
  // A child that ignores SIGTERM is KILLed (only that child) within the bounded stop.
  const stubborn = fakeAnvil(t, `process.on('SIGTERM', () => {}); serve(${ANSWERS('anvil/v1.8.3', '0x7a69')});`);
  const owned = await startAnvil({ anvil: stubborn.file, timeoutMs: 5000 });
  assert.equal(owned.pid, stubborn.read().pid);
  const started = Date.now();
  await owned.stop();
  assert.ok(Date.now() - started >= 4000, 'TERM grace period was observed');
  assert.equal(alive(owned.pid), false);
});

test('read gateway on real Anvil: path/method/CORS/content-type/size/batch rules and no write side effects', async (t) => {
  const anvil = await startAnvil({ chainId: 31337 });
  t.after(() => anvil.stop());
  const rpc = createLoopbackRpc(anvil.endpoint);
  const url = anvil.publicEndpoint;
  const app = 'http://127.0.0.1:45678';
  const state = async () => ({ block: await rpc('eth_blockNumber'), nonce: await rpc('eth_getTransactionCount', [anvil.account, 'latest']), balance: await rpc('eth_getBalance', [anvil.account, 'latest']) });
  const before = await state();
  // Without Origin (Node test runner) reads work; with any Origin before configureOrigin they are refused.
  assert.deepEqual((await post(url, { jsonrpc: '2.0', id: 1, method: 'eth_chainId' })).body, { jsonrpc: '2.0', id: 1, result: '0x7a69' });
  assert.equal((await post(url, { jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { origin: app })).status, 403);
  assert.equal((await fetch(url, { method: 'OPTIONS', headers: { origin: app } })).status, 403);
  assert.throws(() => anvil.configureOrigin('http://localhost:1'), (e) => e.code === CODES.INVALID_PARAMS);
  anvil.configureOrigin(app);
  anvil.configureOrigin(app);
  assert.throws(() => anvil.configureOrigin('http://127.0.0.1:45679'), /already configured/);
  const preflight = await fetch(url, { method: 'OPTIONS', headers: { origin: app, 'access-control-request-method': 'POST' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), app);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal((await fetch(url, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:45679' } })).status, 403);
  assert.equal((await fetch(url, { method: 'OPTIONS' })).status, 403);
  const ok = await post(url, { jsonrpc: '2.0', id: 'a', method: 'eth_blockNumber', params: [] }, { origin: app });
  assert.equal(ok.headers.get('access-control-allow-origin'), app);
  assert.deepEqual(ok.body, { jsonrpc: '2.0', id: 'a', result: before.block });
  assert.equal((await post(url, { jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { origin: 'http://127.0.0.1:45679' })).status, 403);
  assert.equal((await fetch(url + '/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await fetch(url + '/?x=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await fetch(url, { method: 'GET' })).status, 405);
  assert.equal((await fetch(url, { method: 'PUT', body: '{}' })).status, 405);
  assert.equal((await post(url, { jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(url, 'x'.repeat(LIMITS.requestBytes + 1))).status, 413);
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    for (let i = 0; i < 20; i++) req.write(chunk);
    req.end();
  });
  assert.equal(chunked, 413, 'streamed body without Content-Length is bounded too');
  await new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': LIMITS.requestBytes + 1 } }, (res) => {
      assert.equal(res.statusCode, 413);
      res.on('error', () => {}); // An incomplete upload is deliberately closed after the bounded drain window.
      res.once('close', resolve);
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('oversized incomplete upload did not close')); });
    req.flushHeaders();
  });
  assert.deepEqual((await post(url, '{not json')).body.error.code, -32700);
  assert.equal((await post(url, [])).body.error.code, CODES.INVALID_REQUEST);
  assert.equal((await post(url, Array.from({ length: 21 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'eth_chainId' })))).body.error.code, CODES.INVALID_REQUEST);
  // Writes, admin, signing and wallet methods are refused per item, including inside a batch.
  const refused = ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'eth_accounts',
    'anvil_setBalance', 'anvil_mine', 'evm_mine', 'evm_snapshot', 'hardhat_setBalance', 'debug_traceCall', 'admin_nodeInfo', 'wallet_sendTransaction', 'eth_requestAccounts'];
  const batch = [
    ...refused.map((method, id) => ({ jsonrpc: '2.0', id, method, params: method === 'eth_sendTransaction' ? [{ from: anvil.account, to: anvil.account, value: '0x1' }] : method === 'anvil_setBalance' ? [anvil.account, '0x0'] : [] })),
    { jsonrpc: '2.0', method: 'eth_blockNumber' }, // notification
    { jsonrpc: '1.0', id: 'v', method: 'eth_chainId' },
    { jsonrpc: '2.0', id: { x: 1 }, method: 'eth_chainId' },
    { jsonrpc: '2.0', id: 'p', method: 'eth_getBalance', params: [anvil.account] },
    { jsonrpc: '2.0', id: 'o', method: 'eth_call', params: [{ to: anvil.account }, 'latest', { [anvil.account]: { balance: '0x0' } }] },
  ];
  assert.equal(batch.length, LIMITS.batch);
  const replies = (await post(url, batch)).body;
  assert.equal(replies.length, batch.length);
  assert.deepEqual(replies.slice(0, refused.length).map((r) => [r.id, r.error && r.error.code]), refused.map((_, id) => [id, CODES.UNSUPPORTED_METHOD]));
  assert.deepEqual(replies.slice(refused.length).map((r) => [r.id, r.error.code]), [[null, CODES.INVALID_REQUEST], ['v', CODES.INVALID_REQUEST], [null, CODES.INVALID_REQUEST], ['p', CODES.INVALID_PARAMS], ['o', CODES.INVALID_PARAMS]]);
  assert.deepEqual(await state(), before, 'no block, nonce or balance change');
  // Upstream errors (revert data) are preserved; logs need a bounded range.
  const revert = (await post(url, { jsonrpc: '2.0', id: 9, method: 'eth_call', params: [{ data: '0x60006000fd' }, 'latest'] })).body;
  assert.ok(revert.error && Number.isInteger(revert.error.code), JSON.stringify(revert));
  assert.equal((await post(url, { jsonrpc: '2.0', id: 10, method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: '0x2710' }] })).body.error.code, CODES.INVALID_PARAMS);
  assert.deepEqual((await post(url, { jsonrpc: '2.0', id: 11, method: 'eth_getLogs', params: [{}] })).body, { jsonrpc: '2.0', id: 11, result: [] });
});

test('read gateway bounds against a scripted upstream: ownership first, oversized/streamed/redirected replies refused', async (t) => {
  const seen = [];
  let mode = 'ok';
  const upstream = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      const q = JSON.parse(text);
      seen.push(q.method);
      if (mode === 'redirect') { res.writeHead(307, { Location: 'http://127.0.0.1:1/' }); res.end(); return; }
      if (mode === 'big') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: 'x'.repeat(LIMITS.responseBytes) })); return; }
      if (mode === 'stream') {
        res.writeHead(200, { 'content-type': 'application/json' });
        const chunk = Buffer.alloc(1 << 20, 0x20);
        let sent = 0;
        const pump = () => { while (sent <= LIMITS.responseBytes) { sent += chunk.length; if (!res.write(chunk)) { res.once('drain', pump); return; } } res.end(); };
        pump();
        return;
      }
      if (mode === 'error') { res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } })); return; }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: '0x7a69' }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  let owned = false;
  const gateway = await startReadGateway({ endpoint: `http://127.0.0.1:${upstream.address().port}`, beforeSend() { if (!owned) throw new Error('foreign pid'); } });
  t.after(() => gateway.close());
  const call = (id = 1) => post(gateway.publicEndpoint, { jsonrpc: '2.0', id, method: 'eth_chainId' }).then((r) => r.body);
  assert.equal((await call()).error.code, CODES.CHAIN_DISCONNECTED);
  assert.deepEqual((await post(gateway.publicEndpoint, [{ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { jsonrpc: '2.0', id: 2, method: 'eth_getLogs', params: [{}] }])).body.map((r) => r.error.code), [CODES.CHAIN_DISCONNECTED, CODES.CHAIN_DISCONNECTED]);
  assert.deepEqual(seen, [], 'ownership is checked before any upstream dispatch, per item');
  owned = true;
  assert.deepEqual(await call(), { jsonrpc: '2.0', id: 1, result: '0x7a69' });
  for (const m of ['redirect', 'big', 'stream']) {
    mode = m;
    const reply = await call();
    assert.equal(reply.error && reply.error.code, CODES.INTERNAL, m);
    assert.ok(!('result' in reply), m);
  }
  mode = 'error';
  assert.deepEqual((await call()).error, { code: 3, message: 'execution reverted', data: '0x08c379a0' });
  assert.ok(seen.every((m) => m === 'eth_chainId'), 'only the validated read reached upstream');
  assert.equal(seen.length, 5, 'one upstream attempt per accepted item, no retries');
  await gateway.close();
  await gateway.close();
  await assert.rejects(fetch(gateway.publicEndpoint, { method: 'POST' }));
  assert.ok(net.isIP('127.0.0.1'));
});
