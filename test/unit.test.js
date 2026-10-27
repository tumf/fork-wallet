'use strict';
// Offline controls against a scripted JSON-RPC double and a fake BrowserContext. Not chain or browser acceptance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const wallet = require('../src/index.js');
const { installForkWallet, CODES } = wallet;

const account = '0x' + '11'.repeat(20);
const target = '0x' + '22'.repeat(20);
const hash = '0x' + '33'.repeat(32);
const origin = 'http://127.0.0.1:12345';
const chainId = '0x7a69';
const tx = Object.freeze({ chainId, from: account, to: target, value: '0x0', data: '0x1234' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Scripted loopback node. Knobs change behaviour per call so each RPC-integrity failure is exercised. */
async function startNode(t) {
  const node = { sends: 0, chain: chainId, client: 'anvil/v1.8.3', accounts: [account], redirect: false, wrongID: false,
    status: 200, ambiguous: false, nonJSON: false, hash, requests: [] };
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const q = JSON.parse(text);
    node.requests.push(q.method);
    if (node.redirect) { res.writeHead(307, { Location: '/forwarded' }); res.end(); return; }
    if (node.nonJSON) { res.end('not json'); return; }
    const result = q.method === 'eth_chainId' ? node.chain : q.method === 'web3_clientVersion' ? node.client
      : q.method === 'eth_accounts' ? node.accounts : q.method === 'eth_sendTransaction' ? (node.sends++, node.hash) : null;
    const body = { jsonrpc: '2.0', id: node.wrongID ? q.id + 1 : q.id, result };
    if (node.ambiguous) body.error = { code: -1, message: 'both' };
    res.writeHead(node.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  node.endpoint = 'http://127.0.0.1:' + server.address().port;
  return node;
}

function fakeContext(pages = []) {
  const ctx = { binding: null, script: null, pages: () => pages };
  ctx.exposeBinding = async (name, fn) => { assert.equal(name, '__forkWalletRequest'); ctx.binding = fn; };
  ctx.addInitScript = async (fn, args) => { ctx.script = { fn, args }; };
  ctx.request = (method, params = [], frameOrigin = origin) => ctx.binding({ frame: { url: () => frameOrigin + '/' } }, { method, params });
  return ctx;
}

function baseOptions(node, extra = {}) {
  return { endpoint: node.endpoint, origin, chainId, account, validateTransaction() {}, beforeSend() {}, ...extra };
}

test('configuration is fail-closed: loopback HTTP only, exact origin, explicit chain, mandatory guards', async (t) => {
  const node = await startNode(t);
  const ctx = fakeContext();
  const bad = [
    { endpoint: 'https://127.0.0.1:8545' }, { endpoint: 'http://localhost:8545' }, { endpoint: 'http://127.0.0.1:8545#x' },
    { endpoint: 'http://127.0.0.1:8545?x=1' }, { endpoint: 'http://127.0.0.1:8545/rpc' }, { endpoint: 'http://127.0.0.1' },
    { endpoint: 'http://user:pw@127.0.0.1:8545' }, { endpoint: 'http://[::1]:8545' }, { endpoint: 42 },
    { origin: 'http://127.0.0.1:12345/' }, { origin: 'http://localhost:12345' }, { origin: 'https://127.0.0.1:12345' }, { origin: 'http://127.0.0.1' },
    { chainId: undefined }, { chainId: '0x089' }, { chainId: '0x0' }, { chainId: 0 }, { chainId: '137' }, { chainId: 1.5 },
    { account: 'not-an-address' }, { validateTransaction: undefined }, { beforeSend: 'guard' }, { clientVersion: 'anvil' }, { timeoutMs: 0 },
  ];
  for (const change of bad) {
    await assert.rejects(installForkWallet(ctx, baseOptions(node, change)), (e) => e.code === CODES.INVALID_PARAMS, JSON.stringify(change));
  }
  await assert.rejects(installForkWallet({}, baseOptions(node)), (e) => e.code === CODES.INVALID_PARAMS);
  assert.equal(wallet.normalizeChainId(137), '0x89');
  assert.equal(wallet.normalizeChainId('0xA'), '0xa');
  assert.equal(wallet.requireLoopbackEndpoint('http://127.0.0.1:8545/'), 'http://127.0.0.1:8545/');
  const installed = await installForkWallet(ctx, baseOptions(node, { chainId: 31337 }));
  assert.equal(installed.chainId, chainId);
  assert.equal(installed.account, account);
  assert.equal(installed.mode, 'approve');
  assert.equal(installed.connected, true);
  assert.equal(installed.held, false);
  assert.equal(ctx.script.args.origin, origin);
});

test('requests: exact method/params shape, caller origin, and transaction field allowlist', async (t) => {
  const node = await startNode(t);
  const ctx = fakeContext();
  const validated = [];
  const w = await installForkWallet(ctx, baseOptions(node, { validateTransaction: (actual) => validated.push(actual) }));
  assert.deepEqual(await ctx.request('eth_requestAccounts'), { result: [account] });
  assert.deepEqual(await ctx.request('eth_accounts'), { result: [account] });
  assert.deepEqual(await ctx.request('eth_chainId'), { result: chainId });
  for (const method of ['eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'anvil_setBalance', 'eth_sendRawTransaction', 'eth_call']) {
    assert.equal((await ctx.request(method)).error.code, CODES.UNSUPPORTED_METHOD, method);
  }
  assert.equal((await ctx.request('eth_chainId', ['x'])).error.code, CODES.INVALID_PARAMS);
  assert.equal((await ctx.request('eth_accounts', 'nope')).error.code, CODES.INVALID_PARAMS);
  assert.equal((await ctx.binding({ frame: { url: () => origin + '/' } }, null)).error.code, CODES.INVALID_PARAMS);
  assert.equal((await ctx.binding({ frame: { url: () => origin + '/' } }, { method: 'eth_accounts', extra: 1 })).error.code, CODES.INVALID_PARAMS);
  assert.equal((await ctx.request('eth_accounts', [], 'https://evil.invalid')).error.code, CODES.UNSUPPORTED_METHOD);
  assert.equal((await ctx.request('eth_sendTransaction', [tx], 'http://127.0.0.1:12346')).error.code, CODES.UNSUPPORTED_METHOD);
  const badTx = [
    { gas: '0x5208' }, { gasPrice: '0x1' }, { nonce: '0x0' }, { maxFeePerGas: '0x1' }, { type: '0x2' },
    { from: target }, { from: undefined }, { to: 'x' }, { to: undefined }, { value: '0x01' }, { value: 1 }, { data: '0x123' },
    { chainId: '0x1' }, { chainId: 31337 },
  ];
  for (const change of badTx) {
    const reply = await ctx.request('eth_sendTransaction', [{ ...tx, ...change }]);
    assert.equal(reply.error && reply.error.code, CODES.INVALID_PARAMS, JSON.stringify(change));
  }
  for (const params of [[], [tx, tx], [null], [[tx]], ['0x']]) {
    assert.equal((await ctx.request('eth_sendTransaction', params)).error.code, CODES.INVALID_PARAMS);
  }
  assert.equal(node.sends, 0);
  assert.equal(validated.length, 0);
  assert.deepEqual(w.calls, []);
  // Optional value/data/chainId may be omitted; the validator sees exactly what the page sent.
  const minimal = { from: account, to: target };
  assert.deepEqual(await ctx.request('eth_sendTransaction', [minimal]), { result: hash });
  assert.equal(node.sends, 1);
  assert.deepEqual(validated, [minimal, minimal]);
  assert.ok(Object.isFrozen(validated[0]));
  assert.deepEqual(w.calls.map((c) => c.outcome), ['submitted']);
  assert.equal(w.calls[0].hash, hash);
  assert.deepEqual(w.submitted, [hash]);
});

test('preflight: ownership guard, chain, client, unlocked account and RPC integrity all refuse before submission', async (t) => {
  const node = await startNode(t);
  const ctx = fakeContext();
  let owned = true;
  const validator = { fail: false };
  const w = await installForkWallet(ctx, baseOptions(node, {
    beforeSend() { assert.ok(owned, 'not owned'); },
    validateTransaction(actual) { assert.deepEqual(actual, tx); if (validator.fail) throw new Error('validator refused'); },
  }));
  const send = () => ctx.request('eth_sendTransaction', [tx]);
  const expectFailure = async (label, mutate, restore) => {
    mutate();
    const reply = await send();
    restore();
    assert.ok(reply.error, label);
    assert.equal(node.sends, 0, label + ' submitted');
    return reply.error;
  };
  assert.equal((await expectFailure('validator', () => { validator.fail = true; }, () => { validator.fail = false; })).code, CODES.INTERNAL);
  assert.equal(w.calls.length, 0, 'validator refusal is not admitted');
  await expectFailure('beforeSend', () => { owned = false; }, () => { owned = true; });
  await expectFailure('chain', () => { node.chain = '0x1'; }, () => { node.chain = chainId; });
  await expectFailure('client', () => { node.client = 'Geth/v1.13'; }, () => { node.client = 'anvil/v1.8.3'; });
  await expectFailure('account', () => { node.accounts = [target]; }, () => { node.accounts = [account]; });
  await expectFailure('wrong id', () => { node.wrongID = true; }, () => { node.wrongID = false; });
  await expectFailure('redirect', () => { node.redirect = true; }, () => { node.redirect = false; });
  await expectFailure('http 500', () => { node.status = 500; }, () => { node.status = 200; });
  await expectFailure('ambiguous', () => { node.ambiguous = true; }, () => { node.ambiguous = false; });
  await expectFailure('non-json', () => { node.nonJSON = true; }, () => { node.nonJSON = false; });
  assert.ok(w.calls.every((c) => c.outcome === 'failed' && c.error));
  node.hash = '0x1234';
  assert.equal((await send()).error.code, CODES.INTERNAL);
  assert.equal(node.sends, 1, 'a bad hash after a real submission is reported, not hidden');
  assert.deepEqual(w.submitted, []);
  node.hash = hash;
  assert.deepEqual(await send(), { result: hash });
  assert.deepEqual(w.submitted, [hash]);
  // Custom client pattern.
  const ctx2 = fakeContext();
  await installForkWallet(ctx2, baseOptions(node, { clientVersion: /^HardhatNetwork\// }));
  assert.ok((await ctx2.request('eth_sendTransaction', [tx])).error);
  node.client = 'HardhatNetwork/2.0';
  assert.deepEqual(await ctx2.request('eth_sendTransaction', [tx]), { result: hash });
  node.client = 'anvil/v1.8.3';
});

test('modes: approve, reject, lost, hold with concurrency, cancellation, release and repeated lifecycle', async (t) => {
  const node = await startNode(t);
  const ctx = fakeContext();
  let owned = true;
  const w = await installForkWallet(ctx, baseOptions(node, { beforeSend() { assert.ok(owned); } }));
  const send = () => ctx.request('eth_sendTransaction', [tx]);
  assert.throws(() => w.setMode('typo'), (e) => e.code === CODES.INVALID_PARAMS);
  assert.throws(() => w.release(), (e) => e.code === CODES.INTERNAL);
  assert.throws(() => w.release('typo'), (e) => e.code === CODES.INVALID_PARAMS);
  w.setMode('reject');
  assert.equal((await send()).error.code, CODES.USER_REJECTED);
  assert.equal(node.sends, 0);
  assert.equal(w.calls.at(-1).outcome, 'rejected');
  w.setMode('approve');
  assert.deepEqual(await send(), { result: hash });
  w.setMode('lost');
  assert.equal((await send()).error.code, CODES.INTERNAL);
  assert.equal(node.sends, 2);
  assert.deepEqual(w.submitted, [hash, hash]);
  assert.equal(w.calls.at(-1).outcome, 'lost');
  assert.equal(w.calls.at(-1).hash, hash);
  // Hold: one pending request; a second is refused; cancellation sends nothing.
  w.setMode('hold');
  const first = send();
  await w.whenHeld();
  assert.ok(w.held);
  assert.equal((await send()).error.code, CODES.REQUEST_PENDING);
  assert.equal(node.sends, 2);
  w.release('reject');
  assert.equal(w.held, false, 'release clears the hold synchronously');
  assert.throws(() => w.release('approve'), (e) => e.code === CODES.INTERNAL);
  assert.equal((await first).error.code, CODES.USER_REJECTED);
  assert.equal(w.held, false);
  assert.equal(node.sends, 2);
  // Hold then approve, hold then lost, and ownership loss during the hold.
  const second = send();
  await w.whenHeld();
  w.release('approve');
  assert.deepEqual(await second, { result: hash });
  assert.equal(node.sends, 3);
  const third = send();
  await w.whenHeld();
  w.release('lost');
  assert.equal((await third).error.code, CODES.INTERNAL);
  assert.equal(node.sends, 4);
  assert.equal(w.submitted.length, 4);
  const fourth = send();
  await w.whenHeld();
  owned = false;
  w.release('approve');
  assert.ok((await fourth).error);
  owned = true;
  assert.equal(node.sends, 4, 'ownership loss during a hold refuses the send');
  assert.throws(() => w.release());
  // Mode changes after admission do not alter the admitted request.
  const fifth = send();
  await w.whenHeld();
  w.setMode('reject');
  w.release('approve');
  assert.deepEqual(await fifth, { result: hash });
  assert.equal(w.calls.at(-1).mode, 'hold');
  assert.equal(node.sends, 5);
  assert.deepEqual(w.calls.map((c) => c.outcome), ['rejected', 'submitted', 'lost', 'rejected', 'failed', 'submitted', 'lost', 'failed', 'submitted']);
});

test('disconnect: held request fails 4900, later sends refused, events reach only same-origin pages', async (t) => {
  const node = await startNode(t);
  const emitted = [];
  const page = (url) => ({ url: () => url, evaluate: async (fn, arg) => { emitted.push([url, arg]); } });
  const closingPage = { url: () => origin + '/closing', evaluate: async () => { throw new Error('page closed'); } };
  const ctx = fakeContext([closingPage, page(origin + '/app'), page('http://127.0.0.1:9/other'), page('about:blank')]);
  const w = await installForkWallet(ctx, baseOptions(node));
  w.setMode('hold');
  const pending = ctx.request('eth_sendTransaction', [tx]);
  await w.whenHeld();
  await w.disconnect();
  assert.equal((await pending).error.code, CODES.DISCONNECTED);
  assert.equal(node.sends, 0);
  assert.equal(w.connected, false);
  assert.equal(w.held, false);
  assert.deepEqual(await ctx.request('eth_accounts'), { result: [] });
  assert.equal((await ctx.request('eth_requestAccounts')).error.code, CODES.DISCONNECTED);
  assert.equal((await ctx.request('eth_chainId')).error.code, CODES.DISCONNECTED);
  w.setMode('approve');
  assert.equal((await ctx.request('eth_sendTransaction', [tx])).error.code, CODES.DISCONNECTED);
  assert.equal(node.sends, 0);
  assert.deepEqual(emitted, [[origin + '/app', ['accountsChanged', []]], [origin + '/app', ['disconnect', { code: 4900, message: 'wallet disconnected' }]]]);
  await w.disconnect();
  assert.equal(emitted.length, 4, 'disconnect is idempotent');
});

test('page provider: installs only on the allowed origin, maps errors, emits and removes listeners', async (t) => {
  const node = await startNode(t);
  const ctx = fakeContext();
  await installForkWallet(ctx, baseOptions(node));
  const run = (pageOrigin) => {
    const sandbox = { location: { origin: pageOrigin }, window: {}, Map, Set, Error, Object };
    vm.runInNewContext('(' + ctx.script.fn.toString() + ')(' + JSON.stringify(ctx.script.args) + ')', sandbox);
    return sandbox.window;
  };
  assert.equal(run('http://127.0.0.1:9').ethereum, undefined);
  assert.equal(run('https://127.0.0.1:12345').ethereum, undefined);
  const win = run(origin);
  assert.equal(win.ethereum.isForkWallet, true);
  const events = [];
  const listen = (value) => events.push(value);
  win.ethereum.on('accountsChanged', listen);
  win.__forkWalletEmit('accountsChanged', []);
  assert.deepEqual(events, [[]]);
  win.ethereum.removeListener('accountsChanged', listen);
  win.__forkWalletEmit('accountsChanged', []);
  win.__forkWalletEmit('never-registered', 1);
  assert.equal(events.length, 1);
  let seen;
  win.__forkWalletRequest = async (request) => { seen = request; return { error: { code: 4001, message: 'rejected' } }; };
  await assert.rejects(win.ethereum.request({ method: 'eth_sendTransaction', params: [tx] }), (e) => e.code === 4001 && e.message === 'rejected');
  assert.deepEqual(seen, { method: 'eth_sendTransaction', params: [tx] });
  win.__forkWalletRequest = async () => ({ result: [account] });
  assert.deepEqual(await win.ethereum.request({ method: 'eth_accounts' }), [account]);
  await tick();
});
