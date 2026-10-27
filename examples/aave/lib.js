'use strict';
// Helpers for the measured Aave acceptance example: ABI words, transaction policy, UI/market checks, the receipt-based
// pass/fail logic, the aggregate exit-status classification, redaction and the browser egress route handler. No direct
// I/O (the route handler only acts on the Playwright route it is given), no product code, no secrets. Covered by
// selfcheck.js.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const WEI = 10n ** 18n;

// Function selectors (keccak256 of the canonical signature, first 4 bytes) and event topics. selfcheck.js recomputes
// every one of them with ethers from the Aave checkout so a typo here cannot silently pass.
const SELECTORS = Object.freeze({
  depositETH: '0x474cf53d', // depositETH(address,address,uint16)
  withdrawETH: '0x80500d20', // withdrawETH(address,uint256,address)
  withdraw: '0x69328dec', // Pool.withdraw(address,uint256,address)
  approve: '0x095ea7b3', // approve(address,uint256)
  balanceOf: '0x70a08231', // balanceOf(address)
  getReservesData: '0xec489c21', // UiPoolDataProvider.getReservesData(address)
  getReservesIncentivesData: '0x976fafc5', // UiIncentiveDataProvider.getReservesIncentivesData(address)
  getUserReservesData: '0x51974cc0', // UiPoolDataProvider.getUserReservesData(address,address)
  getUserWalletBalances: '0x02405343', // WalletBalanceProvider.getUserWalletBalances(address,address)
});
const SIGNATURES = Object.freeze({
  depositETH: 'depositETH(address,address,uint16)', withdrawETH: 'withdrawETH(address,uint256,address)', withdraw: 'withdraw(address,uint256,address)', approve: 'approve(address,uint256)',
  balanceOf: 'balanceOf(address)', getReservesData: 'getReservesData(address)', getReservesIncentivesData: 'getReservesIncentivesData(address)',
  getUserReservesData: 'getUserReservesData(address,address)', getUserWalletBalances: 'getUserWalletBalances(address,address)',
});
const TOPICS = Object.freeze({
  Supply: '0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61', // Supply(address,address,address,uint256,uint16)
  Withdraw: '0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7', // Withdraw(address,address,address,uint256)
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Transfer(address,address,uint256)
});
const EVENT_SIGNATURES = Object.freeze({
  Supply: 'Supply(address,address,address,uint256,uint16)', Withdraw: 'Withdraw(address,address,address,uint256)', Transfer: 'Transfer(address,address,uint256)',
});

const lower = (a) => String(a).toLowerCase();
const sameAddress = (a, b) => ADDRESS.test(String(a)) && ADDRESS.test(String(b)) && lower(a) === lower(b);
const encodeAddress = (a) => { if (!ADDRESS.test(a)) throw new Error('bad address'); return '0x' + lower(a).slice(2).padStart(64, '0'); };
const encodeUint = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const word = (hexWithoutPrefix, i) => hexWithoutPrefix.slice(i * 64, i * 64 + 64);
const wordToAddress = (w) => '0x' + w.slice(24);
const wordToBigInt = (w) => BigInt('0x' + (w || '0'));
const encodeCall = (selector, ...words) => selector + words.map((w) => w.slice(2)).join('');

/** { selector, words[] } from calldata; words are 64-hex-char strings (no 0x). */
function decodeCall(data) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) return { selector: null, words: [] };
  const body = data.slice(10);
  if (body.length % 64 !== 0) return { selector: data.slice(0, 10).toLowerCase(), words: [], malformed: true };
  const words = [];
  for (let i = 0; i < body.length / 64; i++) words.push(word(body, i));
  return { selector: data.slice(0, 10).toLowerCase(), words };
}

const toBigInt = (v) => (v === undefined || v === null ? 0n : BigInt(v));

/** Withdraw routes the unchanged app can take (src/components/transactions/Withdraw/WithdrawModalContent.tsx -> store.withdraw ->
 * @aave/contract-helpers Pool.withdraw):
 *   gateway-native: Unwrap toggle ON (default). reserve = API_ETH_MOCK_ADDRESS -> WETHGatewayService.withdrawETH: approve(aWETH ->
 *                   gateway, MaxUint256) when allowance < amount, then WETH_GATEWAY.withdrawETH(POOL, amount, user).
 *   pool-weth:      Unwrap toggle OFF. reserve = WETH underlying -> POOL.withdraw(WETH, amount, user); no approval at all
 *                   (useOptimizedPath is false outside Arbitrum/Optimism, src/utils/utils.ts optimizedPath). */
const WITHDRAW_ROUTES = Object.freeze(['pool-weth', 'gateway-native']);

/** Exact calldata the pool-weth route must produce: withdraw(WETH, withdrawWei, account) on the Pool with value 0. */
function expectedPoolWithdrawCall({ account, addresses, withdrawWei }) {
  return { to: addresses.POOL, value: 0n, data: encodeCall(SELECTORS.withdraw, encodeAddress(addresses.WETH), encodeUint(withdrawWei), encodeAddress(account)) };
}

/**
 * Transaction policy for the UI operations on Aave V3 Base this spike accepts:
 *   supply: WETH_GATEWAY.depositETH(POOL, account, ref) with value == supplyWei
 *   withdraw, route pool-weth: POOL.withdraw(WETH, exactly withdrawWei, account) — byte-exact calldata, value 0, no approval
 *   withdraw, route gateway-native: A_WETH.approve(WETH_GATEWAY, amount <= approveCapWei) then WETH_GATEWAY.withdrawETH(POOL, amount <= withdrawWei, account)
 * Only routes listed in `withdrawRoutes` are whitelisted; everything else (other destinations, selectors, values, amounts
 * above the caps, unlimited approvals, routes not whitelisted) is refused. The route-specific checks run before the
 * whitelist check so a refusal names the real reason (e.g. "MaxUint256 (unlimited) exceeds cap") and the route.
 */
function makePolicy({ account, addresses, supplyWei, withdrawWei, approveCapWei = withdrawWei, withdrawRoutes = ['pool-weth'] }) {
  const { POOL, WETH_GATEWAY, A_WETH } = addresses;
  if (!Array.isArray(withdrawRoutes) || withdrawRoutes.some((r) => !WITHDRAW_ROUTES.includes(r))) throw new Error('policy: unknown withdraw route');
  const routes = new Set(withdrawRoutes);
  const expected = expectedPoolWithdrawCall({ account, addresses, withdrawWei });
  const routed = (route, result) => {
    if (!routes.has(route)) throw new Error(`policy: ${result.op} belongs to withdraw route ${route}, which is not whitelisted (${[...routes].join(',') || 'none'})`);
    return { ...result, route };
  };
  return function validateTransaction(tx) {
    if (!tx || !ADDRESS.test(String(tx.to))) throw new Error('policy: transaction.to missing');
    const { selector, words, malformed } = decodeCall(tx.data);
    if (malformed) throw new Error('policy: malformed calldata');
    const value = toBigInt(tx.value);
    if (tx.from !== undefined && !sameAddress(tx.from, account)) throw new Error('policy: from is not the disposable account');
    if (sameAddress(tx.to, POOL)) {
      if (selector !== SELECTORS.withdraw) throw new Error(`policy: selector ${selector} not allowed on Pool`);
      if (words.length !== 3) throw new Error('policy: withdraw arity');
      if (!sameAddress(wordToAddress(words[0]), addresses.WETH)) throw new Error('policy: withdraw asset is not WETH');
      const amount = wordToBigInt(words[1]);
      if (amount !== BigInt(withdrawWei)) throw new Error(`policy: withdraw amount must be exactly ${withdrawWei} wei`);
      if (!sameAddress(wordToAddress(words[2]), account)) throw new Error('policy: withdraw recipient is not the account');
      if (value !== 0n) throw new Error('policy: withdraw must not carry value');
      if (lower(tx.data) !== lower(expected.data)) throw new Error('policy: withdraw calldata is not byte-exact');
      return routed('pool-weth', { op: 'withdraw', amountWei: amount.toString() });
    }
    if (sameAddress(tx.to, WETH_GATEWAY)) {
      if (selector === SELECTORS.depositETH) {
        if (words.length !== 3) throw new Error('policy: depositETH arity');
        if (!sameAddress(wordToAddress(words[0]), POOL)) throw new Error('policy: depositETH pool is not Aave V3 Base Pool');
        if (!sameAddress(wordToAddress(words[1]), account)) throw new Error('policy: depositETH onBehalfOf is not the account');
        if (value !== BigInt(supplyWei)) throw new Error(`policy: depositETH value must be exactly ${supplyWei} wei`);
        return { op: 'supply', amountWei: value.toString() };
      }
      if (selector === SELECTORS.withdrawETH) {
        if (words.length !== 3) throw new Error('policy: withdrawETH arity');
        if (!sameAddress(wordToAddress(words[0]), POOL)) throw new Error('policy: withdrawETH pool is not Aave V3 Base Pool');
        const amount = wordToBigInt(words[1]);
        if (amount === 0n || amount > BigInt(withdrawWei)) throw new Error(`policy: withdrawETH amount must be 1..${withdrawWei} wei`);
        if (!sameAddress(wordToAddress(words[2]), account)) throw new Error('policy: withdrawETH recipient is not the account');
        if (value !== 0n) throw new Error('policy: withdrawETH must not carry value');
        return routed('gateway-native', { op: 'withdrawETH', amountWei: amount.toString() });
      }
      throw new Error(`policy: selector ${selector} not allowed on WETH gateway`);
    }
    if (sameAddress(tx.to, A_WETH)) {
      if (selector !== SELECTORS.approve) throw new Error(`policy: selector ${selector} not allowed on aWETH`);
      if (words.length !== 2) throw new Error('policy: approve arity');
      if (!sameAddress(wordToAddress(words[0]), WETH_GATEWAY)) throw new Error('policy: approve spender is not the WETH gateway');
      const amount = wordToBigInt(words[1]);
      if (value !== 0n) throw new Error('policy: approve must not carry value');
      if (amount > BigInt(approveCapWei)) {
        throw new Error(`policy: approve amount ${amount === MAX_UINT256 ? 'MaxUint256 (unlimited)' : amount.toString()} exceeds cap ${approveCapWei} wei (route gateway-native)`);
      }
      return routed('gateway-native', { op: 'approve', amountWei: amount.toString() });
    }
    throw new Error(`policy: destination ${tx.to} is not Pool, WETH gateway or aWETH`);
  };
}

/**
 * The only WebSocket the browser may open: the Next dev HMR socket of the owned app origin, ws://<app host:port>/_next/webpack-hmr
 * (next/dist/client/page-bootstrap.js connectHMR path; get-socket-url.js builds ws://hostname:port). Without it the client
 * reconnects 25 times and then calls window.location.reload() (next/dist/client/dev/hot-reloader/pages/websocket.js), which
 * destroys the transaction modal mid-flow. Anything else (other path, query, port, host, scheme, external relays) is denied.
 */
function hmrSocketAllowed(wsUrl, appOrigin) {
  let u; let app;
  try { u = new URL(String(wsUrl)); app = new URL(String(appOrigin)); } catch { return false; }
  if (app.protocol !== 'http:' || u.protocol !== 'ws:') return false;
  if (u.hostname !== app.hostname || u.port !== app.port) return false;
  if (u.username || u.password) return false;
  if (u.pathname !== '/_next/webpack-hmr' || u.search !== '' || u.hash !== '') return false;
  return true;
}

/** The market selector renders letters individually ("B a s e F o r k ..."); compare on whitespace-free text. */
function verifyMarketText(innerText) {
  const compact = String(innerText || '').replace(/\s+/g, '');
  const ok = /^BaseFork/.test(compact) && !/Core/.test(compact) && /V3/.test(compact);
  return { ok, compact: compact.slice(0, 80) };
}

/** Header shows textCenterEllipsis(address, 4, 4) => "0x12...abcd" (case preserved as the app formats it). */
function shortAddressRegex(account) {
  const a = String(account);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc(a.slice(0, 4)) + '\\.\\.\\.' + esc(a.slice(-4)), 'i');
}

function receiptOk(r) { return Boolean(r && r.status === '0x1'); }

/**
 * Supply PASS: >= 1 submitted hash, every receipt present with status 0x1, exactly one depositETH receipt to the WETH
 * gateway carrying a Pool Supply(reserve=WETH, onBehalfOf=account, amount=supplyWei) log, and the independently read
 * aWETH balance grew by at least supplyWei minus 1 wei of aToken index rounding. UI text is never consulted here.
 */
function assertSupply({ submitted, receipts, balanceBeforeWei, balanceAfterWei, account, addresses, supplyWei, roundingWei = 1n }) {
  const reasons = [];
  if (!Array.isArray(submitted) || submitted.length === 0) reasons.push('no transaction was submitted (UI success alone never passes)');
  const list = Array.isArray(receipts) ? receipts : [];
  if (list.length !== (submitted || []).length) reasons.push('receipt count differs from submitted count');
  for (const { hash, receipt } of list) {
    if (!receipt) reasons.push(`receipt missing for ${hash}`);
    else if (!receiptOk(receipt)) reasons.push(`receipt ${hash} status ${receipt.status}`);
  }
  const deposits = list.filter(({ receipt }) => receipt && sameAddress(receipt.to, addresses.WETH_GATEWAY));
  if (deposits.length !== 1) reasons.push(`expected exactly one receipt to the WETH gateway, got ${deposits.length}`);
  const supplyLogs = deposits.flatMap(({ receipt }) => (receipt.logs || []).filter((l) => sameAddress(l.address, addresses.POOL) && l.topics && l.topics[0] === TOPICS.Supply));
  const matching = supplyLogs.filter((l) => sameAddress(wordToAddress(l.topics[1].slice(2)), addresses.WETH) && sameAddress(wordToAddress(l.topics[2].slice(2)), account)
    && decodeCall('0x00000000' + l.data.slice(2)).words.length === 2 && wordToBigInt(decodeCall('0x00000000' + l.data.slice(2)).words[1]) === BigInt(supplyWei));
  if (matching.length !== 1) reasons.push(`expected one Pool Supply(WETH, onBehalfOf=account, ${supplyWei}) log, found ${matching.length}`);
  const before = toBigInt(balanceBeforeWei); const after = toBigInt(balanceAfterWei);
  // aToken balanceOf = scaledBalance.rayMul(liquidityIndex): the deposit can read back 1 wei low (observed 0.5 ETH -> 499999999999999999).
  if (after - before < BigInt(supplyWei) - BigInt(roundingWei)) reasons.push(`aWETH balance delta ${(after - before).toString()} < ${supplyWei} - ${roundingWei} wei rounding`);
  return { pass: reasons.length === 0, reasons, aWethDeltaWei: (after - before).toString(), supplyLogs: matching.length };
}

/** Withdraw is only attempted after a passed supply; otherwise it is BLOCKED (never "passed", never "failed"). */
function withdrawGate(supplyResult) {
  if (supplyResult && supplyResult.pass === true) return { allowed: true };
  return { allowed: false, status: 'blocked', reason: 'withdraw blocked: supply did not pass' };
}

const topicAddress = (t) => wordToAddress(String(t || '').slice(2));

/**
 * Withdraw PASS (route pool-weth, the only route the harness whitelists):
 *   exactly one submitted hash (no approval exists on this route), its receipt status 0x1 and `to` == POOL, carrying
 *   one Pool Withdraw(reserve=WETH, user=account, to=account, amount=withdrawWei) log and one WETH Transfer(aWETH ->
 *   account, withdrawWei) log; the independently read aWETH balance fell by withdrawWei within toleranceWei (interest
 *   accrued between the reads) AND the independently read WETH balance of the account rose by exactly withdrawWei.
 * Route gateway-native keeps the former shape (approve receipt + withdrawETH receipt to the gateway, Withdraw log
 * user/to = gateway, ETH delivered as native so no WETH gain) and exists for the selfcheck/negative documentation only.
 * UI text is never consulted here.
 */
function assertWithdraw({ submitted, receipts, balanceBeforeWei, balanceAfterWei, wethBeforeWei, wethAfterWei, account, addresses, withdrawWei, route = 'pool-weth', toleranceWei = 10n ** 13n }) {
  if (!WITHDRAW_ROUTES.includes(route)) throw new Error('assertWithdraw: unknown route');
  const reasons = [];
  if (!Array.isArray(submitted) || submitted.length === 0) reasons.push('no transaction was submitted (UI success alone never passes)');
  const list = Array.isArray(receipts) ? receipts : [];
  if (list.length !== (submitted || []).length) reasons.push('receipt count differs from submitted count');
  for (const { hash, receipt } of list) {
    if (!receipt) reasons.push(`receipt missing for ${hash}`);
    else if (!receiptOk(receipt)) reasons.push(`receipt ${hash} status ${receipt.status}`);
  }
  const target = route === 'pool-weth' ? addresses.POOL : addresses.WETH_GATEWAY;
  const targetName = route === 'pool-weth' ? 'Pool' : 'WETH gateway';
  const withdraws = list.filter(({ receipt }) => receipt && sameAddress(receipt.to, target));
  if (withdraws.length !== 1) reasons.push(`expected exactly one receipt to the ${targetName}, got ${withdraws.length}`);
  if (route === 'pool-weth' && Array.isArray(submitted) && submitted.length !== 1) reasons.push(`pool-weth route needs exactly one transaction, got ${submitted.length}`);
  const logs = withdraws.flatMap(({ receipt }) => (receipt.logs || []).filter((l) => sameAddress(l.address, addresses.POOL) && l.topics && l.topics[0] === TOPICS.Withdraw));
  const party = route === 'pool-weth' ? account : addresses.WETH_GATEWAY;
  const matching = logs.filter((l) => sameAddress(topicAddress(l.topics[1]), addresses.WETH) && sameAddress(topicAddress(l.topics[2]), party)
    && sameAddress(topicAddress(l.topics[3]), party) && wordToBigInt(String(l.data || '0x').slice(2)) === BigInt(withdrawWei));
  if (matching.length !== 1) reasons.push(`expected one Pool Withdraw(WETH, user=${route === 'pool-weth' ? 'account' : 'gateway'}, to=same, ${withdrawWei}) log, found ${matching.length}`);
  let wethTransfers = 0;
  let wethGain = null;
  if (route === 'pool-weth') {
    const transfers = withdraws.flatMap(({ receipt }) => (receipt.logs || []).filter((l) => sameAddress(l.address, addresses.WETH) && l.topics && l.topics[0] === TOPICS.Transfer
      && sameAddress(topicAddress(l.topics[1]), addresses.A_WETH) && sameAddress(topicAddress(l.topics[2]), account) && wordToBigInt(String(l.data || '0x').slice(2)) === BigInt(withdrawWei)));
    wethTransfers = transfers.length;
    if (wethTransfers !== 1) reasons.push(`expected one WETH Transfer(aWETH -> account, ${withdrawWei}) log, found ${wethTransfers}`);
    if (wethBeforeWei === undefined || wethAfterWei === undefined) reasons.push('WETH balance reads missing');
    else {
      wethGain = toBigInt(wethAfterWei) - toBigInt(wethBeforeWei);
      if (wethGain !== BigInt(withdrawWei)) reasons.push(`account WETH balance gain ${wethGain.toString()} is not exactly ${withdrawWei}`);
    }
  }
  const before = toBigInt(balanceBeforeWei); const after = toBigInt(balanceAfterWei);
  const drop = before - after;
  const diff = drop > BigInt(withdrawWei) ? drop - BigInt(withdrawWei) : BigInt(withdrawWei) - drop;
  if (drop <= 0n || diff > BigInt(toleranceWei)) reasons.push(`aWETH balance drop ${drop.toString()} not within ${toleranceWei} of ${withdrawWei}`);
  return { pass: reasons.length === 0, reasons, route, aWethDropWei: drop.toString(), wethGainWei: wethGain === null ? null : wethGain.toString(), withdrawLogs: matching.length, wethTransferLogs: wethTransfers };
}

/**
 * Main-frame navigations observed after a baseline count are unexpected during a transaction flow: a document reload
 * (e.g. the Next HMR client giving up) unmounts the modal and re-requests wallet permissions. Pure; the harness records.
 */
function unexpectedNavigations(navigations, baselineCount) {
  const list = Array.isArray(navigations) ? navigations : [];
  return list.slice(Math.max(0, baselineCount | 0)).map((n) => ({ url: String(n.url || '').slice(0, 200), at: n.at }));
}

/** Classify a gateway/JSON-RPC error without keeping payloads: transport timeout vs upstream (anvil) vs policy. */
function classifyRpcError(error) {
  if (!error) return 'ok';
  const msg = String(error.message || '');
  if (/timeout|aborted/i.test(msg)) return 'transport-timeout';
  if (error.code === 4200 || /unsupported method/i.test(msg)) return 'policy-unsupported-method';
  if (error.code === -32602 || error.code === -32600) return 'policy-invalid';
  if (/rate|429|too many/i.test(msg)) return 'upstream-rate-limit';
  if (/missing trie node|archive|state .* not available|historical/i.test(msg)) return 'upstream-archive';
  if (error.code === -32603) return 'internal';
  return `code:${error.code}`;
}

/** Aggregate one browser-side JSON-RPC exchange into evidence (method + eth_call target/selector only; no calldata). */
function summarizeRpcItem(summary, item, result, elapsedMs) {
  const method = item && typeof item.method === 'string' ? item.method.slice(0, 40) : '?';
  let key = method;
  if (method === 'eth_call' && Array.isArray(item.params) && item.params[0] && typeof item.params[0] === 'object') {
    const to = typeof item.params[0].to === 'string' ? lower(item.params[0].to) : '?';
    const sel = typeof item.params[0].data === 'string' ? item.params[0].data.slice(0, 10).toLowerCase() : '0x';
    key = `${method} ${to} ${sel}`;
  }
  const entry = summary[key] || (summary[key] = { n: 0, ok: 0, errors: {}, maxMs: 0, totalMs: 0 });
  entry.n++;
  entry.maxMs = Math.max(entry.maxMs, elapsedMs);
  entry.totalMs += elapsedMs;
  if (result && result.error) {
    const k = `${result.error.code}:${classifyRpcError(result.error)}`;
    entry.errors[k] = (entry.errors[k] || 0) + 1;
  } else entry.ok++;
  return key;
}

/** Positive routes (supply, pool-weth withdraw) must run with zero policy refusals and zero unsupported-method dispatches. */
function positiveRouteHygiene({ refusals, unsupported }) {
  const reasons = [];
  if (!Array.isArray(refusals) || refusals.length !== 0) reasons.push(`policy refusals during a positive route: ${Array.isArray(refusals) ? refusals.length : 'unknown'}`);
  if (!Array.isArray(unsupported) || unsupported.length !== 0) reasons.push(`unsupported dispatches during a positive route: ${Array.isArray(unsupported) ? unsupported.length : 'unknown'}`);
  return { pass: reasons.length === 0, reasons };
}

/**
 * Native-route refusal check (Unwrap ON on the unchanged UI): exactly one policy refusal, and it is the MaxUint256 aWETH
 * approval naming the cap; zero submitted transactions; zero unsupported dispatches; aWETH balance unchanged. Passing it
 * proves the refusal, never native withdrawal capability (that stays blocked).
 */
function assertNativeRefusal({ submitted, refusals, unsupported, aWethBeforeWei, aWethAfterWei, addresses }) {
  const reasons = [];
  const r = Array.isArray(refusals) ? refusals : [];
  if (!Array.isArray(submitted) || submitted.length !== 0) reasons.push(`native route submitted ${Array.isArray(submitted) ? submitted.length : 'unknown'} transaction(s)`);
  const unlimited = r.filter((x) => x && sameAddress(x.to, addresses.A_WETH) && /MaxUint256 \(unlimited\) exceeds cap/.test(String(x.reason)));
  if (r.length !== 1 || unlimited.length !== 1) reasons.push(`expected exactly one MaxUint256 aWETH approve refusal, got ${r.length} refusal(s), ${unlimited.length} unlimited`);
  if (!Array.isArray(unsupported) || unsupported.length !== 0) reasons.push('unsupported dispatch during the native check');
  if (aWethBeforeWei === undefined || aWethAfterWei === undefined || toBigInt(aWethBeforeWei) !== toBigInt(aWethAfterWei)) reasons.push('aWETH balance changed or unread during the native check');
  return { pass: reasons.length === 0, reasons };
}

/** The only Aave interface commit this example is measured against; any other HEAD is refused before anything starts. */
const PINNED_AAVE_COMMIT = '20fdc895a9e3925960b5cd111fe09535cf224085';

/** Refuses an unpinned or tracked-dirty Aave checkout. `trackedStatus` is `git status --porcelain --untracked-files=no`;
 * anything that is not a string (git failed, not read) is unknown and fails closed. */
function checkAavePin({ head, trackedStatus }, pinned = PINNED_AAVE_COMMIT) {
  const reasons = [];
  if (head !== pinned) reasons.push(`Aave checkout HEAD ${String(head).slice(0, 40)} is not the pinned ${pinned}`);
  if (typeof trackedStatus !== 'string') reasons.push('Aave tracked-file status unknown');
  const dirty = typeof trackedStatus === 'string' ? trackedStatus.split('\n').filter((l) => l.trim()) : [];
  if (dirty.length) reasons.push(`Aave checkout has ${dirty.length} modified tracked file(s)`);
  return { ok: reasons.length === 0, reasons, dirty: dirty.slice(0, 20) };
}

// Any run of 64+ hex characters, with or without 0x: private keys, signatures, hashes and ABI calldata (a selector plus
// one argument word is already 72). Addresses (40) and bare selectors (8) stay readable.
const LONG_HEX = /(?:0x)?[0-9a-fA-F]{64,}/g;
/** Redacts console/error/modal text before it is kept anywhere. */
const redact = (s, max = 1500) => String(s).replace(LONG_HEX, '<redacted>').slice(0, max);

/**
 * Persistence sentinel for serialized evidence: every long hex run that is not an explicitly allowed hash (submitted
 * transaction hashes, the fork block hash, the expected-calldata digest) is replaced and counted. A non-zero count fails
 * acceptance; the offending value itself is never written.
 */
function scrubEvidenceText(text, allowed = []) {
  const ok = new Set(allowed.filter((h) => typeof h === 'string').map((h) => lower(h).replace(/^0x/, '')));
  let hits = 0;
  const out = String(text).replace(LONG_HEX, (m) => { if (ok.has(lower(m).replace(/^0x/, ''))) return m; hits++; return '<redacted>'; });
  return { text: out, hits };
}

/** Current executor identity comes only from SPIKE_RUNNER (short, plain text) or is null; it is never hardcoded.
 * Authorship of this example is documented separately in README.md and never stands in for the runner. */
function runnerMetadata(env) {
  const raw = env && typeof env.SPIKE_RUNNER === 'string' ? env.SPIKE_RUNNER.trim() : '';
  const valid = /^[\w.@:/+ -]{1,80}$/.test(raw);
  return { runner: valid ? raw : null, runnerSource: valid ? 'SPIKE_RUNNER' : (raw ? 'SPIKE_RUNNER-rejected' : 'unset') };
}

/** Status of one diag.* step from its probe result(s): never an acceptance status, never "failed". A transport
 * timeout keeps its own class so a slow cold read is distinguishable from a broken one. */
function diagnosticStatus(probes) {
  const list = Array.isArray(probes) ? probes : [probes];
  if (list.length === 0 || list.some((p) => !p || typeof p.ok !== 'boolean')) return 'diagnostic-failed';
  if (list.every((p) => p.ok)) return 'passed';
  return list.some((p) => !p.ok && p.errorClass === 'transport-timeout') ? 'diagnostic-timeout' : 'diagnostic-failed';
}

/** The three runtime acceptance checks and the step that carries each. Native withdrawal *capability* is not one of
 * them: it is always reported blocked, separately from the refusal check that proves the block. */
const RUNTIME_CHECKS = Object.freeze({ supply: 'ui.supply.ETH', withdrawWETH: 'ui.withdraw.WETH', nativeRouteRefusal: 'ui.withdraw.ETH.native-refusal' });
const EXIT = Object.freeze({ PASS: 0, FAILED: 2, BLOCKED: 3, DEGRADED: 4 });
const BOOKKEEPING = new Set(['observed']);

/**
 * Cleanup verdict from the harness's `close` record. Everything the harness launched must be verifiably gone: browser
 * closed, owned children exited, no listener left on any owned port, no owned app PID alive, temp HOME removed, and the
 * Aave checkout still tracked-clean. Missing evidence for a launched resource is a failure, never a pass.
 */
function cleanupVerdict(close, launched = {}) {
  const c = close || {};
  const reasons = [];
  const emptyList = (v) => Array.isArray(v) && v.length === 0;
  const exited = (v) => ['terminated', 'killed', 'already-exited'].includes(v);
  if (launched.browser && c.browser !== 'closed') reasons.push(`browser ${c.browser || 'not closed'}`);
  if (launched.next) {
    if (!exited(c.next)) reasons.push(`next ${c.next || 'not stopped'}`);
    if (!emptyList(c.appListenerAfter)) reasons.push(`app port listener left: ${JSON.stringify(c.appListenerAfter)}`);
    if (!emptyList(c.appPidsAlive)) reasons.push(`owned app pids alive: ${JSON.stringify(c.appPidsAlive)}`);
  }
  if (launched.gateway) {
    if (c.gateway !== 'closed') reasons.push(`gateway ${c.gateway || 'not closed'}`);
    if (!emptyList(c.gatewayListenerAfter)) reasons.push(`gateway port listener left: ${JSON.stringify(c.gatewayListenerAfter)}`);
  }
  if (launched.anvil) {
    if (!exited(c.anvil)) reasons.push(`anvil ${c.anvil || 'not stopped'}`);
    if (!emptyList(c.anvilListenerAfter)) reasons.push(`anvil port listener left: ${JSON.stringify(c.anvilListenerAfter)}`);
  }
  if (launched.tmpHome && c.tmpHome !== 'removed') reasons.push(`temp HOME ${c.tmpHome || 'not removed'}`);
  if (launched.aave && c.aaveTrackedCleanAfter !== true) reasons.push('Aave checkout not verified tracked-clean after cleanup');
  return { ok: reasons.length === 0, reasons };
}

/**
 * Aggregate outcome; the exit code is derived from this alone.
 *   0 PASS:     all three runtime checks passed, cleanup verified, diagnostics healthy.
 *   4 DEGRADED: all three runtime checks passed, cleanup verified, at least one diag.* step degraded (or none ran).
 *   3 BLOCKED:  a prerequisite/launch stage stopped the run and cleanup was verified.
 *   2 FAILED:   everything else — a runtime check failed, was blocked or never ran, a fatal UI-stage error, any other
 *               failed step, cleanup not verified, or the evidence sentinel found unredacted data.
 * A runtime check is passed only if exactly one step with its name exists with status "passed"; missing = blocked.
 */
function classifyAcceptance({ steps, fatal, cleanup, sentinelHits = 0 }) {
  const list = Array.isArray(steps) ? steps : [];
  const checks = {};
  for (const [key, name] of Object.entries(RUNTIME_CHECKS)) {
    const matches = list.filter((s) => s && s.name === name);
    if (matches.length === 0) checks[key] = 'blocked';
    else if (matches.length > 1) checks[key] = 'failed';
    else checks[key] = ['passed', 'failed', 'blocked'].includes(matches[0].status) ? matches[0].status : 'failed';
  }
  const runtimeNames = new Set(Object.values(RUNTIME_CHECKS));
  const diagnostics = list.filter((s) => s && /^diag\./.test(String(s.name))).map((s) => ({ name: s.name, status: s.status }));
  const diagnosticsDegraded = diagnostics.length === 0 || diagnostics.some((d) => d.status !== 'passed');
  const otherFailures = list.filter((s) => s && !runtimeNames.has(s.name) && !/^diag\./.test(String(s.name)) && !BOOKKEEPING.has(s.status) && s.status !== 'passed').map((s) => s.name);
  const cleanupOk = Boolean(cleanup && cleanup.ok === true);
  const reasons = [];
  for (const [k, v] of Object.entries(checks)) if (v !== 'passed') reasons.push(`${k} ${v}`);
  if (otherFailures.length) reasons.push(`other steps not passed: ${otherFailures.join(', ')}`);
  if (fatal) reasons.push(`fatal at ${fatal.stage || 'unknown'} stage${fatal.step ? ` (${fatal.step})` : ''}`);
  if (!cleanupOk) reasons.push(`cleanup not verified${cleanup && cleanup.reasons && cleanup.reasons.length ? ': ' + cleanup.reasons.join('; ') : ''}`);
  if (sentinelHits > 0) reasons.push(`evidence sentinel redacted ${sentinelHits} long hex value(s)`);
  const runtimeAllPassed = Object.values(checks).every((v) => v === 'passed');
  let overall;
  if (cleanupOk && sentinelHits === 0 && fatal && fatal.stage === 'prerequisite') overall = 'BLOCKED';
  else if (cleanupOk && sentinelHits === 0 && !fatal && runtimeAllPassed && otherFailures.length === 0) overall = diagnosticsDegraded ? 'DEGRADED' : 'PASS';
  else overall = 'FAILED';
  return { ...checks, nativeRouteCapability: 'blocked', diagnosticsDegraded, diagnostics, cleanup: cleanupOk ? 'passed' : 'failed', overall, exitCode: EXIT[overall], reasons };
}

/**
 * Supervised-gate verdict over one harness run (gate.js). Exit 4 is DEGRADED, never a clean PASS; the gate may accept
 * it only after inspecting the evidence. The inspection re-derives the outcome from the raw evidence (steps, fatal,
 * close + launched -> cleanupVerdict, redaction sentinel) instead of trusting the harness summary, and requires: the
 * re-derived and recorded outcomes agree with the harness exit code, supply/withdrawWETH/nativeRouteRefusal passed,
 * cleanup verified with the Aave checkout pinned and tracked-clean before and after. Then 0 -> PASS, 4 -> exit 0 as
 * DEGRADED-ACCEPTED (diagnostics listed). Exit 2/3/other propagate unchanged; any inspection failure is exit 2.
 */
function gateVerdict({ harnessExit, evidence }) {
  if (harnessExit !== EXIT.PASS && harnessExit !== EXIT.DEGRADED) {
    return { verdict: 'NOT-ACCEPTED', exitCode: Number.isInteger(harnessExit) && harnessExit !== 0 ? harnessExit : EXIT.FAILED, harnessExit, reasons: [`harness exit ${harnessExit}`] };
  }
  const reasons = [];
  const e = evidence && typeof evidence === 'object' ? evidence : null;
  if (!e) reasons.push('evidence missing or unreadable');
  const recorded = e && e.acceptance && typeof e.acceptance === 'object' ? e.acceptance : null;
  if (e && !recorded) reasons.push('evidence.acceptance missing');
  let derived = null;
  if (e) {
    const cleanup = cleanupVerdict(e.close, e.launched);
    const hits = e.redactionSentinel && Number.isInteger(e.redactionSentinel.longHexRedacted) ? e.redactionSentinel.longHexRedacted : 1;
    derived = classifyAcceptance({ steps: e.steps, fatal: e.fatal, cleanup, sentinelHits: hits });
    if (derived.exitCode !== harnessExit) reasons.push(`re-derived outcome ${derived.overall} (exit ${derived.exitCode}) != harness exit ${harnessExit}`);
    for (const k of Object.keys(RUNTIME_CHECKS)) if (derived[k] !== 'passed') reasons.push(`${k} ${derived[k]}`);
    if (derived.cleanup !== 'passed') reasons.push(`cleanup not verified: ${cleanup.reasons.join('; ')}`);
    if (!e.cleanup || e.cleanup.ok !== true) reasons.push('recorded cleanup verdict not ok');
    if (!e.launched || e.launched.aave !== true) reasons.push('Aave checkout not launched');
    if (e.aavePinned !== PINNED_AAVE_COMMIT) reasons.push('Aave checkout not the pinned commit');
    if (e.aaveTrackedClean !== true) reasons.push('Aave checkout not tracked-clean before the run');
  }
  if (recorded) {
    if (recorded.exitCode !== harnessExit) reasons.push(`recorded exit ${recorded.exitCode} != harness exit ${harnessExit}`);
    if (derived && recorded.overall !== derived.overall) reasons.push(`recorded overall ${recorded.overall} != re-derived ${derived.overall}`);
    if (recorded.nativeRouteCapability !== 'blocked') reasons.push('native route capability must stay blocked');
  }
  if (reasons.length) return { verdict: 'NOT-ACCEPTED', exitCode: EXIT.FAILED, harnessExit, reasons };
  if (harnessExit === EXIT.PASS) return { verdict: 'PASS', exitCode: 0, harnessExit, reasons };
  return { verdict: 'DEGRADED-ACCEPTED', exitCode: 0, harnessExit, reasons, degradedDiagnostics: derived.diagnostics.filter((d) => d.status !== 'passed') };
}

/**
 * Next hop of a redirect the egress proxy received, or null when it is not a usable redirect. Fetch semantics: 303,
 * and 301/302 after POST, continue as GET without a body; 307/308 keep method and body.
 */
function redirectHop({ status, location, url, method, postData }) {
  if (!(status >= 300 && status < 400) || status === 304 || typeof location !== 'string' || !location) return null;
  let target;
  try { target = new URL(location, url); } catch { return null; }
  const toGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
  return { url: target.href, origin: target.origin, method: toGet ? 'GET' : method, postData: toGet ? undefined : postData };
}
const MAX_REDIRECT_HOPS = 5;

/**
 * Browser HTTP egress route handler: only the owned app origin and the gateway origin; everything else is aborted.
 * Both proxy sites fetch with maxRedirects: 0, so Playwright never follows a redirect on its own (by default
 * route.fetch would, outside the browser, to any destination). A 3xx is never handed to the browser either: measured
 * with Playwright 1.56 Chromium, a fulfilled navigation redirect is followed natively WITHOUT re-entering this handler
 * (selfcheck.js proves both leaks). Instead the handler re-applies the allowlist to every hop itself: a hop to an allowed
 * origin is fetched again with maxRedirects: 0 (at most MAX_REDIRECT_HOPS); a hop to any other origin, a malformed
 * Location or too many hops aborts the request as blockedbyclient. The unchanged Next dev server needs this: it answers
 * some same-origin requests with 308, and aborting those raises its error overlay. Fetch errors abort the request;
 * callbacks only observe and never decide.
 */
function makeEgressHandler({ appOrigin, gatewayOrigin, onGatewayResponse, onAppResponse, onRedirect, onDenied }) {
  const allowed = new Set([appOrigin, gatewayOrigin]);
  const observe = async (cb, arg) => { if (cb) { try { await cb(arg); } catch {} } };
  /** Fetches with maxRedirects: 0 and walks redirects only through allowed origins; returns the final response or null (denied). */
  const fetchAllowed = async (route, request) => {
    let current = { url: request.url(), method: request.method(), postData: request.postDataBuffer() || undefined };
    let response = await route.fetch({ maxRedirects: 0 });
    for (let hops = 0; ; hops++) {
      const hop = redirectHop({ status: response.status(), location: response.headers().location, url: current.url, method: current.method, postData: current.postData });
      if (!hop) {
        if (response.status() >= 300 && response.status() < 400 && response.status() !== 304) { await observe(onDenied, { url: request.url(), redirect: { status: response.status(), target: null } }); return null; }
        return response;
      }
      const decision = allowed.has(hop.origin) && hops < MAX_REDIRECT_HOPS ? 'followed' : 'denied';
      await observe(onRedirect, { from: new URL(current.url).origin, status: response.status(), target: hop.origin, decision });
      if (decision === 'denied') { await observe(onDenied, { url: request.url(), redirect: { status: response.status(), target: hop.origin } }); return null; }
      current = hop;
      response = await route.fetch({ url: hop.url, method: hop.method, postData: hop.postData, maxRedirects: 0 });
    }
  };
  return async (route) => {
    const request = route.request();
    let origin = null;
    try { origin = new URL(request.url()).origin; } catch {}
    try {
      if (origin && origin === gatewayOrigin) {
        const t0 = Date.now();
        const response = await fetchAllowed(route, request);
        if (!response) return route.abort('blockedbyclient').catch(() => {});
        await observe(onGatewayResponse, { request, response, elapsedMs: Date.now() - t0 });
        return await route.fulfill({ response });
      }
      if (origin && origin === appOrigin) {
        const response = await fetchAllowed(route, request);
        if (!response) return route.abort('blockedbyclient').catch(() => {});
        await observe(onAppResponse, { request, response });
        return await route.fulfill({ response });
      }
    } catch {
      return route.abort('failed').catch(() => {});
    }
    await observe(onDenied, { url: request.url(), redirect: null });
    return route.abort('blockedbyclient').catch(() => {});
  };
}

module.exports = {
  ADDRESS, MAX_UINT256, WEI, SELECTORS, SIGNATURES, TOPICS, EVENT_SIGNATURES, WITHDRAW_ROUTES,
  sameAddress, encodeAddress, encodeUint, encodeCall, decodeCall, wordToAddress, wordToBigInt,
  makePolicy, expectedPoolWithdrawCall, hmrSocketAllowed, verifyMarketText, shortAddressRegex, assertSupply, assertWithdraw, withdrawGate,
  unexpectedNavigations, classifyRpcError, summarizeRpcItem,
  PINNED_AAVE_COMMIT, checkAavePin, redact, scrubEvidenceText, runnerMetadata, diagnosticStatus, RUNTIME_CHECKS, EXIT,
  cleanupVerdict, classifyAcceptance, gateVerdict, makeEgressHandler, redirectHop, MAX_REDIRECT_HOPS, positiveRouteHygiene, assertNativeRefusal,
};
