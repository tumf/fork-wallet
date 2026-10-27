'use strict';
// Runnable self-check for lib.js: guards the acceptance logic against false positives (UI success without receipts,
// failed receipts, missing events, wrong market, unlimited approvals, missing/blocked steps, unverified cleanup) and false
// negatives (a genuine pass must pass), and runs a real local redirect-denial control in headless Chromium through the
// same egress route handler the harness uses (owned ephemeral loopback servers only; missing Chromium is FAIL).
// Usage: npm run test:aave:logic   (node examples/aave/selfcheck.js; exit 0 = all checks hold)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const L = require('./lib.js');

const AAVE_DIR = process.env.AAVE_DIR || '/tmp/fork-wallet-aave-interface-20261027';
const ADDR = {
  POOL: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', WETH_GATEWAY: '0xa0d9C1E9E48Ca30c8d8C3B5D69FF5dc1f6DFfC24',
  WETH: '0x4200000000000000000000000000000000000006', A_WETH: '0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7',
};
const ACCOUNT = '0x64175eab28b00b5b3fa21ea8095bc2b221e31af4';
const OTHER = '0x1111111111111111111111111111111111111111';
const SUPPLY = (5n * L.WEI / 10n).toString(); // 0.5 ETH
const WITHDRAW = (L.WEI / 10n).toString(); // 0.1 ETH
const checks = [];
const check = (name, fn) => checks.push({ name, fn }); // run sequentially at the end; fn may be async
const throws = (fn, re) => assert.throws(fn, (e) => re.test(e.message));

// 1. Constants: selectors/topics must equal keccak256 of the canonical signatures (ethers from the Aave checkout).
check('selectors and topics match keccak256', () => {
  const { utils } = require(path.join(AAVE_DIR, 'node_modules', 'ethers'));
  for (const [k, sig] of Object.entries(L.SIGNATURES)) assert.equal(L.SELECTORS[k], utils.id(sig).slice(0, 10), k);
  for (const [k, sig] of Object.entries(L.EVENT_SIGNATURES)) assert.equal(L.TOPICS[k], utils.id(sig), k);
});

// 2. Market text: letter-spaced "Base Fork" passes, "Core" (Ethereum) and "Base" (non-fork) fail.
check('market text verification', () => {
  assert.equal(L.verifyMarketText('B a s e F o r k B a s e F o r k B a s e F o r k V3').ok, true);
  assert.equal(L.verifyMarketText("C o r e C o r e C o r e V3 Supply and borrow the widest range of assets in Aave's deepest market.").ok, false);
  assert.equal(L.verifyMarketText('B a s e B a s e B a s e V3').ok, false);
  assert.equal(L.verifyMarketText('').ok, false);
  assert.match('0x64...1af4', L.shortAddressRegex(ACCOUNT));
  assert.doesNotMatch('0x64...0000', L.shortAddressRegex(ACCOUNT));
});

// 3. Policy. Default whitelist = supply + the pool-weth withdraw route (byte-exact Pool.withdraw(WETH, 0.1 ETH, account)).
// The gateway-native route (capped approve + withdrawETH) is only accepted when whitelisted explicitly; unlimited approvals never.
const policy = L.makePolicy({ account: ACCOUNT, addresses: ADDR, supplyWei: SUPPLY, withdrawWei: WITHDRAW });
const policyNative = L.makePolicy({ account: ACCOUNT, addresses: ADDR, supplyWei: SUPPLY, withdrawWei: WITHDRAW, withdrawRoutes: ['gateway-native'] });
const deposit = (pool = ADDR.POOL, onBehalf = ACCOUNT, value = SUPPLY) => ({ to: ADDR.WETH_GATEWAY, value: '0x' + BigInt(value).toString(16), data: L.encodeCall(L.SELECTORS.depositETH, L.encodeAddress(pool), L.encodeAddress(onBehalf), L.encodeUint(0)) });
const withdrawETH = (amount = WITHDRAW, to = ACCOUNT, pool = ADDR.POOL) => ({ to: ADDR.WETH_GATEWAY, value: '0x0', data: L.encodeCall(L.SELECTORS.withdrawETH, L.encodeAddress(pool), L.encodeUint(amount), L.encodeAddress(to)) });
const approve = (spender = ADDR.WETH_GATEWAY, amount = WITHDRAW) => ({ to: ADDR.A_WETH, value: '0x0', data: L.encodeCall(L.SELECTORS.approve, L.encodeAddress(spender), L.encodeUint(amount)) });
const poolWithdraw = (amount = WITHDRAW, to = ACCOUNT, asset = ADDR.WETH) => ({ to: ADDR.POOL, value: '0x0', from: ACCOUNT, data: L.encodeCall(L.SELECTORS.withdraw, L.encodeAddress(asset), L.encodeUint(amount), L.encodeAddress(to)) });
check('policy (pool-weth): accepts exact supply and byte-exact Pool.withdraw only', () => {
  assert.deepEqual(policy(deposit()), { op: 'supply', amountWei: SUPPLY });
  assert.deepEqual(policy(poolWithdraw()), { op: 'withdraw', amountWei: WITHDRAW, route: 'pool-weth' });
  const expected = L.expectedPoolWithdrawCall({ account: ACCOUNT, addresses: ADDR, withdrawWei: WITHDRAW });
  assert.equal(expected.data.toLowerCase(), poolWithdraw().data.toLowerCase());
  assert.equal(expected.to, ADDR.POOL); assert.equal(expected.value, 0n);
  assert.equal(expected.data.length, 2 + 8 + 3 * 64);
});
check('policy (pool-weth): refuses every deviation of the Pool.withdraw calldata', () => {
  throws(() => policy(poolWithdraw((L.WEI / 20n).toString())), /exactly/); // below the cap but not the fixed amount
  throws(() => policy(poolWithdraw((2n * L.WEI / 10n).toString())), /exactly/);
  throws(() => policy(poolWithdraw(WITHDRAW, OTHER)), /recipient/);
  throws(() => policy(poolWithdraw(WITHDRAW, ACCOUNT, ADDR.A_WETH)), /asset/);
  throws(() => policy({ ...poolWithdraw(), value: '0x1' }), /value/);
  throws(() => policy({ ...poolWithdraw(), from: OTHER }), /from/);
  throws(() => policy({ ...poolWithdraw(), data: poolWithdraw().data + '00'.repeat(32) }), /arity/);
  const dirty = poolWithdraw(); dirty.data = dirty.data.slice(0, 10) + 'ff'.repeat(12) + dirty.data.slice(10 + 24); // dirty high bytes in the asset word
  throws(() => policy(dirty), /byte-exact/);
  throws(() => policy({ to: ADDR.POOL, value: '0x0', data: '0x617ba037' + '00'.repeat(128) }), /selector .* not allowed on Pool/); // supply(address,uint256,address,uint16)
  throws(() => policy({ to: ADDR.POOL, value: '0x0', data: '0x69328decabc' }), /malformed/);
});
check('policy (pool-weth): the gateway-native route is refused even when capped, and unlimited approvals name the cap', () => {
  throws(() => policy(withdrawETH()), /route gateway-native, which is not whitelisted \(pool-weth\)/);
  throws(() => policy(approve()), /route gateway-native, which is not whitelisted/);
  throws(() => policy(approve(ADDR.WETH_GATEWAY, L.MAX_UINT256.toString())), /MaxUint256 \(unlimited\) exceeds cap/);
  throws(() => policy({ to: OTHER, value: '0x0', data: '0x' }), /destination/);
  throws(() => L.makePolicy({ account: ACCOUNT, addresses: ADDR, supplyWei: SUPPLY, withdrawWei: WITHDRAW, withdrawRoutes: ['anything'] }), /unknown withdraw route/);
});
check('policy (gateway-native, explicit): capped approve + withdrawETH accepted, Pool.withdraw refused, deviations refused', () => {
  assert.deepEqual(policyNative(deposit()), { op: 'supply', amountWei: SUPPLY });
  assert.deepEqual(policyNative(withdrawETH()), { op: 'withdrawETH', amountWei: WITHDRAW, route: 'gateway-native' });
  assert.deepEqual(policyNative(withdrawETH((L.WEI / 20n).toString())), { op: 'withdrawETH', amountWei: (L.WEI / 20n).toString(), route: 'gateway-native' });
  assert.deepEqual(policyNative(approve()), { op: 'approve', amountWei: WITHDRAW, route: 'gateway-native' });
  throws(() => policyNative(poolWithdraw()), /route pool-weth, which is not whitelisted \(gateway-native\)/);
  throws(() => policyNative(deposit(ADDR.POOL, ACCOUNT, (6n * L.WEI / 10n).toString())), /exactly/);
  throws(() => policyNative(deposit(OTHER)), /pool/);
  throws(() => policyNative(deposit(ADDR.POOL, OTHER)), /onBehalfOf/);
  throws(() => policyNative(withdrawETH((2n * L.WEI / 10n).toString())), /amount/);
  throws(() => policyNative(withdrawETH(WITHDRAW, OTHER)), /recipient/);
  throws(() => policyNative({ ...withdrawETH(), value: '0x1' }), /value/);
  throws(() => policyNative(approve(ADDR.WETH_GATEWAY, L.MAX_UINT256.toString())), /MaxUint256 \(unlimited\) exceeds cap/);
  throws(() => policyNative(approve(ADDR.WETH_GATEWAY, (BigInt(WITHDRAW) + 1n).toString())), /exceeds cap/);
  throws(() => policyNative(approve(OTHER)), /spender/);
  throws(() => policyNative({ to: ADDR.WETH_GATEWAY, value: '0x0', data: '0x12345678' }), /selector/);
  throws(() => policyNative({ to: ADDR.A_WETH, value: '0x0', data: L.SELECTORS.balanceOf + L.encodeAddress(ACCOUNT).slice(2) }), /selector/);
  throws(() => policyNative({ ...deposit(), from: OTHER }), /from/);
  throws(() => policyNative({ to: ADDR.WETH_GATEWAY, value: '0x0', data: '0x80500d20abc' }), /malformed/);
});

// 3b. WebSocket rule: only ws://<app host:port>/_next/webpack-hmr of the owned app origin; everything else denied.
check('websocket rule: exact Next HMR socket of the owned origin only', () => {
  const app = 'http://127.0.0.1:64758';
  assert.equal(L.hmrSocketAllowed('ws://127.0.0.1:64758/_next/webpack-hmr', app), true);
  assert.equal(L.hmrSocketAllowed('ws://127.0.0.1:64759/_next/webpack-hmr', app), false); // other port
  assert.equal(L.hmrSocketAllowed('ws://localhost:64758/_next/webpack-hmr', app), false); // other host spelling
  assert.equal(L.hmrSocketAllowed('wss://127.0.0.1:64758/_next/webpack-hmr', app), false); // other scheme
  assert.equal(L.hmrSocketAllowed('ws://127.0.0.1:64758/_next/webpack-hmr?x=1', app), false); // query
  assert.equal(L.hmrSocketAllowed('ws://127.0.0.1:64758/_next/webpack-hmr/', app), false); // other path
  assert.equal(L.hmrSocketAllowed('ws://127.0.0.1:64758/ws', app), false);
  assert.equal(L.hmrSocketAllowed('wss://relay.walletconnect.com/?projectId=x', app), false);
  assert.equal(L.hmrSocketAllowed('ws://user:pw@127.0.0.1:64758/_next/webpack-hmr', app), false);
  assert.equal(L.hmrSocketAllowed('not a url', app), false);
  assert.equal(L.hmrSocketAllowed('ws://127.0.0.1:64758/_next/webpack-hmr', 'https://127.0.0.1:64758'), false);
});

// 3c. The routes above are what the UNCHANGED app actually does (read from the checkout, never modified here).
check('upstream sources: unwrap ON = gateway withdrawETH with MaxUint256 approve; unwrap OFF = Pool.withdraw without approval', () => {
  const read = (...p) => fs.readFileSync(path.join(AAVE_DIR, ...p), 'utf8');
  const modal = read('src', 'components', 'transactions', 'Withdraw', 'WithdrawModal.tsx');
  assert.match(modal, /useState\(true\)/); // withdrawUnWrapped defaults to true (native ETH)
  assert.match(modal, /WithdrawModalContent/); assert.doesNotMatch(modal, /WithdrawAndUnwrapAction/); // the token-wrapper component is not on this path
  const content = read('src', 'components', 'transactions', 'Withdraw', 'WithdrawModalContent.tsx');
  assert.match(content, /withdrawUnWrapped && poolReserve\.isWrappedBaseAsset\s*\?\s*API_ETH_MOCK_ADDRESS\s*:\s*poolReserve\.underlyingAsset/);
  assert.match(content, /data-cy=\{'wrappedSwitcher'\}|DetailsUnwrapSwitch/);
  const actions = read('src', 'components', 'transactions', 'Withdraw', 'WithdrawActions.tsx');
  assert.match(actions, /tryPermit: false/); // approval (if any) goes by transaction, never permit
  const pool = read('node_modules', '@aave', 'contract-helpers', 'dist', 'cjs', 'v3-pool-contract', 'index.js');
  assert.match(pool, /API_ETH_MOCK_ADDRESS[\s\S]{0,400}wethGatewayService\.withdrawETH/);
  assert.match(pool, /poolContract\.populateTransaction\.withdraw\(reserve, convertedAmount/);
  const gateway = read('node_modules', '@aave', 'contract-helpers', 'dist', 'cjs', 'v3-wethgateway-contract', 'index.js');
  assert.match(gateway, /async withdrawETH\([\s\S]{0,900}amount: ethers_1\.constants\.MaxUint256\.toString\(\)/);
  const utils = read('src', 'utils', 'utils.ts');
  assert.match(utils, /optimizedPath = \(currentChainId: ChainId\) => \{\s*return \(\s*currentChainId === ChainId\.arbitrum_one \|\| currentChainId === ChainId\.optimism/);
  const ws = read('node_modules', 'next', 'dist', 'client', 'dev', 'hot-reloader', 'pages', 'websocket.js');
  assert.match(ws, /reconnections > 25[\s\S]{0,120}window\.location\.reload\(\)/);
  assert.match(read('node_modules', 'next', 'dist', 'client', 'page-bootstrap.js'), /path: '\/_next\/webpack-hmr'/);
});

// 4. Supply assertions: genuine pass passes; each false-positive vector fails.
const topic = (addr) => L.encodeAddress(addr);
const supplyLog = (amount = SUPPLY, onBehalf = ACCOUNT, reserve = ADDR.WETH) => ({ address: ADDR.POOL, topics: [L.TOPICS.Supply, topic(reserve), topic(onBehalf), L.encodeUint(0)], data: L.encodeAddress(ADDR.WETH_GATEWAY) + L.encodeUint(amount).slice(2) });
const H1 = '0x' + 'a1'.repeat(32);
const good = () => ({ submitted: [H1], receipts: [{ hash: H1, receipt: { status: '0x1', to: ADDR.WETH_GATEWAY, logs: [supplyLog()] } }], balanceBeforeWei: '0x0', balanceAfterWei: '0x' + BigInt(SUPPLY).toString(16), account: ACCOUNT, addresses: ADDR, supplyWei: SUPPLY });
check('supply: genuine pass passes', () => { const r = L.assertSupply(good()); assert.equal(r.pass, true, JSON.stringify(r.reasons)); });
check('supply: 1 wei aToken rounding still passes (observed on fork)', () => { const r = L.assertSupply({ ...good(), balanceAfterWei: '0x' + (BigInt(SUPPLY) - 1n).toString(16) }); assert.equal(r.pass, true, JSON.stringify(r.reasons)); });
check('supply: 2 wei short fails', () => { assert.equal(L.assertSupply({ ...good(), balanceAfterWei: '0x' + (BigInt(SUPPLY) - 2n).toString(16) }).pass, false); });
check('supply: UI success without receipts fails', () => { assert.equal(L.assertSupply({ ...good(), submitted: [], receipts: [] }).pass, false); });
check('supply: reverted receipt fails', () => { const g = good(); g.receipts[0].receipt.status = '0x0'; assert.equal(L.assertSupply(g).pass, false); });
check('supply: missing receipt fails', () => { const g = good(); g.receipts[0].receipt = null; assert.equal(L.assertSupply(g).pass, false); });
check('supply: missing Supply event fails', () => { const g = good(); g.receipts[0].receipt.logs = []; assert.equal(L.assertSupply(g).pass, false); });
check('supply: Supply event for another user fails', () => { const g = good(); g.receipts[0].receipt.logs = [supplyLog(SUPPLY, OTHER)]; assert.equal(L.assertSupply(g).pass, false); });
check('supply: wrong amount in event fails', () => { const g = good(); g.receipts[0].receipt.logs = [supplyLog(WITHDRAW)]; assert.equal(L.assertSupply(g).pass, false); });
check('supply: no aWETH balance increase fails', () => { assert.equal(L.assertSupply({ ...good(), balanceAfterWei: '0x1' }).pass, false); });
check('supply: receipt to another contract fails', () => { const g = good(); g.receipts[0].receipt.to = ADDR.POOL; assert.equal(L.assertSupply(g).pass, false); });

// 5. Withdraw gate + assertions.
check('withdraw is blocked unless supply passed', () => {
  assert.equal(L.withdrawGate({ pass: false }).allowed, false);
  assert.equal(L.withdrawGate(undefined).status, 'blocked');
  assert.equal(L.withdrawGate({ pass: true }).allowed, true);
});
const withdrawLog = (amount = WITHDRAW, party = ACCOUNT, reserve = ADDR.WETH) => ({ address: ADDR.POOL, topics: [L.TOPICS.Withdraw, topic(reserve), topic(party), topic(party)], data: L.encodeUint(amount) });
const wethTransfer = (amount = WITHDRAW, from = ADDR.A_WETH, to = ACCOUNT) => ({ address: ADDR.WETH, topics: [L.TOPICS.Transfer, topic(from), topic(to)], data: L.encodeUint(amount) });
const H2 = '0x' + 'b2'.repeat(32); const H3 = '0x' + 'c3'.repeat(32);
const before = BigInt(SUPPLY); const after = before - BigInt(WITHDRAW) + 10n ** 9n; // a little interest accrued
const hex = (n) => '0x' + BigInt(n).toString(16);
// pool-weth route (the one the harness whitelists): one Pool.withdraw receipt, Withdraw log user/to = account, WETH Transfer aWETH -> account, WETH balance +0.1.
const goodP = () => ({ submitted: [H3], receipts: [{ hash: H3, receipt: { status: '0x1', to: ADDR.POOL, logs: [withdrawLog(), wethTransfer()] } }], balanceBeforeWei: hex(before), balanceAfterWei: hex(after), wethBeforeWei: '0x0', wethAfterWei: hex(WITHDRAW), account: ACCOUNT, addresses: ADDR, withdrawWei: WITHDRAW });
check('withdraw (pool-weth): genuine pass passes', () => { const r = L.assertWithdraw(goodP()); assert.equal(r.pass, true, JSON.stringify(r.reasons)); assert.equal(r.wethGainWei, WITHDRAW); assert.equal(r.route, 'pool-weth'); });
check('withdraw (pool-weth): UI success without receipts fails', () => { assert.equal(L.assertWithdraw({ ...goodP(), submitted: [], receipts: [] }).pass, false); });
check('withdraw (pool-weth): reverted receipt fails', () => { const g = goodP(); g.receipts[0].receipt.status = '0x0'; assert.equal(L.assertWithdraw(g).pass, false); });
check('withdraw (pool-weth): receipt to the gateway instead of the Pool fails', () => { const g = goodP(); g.receipts[0].receipt.to = ADDR.WETH_GATEWAY; assert.equal(L.assertWithdraw(g).pass, false); });
check('withdraw (pool-weth): missing Withdraw event fails', () => { const g = goodP(); g.receipts[0].receipt.logs = [wethTransfer()]; assert.equal(L.assertWithdraw(g).pass, false); });
check('withdraw (pool-weth): Withdraw event with gateway as user/to fails', () => { const g = goodP(); g.receipts[0].receipt.logs = [withdrawLog(WITHDRAW, ADDR.WETH_GATEWAY), wethTransfer()]; assert.equal(L.assertWithdraw(g).pass, false); });
check('withdraw (pool-weth): wrong amount in Withdraw event fails', () => { const g = goodP(); g.receipts[0].receipt.logs = [withdrawLog((L.WEI / 20n).toString()), wethTransfer()]; assert.equal(L.assertWithdraw(g).pass, false); });
check('withdraw (pool-weth): missing WETH Transfer to the account fails', () => { const g = goodP(); g.receipts[0].receipt.logs = [withdrawLog(), wethTransfer(WITHDRAW, ADDR.A_WETH, OTHER)]; assert.equal(L.assertWithdraw(g).pass, false); });
check('withdraw (pool-weth): aWETH balance unchanged fails', () => { assert.equal(L.assertWithdraw({ ...goodP(), balanceAfterWei: hex(before) }).pass, false); });
check('withdraw (pool-weth): WETH balance not increased exactly fails', () => {
  assert.equal(L.assertWithdraw({ ...goodP(), wethAfterWei: '0x0' }).pass, false);
  assert.equal(L.assertWithdraw({ ...goodP(), wethAfterWei: hex(BigInt(WITHDRAW) - 1n) }).pass, false);
  assert.equal(L.assertWithdraw({ ...goodP(), wethBeforeWei: undefined, wethAfterWei: undefined }).pass, false);
});
check('withdraw (pool-weth): an extra (approval) transaction fails', () => { const g = goodP(); g.submitted = [H2, H3]; g.receipts.unshift({ hash: H2, receipt: { status: '0x1', to: ADDR.A_WETH, logs: [] } }); assert.equal(L.assertWithdraw(g).pass, false); });
check('withdraw (pool-weth): native-route evidence does not pass the pool-weth assertion', () => { assert.equal(L.assertWithdraw({ ...goodP(), submitted: [H2, H3], receipts: goodW().receipts }).pass, false); });
check('withdraw: unknown route throws', () => { throws(() => L.assertWithdraw({ ...goodP(), route: 'x' }), /unknown route/); });
// gateway-native route shape (documentation/negative only; never whitelisted by the harness).
function goodW() { return { submitted: [H2, H3], receipts: [{ hash: H2, receipt: { status: '0x1', to: ADDR.A_WETH, logs: [] } }, { hash: H3, receipt: { status: '0x1', to: ADDR.WETH_GATEWAY, logs: [withdrawLog(WITHDRAW, ADDR.WETH_GATEWAY)] } }], balanceBeforeWei: hex(before), balanceAfterWei: hex(after), account: ACCOUNT, addresses: ADDR, withdrawWei: WITHDRAW, route: 'gateway-native' }; }
check('withdraw (gateway-native): genuine pass passes (with approval receipt)', () => { const r = L.assertWithdraw(goodW()); assert.equal(r.pass, true, JSON.stringify(r.reasons)); });
check('withdraw (gateway-native): UI success without receipts fails', () => { assert.equal(L.assertWithdraw({ ...goodW(), submitted: [], receipts: [] }).pass, false); });
check('withdraw (gateway-native): reverted withdrawETH fails', () => { const g = goodW(); g.receipts[1].receipt.status = '0x0'; assert.equal(L.assertWithdraw(g).pass, false); });
check('withdraw (gateway-native): missing Withdraw event fails', () => { const g = goodW(); g.receipts[1].receipt.logs = []; assert.equal(L.assertWithdraw(g).pass, false); });
check('withdraw (gateway-native): balance unchanged fails', () => { assert.equal(L.assertWithdraw({ ...goodW(), balanceAfterWei: hex(before) }).pass, false); });
check('withdraw (gateway-native): approval only (no withdrawETH receipt) fails', () => { const g = goodW(); g.submitted = [H2]; g.receipts = [g.receipts[0]]; assert.equal(L.assertWithdraw(g).pass, false); });

// 5b. Navigation guard: anything after the baseline is unexpected.
check('unexpected navigations after baseline are reported', () => {
  const navs = [{ url: 'http://127.0.0.1:1/?marketName=x', at: 'a' }, { url: 'http://127.0.0.1:1/?marketName=x', at: 'b' }];
  assert.deepEqual(L.unexpectedNavigations(navs, 1), [{ url: 'http://127.0.0.1:1/?marketName=x', at: 'b' }]);
  assert.deepEqual(L.unexpectedNavigations(navs, 2), []);
  assert.deepEqual(L.unexpectedNavigations(undefined, 0), []);
});

// 6. RPC summary keeps method + target + selector only.
check('rpc summary records target and selector, never calldata', () => {
  const s = {};
  const key = L.summarizeRpcItem(s, { method: 'eth_call', params: [{ to: ADDR.POOL, data: L.SELECTORS.balanceOf + 'ff'.repeat(32) }, 'latest'] }, { error: { code: -32603, message: 'loopback RPC transport failure: The operation was aborted due to timeout' } }, 15010);
  assert.equal(key, `eth_call ${ADDR.POOL.toLowerCase()} ${L.SELECTORS.balanceOf}`);
  assert.equal(s[key].errors['-32603:transport-timeout'], 1);
  assert.equal(JSON.stringify(s).includes('ff'.repeat(32)), false);
  assert.equal(L.classifyRpcError({ code: 4200, message: 'unsupported method foo' }), 'policy-unsupported-method');
});

// 7. Positive-route hygiene and the native refusal check (refusal proven, capability never claimed).
check('positive routes need zero policy refusals and zero unsupported dispatches', () => {
  assert.equal(L.positiveRouteHygiene({ refusals: [], unsupported: [] }).pass, true);
  assert.equal(L.positiveRouteHygiene({ refusals: [{ reason: 'x' }], unsupported: [] }).pass, false);
  assert.equal(L.positiveRouteHygiene({ refusals: [], unsupported: [{ method: 'wallet_x' }] }).pass, false);
  assert.equal(L.positiveRouteHygiene({}).pass, false); // unknown counts fail closed
});
const maxRefusal = { to: ADDR.A_WETH, selector: L.SELECTORS.approve, reason: 'policy: approve amount MaxUint256 (unlimited) exceeds cap 100000000000000000 wei (route gateway-native)' };
const nativeGood = () => ({ submitted: [], refusals: [maxRefusal], unsupported: [], aWethBeforeWei: '400', aWethAfterWei: '400', addresses: ADDR });
check('native refusal: exactly one MaxUint256 aWETH refusal, zero sends, unchanged balance passes', () => { const r = L.assertNativeRefusal(nativeGood()); assert.equal(r.pass, true, JSON.stringify(r.reasons)); });
check('native refusal: any deviation fails', () => {
  assert.equal(L.assertNativeRefusal({ ...nativeGood(), submitted: [H1] }).pass, false);
  assert.equal(L.assertNativeRefusal({ ...nativeGood(), refusals: [] }).pass, false);
  assert.equal(L.assertNativeRefusal({ ...nativeGood(), refusals: [maxRefusal, maxRefusal] }).pass, false);
  assert.equal(L.assertNativeRefusal({ ...nativeGood(), refusals: [{ ...maxRefusal, reason: 'policy: approve amount 200 exceeds cap 100 wei' }] }).pass, false);
  assert.equal(L.assertNativeRefusal({ ...nativeGood(), refusals: [{ ...maxRefusal, to: ADDR.WETH }] }).pass, false);
  assert.equal(L.assertNativeRefusal({ ...nativeGood(), unsupported: [{ method: 'x' }] }).pass, false);
  assert.equal(L.assertNativeRefusal({ ...nativeGood(), aWethAfterWei: '399' }).pass, false);
  assert.equal(L.assertNativeRefusal({ ...nativeGood(), aWethAfterWei: undefined }).pass, false);
});

// 8. Diagnostics are classified separately and never as acceptance failures.
check('diagnostic status: passed / diagnostic-timeout / diagnostic-failed with classes kept', () => {
  assert.equal(L.diagnosticStatus({ ok: true, elapsedMs: 80 }), 'passed');
  assert.equal(L.diagnosticStatus({ ok: false, elapsedMs: 20001, errorClass: 'transport-timeout' }), 'diagnostic-timeout');
  assert.equal(L.diagnosticStatus({ ok: false, errorClass: 'upstream-archive' }), 'diagnostic-failed');
  assert.equal(L.diagnosticStatus([{ ok: true }, { ok: false, errorClass: 'transport-timeout' }]), 'diagnostic-timeout');
  assert.equal(L.diagnosticStatus([{ ok: true }, { ok: true }]), 'passed');
  assert.equal(L.diagnosticStatus([]), 'diagnostic-failed');
  assert.equal(L.diagnosticStatus(undefined), 'diagnostic-failed');
  assert.equal(L.classifyRpcError(new Error('The operation was aborted due to timeout')), 'transport-timeout');
});

// 9. Cleanup verdict: everything launched must be verifiably gone; missing evidence fails.
const allLaunched = { aave: true, tmpHome: true, anvil: true, gateway: true, next: true, browser: true };
const cleanClose = () => ({ browser: 'closed', next: 'terminated', appListenerAfter: [], appPidsAlive: [], gateway: 'closed', gatewayListenerAfter: [], anvil: 'terminated', anvilListenerAfter: [], tmpHome: 'removed', aaveTrackedCleanAfter: true });
check('cleanup verdict: verified clean passes; each leftover or missing record fails', () => {
  assert.equal(L.cleanupVerdict(cleanClose(), allLaunched).ok, true);
  assert.equal(L.cleanupVerdict({}, {}).ok, true); // nothing launched, nothing to clean
  for (const [k, v] of [['browser', 'Target closed'], ['next', 'did-not-exit'], ['appListenerAfter', [4242]], ['appPidsAlive', [4242]], ['gateway', 'EBUSY'],
    ['gatewayListenerAfter', [1]], ['anvil', 'did-not-exit'], ['anvilListenerAfter', [77]], ['tmpHome', 'left'], ['aaveTrackedCleanAfter', [' M src/x.ts']]]) {
    assert.equal(L.cleanupVerdict({ ...cleanClose(), [k]: v }, allLaunched).ok, false, k);
    const missing = cleanClose(); delete missing[k];
    assert.equal(L.cleanupVerdict(missing, allLaunched).ok, false, `missing ${k}`);
  }
});

// 10. Aggregate outcome matrix: exit 0 / 4 / 2 / 3 and the fail-closed cases.
const st = (name, status) => ({ name, status });
const passedRuntime = () => [st('aave.pin', 'passed'), st('anvil.fork.start', 'passed'), st('ui.supply.ETH.outcome', 'observed'), st('ui.supply.ETH', 'passed'), st('ui.withdraw.WETH', 'passed'), st('ui.withdraw.ETH.native-refusal', 'passed'), st('ui.modal.close', 'passed')];
const healthyDiag = [st('diag.gateway.cold', 'passed')];
const okCleanup = { ok: true, reasons: [] };
const classify = (steps, extra = {}) => L.classifyAcceptance({ steps, cleanup: okCleanup, fatal: null, ...extra });
check('outcome: all runtime checks + healthy diagnostics + cleanup = exit 0 PASS', () => {
  const a = classify([...healthyDiag, ...passedRuntime()]);
  assert.equal(a.exitCode, 0); assert.equal(a.overall, 'PASS'); assert.equal(a.diagnosticsDegraded, false);
  assert.deepEqual([a.supply, a.withdrawWETH, a.nativeRouteRefusal, a.nativeRouteCapability, a.cleanup], ['passed', 'passed', 'passed', 'blocked', 'passed']);
});
check('outcome: cold diagnostic timeout then warm success = exit 4 DEGRADED, never PASS', () => {
  const steps = [st('diag.gateway.cold', 'diagnostic-timeout'), st('diag.direct.60s', 'diagnostic-timeout'), st('diag.gateway.afterWarm', 'passed'), st('diag.warm.others', 'passed'), ...passedRuntime()];
  const a = classify(steps);
  assert.equal(a.exitCode, 4); assert.equal(a.overall, 'DEGRADED'); assert.equal(a.diagnosticsDegraded, true);
  assert.equal(classify([st('diag.warm.others', 'diagnostic-failed'), ...passedRuntime()]).exitCode, 4);
  assert.equal(classify(passedRuntime()).exitCode, 4); // no diagnostic recorded is degraded, not healthy
});
check('outcome: any runtime check failed, blocked, missing or duplicated = exit 2 even with diagnostics degraded', () => {
  for (const name of Object.values(L.RUNTIME_CHECKS)) {
    for (const status of ['failed', 'blocked', 'observed', 'skipped']) {
      const steps = passedRuntime().map((s) => (s.name === name ? st(name, status) : s));
      for (const diag of [healthyDiag, [st('diag.gateway.cold', 'diagnostic-timeout')]]) {
        const a = classify([...diag, ...steps]);
        assert.equal(a.exitCode, 2, `${name} ${status}`); assert.equal(a.overall, 'FAILED');
      }
    }
    const missing = classify([...healthyDiag, ...passedRuntime().filter((s) => s.name !== name)]);
    assert.equal(missing.exitCode, 2, `${name} missing`);
    assert.equal(Object.entries(L.RUNTIME_CHECKS).some(([k, n]) => n === name && missing[k] === 'blocked'), true);
    assert.equal(classify([...healthyDiag, ...passedRuntime(), st(name, 'passed')]).exitCode, 2, `${name} duplicated`);
  }
  // native refusal not attempted due to budget fails acceptance (never silent success)
  const budget = passedRuntime().map((s) => (s.name === 'ui.withdraw.ETH.native-refusal' ? { ...s, status: 'blocked', detail: { reason: 'budget exhausted; refusal check not attempted' } } : s));
  assert.equal(classify([...healthyDiag, ...budget]).exitCode, 2);
});
check('outcome: cleanup failure or leftover listener = exit 2 even when every runtime check passed', () => {
  const steps = [...healthyDiag, ...passedRuntime()];
  const leftover = L.cleanupVerdict({ ...cleanClose(), anvilListenerAfter: [77] }, allLaunched);
  assert.equal(L.classifyAcceptance({ steps, cleanup: leftover }).exitCode, 2);
  assert.equal(L.classifyAcceptance({ steps, cleanup: undefined }).exitCode, 2);
  assert.equal(L.classifyAcceptance({ steps: [st('diag.gateway.cold', 'diagnostic-timeout'), ...passedRuntime()], cleanup: { ok: false, reasons: ['x'] } }).exitCode, 2);
});
check('outcome: prerequisite fatal = exit 3; acceptance-stage fatal, other failures and sentinel hits = exit 2', () => {
  const pre = classify([st('aave.pin', 'failed')], { fatal: { stage: 'prerequisite', step: 'aave.pin' } });
  assert.equal(pre.exitCode, 3); assert.equal(pre.overall, 'BLOCKED'); assert.equal(pre.supply, 'blocked');
  assert.equal(classify([], { fatal: { stage: 'prerequisite' }, cleanup: { ok: false, reasons: ['anvil did-not-exit'] } }).exitCode, 2);
  assert.equal(classify([...healthyDiag, ...passedRuntime()], { fatal: { stage: 'acceptance', step: 'ui.load' } }).exitCode, 2);
  assert.equal(classify([...healthyDiag, ...passedRuntime()], { fatal: { stage: 'prerequisite' } }).exitCode, 3);
  assert.equal(classify([...healthyDiag, ...passedRuntime(), st('ui.modal.close', 'failed')]).exitCode, 2);
  assert.equal(classify([...healthyDiag, ...passedRuntime()], { sentinelHits: 1 }).exitCode, 2);
  assert.equal(classify([]).exitCode, 2); // nothing ran and no fatal recorded: never 0/4
  assert.deepEqual(L.EXIT, { PASS: 0, FAILED: 2, BLOCKED: 3, DEGRADED: 4 });
});

// 11. Pin, runner metadata and redaction sentinels.
check('pin: only the pinned commit with no tracked modification passes', () => {
  assert.equal(L.PINNED_AAVE_COMMIT, '20fdc895a9e3925960b5cd111fe09535cf224085');
  assert.equal(L.checkAavePin({ head: L.PINNED_AAVE_COMMIT, trackedStatus: '' }).ok, true);
  assert.equal(L.checkAavePin({ head: 'f'.repeat(40), trackedStatus: '' }).ok, false);
  assert.equal(L.checkAavePin({ head: L.PINNED_AAVE_COMMIT, trackedStatus: ' M src/utils/utils.ts' }).ok, false);
  assert.equal(L.checkAavePin({ head: L.PINNED_AAVE_COMMIT, trackedStatus: null }).ok, false);
  assert.equal(L.checkAavePin({ head: null, trackedStatus: '' }).ok, false);
});
check('runner metadata comes from SPIKE_RUNNER or is null; never a hardcoded model', () => {
  assert.deepEqual(L.runnerMetadata({}), { runner: null, runnerSource: 'unset' });
  assert.deepEqual(L.runnerMetadata({ SPIKE_RUNNER: ' conflux ' }), { runner: 'conflux', runnerSource: 'SPIKE_RUNNER' });
  assert.deepEqual(L.runnerMetadata({ SPIKE_RUNNER: 'x\n"y"' }), { runner: null, runnerSource: 'SPIKE_RUNNER-rejected' });
  assert.deepEqual(L.runnerMetadata({ SPIKE_RUNNER: 'a'.repeat(81) }), { runner: null, runnerSource: 'SPIKE_RUNNER-rejected' });
  const harness = fs.readFileSync(path.join(__dirname, 'harness.js'), 'utf8');
  assert.doesNotMatch(harness, /\bmodel\s*:/); // no fixed model attribution field
  assert.doesNotMatch(harness, /claude-|fable|opus|sonnet|haiku/i);
  assert.match(harness, /L\.runnerMetadata\(process\.env\)/);
});
check('redaction removes calldata-sized hex, keys and signatures; keeps addresses, selectors and short text', () => {
  const calldata = L.expectedPoolWithdrawCall({ account: ACCOUNT, addresses: ADDR, withdrawWei: WITHDRAW }).data;
  const approveCall = L.encodeCall(L.SELECTORS.approve, L.encodeAddress(ADDR.WETH_GATEWAY), L.encodeUint(L.MAX_UINT256)); // 68 bytes of calldata
  const key = '0x' + '4f'.repeat(32);
  const sig = '0x' + 'ab'.repeat(65);
  const text = `call ${calldata} approve ${approveCall} key ${key} bare ${'4f'.repeat(32)} sig ${sig} to ${ADDR.POOL} sel ${L.SELECTORS.withdraw}`;
  const out = L.redact(text);
  for (const secret of [calldata, approveCall, key, '4f'.repeat(32), sig]) assert.equal(out.includes(secret.replace(/^0x/, '')), false, secret.slice(0, 20));
  assert.equal(out.includes(ADDR.POOL), true); assert.equal(out.includes(L.SELECTORS.withdraw), true);
  // the old spike pattern missed 0x-prefixed calldata below 65 bytes (one argument word): prove the new one does not
  const oneWord = L.SELECTORS.balanceOf + L.encodeAddress(ACCOUNT).slice(2);
  assert.equal(/0x[0-9a-fA-F]{130,}/.test(oneWord), false);
  assert.equal(L.redact(`x ${oneWord} y`).includes(oneWord.slice(10)), false);
  assert.equal(L.redact('z'.repeat(5000)).length, 1500);
});
check('evidence sentinel: only allowed hashes survive serialization; anything else is counted and replaced', () => {
  const calldata = L.expectedPoolWithdrawCall({ account: ACCOUNT, addresses: ADDR, withdrawWei: WITHDRAW }).data;
  const json = JSON.stringify({ submitted: [H1], blockHash: H2, digest: 'c3'.repeat(32), leaked: calldata, sig: '0x' + 'ab'.repeat(65), to: ADDR.POOL });
  const r = L.scrubEvidenceText(json, [H1, H2.toUpperCase(), 'c3'.repeat(32)]);
  assert.equal(r.hits, 2);
  assert.equal(r.text.includes(H1), true); assert.equal(r.text.includes(H2), true); assert.equal(r.text.includes(ADDR.POOL), true);
  assert.equal(r.text.includes(calldata.slice(10)), false); assert.equal(r.text.includes('ab'.repeat(65)), false);
  assert.equal(L.scrubEvidenceText(json, []).hits, 5);
});

// 12. Redirect hops (pure) and the redirect-denial control in real headless Chromium through the SAME handler the
// harness installs. Owned ephemeral loopback servers only: an allowed "app" origin and "gateway" origin redirect to a
// disallowed destination listener (directly, and via an allowed intermediate hop), which must count zero requests;
// allowed same-origin hops (the unchanged Next dev server answers some requests with 308) still load. Two controls of
// the control prove the zero is not vacuous: Playwright's default route.fetch follows the redirect itself, and handing a
// fetched 3xx to the browser lets a navigation hop bypass the route handler (measured, Playwright 1.56 Chromium) — the
// reason the handler re-checks every hop instead. No public calls.
check('redirect hop: method/body semantics, relative Location, non-redirects', () => {
  const body = Buffer.from('{}');
  assert.deepEqual(L.redirectHop({ status: 308, location: '/a', url: 'http://127.0.0.1:1/x/', method: 'POST', postData: body }), { url: 'http://127.0.0.1:1/a', origin: 'http://127.0.0.1:1', method: 'POST', postData: body });
  assert.equal(L.redirectHop({ status: 307, location: 'http://evil.example/', url: 'http://127.0.0.1:1/', method: 'POST', postData: body }).origin, 'http://evil.example');
  assert.deepEqual(L.redirectHop({ status: 303, location: '/b', url: 'http://127.0.0.1:1/', method: 'POST', postData: body }).method, 'GET');
  assert.equal(L.redirectHop({ status: 302, location: '/b', url: 'http://127.0.0.1:1/', method: 'POST', postData: body }).postData, undefined);
  assert.equal(L.redirectHop({ status: 302, location: '/b', url: 'http://127.0.0.1:1/', method: 'GET' }).method, 'GET');
  assert.equal(L.redirectHop({ status: 200, location: '/b', url: 'http://127.0.0.1:1/', method: 'GET' }), null);
  assert.equal(L.redirectHop({ status: 304, location: '/b', url: 'http://127.0.0.1:1/', method: 'GET' }), null);
  assert.equal(L.redirectHop({ status: 302, location: undefined, url: 'http://127.0.0.1:1/', method: 'GET' }), null);
  assert.equal(L.redirectHop({ status: 302, location: 'http://[bad', url: 'http://127.0.0.1:1/', method: 'GET' }), null);
});
check('redirect control: escapes are never followed, allowed hops re-checked (0 destination requests)', async () => {
  const { chromium } = require('playwright');
  const servers = [];
  const listen = (handler) => new Promise((resolve, reject) => { const srv = http.createServer(handler); servers.push(srv); srv.on('error', reject); srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}`)); });
  let destinationRequests = 0;
  const destination = await listen((req, res) => { destinationRequests++; res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end('escaped'); });
  const appOrigin = await listen((req, res) => {
    const to = (status, location) => { res.writeHead(status, { location }); res.end(); };
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>app</title>'); }
    if (req.url === '/landed') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('landed'); }
    if (req.url === '/hop/') return to(308, '/landed'); // Next-style trailing-slash normalization: allowed, followed
    if (req.url === '/bounce') return to(308, '/out'); // allowed hop that then escapes
    if (req.url === '/out') return to(302, destination + '/via-hop');
    if (req.url === '/loop') return to(308, '/loop');
    return to(302, destination + '/from-app');
  });
  // CORS headers on the redirect so the browser WOULD follow it cross-origin if it were handed over.
  const gatewayOrigin = await listen((req, res) => { res.writeHead(307, { location: destination + '/from-gateway', 'access-control-allow-origin': '*' }); res.end(); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true }); // missing Chromium throws: FAIL, never skip
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const denied = []; const redirects = [];
    await context.route('**/*', L.makeEgressHandler({
      appOrigin, gatewayOrigin,
      onRedirect: ({ status, target, decision }) => redirects.push(`${status} ${target === destination ? 'dest' : target === appOrigin ? 'app' : target} ${decision}`),
      onDenied: ({ url, redirect }) => denied.push(redirect ? `${redirect.status}->${redirect.target === destination ? 'dest' : redirect.target === appOrigin ? 'app' : redirect.target}` : (new URL(url).origin === destination ? 'dest' : url)),
    }));
    const page = await context.newPage();
    const nav = await page.goto(appOrigin + '/redirect').then(() => 'loaded', (e) => e.message);
    assert.match(nav, /ERR_BLOCKED_BY_CLIENT/, `navigation redirect was not blocked: ${nav}`);
    const page2 = await context.newPage(); // the first page is left on Chromium's error document
    const hopNav = await page2.goto(appOrigin + '/hop/');
    assert.equal(await hopNav.text(), 'landed'); // allowed same-origin hop followed by the proxy
    await page2.goto(appOrigin + '/');
    const results = await page2.evaluate(async ([a, g, d]) => {
      const one = async (url, init) => { try { const r = await fetch(url, init); return `status ${r.status} ${await r.text()}`; } catch (e) { return `error ${e.name}`; } };
      return [await one(a + '/redirect'), await one(g + '/', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' }),
        await one(a + '/bounce'), await one(a + '/loop'), await one(a + '/hop/'), await one(d + '/direct')];
    }, [appOrigin, gatewayOrigin, destination]);
    assert.deepEqual(results, ['error TypeError', 'error TypeError', 'error TypeError', 'error TypeError', 'status 200 landed', 'error TypeError']);
    assert.equal(destinationRequests, 0, 'destination listener was reached');
    assert.deepEqual(denied, ['302->dest', '302->dest', '307->dest', '302->dest', '308->app', 'dest']);
    assert.deepEqual(redirects.filter((r) => !r.startsWith('308 app followed')), ['302 dest denied', '302 dest denied', '307 dest denied', '302 dest denied', '308 app denied']);
    assert.equal(redirects.filter((r) => r === '308 app followed').length, 2 + 1 + L.MAX_REDIRECT_HOPS); // /hop/ twice, /bounce once, /loop up to the limit
    await context.close();

    // Control 1: default route.fetch (no maxRedirects) follows the redirect itself and reaches the destination.
    const follow = await browser.newContext();
    await follow.route('**/*', async (route) => route.fulfill({ response: await route.fetch() }));
    const followPage = await follow.newPage();
    await followPage.goto(appOrigin + '/redirect').catch(() => {});
    assert.equal(destinationRequests, 1, 'control 1: default route.fetch did not reach the destination');
    await follow.close();
    // Control 2: maxRedirects: 0 but the 3xx handed to the browser; the navigation hop bypasses the route handler.
    const handOver = await browser.newContext();
    const handOverSeen = [];
    await handOver.route('**/*', async (route) => {
      handOverSeen.push(new URL(route.request().url()).origin);
      if (new URL(route.request().url()).origin !== appOrigin) return route.abort('blockedbyclient');
      return route.fulfill({ response: await route.fetch({ maxRedirects: 0 }) });
    });
    const handOverPage = await handOver.newPage();
    await handOverPage.goto(appOrigin + '/redirect').catch(() => {});
    assert.equal(destinationRequests, 2, 'control 2: handed-over navigation redirect did not reach the destination (re-check the handler rationale)');
    assert.equal(handOverSeen.includes(destination), false); // the hop never re-entered the route handler
    await handOver.close();

    const libSource = fs.readFileSync(path.join(__dirname, 'lib.js'), 'utf8');
    const fetchCalls = libSource.match(/route\.fetch\([^)]*\)/g) || [];
    assert.equal(fetchCalls.length, 2); assert.ok(fetchCalls.every((c) => /maxRedirects: 0/.test(c)), 'every proxy fetch must use maxRedirects: 0');
    assert.equal((libSource.match(/await fetchAllowed\(route, request\)/g) || []).length, 2, 'both proxy sites (gateway, app) must go through fetchAllowed');
    assert.match(fs.readFileSync(path.join(__dirname, 'harness.js'), 'utf8'), /context\.route\('\*\*\/\*', L\.makeEgressHandler\(/);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await Promise.all(servers.map((srv) => new Promise((r) => srv.close(() => r()))));
  }
});

(async () => {
  const results = [];
  for (const { name, fn } of checks) {
    try { await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); }
  }
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? ' :: ' + r.error : ''}`);
  console.log(`selfcheck: ${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length || results.length === 0 ? 1 : 0;
})();
