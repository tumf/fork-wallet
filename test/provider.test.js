'use strict';
// Offline unit controls for permission, registered-chain, requestId/epoch, outcome and event contracts. In-memory
// doubles only (test/helpers.js): no sockets, processes or browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installForkWallet, CODES } = require('../src/index.js');
const { account, other, target, hash, origin, chainId, tick, installFetch, createNode, fakePage, fakeContext, baseOptions } = require('./helpers.js');

const chain2 = '0x7a6a';
const code = (reply) => reply && reply.error && reply.error.code;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const txFor = (from = account) => ({ from, to: target, value: '0x1' });

async function setup(t, extra = {}) {
  const nodes = installFetch(t);
  const node = createNode(nodes);
  const node2 = createNode(nodes, { chain: chain2, accounts: [other] });
  const events = [];
  const page = fakePage(origin + '/app', { onEvaluate: ([name, payload]) => events.push([name, payload]) });
  const ctx = fakeContext([page, fakePage('http://127.0.0.1:9/', { onEvaluate: () => events.push(['wrong-origin']) })]);
  ctx.page = page;
  const guards = { one: true, two: true };
  const w = await installForkWallet(ctx, baseOptions(node, {
    beforeSend() { if (!guards.one) throw new Error('chain one not owned'); },
    chains: [{ endpoint: node2.endpoint, chainId: 31338, account: other, beforeSend() { if (!guards.two) throw new Error('chain two not owned'); } }],
    ...extra,
  }));
  return { node, node2, ctx, w, events, guards };
}

const descriptor = (acct = account) => ({ invoker: origin, parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [acct] }] });

test('permissions: unauthorized start, control-mode grant/reject/hold, exact descriptor, revoke without disconnect', async (t) => {
  const { node, ctx, w, events } = await setup(t);
  assert.deepEqual(await ctx.request('wallet_getPermissions'), { result: [] });
  assert.equal(code(await ctx.request('eth_sendTransaction', [txFor()])), CODES.UNAUTHORIZED);
  assert.equal(code(await ctx.request('wallet_switchEthereumChain', [{ chainId: chain2 }])), CODES.UNAUTHORIZED);
  assert.equal(node.sends, 0);
  // Rejected connect keeps the wallet unauthorized.
  w.setMode('reject');
  assert.equal(code(await ctx.request('eth_requestAccounts')), CODES.USER_REJECTED);
  assert.equal(w.authorized, false);
  assert.deepEqual(events, []);
  // Global lost never drops a connection response: it is treated as approve.
  w.setMode('lost');
  assert.deepEqual(await ctx.request('eth_requestAccounts'), { result: [account] });
  assert.deepEqual(events, [['accountsChanged', [account]]], 'accountsChanged once after grant, only to the allowed origin');
  const approvals = w.calls.length;
  assert.deepEqual(await ctx.request('eth_requestAccounts'), { result: [account] }, 'already authorized: no new approval');
  assert.equal(w.calls.length, approvals);
  assert.deepEqual(await ctx.request('wallet_getPermissions'), { result: [descriptor()] });
  assert.deepEqual(await ctx.request('wallet_getPermissions', []), { result: [descriptor()] });
  assert.equal(code(await ctx.request('wallet_getPermissions', [{}])), CODES.INVALID_PARAMS);
  for (const params of [undefined, [], [{}], [{ eth_accounts: {}, other: {} }], [{ eth_accounts: { a: 1 } }], [{ eth_accounts: {} }, {}], [{ eth_accounts: [] }], [{ personal_sign: {} }]]) {
    assert.equal(code(await ctx.request('wallet_requestPermissions', params)), CODES.INVALID_PARAMS, JSON.stringify(params));
    assert.equal(code(await ctx.request('wallet_revokePermissions', params)), CODES.INVALID_PARAMS, JSON.stringify(params));
  }
  // requestPermissions always asks; approving while authorized returns the descriptor without a new accountsChanged.
  w.setMode('approve');
  w.nextRequest({ method: 'wallet_requestPermissions', mode: 'hold' });
  const asked = ctx.request('wallet_requestPermissions', [{ eth_accounts: {} }]);
  const id = await w.whenHeld();
  assert.equal(w.calls.at(-1).method, 'wallet_requestPermissions');
  assert.equal(w.calls.at(-1).requestId, id);
  w.release(id);
  assert.deepEqual(await asked, { result: [descriptor()] });
  assert.equal(w.calls.at(-1).outcome, 'approved');
  assert.equal(events.length, 1);
  w.nextRequest({ method: 'wallet_requestPermissions', mode: 'reject' });
  assert.equal(code(await ctx.request('wallet_requestPermissions', [{ eth_accounts: {} }])), CODES.USER_REJECTED);
  assert.equal(w.authorized, true, 'a rejected re-prompt keeps the existing grant');
  // Revoke: accountsChanged([]) and no disconnect; transport stays connected and reads still work.
  assert.deepEqual(await ctx.request('wallet_revokePermissions', [{ eth_accounts: {} }]), { result: null });
  assert.deepEqual(events.slice(1), [['accountsChanged', []]]);
  assert.equal(w.authorized, false);
  assert.equal(w.connected, true);
  assert.deepEqual(await ctx.request('eth_accounts'), { result: [] });
  assert.deepEqual(await ctx.request('wallet_getPermissions'), { result: [] });
  assert.deepEqual(await ctx.request('eth_blockNumber'), { result: '0x0' });
  await w.revoke();
  assert.equal(events.length, 2, 'revoking twice emits nothing new');
  // Reconnect never regrants a revoked permission.
  await w.disconnect();
  await w.reconnect();
  assert.deepEqual(await ctx.request('eth_accounts'), { result: [] });
  assert.deepEqual(events.slice(2), [['disconnect', { code: 4900, message: 'wallet disconnected' }], ['connect', { chainId }]]);
  // A fresh install (fresh context) starts unapproved.
  const ctx2 = fakeContext();
  const w2 = await installForkWallet(ctx2, baseOptions(node));
  assert.equal(w2.authorized, false);
  assert.deepEqual(await ctx2.request('eth_accounts'), { result: [] });
  assert.notEqual(w2.info.uuid, w.info.uuid);
  assert.throws(() => w.nextRequest({ method: 'eth_requestAccounts', mode: 'lost' }), (e) => e.code === CODES.INVALID_PARAMS);
  assert.throws(() => w.nextRequest({ method: 'eth_call', mode: 'reject' }), (e) => e.code === CODES.INVALID_PARAMS);
  assert.throws(() => w.nextRequest({ method: 'eth_sendTransaction', mode: 'typo' }), (e) => e.code === CODES.INVALID_PARAMS);
});

test('transport: disconnect keeps permission, reconnect preflights, emits connect once and restores accounts', async (t) => {
  const { ctx, w, events, guards } = await setup(t);
  await ctx.request('eth_requestAccounts');
  events.length = 0;
  await w.reconnect();
  assert.deepEqual(events, [], 'reconnect while connected is a no-op');
  await w.disconnect();
  assert.deepEqual(events, [['disconnect', { code: 4900, message: 'wallet disconnected' }]]);
  assert.deepEqual(await ctx.request('eth_accounts'), { result: [] });
  assert.equal(code(await ctx.request('eth_call', [{ to: target }, 'latest'])), CODES.DISCONNECTED);
  guards.one = false;
  await assert.rejects(w.reconnect(), (e) => e.code === CODES.CHAIN_DISCONNECTED);
  assert.equal(w.connected, false);
  guards.one = true;
  await w.reconnect();
  assert.equal(w.connected, true);
  assert.deepEqual(events.slice(1), [['connect', { chainId }]]);
  assert.deepEqual(await ctx.request('eth_accounts'), { result: [account] });
  assert.deepEqual(await ctx.bindings.__forkWalletInit({ page: ctx.page, frame: ctx.page.mainFrame() }), { connected: true, chainId });
});

test('registered chains: authorized approval, 4902 for unknown, target preflight, events, caveat and routing', async (t) => {
  const { node, node2, ctx, w, events, guards } = await setup(t);
  await ctx.request('eth_requestAccounts');
  events.length = 0;
  for (const params of [[], [{}], [{ chainId: 31338 }], [{ chainId: '0x07a6a' }], [{ chainId: chain2, rpcUrls: [] }], [{ chainId: chain2 }, {}]]) {
    assert.equal(code(await ctx.request('wallet_switchEthereumChain', params)), CODES.INVALID_PARAMS, JSON.stringify(params));
  }
  assert.equal(code(await ctx.request('wallet_switchEthereumChain', [{ chainId: '0x1' }])), CODES.UNRECOGNIZED_CHAIN);
  assert.equal(code(await ctx.request('wallet_addEthereumChain', [{ chainId: '0x1' }])), CODES.UNSUPPORTED_METHOD);
  const before = w.calls.length;
  assert.deepEqual(await ctx.request('wallet_switchEthereumChain', [{ chainId }]), { result: null }, 'already active: no approval');
  assert.equal(w.calls.length, before);
  w.nextRequest({ method: 'wallet_switchEthereumChain', mode: 'reject' });
  assert.equal(code(await ctx.request('wallet_switchEthereumChain', [{ chainId: chain2 }])), CODES.USER_REJECTED);
  assert.equal(w.chainId, chainId);
  guards.two = false;
  assert.equal(code(await ctx.request('wallet_switchEthereumChain', [{ chainId: chain2.toUpperCase().replace('0X', '0x') }])), CODES.CHAIN_DISCONNECTED);
  assert.equal(w.chainId, chainId, 'failed target preflight leaves the registration unchanged');
  guards.two = true;
  assert.deepEqual(events, []);
  assert.deepEqual(await ctx.request('wallet_switchEthereumChain', [{ chainId: chain2 }]), { result: null });
  assert.deepEqual(events, [['chainChanged', chain2], ['accountsChanged', [other]]], 'chainChanged then accountsChanged once');
  assert.equal(w.chainId, chain2);
  assert.equal(w.account, other);
  assert.deepEqual(await ctx.request('eth_chainId'), { result: chain2 });
  assert.deepEqual(await ctx.request('wallet_getPermissions'), { result: [descriptor(other)] });
  const reads = node2.requests.length;
  await ctx.request('eth_getBalance', [other, 'latest']);
  assert.deepEqual(node2.requests.slice(reads).map((r) => r.method), ['eth_getBalance'], 'reads go to the selected node');
  assert.equal(code(await ctx.request('eth_sendTransaction', [txFor(account)])), CODES.INVALID_PARAMS, 'from must be the active account');
  assert.deepEqual(await ctx.request('eth_sendTransaction', [txFor(other)]), { result: hash });
  assert.equal(node2.sends, 1);
  assert.equal(node.sends, 0);
  assert.equal(w.calls.at(-1).chainId, chain2);
  assert.equal(w.calls.at(-1).endpoint, node2.endpoint);
  // Node-side switch back: no approval, same events.
  events.length = 0;
  await w.switchChain(31337);
  assert.deepEqual(events, [['chainChanged', chainId], ['accountsChanged', [account]]]);
  await assert.rejects(w.switchChain(1), (e) => e.code === CODES.UNRECOGNIZED_CHAIN);
  node2.chain = '0x1';
  await assert.rejects(w.switchChain(chain2), (e) => e.code === CODES.CHAIN_DISCONNECTED);
  assert.equal(w.chainId, chainId);
});

test('setAccount: only unlocked node accounts, emits accountsChanged and invalidates held requests', async (t) => {
  const { node, ctx, w, events } = await setup(t);
  await ctx.request('eth_requestAccounts');
  events.length = 0;
  await assert.rejects(w.setAccount(target), (e) => e.code === CODES.INVALID_PARAMS);
  await assert.rejects(w.setAccount('nope'), (e) => e.code === CODES.INVALID_PARAMS);
  w.setMode('hold');
  const pending = ctx.request('eth_sendTransaction', [txFor()]);
  const id = await w.whenHeld();
  await w.setAccount(other);
  assert.equal(code(await pending), CODES.UNAUTHORIZED);
  assert.equal(w.calls.at(-1).outcome, 'cancelled');
  assert.throws(() => w.release(id), (e) => e.code === CODES.INTERNAL, 'an invalidated request cannot be released');
  assert.deepEqual(events, [['accountsChanged', [other]]]);
  assert.equal(w.account, other);
  assert.deepEqual(await ctx.request('eth_accounts'), { result: [other] });
  w.setMode('approve');
  assert.equal(code(await ctx.request('eth_sendTransaction', [txFor(account)])), CODES.INVALID_PARAMS);
  assert.deepEqual(await ctx.request('eth_sendTransaction', [txFor(other)]), { result: hash });
  assert.equal(node.sends, 1);
});

test('epochs: late policy, preflight and pre-admission races never dispatch; dispatched writes keep their chain', async (t) => {
  const { node, node2, ctx, w } = await setup(t);
  await ctx.request('eth_requestAccounts');
  // (a) Late policy: the final validateTransaction returns after revoke.
  let gate = null;
  let validations = 0;
  const policy = async () => { validations++; if (gate && validations === gate.at) await gate.promise; };
  const ctxA = await setup(t, { validateTransaction: policy });
  await ctxA.ctx.request('eth_requestAccounts');
  gate = { at: 2, ...deferred() };
  const late = ctxA.ctx.request('eth_sendTransaction', [txFor()]);
  while (validations < 2) await tick(1);
  await ctxA.w.revoke();
  gate.resolve();
  assert.equal(code(await late), CODES.UNAUTHORIZED);
  assert.equal(ctxA.node.sends, 0);
  assert.equal(ctxA.w.calls.at(-1).outcome, 'cancelled');
  // (b) Pre-admission policy race: revoke while the first validation is pending; nothing is admitted.
  await ctxA.ctx.request('eth_requestAccounts');
  validations = 0;
  gate = { at: 1, ...deferred() };
  const admittedBefore = ctxA.w.calls.length;
  const early = ctxA.ctx.request('eth_sendTransaction', [txFor()]);
  while (validations < 1) await tick(1);
  await ctxA.w.revoke();
  gate.resolve();
  assert.equal(code(await early), CODES.UNAUTHORIZED);
  assert.equal(ctxA.w.calls.length, admittedBefore, 'not admitted');
  assert.equal(ctxA.node.sends, 0);
  // Pre-admission disconnect and chain-switch races fail with their own cause (4900 / 4901), never 4100.
  await ctxA.ctx.request('eth_requestAccounts');
  for (const [race, expected] of [[() => ctxA.w.disconnect(), CODES.DISCONNECTED], [() => ctxA.w.switchChain(chain2), CODES.CHAIN_DISCONNECTED]]) {
    validations = 0;
    gate = { at: 1, ...deferred() };
    const before = ctxA.w.calls.length;
    const pending = ctxA.ctx.request('eth_sendTransaction', [txFor()]);
    while (validations < 1) await tick(1);
    await race();
    gate.resolve();
    assert.equal(code(await pending), expected);
    assert.equal(ctxA.w.calls.length, before, 'not admitted');
    assert.equal(ctxA.node.sends + ctxA.node2.sends, 0);
    await ctxA.w.reconnect();
  }
  // (c) Preflight race: a Node-side chain switch while the ownership guard is pending.
  let guardGate = null;
  const ctxC = await setup(t, { beforeSend: async () => { if (guardGate) { const g = guardGate; guardGate = null; await g.promise; } } });
  await ctxC.ctx.request('eth_requestAccounts');
  const g = deferred();
  guardGate = g;
  const raced = ctxC.ctx.request('eth_sendTransaction', [txFor()]);
  await tick();
  await ctxC.w.switchChain(chain2);
  g.resolve();
  assert.equal(code(await raced), CODES.CHAIN_DISCONNECTED);
  assert.equal(ctxC.node.sends + ctxC.node2.sends, 0);
  assert.equal(ctxC.w.calls.at(-1).outcome, 'cancelled');
  // (d) Dispatched write: a scope change during dispatch is not a cancellation; the write stays on its chain.
  const dispatch = deferred();
  node.gate = { method: 'eth_sendTransaction', promise: dispatch.promise };
  const inFlight = ctx.request('eth_sendTransaction', [txFor()]);
  while (!w.calls.some((c) => c.outcome === 'dispatching')) await tick(1);
  assert.equal(code(await ctx.request('eth_sendTransaction', [txFor()])), CODES.REQUEST_PENDING, 'dispatching counts as outstanding');
  assert.deepEqual(await ctx.request('eth_blockNumber'), { result: '0x0' }, 'parallel reads are allowed');
  await w.switchChain(chain2);
  await w.revoke();
  dispatch.resolve();
  assert.deepEqual(await inFlight, { result: hash });
  const record = w.calls.at(-1);
  assert.equal(record.outcome, 'submitted');
  assert.equal(record.chainId, chainId);
  assert.equal(record.endpoint, node.endpoint);
  assert.equal(node.sends, 1);
  assert.equal(node2.sends, 0);
  node.gate = null;
});

test('outcomes: upstream failure keeps data, timeout after dispatch is unknown, lost keeps the submission, no retries', async (t) => {
  const nodes = installFetch(t);
  const node = createNode(nodes);
  const emitted = [];
  const ctx = fakeContext([fakePage(origin + '/', { onEvaluate: (arg) => emitted.push(arg) })]);
  const w = await installForkWallet(ctx, baseOptions(node, { timeoutMs: 50 }));
  await ctx.request('eth_requestAccounts');
  const last = () => w.calls.at(-1);
  // Upstream JSON-RPC error after dispatch: failed, code/message/data preserved to the page.
  node.errorOn.eth_sendTransaction = { code: -32003, message: 'insufficient funds', data: { reason: 'x' } };
  assert.deepEqual((await ctx.request('eth_sendTransaction', [txFor()])).error, { code: -32003, message: 'insufficient funds', data: { reason: 'x' } });
  assert.equal(last().outcome, 'failed');
  delete node.errorOn.eth_sendTransaction;
  // Timeout after dispatch: unknown, never rewritten as failure-before-send, and not retried.
  node.hangOn = 'eth_sendTransaction';
  const sentBefore = node.sent('eth_sendTransaction');
  assert.equal(code(await ctx.request('eth_sendTransaction', [txFor()])), CODES.INTERNAL);
  assert.equal(last().outcome, 'unknown');
  assert.ok(last().dispatchedAt);
  assert.equal(node.sent('eth_sendTransaction'), sentBefore + 1, 'exactly one attempt');
  node.hangOn = null;
  // Lost: hash recorded and enriched, page sees -32603; enrichment failure cannot erase the submission.
  w.nextRequest({ method: 'eth_sendTransaction', mode: 'lost' });
  node.errorOn.eth_getTransactionByHash = { code: -32000, message: 'unavailable' };
  assert.equal(code(await ctx.request('eth_sendTransaction', [txFor()])), CODES.INTERNAL);
  assert.equal(last().outcome, 'response-lost');
  assert.equal(last().hash, hash);
  assert.equal(last().enrichError, 'unavailable');
  assert.deepEqual(w.submitted, [hash]);
  delete node.errorOn.eth_getTransactionByHash;
  assert.deepEqual(await ctx.request('eth_sendTransaction', [txFor()]), { result: hash }, 'the one-shot override was consumed');
  assert.equal(last().outcome, 'submitted');
  assert.equal(last().nonce, '0x1');
  assert.equal(last().type, '0x2');
  assert.equal(node.sent('eth_sendTransaction'), sentBefore + 3);
  // Reads never consume a pending override.
  w.nextRequest({ method: 'eth_sendTransaction', mode: 'reject' });
  await ctx.request('eth_blockNumber');
  await ctx.request('eth_requestAccounts');
  assert.equal(code(await ctx.request('eth_sendTransaction', [txFor()])), CODES.USER_REJECTED);
  // Read errors keep upstream code/message/data (e.g. ABI revert data).
  node.errorOn.eth_call = { code: 3, message: 'execution reverted', data: '0x08c379a0' };
  assert.deepEqual((await ctx.request('eth_call', [{ to: target, data: '0x' }, 'latest'])).error, { code: 3, message: 'execution reverted', data: '0x08c379a0' });
  const forwarded = node.requests.filter((r) => r.method === 'eth_call').at(-1);
  assert.deepEqual(forwarded.params, [{ to: target, data: '0x' }, 'latest']);
  assert.equal(code(await ctx.request('eth_call', [{ to: target, data: '0x' }, 'latest', {}])), CODES.INVALID_PARAMS);
  node.blockNumber = '0x64';
  await ctx.request('eth_getLogs', [{ address: target }]);
  assert.deepEqual(node.requests.filter((r) => r.method === 'eth_getLogs').at(-1).params, [{ address: target, fromBlock: '0x64', toBlock: '0x64' }]);
  assert.equal(node.requests.filter((r) => !['eth_chainId', 'web3_clientVersion', 'eth_accounts', 'eth_sendTransaction', 'eth_getTransactionByHash', 'eth_blockNumber', 'eth_call', 'eth_getBlockByNumber', 'eth_getLogs'].includes(r.method)).length, 0, 'no other upstream methods');
  assert.ok(emitted.length >= 1);
});

test('parallel approvals and held lifecycle: -32002, whenHeld IDs, revoke/disconnect invalidation, no duplicate release', async (t) => {
  const { node, ctx, w } = await setup(t);
  await ctx.request('eth_requestAccounts');
  w.setMode('hold');
  const waiting = w.whenHeld();
  const a = ctx.request('eth_sendTransaction', [txFor()]);
  const b = ctx.request('eth_sendTransaction', [txFor()]);
  const id = await waiting;
  assert.equal(await w.whenHeld(), id, 'whenHeld resolves immediately with the held ID');
  assert.equal(code(await b), CODES.REQUEST_PENDING);
  await w.revoke();
  assert.equal(code(await a), CODES.UNAUTHORIZED);
  assert.throws(() => w.release(id));
  const pendingConnect = ctx.request('eth_requestAccounts');
  const connectId = await w.whenHeld();
  w.release(connectId);
  assert.deepEqual(await pendingConnect, { result: [account] });
  const c = ctx.request('eth_sendTransaction', [txFor()]);
  const cId = await w.whenHeld();
  assert.notEqual(cId, id);
  w.release(cId, 'approve');
  assert.throws(() => w.release(cId, 'approve'), (e) => e.code === CODES.INTERNAL);
  assert.deepEqual(await c, { result: hash });
  assert.equal(node.sends, 1);
  const states = w.calls.map((r) => r.outcome);
  assert.ok(states.every((s) => ['approved', 'submitted', 'cancelled', 'rejected', 'failed'].includes(s)), JSON.stringify(states));
});
