'use strict';
// Offline unit controls: options, request shape, caller frame, transaction and read schemas, preflight / RPC
// integrity, modes and the page provider script. Uses in-memory doubles only (test/helpers.js); not chain or browser
// acceptance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const wallet = require('../src/index.js');
const { installForkWallet, checkTransaction, validateReadRequest, createLoopbackRpc, CODES, LIMITS } = wallet;
const { account, other, target, hash, origin, chainId, tick, installFetch, createNode, fakePage, fakeContext, baseOptions, runPageScript } = require('./helpers.js');

const tx = Object.freeze({ chainId, from: account, to: target, value: '0x0', data: '0x1234' });
const code = (reply) => reply && reply.error && reply.error.code;

async function connected(t, extra = {}, nodeOptions) {
  const nodes = installFetch(t);
  const node = createNode(nodes, nodeOptions);
  const ctx = fakeContext();
  const w = await installForkWallet(ctx, baseOptions(node, extra));
  assert.deepEqual(await ctx.request('eth_requestAccounts'), { result: [account] });
  return { nodes, node, ctx, w };
}

test('configuration is fail-closed: loopback HTTP only, exact origin, explicit chain, mandatory guards, chain registry', async (t) => {
  const nodes = installFetch(t);
  const node = createNode(nodes);
  const ctx = fakeContext();
  const bad = [
    { endpoint: 'https://127.0.0.1:8545' }, { endpoint: 'http://localhost:8545' }, { endpoint: 'http://127.0.0.1:8545#x' },
    { endpoint: 'http://127.0.0.1:8545?x=1' }, { endpoint: 'http://127.0.0.1:8545/rpc' }, { endpoint: 'http://127.0.0.1' },
    { endpoint: 'http://user:pw@127.0.0.1:8545' }, { endpoint: 'http://[::1]:8545' }, { endpoint: 42 },
    { origin: 'http://127.0.0.1:12345/' }, { origin: 'http://localhost:12345' }, { origin: 'https://127.0.0.1:12345' }, { origin: 'http://127.0.0.1' },
    { chainId: undefined }, { chainId: '0x089' }, { chainId: '0x0' }, { chainId: 0 }, { chainId: '137' }, { chainId: 1.5 },
    { account: 'not-an-address' }, { validateTransaction: undefined }, { beforeSend: 'guard' }, { clientVersion: 'anvil' },
    { timeoutMs: 0 }, { timeoutMs: 15001 }, { chains: {} },
    { chains: [{ endpoint: node.endpoint, chainId, account, beforeSend() {} }] }, // duplicate of the initial chain
    { chains: [{ endpoint: 'http://localhost:1', chainId: 31338, account, beforeSend() {} }] },
    { chains: [{ endpoint: node.endpoint, chainId: 31338, account }] },
    { chains: [{ endpoint: node.endpoint, chainId: 31338, account, beforeSend() {}, rpcUrl: 'x' }] },
    { chains: [{ endpoint: node.endpoint, chainId: 31338, account, beforeSend() {} }, { endpoint: node.endpoint, chainId: '0x7a6a', account, beforeSend() {} }] },
  ];
  for (const change of bad) {
    await assert.rejects(installForkWallet(fakeContext(), baseOptions(node, change)), (e) => e.code === CODES.INVALID_PARAMS, JSON.stringify(change));
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
  assert.equal(installed.authorized, false, 'a fresh install starts unauthorized');
  assert.equal(installed.held, false);
  assert.deepEqual(installed.chains, [chainId]);
  assert.equal(ctx.scripts.length, 1);
  assert.equal(ctx.scripts[0].args.origin, origin);
  assert.match(ctx.scripts[0].args.info.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(ctx.bindings).sort(), ['__forkWalletInit', '__forkWalletRequest']);
  await assert.rejects(installForkWallet(ctx, baseOptions(node)), /binding installed twice/);
});

test('requests: exact request shape, main-frame caller origin, method allowlist with recorded refusals', async (t) => {
  const nodes = installFetch(t);
  const node = createNode(nodes);
  const ctx = fakeContext();
  const w = await installForkWallet(ctx, baseOptions(node));
  assert.deepEqual(await ctx.request('eth_accounts'), { result: [] }, 'no accounts before authorization');
  assert.deepEqual(await ctx.request('eth_chainId'), { result: chainId }, 'chain is readable without permission');
  assert.deepEqual(await ctx.request('eth_chainId', []), { result: chainId });
  assert.deepEqual(await ctx.request('eth_requestAccounts'), { result: [account] });
  assert.deepEqual(await ctx.request('eth_accounts'), { result: [account] });
  for (const method of ['eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'wallet_addEthereumChain', 'wallet_sendTransaction',
    'anvil_setBalance', 'evm_mine', 'debug_traceCall', 'admin_peers', 'eth_sendRawTransaction', 'eth_subscribe', 'wallet_sendCalls', 'eth_signTransaction']) {
    assert.equal(code(await ctx.request(method)), CODES.UNSUPPORTED_METHOD, method);
  }
  assert.deepEqual(w.unsupported.filter((u) => u.reason === 'unsupported-method').map((u) => u.method).slice(0, 2), ['eth_sign', 'wallet_addEthereumChain']);
  assert.deepEqual(w.unsupported.filter((u) => u.reason === 'signing-disabled').map((u) => u.method), ['personal_sign', 'eth_signTypedData_v4'], 'signing absent: 4200 recorded as signing-disabled');
  assert.equal(code(await ctx.request('eth_chainId', ['x'])), CODES.INVALID_PARAMS);
  assert.equal(code(await ctx.request('eth_accounts', 'nope')), CODES.INVALID_PARAMS);
  assert.equal(code(await ctx.request('eth_accounts', {})), CODES.INVALID_PARAMS);
  const main = { page: ctx.page, frame: ctx.page.mainFrame() };
  assert.equal(code(await ctx.raw(main, null)), CODES.INVALID_REQUEST);
  assert.equal(code(await ctx.raw(main, { method: 'eth_accounts', extra: 1 })), CODES.INVALID_REQUEST);
  assert.equal(code(await ctx.raw(main, { method: 7 })), CODES.INVALID_REQUEST);
  assert.equal(code(await ctx.raw(main, { method: 'eth_call', params: ['x'.repeat(LIMITS.requestBytes)] })), CODES.INVALID_REQUEST);
  // Caller identity: other origins, subframes (even same-origin) and sources without page structure are refused.
  assert.equal(code(await ctx.request('eth_accounts', [], { frameOrigin: 'https://evil.invalid' })), CODES.UNSUPPORTED_METHOD);
  assert.equal(code(await ctx.request('eth_sendTransaction', [tx], { frameOrigin: 'http://127.0.0.1:12346' })), CODES.UNSUPPORTED_METHOD);
  assert.equal(code(await ctx.raw({ page: ctx.page, frame: ctx.page.subframe(origin + '/frame') }, { method: 'eth_accounts' })), CODES.UNSUPPORTED_METHOD);
  assert.equal(code(await ctx.raw({ frame: { url: () => origin + '/' } }, { method: 'eth_accounts' })), CODES.UNSUPPORTED_METHOD, 'no silent absent-page fallback');
  assert.equal(code(await ctx.raw({ page: fakePage(origin + '/'), frame: ctx.page.mainFrame() }, { method: 'eth_accounts' })), CODES.UNSUPPORTED_METHOD, 'frame of another page');
  assert.equal(await ctx.bindings.__forkWalletInit({ page: ctx.page, frame: ctx.page.subframe(origin + '/x') }), null);
  assert.deepEqual(await ctx.bindings.__forkWalletInit(main), { connected: true, chainId });
  assert.ok(w.unsupported.some((u) => u.reason === 'caller-frame'));
  assert.equal(node.sends, 0);
});

test('transaction schema: legacy/2930/1559 fields, deployment, conflicts, aliases and exact values', async (t) => {
  const good = [
    { from: account, to: target },
    { ...tx, gas: '0x5208', nonce: '0x0', type: '0x2', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1' },
    { from: account, to: target, type: '0x0', gasPrice: '0x3b9aca00', gas: '0x5208' },
    { from: account, to: target, gasPrice: '0x1' },
    { from: account, to: target, type: '0x1', gasPrice: '0x1', accessList: [{ address: target, storageKeys: [hash] }] },
    { from: account.toUpperCase().replace('0X', '0x'), data: '0x6000' }, // deployment, case-insensitive from
  ];
  for (const input of good) {
    const out = checkTransaction([input], account, chainId);
    assert.deepEqual(out, input);
    assert.ok(Object.isFrozen(out));
    if (out.accessList) assert.ok(Object.isFrozen(out.accessList[0].storageKeys));
  }
  const badTx = [
    { gasLimit: '0x5208' }, { input: '0x' }, { unknownField: 1 }, { gas: '0x05208' }, { gas: 21000 }, { gas: '-0x1' },
    { type: '0x3' }, { type: 2 }, { gasPrice: '0x1', maxFeePerGas: '0x1' }, { type: '0x0', maxFeePerGas: '0x1' },
    { type: '0x1', maxPriorityFeePerGas: '0x1' }, { type: '0x2', gasPrice: '0x1' }, { type: '0x0', accessList: [] },
    { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x2' }, { accessList: [{ address: target }] },
    { accessList: [{ address: target, storageKeys: ['0x1'] }] }, { accessList: [{ address: target, storageKeys: [], extra: 1 }] },
    { accessList: Array.from({ length: 1025 }, () => ({ address: target, storageKeys: [] })) },
    { from: target }, { from: undefined }, { to: 'x' }, { to: undefined, data: '0x' }, { to: undefined, data: undefined }, { to: null }, { value: '0x01' }, { value: 1 },
    { data: '0x123' }, { chainId: '0x1' }, { chainId: 31337 }, { nonce: '0x' + 'f'.repeat(65) },
  ];
  for (const change of badTx) {
    const input = { ...tx, ...change };
    for (const key of Object.keys(change)) if (change[key] === undefined) delete input[key];
    assert.throws(() => checkTransaction([input], account, chainId), (e) => e.code === CODES.INVALID_PARAMS, JSON.stringify(change).slice(0, 80));
  }
  assert.throws(() => checkTransaction([{ from: account, data: '0x' }], account, chainId), (e) => e.code === CODES.INVALID_PARAMS, 'empty deployment');
  for (const params of [[], [tx, tx], [null], [[tx]], ['0x'], 'x']) {
    assert.throws(() => checkTransaction(params, account, chainId), (e) => e.code === CODES.INVALID_PARAMS);
  }
  // Through the provider: refused shapes are never admitted, validated or sent; the validator sees exact values.
  const validated = [];
  const { ctx, node, w } = await connected(t, { validateTransaction: (actual) => validated.push(actual) });
  for (const change of [{ gasLimit: '0x5208' }, { type: '0x3' }, { from: target }]) {
    assert.equal(code(await ctx.request('eth_sendTransaction', [{ ...tx, ...change }])), CODES.INVALID_PARAMS);
  }
  assert.equal(node.sends, 0);
  assert.equal(validated.length, 0);
  assert.deepEqual(w.calls.filter((c) => c.method === 'eth_sendTransaction'), []);
  const minimal = { from: account, to: target };
  assert.deepEqual(await ctx.request('eth_sendTransaction', [minimal]), { result: hash });
  assert.equal(node.sends, 1);
  assert.deepEqual(validated, [minimal, minimal]);
  assert.ok(Object.isFrozen(validated[0]));
  assert.deepEqual(node.requests.find((r) => r.method === 'eth_sendTransaction').params, [minimal], 'forwarded unchanged');
  const call = w.calls.at(-1);
  assert.equal(call.outcome, 'submitted');
  assert.equal(call.hash, hash);
  assert.match(call.inputHash, /^[0-9a-f]{64}$/);
  assert.match(call.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(w.submitted, [hash]);
});

test('read schemas: exact arity, field allowlists, bounded logs/feeHistory, unknown methods 4200', async () => {
  const blocks = [];
  const rpc = async (method, params) => { blocks.push(params[0]); return { number: '0x2710' }; }; // latest = 10000
  const ok = async (method, params, expected = params) => assert.deepEqual(await validateReadRequest(method, params, rpc), expected, method);
  const no = async (method, params, expectedCode = CODES.INVALID_PARAMS) => assert.rejects(validateReadRequest(method, params, rpc), (e) => e.code === expectedCode, `${method} ${JSON.stringify(params).slice(0, 80)}`);
  for (const method of ['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas']) {
    await ok(method, undefined, []);
    await ok(method, []);
    await no(method, ['latest']);
    await no(method, {});
  }
  for (const method of ['eth_getBalance', 'eth_getCode', 'eth_getTransactionCount']) {
    await ok(method, [account, 'latest']);
    await ok(method, [account, '0x1f']);
    await no(method, [account]);
    await no(method, [account, 'latest', 'extra']);
    await no(method, ['0x1234', 'latest']);
    await no(method, [account, '0x01']);
    await no(method, [account, { blockHash: hash }]);
    await no(method, [account, 'Latest']);
  }
  await ok('eth_getStorageAt', [account, '0x0', 'latest']);
  await ok('eth_getStorageAt', [account, hash, 'pending']);
  await no('eth_getStorageAt', [account, '0x00', 'latest']);
  await ok('eth_call', [{ to: target, data: '0x12345678' }, 'latest']);
  await ok('eth_call', [{ from: other, to: target, data: '0x', value: '0x1', gas: '0x1', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', type: '0x2', nonce: '0x0', chainId }]);
  await no('eth_call', [{ to: target }, 'latest', { [target]: { balance: '0x1' } }], CODES.INVALID_PARAMS); // no state override
  await no('eth_call', [{ to: target, input: '0x' }, 'latest']);
  await no('eth_call', [{ to: target, data: '0x1' }, 'latest']);
  await no('eth_call', ['0x', 'latest']);
  await no('eth_call', []);
  await ok('eth_estimateGas', [{ from: account, to: target, value: '0x1' }]);
  await no('eth_estimateGas', [{ from: account, to: target, blobs: [] }]);
  await ok('eth_feeHistory', ['0x4', 'latest', [10, 50, 90]]);
  await ok('eth_feeHistory', ['0x400', '0x10', []]);
  await no('eth_feeHistory', ['0x401', 'latest', []]);
  await no('eth_feeHistory', ['0x0', 'latest', []]);
  await no('eth_feeHistory', ['0x4', 'latest', [50, 10]]);
  await no('eth_feeHistory', ['0x4', 'latest', [101]]);
  await no('eth_feeHistory', ['0x4', 'latest', [Number.NaN]]);
  await no('eth_feeHistory', ['0x4', 'latest', Array(101).fill(1)]);
  await ok('eth_getBlockByNumber', ['latest', false]);
  await no('eth_getBlockByNumber', ['latest']);
  await no('eth_getBlockByNumber', ['latest', 'false']);
  await ok('eth_getBlockByHash', [hash, true]);
  await no('eth_getBlockByHash', ['0x12', true]);
  await ok('eth_getTransactionByHash', [hash]);
  await ok('eth_getTransactionReceipt', [hash]);
  await no('eth_getTransactionReceipt', [hash, 'x']);
  // Logs: explicit bounded ranges; tags resolved to heights; blockHash exclusive; address/topic bounds.
  await ok('eth_getLogs', [{ address: target, fromBlock: '0x1', toBlock: '0x2710' }]);
  await ok('eth_getLogs', [{}], [{ fromBlock: '0x2710', toBlock: '0x2710' }]);
  await ok('eth_getLogs', [{ fromBlock: '0x1', toBlock: 'latest', topics: [hash, null, [hash, hash]] }], [{ topics: [hash, null, [hash, hash]], fromBlock: '0x1', toBlock: '0x2710' }]);
  await ok('eth_getLogs', [{ fromBlock: 'earliest', toBlock: '0x0' }], [{ fromBlock: '0x0', toBlock: '0x0' }]);
  await ok('eth_getLogs', [{ blockHash: hash, address: [target, account] }]);
  await no('eth_getLogs', [{ fromBlock: 'earliest', toBlock: 'latest' }]); // 10001 blocks
  await no('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x2710' }]);
  await no('eth_getLogs', [{ fromBlock: '0x2', toBlock: '0x1' }]);
  await no('eth_getLogs', [{ blockHash: hash, fromBlock: '0x1' }]);
  await no('eth_getLogs', [{ address: Array(21).fill(target), fromBlock: '0x1', toBlock: '0x1' }]);
  await no('eth_getLogs', [{ address: [], fromBlock: '0x1', toBlock: '0x1' }]);
  await no('eth_getLogs', [{ topics: [null, null, null, null, null] }]);
  await no('eth_getLogs', [{ topics: [Array(21).fill(hash)] }]);
  await no('eth_getLogs', [{ topics: ['0x12'] }]);
  await no('eth_getLogs', [{ limit: 1 }]);
  await no('eth_getLogs', []);
  assert.ok(blocks.every((b) => b === 'latest'));
  for (const method of ['eth_accounts', 'eth_sendTransaction', 'anvil_mine', 'personal_sign', 'eth_newFilter', 'debug_traceTransaction', '__proto__']) {
    await no(method, [], CODES.UNSUPPORTED_METHOD);
  }
});

test('RPC client: integrity, bounded responses, timeouts and upstream error data are distinguished', async (t) => {
  const nodes = installFetch(t);
  const node = createNode(nodes);
  const rpc = createLoopbackRpc(node.endpoint, { timeoutMs: 50 });
  assert.equal(await rpc('eth_chainId'), chainId);
  const kind = async (label, mutate, restore, expected) => {
    mutate();
    try { await assert.rejects(rpc('eth_chainId'), (e) => e.kind === expected && Number.isInteger(e.code), label); } finally { restore(); }
  };
  await kind('wrong id', () => { node.wrongID = true; }, () => { node.wrongID = false; }, 'integrity');
  await kind('ambiguous', () => { node.ambiguous = true; }, () => { node.ambiguous = false; }, 'integrity');
  await kind('non-json', () => { node.nonJSON = true; }, () => { node.nonJSON = false; }, 'integrity');
  await kind('http 500', () => { node.status = 500; }, () => { node.status = 200; }, 'transport');
  await kind('redirect', () => { node.redirect = true; }, () => { node.redirect = false; }, 'transport');
  await kind('timeout', () => { node.hangOn = 'eth_chainId'; }, () => { node.hangOn = null; }, 'transport');
  await kind('oversized response', () => { node.bigResponse = LIMITS.responseBytes + 1; }, () => { node.bigResponse = 0; }, 'transport');
  await kind('malformed error', () => { node.errorOn.eth_chainId = { code: 'x' }; }, () => { delete node.errorOn.eth_chainId; }, 'integrity');
  node.errorOn.eth_chainId = { code: 3, message: 'execution reverted', data: '0x08c379a0' };
  await assert.rejects(rpc('eth_chainId'), (e) => e.kind === 'upstream' && e.code === 3 && e.data === '0x08c379a0' && e.message === 'execution reverted');
  node.errorOn.eth_chainId = { code: 3, message: 'big', data: 'x'.repeat(LIMITS.errorDataBytes + 1) };
  await assert.rejects(rpc('eth_chainId'), (e) => e.kind === 'upstream' && e.code === 3 && !('data' in e), 'oversized error data is dropped');
  delete node.errorOn.eth_chainId;
  await assert.rejects(rpc('eth_call', ['x'.repeat(LIMITS.requestBytes)]), (e) => e.code === CODES.INVALID_PARAMS);
  assert.throws(() => createLoopbackRpc(node.endpoint, { timeoutMs: 15001 }), (e) => e.code === CODES.INVALID_PARAMS);
  assert.throws(() => createLoopbackRpc('http://localhost:1'), (e) => e.code === CODES.INVALID_PARAMS);
  const calls = node.requests.length;
  await assert.rejects(createLoopbackRpc('http://127.0.0.1:1')('eth_chainId'), (e) => e.kind === 'transport');
  assert.equal(node.requests.length, calls, 'no retries anywhere');
});

test('preflight: ownership guard, chain, client, unlocked account and RPC integrity all refuse before submission', async (t) => {
  let owned = true;
  const validator = { fail: false };
  const { node, ctx, w } = await connected(t, {
    beforeSend() { assert.ok(owned, 'not owned'); },
    validateTransaction(actual) { assert.deepEqual(actual, tx); if (validator.fail) throw new Error('validator refused'); },
  });
  const send = () => ctx.request('eth_sendTransaction', [tx]);
  const expectFailure = async (label, mutate, restore, expected = CODES.CHAIN_DISCONNECTED) => {
    mutate();
    const reply = await send();
    restore();
    assert.equal(code(reply), expected, label);
    assert.equal(node.sends, 0, label + ' submitted');
  };
  const sendCalls = () => w.calls.filter((c) => c.method === 'eth_sendTransaction');
  await expectFailure('validator', () => { validator.fail = true; }, () => { validator.fail = false; }, CODES.INTERNAL);
  assert.equal(sendCalls().length, 0, 'validator refusal is not admitted');
  await expectFailure('beforeSend', () => { owned = false; }, () => { owned = true; });
  await expectFailure('chain', () => { node.chain = '0x1'; }, () => { node.chain = chainId; });
  await expectFailure('client', () => { node.client = 'Geth/v1.13'; }, () => { node.client = 'anvil/v1.8.3'; });
  await expectFailure('account', () => { node.accounts = [target]; }, () => { node.accounts = [account, other]; });
  await expectFailure('wrong id', () => { node.wrongID = true; }, () => { node.wrongID = false; });
  await expectFailure('redirect', () => { node.redirect = true; }, () => { node.redirect = false; });
  await expectFailure('http 500', () => { node.status = 500; }, () => { node.status = 200; });
  await expectFailure('ambiguous', () => { node.ambiguous = true; }, () => { node.ambiguous = false; });
  await expectFailure('non-json', () => { node.nonJSON = true; }, () => { node.nonJSON = false; });
  assert.ok(sendCalls().every((c) => c.outcome === 'failed' && c.error && c.error.code === CODES.CHAIN_DISCONNECTED));
  // A malformed hash after a real submission is reported as unknown, not hidden and not "not sent".
  node.hash = '0x1234';
  assert.equal(code(await send()), CODES.INTERNAL);
  assert.equal(node.sends, 1);
  assert.equal(sendCalls().at(-1).outcome, 'unknown');
  assert.deepEqual(w.submitted, []);
  node.hash = hash;
  assert.deepEqual(await send(), { result: hash });
  assert.deepEqual(w.submitted, [hash]);
  // Reads refuse when ownership fails, before anything is forwarded.
  owned = false;
  const before = node.requests.length;
  assert.equal(code(await ctx.request('eth_blockNumber')), CODES.CHAIN_DISCONNECTED);
  assert.equal(node.requests.length, before);
  owned = true;
  // Custom client pattern.
  const ctx2 = fakeContext();
  await installForkWallet(ctx2, baseOptions(node, { clientVersion: /^HardhatNetwork\// }));
  assert.equal(code(await ctx2.request('eth_requestAccounts')), CODES.CHAIN_DISCONNECTED);
  node.client = 'HardhatNetwork/2.0';
  assert.deepEqual(await ctx2.request('eth_requestAccounts'), { result: [account] });
  assert.deepEqual(await ctx2.request('eth_sendTransaction', [tx]), { result: hash });
  node.client = 'anvil/v1.8.3';
});

test('modes: approve, reject, lost, hold with concurrency, cancellation, ID-bound release and repeated lifecycle', async (t) => {
  let owned = true;
  const { node, ctx, w } = await connected(t, { beforeSend() { assert.ok(owned); } });
  const send = () => ctx.request('eth_sendTransaction', [tx]);
  const sendCalls = () => w.calls.filter((c) => c.method === 'eth_sendTransaction');
  assert.throws(() => w.setMode('typo'), (e) => e.code === CODES.INVALID_PARAMS);
  assert.throws(() => w.release(), (e) => e.code === CODES.INVALID_PARAMS, 'release needs the request ID');
  assert.throws(() => w.release('nope'), (e) => e.code === CODES.INTERNAL, 'nothing held');
  w.setMode('reject');
  assert.equal(code(await send()), CODES.USER_REJECTED);
  assert.equal(node.sends, 0);
  assert.equal(sendCalls().at(-1).outcome, 'rejected');
  w.setMode('approve');
  assert.deepEqual(await send(), { result: hash });
  w.setMode('lost');
  assert.equal(code(await send()), CODES.INTERNAL);
  assert.equal(node.sends, 2);
  assert.deepEqual(w.submitted, [hash, hash]);
  assert.equal(sendCalls().at(-1).outcome, 'response-lost');
  assert.equal(sendCalls().at(-1).hash, hash);
  assert.equal(sendCalls().at(-1).sender, account, 'enriched from the node by hash');
  // Hold: one outstanding request; a second is refused; cancellation sends nothing.
  w.setMode('hold');
  const first = send();
  const firstId = await w.whenHeld();
  assert.ok(w.held);
  assert.equal(w.heldRequestId, firstId);
  assert.equal(code(await send()), CODES.REQUEST_PENDING);
  assert.equal(code(await ctx.request('wallet_requestPermissions', [{ eth_accounts: {} }])), CODES.REQUEST_PENDING, 'one approval of any kind');
  assert.equal(node.sends, 2);
  assert.throws(() => w.release('00000000-0000-4000-8000-000000000000'), (e) => e.code === CODES.INVALID_PARAMS, 'wrong ID');
  assert.throws(() => w.release(firstId, 'typo'), (e) => e.code === CODES.INVALID_PARAMS);
  w.release(firstId, 'reject');
  assert.equal(w.held, false, 'release clears the hold synchronously');
  assert.throws(() => w.release(firstId, 'approve'), (e) => e.code === CODES.INTERNAL, 'duplicate release');
  assert.equal(code(await first), CODES.USER_REJECTED);
  assert.equal(node.sends, 2);
  // Hold then approve, hold then lost, and ownership loss during the hold.
  const second = send();
  w.release(await w.whenHeld(), 'approve');
  assert.deepEqual(await second, { result: hash });
  assert.equal(node.sends, 3);
  const third = send();
  w.release(await w.whenHeld(), 'lost');
  assert.equal(code(await third), CODES.INTERNAL);
  assert.equal(node.sends, 4);
  assert.equal(w.submitted.length, 4);
  const fourth = send();
  const fourthId = await w.whenHeld();
  owned = false;
  w.release(fourthId, 'approve');
  assert.equal(code(await fourth), CODES.CHAIN_DISCONNECTED);
  owned = true;
  assert.equal(node.sends, 4, 'ownership loss during a hold refuses the send');
  assert.throws(() => w.release(fourthId));
  // Mode changes after admission do not alter the admitted request.
  const fifth = send();
  const fifthId = await w.whenHeld();
  w.setMode('reject');
  w.release(fifthId, 'approve');
  assert.deepEqual(await fifth, { result: hash });
  assert.equal(sendCalls().at(-1).mode, 'hold');
  assert.equal(node.sends, 5);
  assert.deepEqual(sendCalls().map((c) => c.outcome), ['rejected', 'submitted', 'response-lost', 'rejected', 'submitted', 'response-lost', 'failed', 'submitted']);
  assert.equal(new Set(sendCalls().map((c) => c.requestId)).size, sendCalls().length, 'unique request IDs');
  assert.equal(node.sent('eth_sendTransaction'), 5, 'one node submission per approved request, no retries');
});

test('disconnect: held request fails 4900, later requests refused, events reach only same-origin pages', async (t) => {
  const nodes = installFetch(t);
  const node = createNode(nodes);
  const emitted = [];
  const page = (url) => fakePage(url, { onEvaluate: (arg) => emitted.push([url, arg]) });
  const closingPage = fakePage(origin + '/closing', { onEvaluate: () => { throw new Error('page closed'); } });
  const ctx = fakeContext([closingPage, page(origin + '/app'), page('http://127.0.0.1:9/other'), page('about:blank')]);
  const w = await installForkWallet(ctx, baseOptions(node));
  await ctx.request('eth_requestAccounts');
  emitted.length = 0;
  w.setMode('hold');
  const pending = ctx.request('eth_sendTransaction', [tx]);
  await w.whenHeld();
  await w.disconnect();
  assert.equal(code(await pending), CODES.DISCONNECTED);
  assert.equal(w.calls.at(-1).outcome, 'cancelled');
  assert.equal(node.sends, 0);
  assert.equal(w.connected, false);
  assert.equal(w.held, false);
  assert.equal(w.authorized, true, 'disconnect is transport loss, not revocation');
  assert.deepEqual(await ctx.request('eth_accounts'), { result: [] });
  assert.equal(code(await ctx.request('eth_requestAccounts')), CODES.DISCONNECTED);
  assert.equal(code(await ctx.request('eth_chainId')), CODES.DISCONNECTED);
  assert.equal(code(await ctx.request('eth_blockNumber')), CODES.DISCONNECTED);
  w.setMode('approve');
  assert.equal(code(await ctx.request('eth_sendTransaction', [tx])), CODES.DISCONNECTED);
  assert.equal(node.sends, 0);
  assert.deepEqual(emitted, [[origin + '/app', ['disconnect', { code: 4900, message: 'wallet disconnected' }]]]);
  await w.disconnect();
  assert.equal(emitted.length, 1, 'disconnect is idempotent');
});

test('page provider: main frame of the allowed origin only, EIP-6963 announce, connect after init, error data, listeners', async (t) => {
  const nodes = installFetch(t);
  const node = createNode(nodes);
  const ctx = fakeContext();
  const w = await installForkWallet(ctx, baseOptions(node));
  const [script] = ctx.scripts;
  assert.equal(runPageScript(script, { pageOrigin: 'http://127.0.0.1:9' }).ethereum, undefined);
  assert.equal(runPageScript(script, { pageOrigin: 'https://127.0.0.1:12345' }).ethereum, undefined);
  assert.equal(runPageScript(script, { top: false }).ethereum, undefined, 'no injection into subframes');
  const order = [];
  const uncaught = [];
  const win = runPageScript(script, { timers: (fn) => { try { fn(); } catch (error) { uncaught.push(error.message); } } });
  assert.equal(win.ethereum.isForkWallet, true);
  assert.equal(win.ethereum.isMetaMask, undefined);
  assert.ok(Object.isFrozen(win.ethereum));
  // Announce happened during init; a requestProvider re-announces the same frozen detail and provider object.
  const announced = [];
  win.addEventListener('eip6963:announceProvider', (event) => announced.push(event.detail));
  win.dispatchEvent({ type: 'eip6963:requestProvider' });
  win.dispatchEvent({ type: 'eip6963:requestProvider' });
  assert.equal(announced.length, 2);
  assert.equal(announced[0], announced[1]);
  assert.equal(announced[0].provider, win.ethereum);
  assert.ok(Object.isFrozen(announced[0]) && Object.isFrozen(announced[0].info));
  assert.deepEqual({ ...announced[0].info }, { ...w.info });
  assert.equal(announced[0].info.name, 'Fork Wallet');
  assert.equal(announced[0].info.rdns, 'dev.forkwallet.test');
  assert.match(announced[0].info.icon, /^data:image\/svg\+xml;base64,/);
  win.ethereum.on('connect', (info) => order.push(['connect', info]));
  await tick();
  assert.equal(JSON.stringify(order), JSON.stringify([['connect', { chainId }]]), 'connect is emitted once after init');
  const disconnectedWin = runPageScript(script, { init: async () => ({ connected: false, chainId }) });
  const none = [];
  disconnectedWin.ethereum.on('connect', () => none.push(1));
  await tick();
  assert.deepEqual(none, []);
  const events = [];
  const listen = (value) => events.push(value);
  const throwing = () => { throw new Error('listener bug'); };
  win.ethereum.on('accountsChanged', throwing);
  win.ethereum.on('accountsChanged', listen);
  win.__forkWalletEmit('accountsChanged', []);
  assert.equal(JSON.stringify(events), '[[]]', 'a throwing listener cannot block others');
  assert.deepEqual(uncaught, ['listener bug']);
  win.ethereum.removeListener('accountsChanged', listen);
  win.ethereum.off('accountsChanged', throwing);
  win.__forkWalletEmit('accountsChanged', []);
  win.__forkWalletEmit('never-registered', 1);
  assert.equal(events.length, 1);
  let seen;
  win.__forkWalletRequest = async (request) => { seen = request; return { error: { code: 3, message: 'execution reverted', data: '0xdeadbeef' } }; };
  await assert.rejects(win.ethereum.request({ method: 'eth_call', params: [tx, 'latest'] }), (e) => e.code === 3 && e.message === 'execution reverted' && e.data === '0xdeadbeef');
  assert.deepEqual(seen, { method: 'eth_call', params: [tx, 'latest'] });
  win.__forkWalletRequest = async () => ({ result: [account] });
  assert.deepEqual(await win.ethereum.request({ method: 'eth_accounts' }), [account]);
});
