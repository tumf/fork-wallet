'use strict';
// Offline unit controls for opt-in signing: install policy, exact input bounds, handle order, approval/epoch
// lifecycle, post-dispatch scope races and redaction. In-memory doubles only (test/helpers.js): no sockets, processes
// or browser. STUB: the scripted node returns a synthetic 65-byte hex value; it exercises local state transitions
// only and is never cryptographic evidence (real signatures are proven in test/signing-compat.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const wallet = require('../src/index.js');
const { installForkWallet, checkSignatureRequest, CODES, LIMITS, METHODS, APPROVAL_METHODS, SIGNING_METHODS, SIGNING_CHAINS, STATES } = wallet;
const { account, other, target, origin, chainId, tick, installFetch, createNode, fakePage, fakeContext, baseOptions } = require('./helpers.js');

const chain2 = '0x7a6a';
const STUB_SIGNATURE = '0x' + 'ab'.repeat(65); // STUB: synthetic, not a signature
const SENTINEL = 'SENTINEL_d41d8cd98f00b204';
const code = (reply) => reply && reply.error && reply.error.code;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const hexOf = (text) => '0x' + Buffer.from(text, 'utf8').toString('hex');
const message = hexOf('fork-wallet local test note');
const typed = (overrides = {}) => ({
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    TestNote: [{ name: 'id', type: 'uint256' }, { name: 'tags', type: 'string[]' }, { name: 'blob', type: 'bytes' }, { name: 'inner', type: 'Inner' }],
    Inner: [{ name: 'flag', type: 'bool' }, { name: 'amount', type: 'uint256' }],
  },
  primaryType: 'TestNote',
  domain: { name: 'fork-wallet test', chainId: 31337, verifyingContract: target },
  message: { id: 7, tags: ['a', 'b'], blob: '0x1234', inner: { flag: true, amount: '340282366920938463463374607431768211455' } },
  ...overrides,
});

async function setup(t, { policy, extra = {}, authorize = true } = {}) {
  const nodes = installFetch(t);
  const node = createNode(nodes);
  const node2 = createNode(nodes, { chain: chain2, accounts: [other] });
  node.results.personal_sign = STUB_SIGNATURE;
  node.results.eth_signTypedData_v4 = STUB_SIGNATURE;
  node2.results.personal_sign = STUB_SIGNATURE;
  const seen = [];
  const events = [];
  const page = fakePage(origin + '/', { onEvaluate: (arg) => events.push(arg) });
  const ctx = fakeContext([page]);
  ctx.page = page;
  const w = await installForkWallet(ctx, baseOptions(node, {
    signing: { async validateSignature(request) { seen.push(request); if (policy) await policy(request); } },
    chains: [{ endpoint: node2.endpoint, chainId: 31338, account: other, beforeSend() {} }],
    ...extra,
  }));
  if (authorize) assert.deepEqual(await ctx.request('eth_requestAccounts'), { result: [account] });
  const dispatches = () => node.sent('personal_sign') + node.sent('eth_signTypedData_v4') + node2.sent('personal_sign') + node2.sent('eth_signTypedData_v4');
  const signs = () => w.calls.filter((c) => SIGNING_METHODS.includes(c.method));
  return { node, node2, ctx, w, seen, events, dispatches, signs };
}

/** No sentinel, message, typed data or signature anywhere in the serialized trace or replies. */
function assertRedacted(w, replies, secrets = [SENTINEL]) {
  const text = JSON.stringify({ calls: w.calls, unsupported: w.unsupported, submitted: w.submitted, replies });
  for (const secret of secrets) assert.ok(!text.includes(secret), 'trace and replies are redacted');
}

test('signing is opt-in: absent is 4200 (signing-disabled), install policy shape and local chains are fail-closed', async (t) => {
  const nodes = installFetch(t);
  const node = createNode(nodes);
  assert.ok(SIGNING_METHODS.every((m) => METHODS.includes(m) && APPROVAL_METHODS.includes(m)), 'static supported-capability lists');
  assert.deepEqual([...SIGNING_CHAINS], ['0x7a69', '0x7a6a']);
  assert.ok(STATES.includes('signed') && STATES.includes('signed-discarded'));
  const ctx = fakeContext();
  const w = await installForkWallet(ctx, baseOptions(node));
  assert.equal(w.signing, false);
  assert.deepEqual(await ctx.request('eth_requestAccounts'), { result: [account] });
  // Disabled wins over every later check, including malformed params and transport loss.
  assert.equal(code(await ctx.request('personal_sign', [message, account])), CODES.UNSUPPORTED_METHOD);
  assert.equal(code(await ctx.request('eth_signTypedData_v4', [account, JSON.stringify(typed())])), CODES.UNSUPPORTED_METHOD);
  assert.equal(code(await ctx.request('personal_sign', 'nope')), CODES.UNSUPPORTED_METHOD);
  await w.disconnect();
  assert.equal(code(await ctx.request('personal_sign', [message, account])), CODES.UNSUPPORTED_METHOD);
  assert.deepEqual(w.unsupported.map((u) => [u.method, u.reason]), [['personal_sign', 'signing-disabled'], ['eth_signTypedData_v4', 'signing-disabled'], ['personal_sign', 'signing-disabled'], ['personal_sign', 'signing-disabled']]);
  assert.throws(() => w.nextRequest({ method: 'personal_sign', mode: 'approve' }), (e) => e.code === CODES.INVALID_PARAMS);
  assert.equal(node.sent('personal_sign') + node.sent('eth_signTypedData_v4'), 0);
  assert.equal(w.calls.filter((c) => SIGNING_METHODS.includes(c.method)).length, 0);
  // validateTransaction never implies a signing policy; signing needs exactly {validateSignature}.
  const ok = { validateSignature() {} };
  for (const signing of [null, true, {}, { validateSignature: 'x' }, { validateSignature() {}, extra: 1 }, [ok], Object.create(ok)]) {
    await assert.rejects(installForkWallet(fakeContext(), baseOptions(node, { signing })), (e) => e.code === CODES.INVALID_PARAMS, String(signing));
  }
  // Signing enabled only when every configured chain is 31337 or 31338 (not a mainnet-ID fork design).
  const node1 = createNode(nodes, { chain: '0x1' });
  await assert.rejects(installForkWallet(fakeContext(), baseOptions(node1, { signing: ok })), (e) => e.code === CODES.INVALID_PARAMS && /31337\/31338/.test(e.message));
  await assert.rejects(installForkWallet(fakeContext(), baseOptions(node, { signing: ok, chains: [{ endpoint: node1.endpoint, chainId: 1, account, beforeSend() {} }] })), (e) => e.code === CODES.INVALID_PARAMS);
  const node2 = createNode(nodes, { chain: chain2 });
  const enabled = await installForkWallet(fakeContext(), baseOptions(node, { signing: ok, chains: [{ endpoint: node2.endpoint, chainId: 31338, account, beforeSend() {} }] }));
  assert.equal(enabled.signing, true);
  // The same unsigned install still works for transactions-only use without a signing option.
  assert.equal(await installForkWallet(fakeContext(), baseOptions(node1)).then((x) => x.signing), false);
});

test('signing handle order: params array, transport 4900, permission 4100, then exact input -32602, then policy', async (t) => {
  const { ctx, w, seen, dispatches } = await setup(t, { authorize: false });
  assert.equal(code(await ctx.request('personal_sign', 'nope')), CODES.INVALID_PARAMS, 'params must be an array');
  // Connecting is not blanket signature permission: unauthorized is 4100 even with invalid input.
  assert.equal(code(await ctx.request('personal_sign', [message, account])), CODES.UNAUTHORIZED);
  assert.equal(code(await ctx.request('personal_sign', ['bad'])), CODES.UNAUTHORIZED);
  assert.equal(code(await ctx.request('eth_signTypedData_v4', [account, '{}'])), CODES.UNAUTHORIZED);
  await ctx.request('eth_requestAccounts');
  await w.disconnect();
  assert.equal(code(await ctx.request('personal_sign', [message, account])), CODES.DISCONNECTED);
  await w.reconnect();
  await w.revoke();
  assert.equal(code(await ctx.request('personal_sign', [message, account])), CODES.UNAUTHORIZED, 'revoked permission');
  await ctx.request('eth_requestAccounts');
  assert.equal(code(await ctx.request('personal_sign', [message, other])), CODES.INVALID_PARAMS, 'another unlocked account cannot sign');
  // Untrusted caller frames never reach signing.
  assert.equal(code(await ctx.request('personal_sign', [message, account], { frameOrigin: 'http://127.0.0.1:9' })), CODES.UNSUPPORTED_METHOD);
  assert.equal(code(await ctx.raw({ page: ctx.page, frame: ctx.page.subframe(origin + '/f') }, { method: 'personal_sign', params: [message, account] })), CODES.UNSUPPORTED_METHOD);
  assert.equal(seen.length, 0, 'policy never ran');
  assert.equal(dispatches(), 0);
  assert.equal(w.calls.filter((c) => SIGNING_METHODS.includes(c.method)).length, 0, 'nothing admitted');
});

test('personal_sign input: exactly [0x bytes <= 64 KiB, active address], no UTF-8 or address-first alias', async (t) => {
  const { node, ctx, seen, dispatches } = await setup(t);
  const max = '0x' + 'ab'.repeat(LIMITS.signMessageBytes);
  const bad = [[], [message], [message, account, 'x'], ['fork-wallet local test note', account], [account, message], ['0x123', account],
    ['0xzz', account], ['ab', account], [message, '0x1234'], [message, target], [message, null], [{ data: message }, account],
    ['0x' + 'ab'.repeat(LIMITS.signMessageBytes + 1), account]];
  for (const params of bad) assert.equal(code(await ctx.request('personal_sign', params)), CODES.INVALID_PARAMS, JSON.stringify(params).slice(0, 80));
  assert.equal(dispatches(), 0);
  assert.equal(seen.length, 0);
  // Address comparison is case-insensitive; the forwarded pair is normalized to [message, registered account].
  assert.deepEqual(await ctx.request('personal_sign', [message, account.toUpperCase().replace('0X', '0x')]), { result: STUB_SIGNATURE });
  assert.deepEqual(node.requests.filter((r) => r.method === 'personal_sign').at(-1).params, [message, account]);
  assert.deepEqual(await ctx.request('personal_sign', [max, account]), { result: STUB_SIGNATURE }, 'exactly 65536 bytes allowed');
  // Empty bytes are structurally allowed and forwarded unchanged (no substitution).
  assert.deepEqual(await ctx.request('personal_sign', ['0x', account]), { result: STUB_SIGNATURE });
  assert.deepEqual(node.requests.filter((r) => r.method === 'personal_sign').at(-1).params, ['0x', account]);
  assert.equal(dispatches(), 3);
  assert.ok(Object.isFrozen(seen[0]));
  assert.deepEqual(seen[0], { method: 'personal_sign', account, message });
});

test('typed data input: one JSON.parse, identical value to policy and node, string/object forms, exact bounds', async (t) => {
  const { node, ctx, w, seen, dispatches } = await setup(t);
  const forwarded = () => node.requests.filter((r) => r.method === 'eth_signTypedData_v4').at(-1).params;
  // JSON text and plain object normalize to the same value; the node gets [account, JSON.stringify(policy value)].
  assert.deepEqual(await ctx.request('eth_signTypedData_v4', [account, JSON.stringify(typed())]), { result: STUB_SIGNATURE });
  const fromText = forwarded();
  assert.deepEqual(await ctx.request('eth_signTypedData_v4', [account.toLowerCase(), typed()]), { result: STUB_SIGNATURE });
  assert.deepEqual(forwarded(), fromText);
  assert.equal(fromText[0], account);
  assert.equal(fromText[1], JSON.stringify(seen[0].typedData), 'policy and upstream use the identical parsed value');
  assert.equal(fromText[1], JSON.stringify(seen[2].typedData));
  assert.ok(Object.isFrozen(seen[0].typedData.message.inner) && Object.isFrozen(seen[0].typedData.types.TestNote[0]));
  assert.equal(seen[0].typedData.message.inner.amount, '340282366920938463463374607431768211455', 'large values stay strings');
  // Duplicate keys follow JSON.parse last-key behaviour; exponent spelling only matters through its safe value.
  const dup = JSON.stringify(typed()).replace('"id":7', '"id":1,"id":1e3');
  assert.deepEqual(await ctx.request('eth_signTypedData_v4', [account, dup]), { result: STUB_SIGNATURE });
  assert.equal(JSON.parse(forwarded()[1]).message.id, 1000);
  // Domain chainId forms: safe integer, decimal string, canonical hex; compared as BigInt with the active chain.
  for (const id of [31337, '31337', '0x7a69']) {
    assert.deepEqual(await ctx.request('eth_signTypedData_v4', [account, typed({ domain: { name: 'n', chainId: id, verifyingContract: target } })]), { result: STUB_SIGNATURE }, String(id));
  }
  const signed = dispatches();
  const types = typed().types;
  const deep = (n) => { let v = 'x'; for (let i = 0; i < n; i++) v = [v]; return v; };
  const bad = [
    [], [account], [account, typed(), 'x'], [typed(), account], [target, typed()], [account, 'not json'], [account, '[]'], [account, 42], [account, null],
    [account, typed({ extra: 1 })], [account, (({ message: _m, ...rest }) => rest)(typed())],
    [account, typed({ types: { TestNote: types.TestNote, Inner: types.Inner } })],
    [account, typed({ primaryType: 'EIP712Domain' })], [account, typed({ primaryType: 'Missing' })], [account, typed({ primaryType: 1 })],
    [account, typed({ types: [] })], [account, typed({ types: { ...types, TestNote: {} } })],
    [account, typed({ types: { ...types, TestNote: [{ name: 'id', type: 'uint256', extra: 1 }] } })],
    [account, typed({ types: { ...types, TestNote: [{ name: '', type: 'uint256' }] } })],
    [account, typed({ types: { ...types, TestNote: [{ name: 'id', type: 'uint256' }, { name: 'id', type: 'string' }] } })],
    [account, typed({ types: { ...types, TestNote: [{ name: 'x'.repeat(LIMITS.typedDataNameChars + 1), type: 'uint256' }] } })],
    [account, typed({ types: { ...types, ['T'.repeat(LIMITS.typedDataNameChars + 1)]: [] } })],
    [account, typed({ types: { ...types, TestNote: Array.from({ length: LIMITS.typedDataFields + 1 }, (_, i) => ({ name: 'f' + i, type: 'uint8' })) } })],
    [account, typed({ types: { ...types, ...Object.fromEntries(Array.from({ length: LIMITS.typedDataTypes }, (_, i) => ['T' + i, []])) } })],
    [account, typed({ domain: { name: 'n', chainId: 31338, verifyingContract: target } })], // wrong chain
    [account, typed({ domain: { name: 'n', chainId: 1, verifyingContract: target } })],
    [account, typed({ domain: { name: 'n', verifyingContract: target }, types: { ...types, EIP712Domain: [types.EIP712Domain[0], types.EIP712Domain[2]] } })], // no chainId
    [account, typed({ domain: { name: 'n', chainId: '0x07a69', verifyingContract: target } })],
    [account, typed({ domain: { name: 'n', chainId: '031337', verifyingContract: target } })],
    [account, typed({ domain: { name: 'n', chainId: -31337, verifyingContract: target } })],
    [account, typed({ domain: { name: 'n', chainId: 31337.5, verifyingContract: target } })],
    [account, typed({ domain: { name: 'n', chainId: 31337, verifyingContract: target, version: '1' } })], // undeclared field
    [account, typed({ domain: { chainId: 31337, verifyingContract: target, extra: 'x' } })],
    [account, typed({ types: { ...types, EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint64' }, { name: 'verifyingContract', type: 'address' }] } })],
    [account, typed({ domain: { name: 7, chainId: 31337, verifyingContract: target } })],
    [account, typed({ domain: { name: 'n', chainId: 31337, verifyingContract: '0x1234' } })],
    [account, typed({ domain: { chainId: 31337, salt: '0x12' }, types: { ...types, EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'salt', type: 'bytes32' }] } })],
    [account, typed({ message: [] })], [account, typed({ message: 'x' })],
    [account, typed({ message: { id: 1.5 } })], [account, typed({ message: { id: 2 ** 53 } })], [account, typed({ message: { x: deep(LIMITS.typedDataDepth) } })],
    [account, typed({ message: { list: Array.from({ length: LIMITS.typedDataNodes }, (_, i) => i) } })],
    [account, typed({ message: { blob: '0x' + 'ab'.repeat(LIMITS.typedDataBytes) } })],
    [account, JSON.stringify(typed()) + ' '.repeat(LIMITS.typedDataBytes)],
    [account, JSON.stringify(typed()).replace('"message":{', '"message":{"__proto__":{"x":1},')],
    [account, JSON.stringify(typed()).replace('"message":{', '"message":{"constructor":1,')],
    [account, JSON.stringify(typed()).replace('"message":{', '"message":{"prototype":1,')],
    [account, JSON.stringify(typed()).replace('"id":7', '"id":7.25')],
    [account, JSON.stringify(typed()).replace('"id":7', '"id":12345678901234567890')],
  ];
  for (const params of bad) assert.equal(code(await ctx.request('eth_signTypedData_v4', params)), CODES.INVALID_PARAMS, JSON.stringify(params).slice(0, 160));
  // Values JSON cannot carry are refused when an object arrives (the binding deserializes richer values).
  const raw = (td) => ctx.raw({ page: ctx.page, frame: ctx.page.mainFrame() }, { method: 'eth_signTypedData_v4', params: [account, td] });
  const withValue = (value) => { const td = typed(); td.message.inner.extra = value; return td; };
  const getter = typed();
  Object.defineProperty(getter.message, 'g', { enumerable: true, get() { return 1; } });
  const sparse = typed();
  sparse.message.tags = ['a', , 'c']; // eslint-disable-line no-sparse-arrays
  const nullProto = Object.assign(Object.create(null), typed());
  for (const td of [withValue(undefined), withValue(() => 1), withValue(new Date(0)), withValue(Number.NaN), withValue(Infinity), withValue(new (class X {})()), getter, sparse,
    withValue(Object.assign([], { extra: 1 })), withValue({ [Symbol('s')]: 1 })]) {
    assert.equal(code(await raw(td)), CODES.INVALID_PARAMS);
  }
  assert.equal(code(await raw(withValue(1n))), CODES.INVALID_REQUEST, 'bigint is not JSON at the request boundary');
  assert.deepEqual(await raw(nullProto), { result: STUB_SIGNATURE }, 'null-prototype plain object is plain data');
  assert.equal(dispatches(), signed + 1);
  // The domain summary is recorded; full typed data never is.
  const rec = w.calls.filter((c) => c.method === 'eth_signTypedData_v4').at(-1);
  assert.deepEqual(rec.domain, { chainId: '0x7a69', verifyingContract: target });
  assert.ok(!('typedData' in rec) && !('message' in rec) && !('signature' in rec));
  // Exported pure validator (same contract, no wallet state).
  assert.deepEqual(checkSignatureRequest('personal_sign', [message, account], account, chainId), { method: 'personal_sign', account, message });
  assert.throws(() => checkSignatureRequest('eth_sign', [message, account], account, chainId), (e) => e.code === CODES.UNSUPPORTED_METHOD);
  assert.throws(() => checkSignatureRequest('eth_signTypedData_v4', [account, typed()], account, chain2), (e) => e.code === CODES.INVALID_PARAMS);
});

test('signing approvals: signed outcome, reject/hold/release, single slot with sends, lost refused, no retry', async (t) => {
  let held = null;
  const { node, ctx, w, seen, dispatches, signs } = await setup(t);
  // Approve: actual node result returned, signed record with booleans, wallet.submitted stays transactions-only.
  assert.deepEqual(await ctx.request('personal_sign', [message, account]), { result: STUB_SIGNATURE });
  const rec = signs().at(-1);
  assert.equal(rec.outcome, 'signed');
  assert.equal(rec.signatureReturned, true);
  assert.equal(rec.delivered, true);
  assert.match(rec.inputHash, /^[0-9a-f]{64}$/);
  assert.ok(rec.dispatchedAt && rec.requestId && rec.epoch >= 0 && rec.chainId === chainId && rec.account === account && rec.mode === 'approve');
  assert.deepEqual(w.submitted, []);
  assert.equal(seen.length, 2, 'policy before admission and after preflight');
  // Reject: 4001, zero dispatch.
  w.nextRequest({ method: 'personal_sign', mode: 'reject' });
  assert.equal(code(await ctx.request('personal_sign', [message, account])), CODES.USER_REJECTED);
  assert.equal(signs().at(-1).outcome, 'rejected');
  assert.equal(dispatches(), 1);
  // Global lost: -32602 before policy/admission, one-shot overrides of other methods untouched.
  w.setMode('lost');
  const policyRuns = seen.length;
  const admitted = w.calls.length;
  w.nextRequest({ method: 'eth_sendTransaction', mode: 'reject' });
  assert.equal(code(await ctx.request('personal_sign', [message, account])), CODES.INVALID_PARAMS);
  assert.equal(code(await ctx.request('eth_signTypedData_v4', [account, typed()])), CODES.INVALID_PARAMS);
  assert.equal(seen.length, policyRuns);
  assert.equal(w.calls.length, admitted);
  assert.throws(() => w.nextRequest({ method: 'personal_sign', mode: 'lost' }), (e) => e.code === CODES.INVALID_PARAMS);
  // A queued same-method signing override does not bypass global lost and is left unconsumed.
  w.nextRequest({ method: 'personal_sign', mode: 'reject' });
  assert.equal(code(await ctx.request('personal_sign', [message, account])), CODES.INVALID_PARAMS);
  assert.equal(seen.length, policyRuns);
  assert.equal(w.calls.length, admitted);
  w.setMode('approve');
  assert.equal(code(await ctx.request('eth_sendTransaction', [{ from: account, to: target }])), CODES.USER_REJECTED, 'send override was not consumed by signing');
  assert.equal(code(await ctx.request('personal_sign', [message, account])), CODES.USER_REJECTED, 'signing override survived global lost');
  assert.equal(signs().at(-1).outcome, 'rejected');
  assert.equal(dispatches(), 1);
  // Hold: shares the single approval slot with sends and permissions; wrong-ID, lost and double release refused.
  w.setMode('hold');
  const pending = ctx.request('eth_signTypedData_v4', [account, typed()]);
  held = await w.whenHeld();
  assert.equal(signs().at(-1).outcome, 'held');
  assert.equal(code(await ctx.request('eth_sendTransaction', [{ from: account, to: target }])), CODES.REQUEST_PENDING);
  assert.equal(code(await ctx.request('personal_sign', [message, account])), CODES.REQUEST_PENDING);
  assert.equal(code(await ctx.request('wallet_requestPermissions', [{ eth_accounts: {} }])), CODES.REQUEST_PENDING);
  assert.throws(() => w.release('00000000-0000-4000-8000-000000000000'), (e) => e.code === CODES.INVALID_PARAMS);
  assert.throws(() => w.release(held, 'lost'), (e) => e.code === CODES.INVALID_PARAMS);
  assert.equal(w.heldRequestId, held, 'lost release did not release it');
  w.release(held, 'approve');
  assert.throws(() => w.release(held, 'approve'), (e) => e.code === CODES.INTERNAL, 'double release');
  assert.deepEqual(await pending, { result: STUB_SIGNATURE });
  assert.equal(dispatches(), 2);
  // A held send blocks signing in the same slot.
  const send = ctx.request('eth_sendTransaction', [{ from: account, to: target }]);
  const sendId = await w.whenHeld();
  assert.equal(code(await ctx.request('personal_sign', [message, account])), CODES.REQUEST_PENDING);
  w.release(sendId, 'reject');
  assert.equal(code(await send), CODES.USER_REJECTED);
  // Hold then reject: zero dispatch.
  const rejected = ctx.request('personal_sign', [message, account]);
  w.release(await w.whenHeld(), 'reject');
  assert.equal(code(await rejected), CODES.USER_REJECTED);
  assert.equal(dispatches(), 2);
  w.setMode('approve');
  assert.equal(node.sends, 0);
  assert.deepEqual(w.submitted, []);
  assert.ok(signs().every((c) => STATES.includes(c.outcome)));
});

test('scope races: revoke/account/chain/disconnect during policy or hold cancel with zero signing dispatch', async (t) => {
  let gate = null;
  let runs = 0;
  const policy = async () => { runs++; if (gate && runs === gate.at) await gate.promise; };
  const { ctx, w, dispatches, signs } = await setup(t, { policy });
  const races = [
    [() => w.revoke(), CODES.UNAUTHORIZED], [() => w.setAccount(other), CODES.UNAUTHORIZED],
    [() => w.switchChain(31338), CODES.CHAIN_DISCONNECTED], [() => w.disconnect(), CODES.DISCONNECTED],
  ];
  const restore = async () => {
    if (!w.connected) await w.reconnect();
    if (w.chainId !== chainId) await w.switchChain(31337);
    if (w.account !== account) await w.setAccount(account);
    if (!w.authorized) await ctx.request('eth_requestAccounts');
  };
  // (a) Pre-admission policy pending: not admitted, own cause code.
  for (const [race, expected] of races) {
    runs = 0;
    gate = { at: 1, ...deferred() };
    const before = w.calls.length;
    const pending = ctx.request('personal_sign', [message, account]);
    while (runs < 1) await tick(1);
    await race();
    gate.resolve();
    assert.equal(code(await pending), expected);
    assert.equal(w.calls.length, before, 'not admitted');
    await restore();
  }
  // (b) Final policy pending after preflight: cancelled, never dispatched.
  for (const [race, expected] of races) {
    runs = 0;
    gate = { at: 2, ...deferred() };
    const pending = ctx.request('eth_signTypedData_v4', [account, typed()]);
    while (runs < 2) await tick(1);
    await race();
    gate.resolve();
    assert.equal(code(await pending), expected);
    assert.equal(signs().at(-1).outcome, 'cancelled');
    await restore();
  }
  gate = null;
  // (c) Held: cancelled by the scope change; the stale ID cannot be released.
  w.setMode('hold');
  for (const [race, expected] of races) {
    const pending = ctx.request('personal_sign', [message, account]);
    const id = await w.whenHeld();
    await race();
    assert.equal(code(await pending), expected);
    assert.equal(signs().at(-1).outcome, 'cancelled');
    assert.throws(() => w.release(id));
    w.setMode('approve');
    await restore();
    w.setMode('hold');
  }
  w.setMode('approve');
  assert.equal(dispatches(), 0, 'no stale request dispatched');
  assert.ok(signs().every((c) => c.signatureReturned === false && c.delivered === false));
});

test('after dispatch: scope change discards a returned signature (signed-discarded), keeps attribution, no stale delivery', async (t) => {
  const { node, ctx, w, dispatches, signs } = await setup(t);
  const cases = [[() => w.switchChain(31338), CODES.CHAIN_DISCONNECTED], [() => w.revoke(), CODES.UNAUTHORIZED],
    [() => w.setAccount(other), CODES.UNAUTHORIZED], [() => w.disconnect(), CODES.DISCONNECTED],
    // Away and back: chain and account match again, but the epoch moved, so the signature is still discarded.
    [async () => { await w.switchChain(31338); await w.switchChain(31337); }, CODES.CHAIN_DISCONNECTED]];
  for (const [race, expected] of cases) {
    const gate = deferred();
    node.gate = { method: 'personal_sign', promise: gate.promise };
    const pending = ctx.request('personal_sign', [message, account]);
    while (!signs().some((c) => c.outcome === 'dispatching')) await tick(1);
    await race();
    gate.resolve();
    const reply = await pending;
    assert.deepEqual(Object.keys(reply), ['error']);
    assert.equal(reply.error.code, expected);
    assert.ok(!JSON.stringify(reply).includes(STUB_SIGNATURE.slice(2)), 'signature not delivered');
    const rec = signs().at(-1);
    assert.equal(rec.outcome, 'signed-discarded');
    assert.equal(rec.signatureReturned, true);
    assert.equal(rec.delivered, false);
    assert.equal(rec.chainId, chainId, 'attributed to the original chain');
    assert.equal(rec.account, account);
    node.gate = null;
    if (!w.connected) await w.reconnect();
    if (w.chainId !== chainId) await w.switchChain(31337);
    if (w.account !== account) await w.setAccount(account);
    if (!w.authorized) await ctx.request('eth_requestAccounts');
  }
  assert.equal(dispatches(), cases.length, 'generation cannot be undone: one dispatch each, no retry');
  assert.deepEqual(w.submitted, []);
});

test('redaction: policy throws, upstream echoes, timeout and malformed results expose only fixed messages and codes', async (t) => {
  const replies = [];
  let refuse = false;
  const { node, ctx, w, dispatches, signs } = await setup(t, {
    policy: () => { if (refuse) { const e = new Error('policy saw ' + SENTINEL); e.code = 4001; e.data = SENTINEL; throw e; } },
    extra: { timeoutMs: 50 },
  });
  const secretMessage = hexOf('secret ' + SENTINEL);
  const secretTyped = typed({ message: { id: 1, tags: [SENTINEL], blob: '0x', inner: { flag: false, amount: '1' } } });
  const request = async (method, params) => { const reply = await ctx.request(method, params); replies.push(reply); return reply; };
  // Policy throwing with an embedded sentinel: fixed message, fixed code, no data.
  refuse = true;
  const refused = await request('personal_sign', [secretMessage, account]);
  assert.deepEqual(refused, { error: { code: CODES.INTERNAL, message: 'signature refused by policy' } });
  refuse = false;
  // Upstream error echoing the payload: numeric code kept, message/data dropped, failed (no signature generated).
  node.errorOn.eth_signTypedData_v4 = { code: -32602, message: 'type mismatch: got ' + SENTINEL, data: { echoed: SENTINEL } };
  const echoed = await request('eth_signTypedData_v4', [account, secretTyped]);
  assert.deepEqual(echoed, { error: { code: -32602, message: 'node refused the signing request' } });
  assert.equal(signs().at(-1).outcome, 'failed');
  delete node.errorOn.eth_signTypedData_v4;
  // Invalid input whose type name carries the sentinel: the validation message never echoes it.
  const named = typed({ types: { ...typed().types, [SENTINEL + 'x'.repeat(LIMITS.typedDataNameChars)]: [] } });
  assert.equal(code(await request('eth_signTypedData_v4', [account, named])), CODES.INVALID_PARAMS);
  // Timeout after dispatch: unknown, fixed -32603, exactly one attempt.
  node.hangOn = 'personal_sign';
  const before = node.sent('personal_sign');
  const timedOut = await request('personal_sign', [secretMessage, account]);
  assert.deepEqual(timedOut, { error: { code: CODES.INTERNAL, message: 'signing outcome unknown: no usable node response' } });
  assert.equal(signs().at(-1).outcome, 'unknown');
  assert.equal(node.sent('personal_sign'), before + 1, 'no automatic retry');
  node.hangOn = null;
  // Malformed result (not 65 bytes of hex), even one echoing the payload: unknown, nothing delivered.
  for (const result of [SENTINEL, '0x' + 'ab'.repeat(64), null, { signature: STUB_SIGNATURE }]) {
    node.results.personal_sign = result;
    const malformed = await request('personal_sign', [secretMessage, account]);
    assert.deepEqual(malformed, { error: { code: CODES.INTERNAL, message: 'signing outcome unknown: node returned no well-formed signature' } });
    const rec = signs().at(-1);
    assert.deepEqual([rec.outcome, rec.signatureReturned, rec.delivered], ['unknown', false, false]);
  }
  // Preflight failures on a signing path are also fixed text.
  node.client = 'other/' + SENTINEL;
  const preflight = await request('personal_sign', [secretMessage, account]);
  assert.deepEqual(preflight, { error: { code: CODES.CHAIN_DISCONNECTED, message: 'selected chain changed or unavailable' } });
  node.client = 'anvil/v1.8.3';
  node.results.personal_sign = STUB_SIGNATURE;
  assert.deepEqual(await ctx.request('personal_sign', [secretMessage, account]), { result: STUB_SIGNATURE });
  assertRedacted(w, replies, [SENTINEL, secretMessage.slice(2), STUB_SIGNATURE.slice(2)]);
  assert.ok(signs().every((c) => !['message', 'typedData', 'signature', 'params'].some((k) => k in c)));
  assert.equal(dispatches(), 1 + 1 + 4 + 1, 'every dispatch counted once');
  // Transaction and read error data are unchanged by signing redaction.
  node.errorOn.eth_call = { code: 3, message: 'execution reverted', data: '0x08c379a0' };
  assert.deepEqual((await ctx.request('eth_call', [{ to: target }, 'latest'])).error, { code: 3, message: 'execution reverted', data: '0x08c379a0' });
});
