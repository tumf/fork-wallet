'use strict';
// Offline unit controls for the narrow legacy surface of the injected provider: the false-only
// autoRefreshOnNetworkChange accessor and the zero-argument enable() alias of eth_requestAccounts. The provider under
// test is the actual pageScript captured from installForkWallet and run in a VM realm (test/helpers.js), bound to the
// real Node request handler. In-memory doubles only: no sockets, processes or browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installForkWallet, CODES } = require('../src/index.js');
const { account, other, target, origin, chainId, tick, installFetch, createNode, fakePage, fakeContext, baseOptions, runPageScript } = require('./helpers.js');

const LEGACY_EVENTS = ['connect', 'disconnect', 'accountsChanged', 'chainChanged', 'message'];
const shape = (error) => ({ code: error.code, message: error.message, data: error.data });

/** Installs the wallet, runs its serialized page script and wires the page binding to a chosen caller frame. */
async function setup(t, extra = {}) {
  const nodes = installFetch(t);
  const node = createNode(nodes);
  const emitted = [];
  const page = fakePage(origin + '/app', { onEvaluate: ([name, payload]) => emitted.push([name, payload]) });
  const ctx = fakeContext([page]);
  ctx.page = page;
  const w = await installForkWallet(ctx, baseOptions(node, extra));
  assert.equal(ctx.scripts.length, 1);
  const win = runPageScript(ctx.scripts[0]);
  await tick(); // let the init connect event settle before counting
  const pageEvents = [];
  for (const name of LEGACY_EVENTS) win.ethereum.on(name, (payload) => pageEvents.push([name, payload]));
  const bindingCalls = [];
  let source = { page, frame: page.mainFrame() };
  win.__forkWalletRequest = (request) => {
    bindingCalls.push(request);
    // Playwright serializes binding arguments across the page boundary; clone so the handler sees a host-realm object.
    return ctx.bindings.__forkWalletRequest(source, structuredClone(request));
  };
  const setSource = (next) => { source = next; };
  return { node, ctx, w, win, provider: win.ethereum, emitted, pageEvents, bindingCalls, setSource, page };
}

test('legacy autoRefreshOnNetworkChange: strict false write succeeds on the frozen provider with no side effects', async (t) => {
  const { node, w, provider, emitted, pageEvents, bindingCalls } = await setup(t);
  assert.ok(Object.isFrozen(provider));
  assert.equal(provider.autoRefreshOnNetworkChange, false);
  // A strict-mode render in the host realm and in a separate VM realm (as page code would run).
  provider.autoRefreshOnNetworkChange = false;
  vm.runInNewContext("'use strict'; ethereum.autoRefreshOnNetworkChange = false; result = ethereum.autoRefreshOnNetworkChange;",
    Object.assign(Object.create(null), { ethereum: provider, result: null }));
  assert.equal(provider.autoRefreshOnNetworkChange, false);
  assert.ok(Object.isFrozen(provider), 'still frozen after the legacy write');
  const descriptor = Object.getOwnPropertyDescriptor(provider, 'autoRefreshOnNetworkChange');
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.configurable, false);
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(typeof descriptor.set, 'function');
  assert.equal(descriptor.get.call(undefined), false, 'getter holds no state');
  // Every other value throws a VM-realm TypeError synchronously without coercion hooks or state change.
  let coerced = 0;
  const hostile = { valueOf() { coerced++; return false; }, toString() { coerced++; return 'false'; }, [Symbol.toPrimitive]() { coerced++; return false; } };
  for (const value of [true, undefined, null, 0, -0, NaN, '', 'false', {}, [], hostile, Object(false), () => false, Symbol('x'), 0n]) {
    assert.throws(() => { provider.autoRefreshOnNetworkChange = value; }, { name: 'TypeError' }, String(typeof value));
    assert.throws(() => vm.runInNewContext("'use strict'; ethereum.autoRefreshOnNetworkChange = value;",
      Object.assign(Object.create(null), { ethereum: provider, value })), { name: 'TypeError' });
    assert.equal(provider.autoRefreshOnNetworkChange, false);
  }
  assert.equal(coerced, 0, 'setter never invokes caller coercion hooks');
  // No binding, approval, submission or event anywhere.
  assert.deepEqual(bindingCalls, []);
  assert.equal(w.calls.length, 0);
  assert.equal(node.requests.length, 0);
  assert.deepEqual(pageEvents, []);
  assert.deepEqual(emitted, []);
});

test('legacy members: strict mutation of the frozen provider is refused; discovery and members otherwise unchanged', async (t) => {
  const { provider, win, w, bindingCalls } = await setup(t);
  const request = provider.request;
  const enable = provider.enable;
  assert.deepEqual(Object.keys(provider), ['isForkWallet', 'on', 'removeListener', 'request', 'enable', 'off']);
  assert.deepEqual(Object.getOwnPropertyNames(provider).sort(),
    ['autoRefreshOnNetworkChange', 'enable', 'isForkWallet', 'off', 'on', 'removeListener', 'request']);
  for (const absent of ['send', 'sendAsync', 'isMetaMask', 'selectedAddress', 'chainId', 'networkVersion']) assert.equal(provider[absent], undefined, absent);
  assert.throws(() => { provider.request = async () => [account]; }, { name: 'TypeError' });
  assert.throws(() => { provider.enable = async () => [account]; }, { name: 'TypeError' });
  assert.throws(() => { provider.unknownLegacyFlag = true; }, { name: 'TypeError' });
  assert.throws(() => { delete provider.enable; }, { name: 'TypeError' });
  assert.throws(() => { delete provider.request; }, { name: 'TypeError' });
  assert.throws(() => { delete provider.autoRefreshOnNetworkChange; }, { name: 'TypeError' });
  assert.throws(() => Object.defineProperty(provider, 'autoRefreshOnNetworkChange', { value: true }), { name: 'TypeError' });
  assert.throws(() => Object.defineProperty(provider, 'autoRefreshOnNetworkChange', { get: () => true }), { name: 'TypeError' });
  assert.throws(() => Object.defineProperty(provider, 'enable', { value: async () => [account] }), { name: 'TypeError' });
  assert.throws(() => vm.runInNewContext("'use strict'; ethereum.request = null;", Object.assign(Object.create(null), { ethereum: provider })), { name: 'TypeError' });
  assert.equal(provider.request, request);
  assert.equal(provider.enable, enable);
  assert.equal(provider.unknownLegacyFlag, undefined);
  assert.equal(provider.autoRefreshOnNetworkChange, false);
  // EIP-6963 discovery still re-announces the same frozen detail carrying this exact provider object.
  const announced = [];
  win.addEventListener('eip6963:announceProvider', (event) => announced.push(event.detail));
  win.dispatchEvent({ type: 'eip6963:requestProvider' });
  assert.equal(announced.length, 1);
  assert.equal(announced[0].provider, provider);
  assert.equal(win.ethereum, provider);
  assert.ok(Object.isFrozen(announced[0]) && Object.isFrozen(announced[0].info));
  assert.deepEqual({ ...announced[0].info }, { ...w.info });
  assert.deepEqual(bindingCalls, []);
});

test('legacy enable: any argument (including explicit undefined) rejects -32602 before any binding', async (t) => {
  const { node, w, provider, bindingCalls, pageEvents } = await setup(t);
  for (const args of [[undefined], [null], [{}], [[]], ['eth_requestAccounts'], [1, 2], [undefined, undefined]]) {
    const result = provider.enable(...args);
    assert.ok(result instanceof Promise || typeof result.then === 'function', 'enable returns a promise even when refusing');
    await assert.rejects(result, (e) => e.code === CODES.INVALID_PARAMS && e.message === 'enable takes no arguments', JSON.stringify(args));
  }
  assert.deepEqual(bindingCalls, []);
  assert.equal(w.calls.length, 0);
  assert.equal(w.authorized, false);
  assert.equal(node.requests.length, 0);
  assert.deepEqual(pageEvents, []);
  // enable is not a JSON-RPC method: the request path still refuses it as unsupported.
  await assert.rejects(provider.request({ method: 'enable' }), (e) => e.code === CODES.UNSUPPORTED_METHOD);
  assert.deepEqual(bindingCalls, [{ method: 'enable' }]);
  assert.deepEqual(w.unsupported.map((u) => [u.method, u.reason]), [['enable', 'unsupported-method']]);
  assert.equal(w.calls.length, 0);
});

test('legacy enable: governed by eth_requestAccounts reject/hold/approve, traced as eth_requestAccounts, no send authority', async (t) => {
  const { node, w, provider, emitted, bindingCalls } = await setup(t);
  // Rejection: same code and message as the request path; no grant.
  w.setMode('reject');
  const viaEnable = await provider.enable().then(() => assert.fail('enable resolved'), shape);
  const viaRequest = await provider.request({ method: 'eth_requestAccounts' }).then(() => assert.fail('request resolved'), shape);
  assert.deepEqual(viaEnable, viaRequest);
  assert.equal(viaEnable.code, CODES.USER_REJECTED);
  assert.equal(w.authorized, false);
  assert.deepEqual(w.calls.map((r) => [r.method, r.outcome]), [['eth_requestAccounts', 'rejected'], ['eth_requestAccounts', 'rejected']]);
  assert.deepEqual(emitted, []);
  // Unauthorized: enable grants nothing for sending.
  await assert.rejects(provider.request({ method: 'eth_sendTransaction', params: [{ from: account, to: target, value: '0x1' }] }), (e) => e.code === CODES.UNAUTHORIZED);
  // Held approval: the existing control decides via nextRequest({method:'eth_requestAccounts'}).
  w.setMode('approve');
  w.nextRequest({ method: 'eth_requestAccounts', mode: 'hold' });
  const pending = provider.enable();
  const id = await w.whenHeld();
  assert.equal(w.calls.at(-1).requestId, id);
  assert.equal(w.calls.at(-1).method, 'eth_requestAccounts');
  assert.equal(w.authorized, false);
  w.release(id);
  assert.deepEqual(await pending, [account]);
  assert.equal(w.authorized, true);
  assert.deepEqual(emitted, [['accountsChanged', [account]]]);
  // Extracted call (no receiver) works and, already authorized, opens no new approval.
  const { enable } = provider;
  const approvals = w.calls.length;
  assert.deepEqual(await enable(), [account]);
  assert.deepEqual(await Reflect.apply(enable, undefined, []), [account]);
  assert.equal(w.calls.length, approvals);
  assert.ok(w.calls.every((r) => r.method === 'eth_requestAccounts'), 'no invented enable trace');
  assert.ok(bindingCalls.every((r) => r.method !== 'enable'), 'enable never crosses the binding');
  assert.equal(node.sends, 0, 'enable submits nothing');
  assert.equal(w.submitted.length, 0);
  // Signing stays disabled: enable is not signing authority.
  await assert.rejects(provider.request({ method: 'personal_sign', params: ['0x00', account] }), (e) => e.code === CODES.UNSUPPORTED_METHOD);
});

test('legacy enable: revoke, disconnect and reconnect semantics and error data match eth_requestAccounts', async (t) => {
  const { node, w, provider, ctx } = await setup(t);
  assert.deepEqual(await provider.enable(), [account]);
  // Revoke clears the grant; a later enable re-prompts through the same approval instead of regranting.
  await w.revoke();
  assert.equal(w.authorized, false);
  w.nextRequest({ method: 'eth_requestAccounts', mode: 'reject' });
  assert.equal((await provider.enable().catch(shape)).code, CODES.USER_REJECTED);
  assert.equal(w.authorized, false);
  // A held enable is invalidated by a scope change exactly like a held eth_requestAccounts.
  const compare = async (invalidate) => {
    const results = [];
    for (const [i, call] of [() => provider.enable(), () => provider.request({ method: 'eth_requestAccounts' })].entries()) {
      w.nextRequest({ method: 'eth_requestAccounts', mode: 'hold' });
      const pending = call().then(() => assert.fail('resolved'), shape);
      await w.whenHeld();
      await invalidate(i);
      results.push(await pending);
      if (!w.connected) await w.reconnect();
    }
    assert.deepEqual(results[0], results[1]);
    return results[0];
  };
  const changed = await compare((i) => w.setAccount(i === 0 ? other : account));
  assert.equal(changed.code, CODES.UNAUTHORIZED);
  assert.equal(w.authorized, false);
  const disconnected = await compare(() => w.disconnect());
  assert.equal(disconnected.code, CODES.DISCONNECTED);
  // Disconnected: enable fails 4900 like request; reconnect never regrants a revoked permission.
  await w.disconnect();
  const down = [await provider.enable().catch(shape), await provider.request({ method: 'eth_requestAccounts' }).catch(shape)];
  assert.deepEqual(down[0], down[1]);
  assert.equal(down[0].code, CODES.DISCONNECTED);
  await w.reconnect();
  assert.deepEqual(await ctx.request('eth_accounts'), { result: [] });
  assert.equal(w.authorized, false);
  // Error data from the handler (here a node failure during the connect preflight) is shaped identically.
  node.errorOn.eth_accounts = { code: -32000, message: 'boom', data: '0xdead' };
  const failed = [await provider.enable().catch(shape), await provider.request({ method: 'eth_requestAccounts' }).catch(shape)];
  assert.deepEqual(failed[0], failed[1]);
  assert.equal(failed[0].code, CODES.CHAIN_DISCONNECTED);
  assert.equal(w.authorized, false);
  // Handler error data (here a node revert surfaced through a read) uses the same page-side shaping enable reuses.
  delete node.errorOn.eth_accounts;
  node.errorOn.eth_call = { code: 3, message: 'execution reverted', data: '0xdeadbeef' };
  const reverted = await provider.request({ method: 'eth_call', params: [{ to: target }, 'latest'] }).catch(shape);
  assert.deepEqual(reverted, { code: 3, message: 'execution reverted', data: '0xdeadbeef' });
  assert.equal(node.sends, 0);
});

test('legacy enable: wrong origin or subframe callers are refused like request; no injection off-origin', async (t) => {
  const { w, provider, setSource, page, ctx, bindingCalls } = await setup(t);
  assert.equal(runPageScript(ctx.scripts[0], { pageOrigin: 'http://127.0.0.1:9' }).ethereum, undefined);
  assert.equal(runPageScript(ctx.scripts[0], { top: false }).ethereum, undefined);
  const elsewhere = fakePage('http://127.0.0.1:9/');
  for (const source of [{ page: elsewhere, frame: elsewhere.mainFrame() }, { page, frame: page.subframe(origin + '/frame') }]) {
    setSource(source);
    const viaEnable = await provider.enable().catch(shape);
    const viaRequest = await provider.request({ method: 'eth_requestAccounts' }).catch(shape);
    assert.deepEqual(viaEnable, viaRequest);
    assert.equal(viaEnable.code, CODES.UNSUPPORTED_METHOD);
  }
  assert.equal(w.calls.length, 0, 'no approval admitted for a foreign caller');
  assert.equal(w.authorized, false);
  assert.equal(w.unsupported.filter((u) => u.reason === 'caller-frame').length, 4);
  assert.equal(bindingCalls.length, 4);
  assert.equal(w.chainId, chainId);
});
