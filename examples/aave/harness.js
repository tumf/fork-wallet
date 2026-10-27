'use strict';
// Measured acceptance example: fork-wallet against the UNCHANGED, pinned Aave interface on an owned Base fork (macOS).
// Writes only examples/aave/artifacts/<ts>/ (gitignored). No product source is touched; no Aave source is touched.
// Owned processes: one anvil 1.8.3 fork child, one sandboxed `next dev` child (+ its server child), one Playwright
// Chromium. All stopped in finally. Never logs mnemonics, keys, signatures, calldata or raw signed payloads.
//
// Browser egress: app origin + gateway over HTTP only. The single WebSocket allowed is the Next dev HMR socket of the
// owned app origin (ws://127.0.0.1:<appPort>/_next/webpack-hmr, proxied frame-by-frame and counted); every other
// WebSocket is denied. Without that socket the unchanged Next client reloads the document after 25 failed reconnects
// (next/dist/client/dev/hot-reloader/pages/websocket.js), which destroyed the transaction modal in earlier runs.
// Main-frame navigations are recorded; any navigation during a transaction flow fails that step.
//
// Withdraw route (determined from the unchanged app sources, see lib.js WITHDRAW_ROUTES): the default "Unwrap WETH"
// toggle (native ETH) requires an aWETH->gateway approval of MaxUint256, which the 0.1 ETH approve cap refuses by design,
// so the native route is documented as blocked and proven blocked by a UI negative check. The accepted variant is the
// toggle OFF: a plain Pool.withdraw(WETH, 0.1 ETH, account) with no approval; the policy whitelists exactly that calldata.
//
// Exit status comes only from lib.js classifyAcceptance: 0 PASS, 4 DEGRADED (runtime checks passed, a diagnostic
// degraded), 2 FAILED, 3 BLOCKED (prerequisite/launch). See README.md.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { installForkWallet, createLoopbackRpc, requireLoopbackEndpoint } = require('../../src/index.js');
const { startReadGateway, requireNoCredentials, scrubbedEnv, freePort, listenerPids, requireOwnedPort, SUPPORTED_ANVIL } = require('../../src/anvil.js');
const L = require('./lib.js');

const AAVE_DIR = process.env.AAVE_DIR || '/tmp/fork-wallet-aave-interface-20261027';
const UPSTREAM = 'https://mainnet.base.org'; // the only external endpoint; read by the fork child (and one eth_blockNumber here)
const NODE_BIN_DIR = '/opt/homebrew/opt/node@24/bin';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const CHAIN_ID = 31337;
const BASE_CHAIN_ID = 8453;
const MARKET = 'fork_proto_base_v3';
const SUPPLY_WEI = (5n * L.WEI / 10n).toString(); // 0.5 ETH
const WITHDRAW_WEI = (L.WEI / 10n).toString(); // 0.1 ETH
const TOTAL_BUDGET_MS = 11 * 60 * 1000;
const PRODUCT_TIMEOUT_MS = 15000; // LIMITS.timeoutMs; never changed here
const PROBE_TIMEOUT_MS = 60000; // read-only diagnostic probe straight at the owned anvil, outside the product
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { redact } = L;

// Aave V3 Base addresses from the address book the app itself uses (@aave-dao/aave-address-book) + the app's own
// hardcoded UiPoolDataProvider (src/ui-config/marketsConfig.tsx). Verified on the fork by eth_getCode. Loaded only
// after the pin check, so an unpinned checkout's code is never required.
let ADDR = null;
function loadAddresses() {
  const AB = require(path.join(AAVE_DIR, 'node_modules', '@aave-dao', 'aave-address-book')).AaveV3Base;
  return {
    POOL: AB.POOL, WETH_GATEWAY: AB.WETH_GATEWAY, POOL_ADDRESSES_PROVIDER: AB.POOL_ADDRESSES_PROVIDER,
    UI_POOL_DATA_PROVIDER: '0x0c6bc4a12039788be08f87e87cff87fedbd1d386', UI_INCENTIVE_DATA_PROVIDER: AB.UI_INCENTIVE_DATA_PROVIDER,
    WALLET_BALANCE_PROVIDER: AB.WALLET_BALANCE_PROVIDER, WETH: AB.ASSETS.WETH.UNDERLYING, A_WETH: AB.ASSETS.WETH.A_TOKEN,
  };
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const artifacts = path.join(__dirname, 'artifacts', ts);
fs.mkdirSync(artifacts, { recursive: true });
const evidence = {
  ...L.runnerMetadata(process.env), forkWallet: require('../../package.json').version, aaveDir: AAVE_DIR, aavePinned: L.PINNED_AAVE_COMMIT, aaveCommit: null, aaveTrackedClean: null,
  upstream: UPSTREAM, startedAt: new Date().toISOString(), harnessPid: process.pid, addresses: null, fatal: null, acceptance: null, amounts: { supplyWei: SUPPLY_WEI, withdrawWei: WITHDRAW_WEI, approveCapWei: WITHDRAW_WEI },
  steps: [], pids: {}, listeners: {}, denied: {}, allowedHosts: [], consoleErrors: [], unsupported: [], calls: [], submitted: [], policyRefusals: [], notes: [],
  rpcSummary: {}, appHttpErrors: {}, redirects: {}, diagnostics: {}, sandbox: {}, anvilStderr: [],
  navigations: [], webSockets: { allowedRule: 'ws://<app host:port>/_next/webpack-hmr only', sessions: [], denied: [] }, modalSnapshots: {},
  withdrawRouteAnalysis: {
    source: ['src/components/transactions/Withdraw/WithdrawModal.tsx (withdrawUnWrapped = useState(true))',
      'src/components/transactions/Withdraw/WithdrawModalContent.tsx (poolAddress = unwrap && isWrappedBaseAsset ? API_ETH_MOCK_ADDRESS : underlyingAsset; DetailsUnwrapSwitch data-cy=wrappedSwitcher)',
      'src/components/transactions/Withdraw/WithdrawActions.tsx (useTransactionHandler tryPermit:false -> store.withdraw)',
      'src/store/poolSlice.ts withdraw -> @aave/contract-helpers v3-pool-contract Pool.withdraw (useOptimizedPath=false: src/utils/utils.ts optimizedPath is Arbitrum/Optimism only)',
      '@aave/contract-helpers v3-wethgateway-contract withdrawETH: approve(aWETH -> gateway, MaxUint256) when allowance < amount, then withdrawETH(pool, amount, user)'],
    'gateway-native': { capability: 'blocked', reason: 'unchanged app approves aWETH to the WETH gateway with MaxUint256 before withdrawETH; the 0.1 ETH approve cap refuses unlimited approvals; no allowance preload, no signing. The refusal itself is checked by ui.withdraw.ETH.native-refusal' },
    'pool-weth': { status: 'whitelisted', calldata: 'Pool.withdraw(WETH, exactly 0.1 ETH, account), value 0, no approval' },
  },
};
const step = (name, status, detail) => {
  const entry = { name, status, at: new Date().toISOString(), ...(detail !== undefined ? { detail } : {}) };
  evidence.steps.push(entry);
  console.log(`[${status}] ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 600) : ''}`);
  return entry;
};

// "prerequisite" until the browser, wallet and app are up; "acceptance" from the first UI step on. A fatal error in the
// prerequisite stage is BLOCKED (exit 3); in the acceptance stage it is FAILED (exit 2).
let stage = 'prerequisite';
const launched = {};
const fatalAt = (stepName, e) => { if (!evidence.fatal) evidence.fatal = { stage, step: stepName, error: redact(e && e.message, 600) }; };

async function run(name, fn, { fatal = false } = {}) {
  try { const r = await fn(); step(name, 'passed', r); return r; } catch (e) {
    step(name, 'failed', { error: redact(e && e.message), code: e && e.code });
    if (fatal) { fatalAt(name, e); throw e; }
    return undefined;
  }
}

async function publicRpc(method, params = []) {
  const res = await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  const j = await res.json();
  if (j.error) throw new Error(`upstream ${method}: ${j.error.message}`);
  return j.result;
}

/** Read-only probe straight at an endpoint with an explicit finite timeout (diagnostics only; never product code). */
async function probe(endpoint, method, params, timeoutMs) {
  const t0 = Date.now();
  try {
    const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const j = await res.json();
    if (j.error) return { ok: false, elapsedMs: Date.now() - t0, errorCode: j.error.code, errorClass: L.classifyRpcError(j.error), message: redact(j.error.message).slice(0, 160) };
    return { ok: true, elapsedMs: Date.now() - t0, resultBytes: typeof j.result === 'string' ? (j.result.length - 2) / 2 : JSON.stringify(j.result).length };
  } catch (e) {
    return { ok: false, elapsedMs: Date.now() - t0, errorClass: L.classifyRpcError(e), message: redact(e.message).slice(0, 160) };
  }
}

function ancestors(pid, maxDepth = 6) {
  const chain = [];
  let cur = pid;
  for (let i = 0; i < maxDepth && cur > 1; i++) {
    let ppid;
    try { ppid = Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(cur)], { encoding: 'utf8' }).trim()); } catch { break; }
    if (!ppid) break;
    chain.push(ppid);
    cur = ppid;
  }
  return chain;
}
const comm = (pid) => { try { return execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim().slice(0, 80); } catch { return null; } };

async function stopChild(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return 'already-exited';
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])) return 'terminated';
  child.kill('SIGKILL');
  return (await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])) ? 'killed' : 'did-not-exit';
}

/** Seatbelt profile: everything allowed except network, which is limited to the owned app and gateway loopback ports. */
function writeSandboxProfile(appPort, gatewayPort) {
  const profile = [
    '(version 1)', '(allow default)', '(deny network*)',
    `(allow network-bind (local ip "localhost:${appPort}"))`,
    `(allow network-inbound (local ip "localhost:${appPort}"))`,
    `(allow network-outbound (remote ip "localhost:${appPort}"))`,
    `(allow network-outbound (remote ip "localhost:${gatewayPort}"))`,
  ].join('\n') + '\n';
  const file = path.join(artifacts, 'next-sandbox.sb');
  fs.writeFileSync(file, profile);
  return file;
}

/** Negative + positive controls run through the SAME profile with the same scrubbed env before the app may start.
 * Asynchronous on purpose: the gateway under test lives in this process, so the event loop must stay free. */
function sandboxControl(profile, env, url, label) {
  const script = `fetch(${JSON.stringify(url)},{method:'POST',headers:{'content-type':'application/json'},body:'{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',signal:AbortSignal.timeout(8000)}).then(r=>r.text()).then(t=>{console.log(JSON.stringify({ok:true,body:t.slice(0,60)}))}).catch(e=>{console.log(JSON.stringify({ok:false,error:(e.cause&&(e.cause.code||e.cause.message))||e.name||e.message}))})`;
  return new Promise((resolve) => {
    const child = spawn(SANDBOX_EXEC, ['-f', profile, path.join(NODE_BIN_DIR, 'node'), '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { parsed = { ok: false, error: `no-output exit ${code}` }; }
      resolve({ label, url: url.replace(/^(https?:\/\/[^/]+).*$/, '$1'), ...parsed });
    });
  });
}

/** `git -C AAVE_DIR ...` output, or null when git fails (treated as unknown and failing closed by the pin check). */
function gitRead(args) {
  try { return execFileSync('/usr/bin/git', ['-C', AAVE_DIR, ...args], { encoding: 'utf8', timeout: 30000 }).trim(); } catch { return null; }
}

async function main() {
  let anvil = null; let anvilPort = null; let gateway = null; let next = null; let browser = null; let tmpHome = null; let walletRef = null;
  const close = {};
  // The pre-launch refusals run inside the same try/finally as the run itself, so a refusal still records close,
  // launched and a verified cleanup verdict (including the Aave tracked-status recheck once the pin check passed) and
  // classifies as BLOCKED (exit 3) instead of FAILED with an unverified cleanup.
  try {
    requireNoCredentials(process.env);
    if (!fs.existsSync(SANDBOX_EXEC)) throw new Error('sandbox-exec missing; refusing to run the app server without egress control');
    // Pin + tracked-clean check before anything is launched or any transaction can exist. No fetch/install here.
    const pin = await run('aave.pin', async () => {
      const head = gitRead(['rev-parse', 'HEAD']);
      const trackedStatus = gitRead(['status', '--porcelain', '--untracked-files=no']);
      evidence.aaveCommit = head;
      const result = L.checkAavePin({ head, trackedStatus });
      evidence.aaveTrackedClean = typeof trackedStatus === 'string' && result.dirty.length === 0 ? true : result.dirty;
      if (!result.ok) throw new Error(`refusing to test an unpinned or changed Aave app: ${result.reasons.join('; ')}`);
      return { head, trackedClean: true };
    }, { fatal: true });
    launched.aave = Boolean(pin);
    ADDR = loadAddresses();
    evidence.addresses = ADDR;
    const deadline = Date.now() + TOTAL_BUDGET_MS;
    const budgetLeft = () => deadline - Date.now();
    const env = scrubbedEnv(process.env);
    env.PATH = `${NODE_BIN_DIR}:${env.PATH}`;

    // 1. Upstream reachability + fixed fork block (read-only, no credentials).
    const latest = await run('upstream.eth_blockNumber', async () => Number(await publicRpc('eth_blockNumber')), { fatal: true });
    const forkBlock = latest - 5;
    evidence.forkBlock = forkBlock;

    // 2. Owned anvil fork child: unique HOME (no shared fork cache), scrubbed env, stderr captured redacted.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-wallet-aave-home-'));
    launched.tmpHome = true;
    anvilPort = await freePort();
    const endpoint = requireLoopbackEndpoint(`http://127.0.0.1:${anvilPort}`);
    const args = ['--host', '127.0.0.1', '--port', String(anvilPort), '--chain-id', String(CHAIN_ID), '--mnemonic-random', '--silent', '--no-cors',
      '--fork-url', UPSTREAM, '--fork-block-number', String(forkBlock), '--no-storage-caching'];
    anvil = spawn('anvil', args, { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: env.PATH, HOME: tmpHome } });
    launched.anvil = true;
    anvil.stderr.on('data', (d) => { for (const line of String(d).split('\n')) if (line.trim() && evidence.anvilStderr.length < 200) evidence.anvilStderr.push(redact(line).slice(0, 300)); });
    anvil.once('error', (e) => { anvil.launchError = e; });
    evidence.pids.anvil = anvil.pid;
    evidence.anvilArgs = args;
    const owned = () => { if (anvil.launchError || anvil.exitCode !== null || anvil.signalCode !== null) throw new Error('owned anvil not running'); process.kill(anvil.pid, 0); requireOwnedPort(anvil.pid, anvilPort); };
    const rpc = createLoopbackRpc(endpoint, { timeoutMs: PRODUCT_TIMEOUT_MS });
    await run('anvil.fork.start', async () => {
      const t0 = Date.now();
      let version = null;
      while (version === null) {
        if (anvil.launchError) throw new Error(`cannot start anvil: ${anvil.launchError.message}`);
        if (anvil.exitCode !== null) throw new Error(`anvil exited during startup (code ${anvil.exitCode})`);
        if (Date.now() - t0 > 90000) throw new Error('anvil fork did not become ready within 90s');
        try { version = await createLoopbackRpc(endpoint, { timeoutMs: 1000 })('web3_clientVersion'); } catch { await sleep(250); }
      }
      if (!SUPPORTED_ANVIL.test(version)) throw new Error(`unsupported client ${version}`);
      owned();
      const chain = await rpc('eth_chainId');
      if (chain !== '0x7a69') throw new Error(`chain ${chain}`);
      const accounts = await rpc('eth_accounts');
      evidence.account = accounts[0];
      return { version, readyMs: Date.now() - t0, accounts: accounts.length, listener: listenerPids(anvilPort) };
    }, { fatal: true });
    await run('anvil.fork.reads', async () => {
      const block = await rpc('eth_getBlockByNumber', ['latest', false]);
      const codes = {};
      for (const [k, a] of Object.entries(ADDR)) { const c = await rpc('eth_getCode', [a, 'latest']); codes[k] = (c.length - 2) / 2; if (k !== 'WETH' && codes[k] === 0) throw new Error(`${k} has no code on fork`); }
      const bal = await rpc('eth_getBalance', [evidence.account, 'latest']);
      evidence.forkBlockHash = block.hash;
      return { forkBlockNumber: Number(block.number), forkBlockHash: block.hash, codeBytes: codes, accountBalanceWei: BigInt(bal).toString() };
    }, { fatal: true });

    // 3. Read gateway (fork-wallet's own, unchanged limits) in this process.
    gateway = await startReadGateway({ endpoint, beforeSend: owned });
    launched.gateway = true;
    requireOwnedPort(process.pid, gateway.port);
    evidence.listeners.gateway = gateway.port;

    // 3b. Diagnostics on the SAME fork block: representative app read (UiPoolDataProvider.getReservesData) cold via the
    // product gateway (15s), then if it did not finish, once directly at the owned anvil with a 60s read-only probe
    // (warming the fork's in-memory state), then via the gateway again. Compare classes, never change the product.
    const reservesCall = [{ to: ADDR.UI_POOL_DATA_PROVIDER, data: L.encodeCall(L.SELECTORS.getReservesData, L.encodeAddress(ADDR.POOL_ADDRESSES_PROVIDER)) }, 'latest'];
    const diag = evidence.diagnostics;
    diag.representative = { contract: 'UiPoolDataProvider', to: ADDR.UI_POOL_DATA_PROVIDER, selector: L.SELECTORS.getReservesData, arg: 'POOL_ADDRESSES_PROVIDER' };
    diag.blockBefore = Number(await rpc('eth_blockNumber'));
    // Every diag.* step is classified on its own (passed / diagnostic-timeout / diagnostic-failed, error class and
    // timing kept). Diagnostics are never acceptance steps: a degraded one turns PASS into DEGRADED (exit 4), never
    // FAILED, and never hides a runtime failure. The product timeout is never changed here.
    diag.gatewayCold = await probe(gateway.publicEndpoint, 'eth_call', reservesCall, PRODUCT_TIMEOUT_MS + 5000);
    step('diag.gateway.cold', L.diagnosticStatus(diag.gatewayCold), diag.gatewayCold);
    if (!diag.gatewayCold.ok) {
      diag.directWarm = await probe(endpoint, 'eth_call', reservesCall, PROBE_TIMEOUT_MS);
      step('diag.direct.60s', L.diagnosticStatus(diag.directWarm), diag.directWarm);
      diag.gatewayAfterWarm = await probe(gateway.publicEndpoint, 'eth_call', reservesCall, PRODUCT_TIMEOUT_MS + 5000);
      step('diag.gateway.afterWarm', L.diagnosticStatus(diag.gatewayAfterWarm), diag.gatewayAfterWarm);
      // Warm the other reads the dashboard needs once (same block, read-only, direct), so the unchanged product path is measured warm.
      diag.warmOthers = {};
      diag.warmOthers.incentives = await probe(endpoint, 'eth_call', [{ to: ADDR.UI_INCENTIVE_DATA_PROVIDER, data: L.encodeCall(L.SELECTORS.getReservesIncentivesData, L.encodeAddress(ADDR.POOL_ADDRESSES_PROVIDER)) }, 'latest'], PROBE_TIMEOUT_MS);
      diag.warmOthers.userReserves = await probe(endpoint, 'eth_call', [{ to: ADDR.UI_POOL_DATA_PROVIDER, data: L.encodeCall(L.SELECTORS.getUserReservesData, L.encodeAddress(ADDR.POOL_ADDRESSES_PROVIDER), L.encodeAddress(evidence.account)) }, 'latest'], PROBE_TIMEOUT_MS);
      diag.warmOthers.walletBalances = await probe(endpoint, 'eth_call', [{ to: ADDR.WALLET_BALANCE_PROVIDER, data: L.encodeCall(L.SELECTORS.getUserWalletBalances, L.encodeAddress(ADDR.POOL_ADDRESSES_PROVIDER), L.encodeAddress(evidence.account)) }, 'latest'], PROBE_TIMEOUT_MS);
      step('diag.warm.others', L.diagnosticStatus(Object.values(diag.warmOthers)), diag.warmOthers);
    }
    diag.blockAfter = Number(await rpc('eth_blockNumber'));
    diag.anvilStderrLines = evidence.anvilStderr.length;
    if (budgetLeft() < 4 * 60 * 1000) { const e = new Error('budget: diagnostics consumed too much time; app branch not started'); fatalAt('budget', e); throw e; }

    // 4. Sandboxed, unchanged Aave interface via `next dev`. Network for next and all its children is limited to the
    // owned app and gateway loopback ports by sandbox-exec; controls prove it before the app starts.
    const appPort = await freePort();
    const appOrigin = `http://127.0.0.1:${appPort}`;
    gateway.configureOrigin(appOrigin);
    const profile = writeSandboxProfile(appPort, gateway.port);
    evidence.sandbox.profile = profile;
    const envFileKeys = fs.existsSync(path.join(AAVE_DIR, '.env.development'))
      ? fs.readFileSync(path.join(AAVE_DIR, '.env.development'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split('=')[0]) : [];
    // next dev auto-loads the tracked .env.development; @next/env never overrides keys already present in the process
    // environment, so every key it declares is pre-set here to a harmless loopback/empty value (values never read).
    const nextEnv = {
      PATH: env.PATH, HOME: env.HOME, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development',
      NEXT_PUBLIC_ENV: 'prod', NEXT_PUBLIC_IS_CYPRESS_ENABLED: 'true', NEXT_PUBLIC_ENABLE_GOVERNANCE: 'false', NEXT_PUBLIC_ENABLE_STAKING: 'false',
      NEXT_PUBLIC_FIAT_ON_RAMP: 'false', NEXT_PUBLIC_PRIVATE_RPC_ENABLED: 'false',
      NEXT_PUBLIC_FORK_BASE_CHAIN_ID: String(BASE_CHAIN_ID), NEXT_PUBLIC_FORK_CHAIN_ID: String(CHAIN_ID), NEXT_PUBLIC_FORK_URL_RPC: gateway.publicEndpoint,
    };
    for (const k of envFileKeys) if (!(k in nextEnv)) nextEnv[k] = /URL/i.test(k) ? 'http://127.0.0.1:9/' : '';
    evidence.nextEnv = nextEnv; // only public test settings, loopback URLs and empty shadows
    evidence.envFileKeysShadowed = envFileKeys;
    await run('sandbox.controls', async () => {
      const controls = [
        await sandboxControl(profile, nextEnv, UPSTREAM + '/', 'negative:public-upstream'),
        await sandboxControl(profile, nextEnv, `http://127.0.0.1:${anvilPort}/`, 'negative:loopback-anvil-port-not-allowed'),
        await sandboxControl(profile, nextEnv, gateway.publicEndpoint + '/', 'positive:gateway-port'),
      ];
      evidence.sandbox.controls = controls;
      if (controls[0].ok || controls[1].ok) throw new Error('sandbox did NOT deny egress; server branch stopped');
      if (!controls[2].ok) throw new Error('sandbox denied the gateway port too; profile unusable, server branch stopped');
      return controls;
    }, { fatal: true });

    const nextLog = fs.openSync(path.join(artifacts, 'next-dev.log'), 'w');
    evidence.listeners.app = appPort;
    next = spawn(SANDBOX_EXEC, ['-f', profile, path.join(AAVE_DIR, 'node_modules', '.bin', 'next'), 'dev', '-H', '127.0.0.1', '-p', String(appPort)], { cwd: AAVE_DIR, stdio: ['ignore', nextLog, nextLog], env: nextEnv });
    launched.next = true;
    next.once('error', (e) => { next.launchError = e; });
    evidence.pids.next = next.pid;
    await run('aave.next-dev.ready', async () => {
      const t0 = Date.now();
      for (;;) {
        if (next.launchError) throw new Error(`cannot start next: ${next.launchError.message}`);
        if (next.exitCode !== null) throw new Error(`next exited (code ${next.exitCode}); see next-dev.log`);
        if (Date.now() - t0 > 180000) throw new Error('next dev not ready within 180s');
        try {
          const res = await fetch(appOrigin + '/', { signal: AbortSignal.timeout(120000) });
          if (res.status === 200) { const html = await res.text(); return { readyMs: Date.now() - t0, htmlBytes: html.length }; }
          throw new Error(`status ${res.status}`);
        } catch (e) { if (Date.now() - t0 > 180000) throw e; await sleep(1000); }
      }
    }, { fatal: true });
    evidence.listeners.appPids = listenerPids(appPort).map((pid) => { const chain = ancestors(pid); return { pid, comm: comm(pid), ancestors: chain, ownedByNext: pid === next.pid || chain.includes(next.pid) }; });
    evidence.pids.nextComm = comm(next.pid);
    if (!evidence.listeners.appPids.length || !evidence.listeners.appPids.every((p) => p.ownedByNext)) { const e = new Error(`app port ${appPort} listener not owned: ${JSON.stringify(evidence.listeners.appPids)}`); fatalAt('aave.app.listener', e); throw e; }
    // The server-side API routes must fail closed inside the sandbox (they fetch external services).
    evidence.sandbox.serverApiProbe = {};
    for (const p of ['/api/protocol-totals', '/api/coingecko-categories']) {
      try { const r = await fetch(appOrigin + p, { signal: AbortSignal.timeout(30000) }); evidence.sandbox.serverApiProbe[p] = r.status; } catch (e) { evidence.sandbox.serverApiProbe[p] = redact(e.message).slice(0, 80); }
    }
    step('sandbox.server-api-routes', 'passed', evidence.sandbox.serverApiProbe);

    // 5. Browser: egress denied except app origin + gateway; service workers blocked; the only websocket is the app's own
    // Next HMR socket (proxied + counted); no trace/HAR/video.
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    launched.browser = true;
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 1000 } });
    evidence.allowedHosts = [appOrigin, gateway.publicEndpoint];
    // Same handler the selfcheck redirect control exercises: both proxy sites fetch with maxRedirects: 0 and every
    // redirect hop is re-checked against this allowlist (followed only to the app/gateway origins, otherwise aborted).
    await context.route('**/*', L.makeEgressHandler({
      appOrigin,
      gatewayOrigin: gateway.publicEndpoint,
      async onGatewayResponse({ request, response, elapsedMs }) {
        if (request.method() !== 'POST') return;
        const body = await response.json();
        const req = request.postDataJSON();
        const reqs = Array.isArray(req) ? req : [req];
        const ress = Array.isArray(body) ? body : [body];
        reqs.forEach((item, i) => L.summarizeRpcItem(evidence.rpcSummary, item, ress[i], elapsedMs));
      },
      onAppResponse({ request, response }) {
        if (response.status() >= 400) { const k = `${response.status()} ${new URL(request.url()).pathname}`; evidence.appHttpErrors[k] = (evidence.appHttpErrors[k] || 0) + 1; }
      },
      onRedirect({ from, status, target, decision }) { const k = `${status} ${from} -> ${target} ${decision}`; evidence.redirects[k] = (evidence.redirects[k] || 0) + 1; },
      onDenied({ url, redirect }) {
        let key = '?';
        try { key = redirect ? `redirect:${redirect.status}->${redirect.target}` : new URL(url).host; } catch {}
        evidence.denied[key] = (evidence.denied[key] || 0) + 1;
      },
    }));
    // WebSockets: exactly ws://<app host:port>/_next/webpack-hmr of the owned app origin is connected through to the
    // sandboxed next dev server (frames counted, never stored); everything else is closed and recorded as denied.
    await context.routeWebSocket('**', (ws) => {
      const url = ws.url();
      if (!L.hmrSocketAllowed(url, appOrigin)) {
        let host = '?'; try { host = new URL(url).host; } catch {}
        evidence.denied['ws:' + host] = (evidence.denied['ws:' + host] || 0) + 1;
        if (evidence.webSockets.denied.length < 50) evidence.webSockets.denied.push({ url: String(url).slice(0, 120), at: new Date().toISOString() });
        ws.close({ code: 1008, reason: 'denied' });
        return;
      }
      const session = { path: new URL(url).pathname, openedAt: new Date().toISOString(), toServer: 0, fromServer: 0, closedAt: null, closedBy: null };
      evidence.webSockets.sessions.push(session);
      const server = ws.connectToServer();
      ws.onMessage((m) => { session.toServer++; server.send(m); });
      server.onMessage((m) => { session.fromServer++; ws.send(m); });
      ws.onClose((code, reason) => { session.closedAt = new Date().toISOString(); session.closedBy = 'page'; server.close({ code, reason }); });
      server.onClose((code, reason) => { session.closedAt = new Date().toISOString(); session.closedBy = 'server'; ws.close({ code, reason }); });
    });
    // Documented fork config (CONTRIBUTING.md "Running Against a Chain Fork") + the documented Cypress market preselect.
    await context.addInitScript(([rpcUrl, market]) => {
      try {
        localStorage.setItem('forkEnabled', 'true'); localStorage.setItem('forkBaseChainId', '8453'); localStorage.setItem('forkNetworkId', '31337');
        localStorage.setItem('forkRPCUrl', rpcUrl); localStorage.setItem('selectedMarket', market);
      } catch {}
    }, [gateway.publicEndpoint, MARKET]);
    // Per-document id (init scripts run once per new document, never on same-document router navigations): the
    // navigation guard uses it to detect a reload during a transaction flow.
    await context.addInitScript(() => { window.__spikeDocId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); });

    // Policy: supply (exact depositETH) + withdraw route pool-weth only (byte-exact Pool.withdraw(WETH, 0.1 ETH, account), value 0).
    // The gateway-native route is NOT whitelisted; its approve(MaxUint256) is refused by the cap and recorded as a policy refusal.
    const policy = L.makePolicy({ account: evidence.account, addresses: ADDR, supplyWei: SUPPLY_WEI, withdrawWei: WITHDRAW_WEI, withdrawRoutes: ['pool-weth'] });
    const expectedWithdraw = L.expectedPoolWithdrawCall({ account: evidence.account, addresses: ADDR, withdrawWei: WITHDRAW_WEI });
    evidence.expectedWithdrawCall = { to: expectedWithdraw.to, value: '0', selector: L.SELECTORS.withdraw, asset: ADDR.WETH, amountWei: WITHDRAW_WEI, recipient: evidence.account,
      dataBytes: (expectedWithdraw.data.length - 2) / 2, dataSha256: require('node:crypto').createHash('sha256').update(expectedWithdraw.data.toLowerCase()).digest('hex') };
    const wallet = await installForkWallet(context, {
      endpoint, origin: appOrigin, chainId: CHAIN_ID, account: evidence.account, beforeSend: owned,
      validateTransaction(tx) {
        try { const ok = policy(tx); evidence.notes.push(`policy accepted ${ok.op} ${ok.amountWei} wei to ${tx.to}`); return ok; } catch (e) { evidence.policyRefusals.push({ to: tx.to, selector: L.decodeCall(tx.data).selector, reason: e.message, at: new Date().toISOString() }); throw e; }
      },
    });
    walletRef = wallet;
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && evidence.consoleErrors.length < 60) evidence.consoleErrors.push(redact(m.text()).slice(0, 300)); });
    page.on('pageerror', (e) => { if (evidence.consoleErrors.length < 60) evidence.consoleErrors.push('pageerror: ' + redact(e.message).slice(0, 300)); });
    // Main-frame navigations: `framenavigated` (also same-document URL changes, recorded for diagnostics) and `load`
    // (new document). The guard compares a per-document id set by an init script, so only a real document load/reload
    // (e.g. the Next HMR client giving up) trips it; the app's own router.push/replace does not.
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame() && evidence.navigations.length < 50) evidence.navigations.push({ kind: 'framenavigated', url: frame.url().slice(0, 200), at: new Date().toISOString() }); });
    page.on('load', () => { if (evidence.navigations.length < 50) evidence.navigations.push({ kind: 'load', url: page.url().slice(0, 200), at: new Date().toISOString() }); });
    const docId = () => page.evaluate(() => window.__spikeDocId || null).catch(() => null);
    const navGuard = async (label) => {
      const baselineDoc = await docId();
      const baseline = evidence.navigations.length;
      if (!baselineDoc) throw new Error(`${label}: document id missing (init script did not run)`);
      return async () => {
        const now = await docId();
        if (now !== baselineDoc) throw new Error(`${label}: unexpected main-frame document load/reload (doc ${baselineDoc} -> ${now}); navigations ${JSON.stringify(L.unexpectedNavigations(evidence.navigations, baseline))}`);
      };
    };
    const snapshot = (label) => { evidence[`calls.${label}`] = wallet.calls.map((c) => ({ method: c.method, outcome: c.outcome, error: c.error && c.error.code })); };
    const balanceOf = async (token) => BigInt(await rpc('eth_call', [{ to: token, data: L.encodeCall(L.SELECTORS.balanceOf, L.encodeAddress(evidence.account)) }, 'latest'])).toString();
    const aWethBalance = () => balanceOf(ADDR.A_WETH);
    const wethBalance = () => balanceOf(ADDR.WETH);
    const receiptOf = async (hash) => { const r = await rpc('eth_getTransactionReceipt', [hash]); return r && { status: r.status, to: r.to, gasUsed: r.gasUsed, blockNumber: r.blockNumber, logs: (r.logs || []).map((l) => ({ address: l.address, topics: l.topics, data: l.data })) }; };
    const modal = page.locator('[data-cy=Modal]');
    const modalText = async () => (await modal.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    /** Sanitized snapshot of the visible modal: title/text (redacted, truncated), buttons with disabled state, switch state. Never calldata. */
    const modalSnapshot = async (label) => {
      const snap = await page.evaluate(() => {
        const m = document.querySelector('[data-cy=Modal]');
        if (!m) return { visible: false };
        const buttons = [...m.querySelectorAll('button')].map((b) => ({ text: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60), disabled: b.disabled, cy: b.getAttribute('data-cy') }));
        const sw = m.querySelector('[data-cy=wrappedSwitcher] input[type=checkbox]');
        const alerts = [...m.querySelectorAll('[role=alert]')].map((a) => (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200));
        return { visible: true, text: (m.innerText || '').replace(/\s+/g, ' ').slice(0, 400), buttons: buttons.slice(0, 12), unwrapSwitchChecked: sw ? sw.checked : null, alerts: alerts.slice(0, 5) };
      }).catch((e) => ({ visible: null, error: String(e && e.message).slice(0, 120) }));
      if (snap.text) snap.text = redact(snap.text);
      if (snap.alerts) snap.alerts = snap.alerts.map(redact);
      evidence.modalSnapshots[label] = { at: new Date().toISOString(), url: page.url().slice(0, 200), ...snap };
      return evidence.modalSnapshots[label];
    };
    /**
     * Bounded outcome wait for one UI-initiated flow: polls (500 ms) the wallet's submitted hashes (receipts from the owned
     * fork, mined on submission), the modal's terminal text, wallet failures (policy refusal / unsupported) and the
     * navigation guard. Stops at the first terminal condition; never waits the full budget just for modal text.
     */
    const awaitOutcome = async ({ submittedBefore, expectTx, guard, receiptMs = 60000, uiMs = 30000, label }) => {
      const t0 = Date.now();
      const callsBefore = wallet.calls.length;
      const refusalsBefore = evidence.policyRefusals.length;
      const terminal = /Supplied Successfully|Withdrawn Successfully|All done|Transaction Failed|There was some error|something went wrong|rejected|refused|failed/i;
      let receipts = []; let text = ''; let reason = null; let firstReceiptAt = null;
      for (;;) {
        await guard();
        const submitted = wallet.submitted.slice(submittedBefore);
        if (submitted.length > receipts.length) { receipts = []; for (const h of submitted) receipts.push({ hash: h, receipt: await receiptOf(h) }); }
        const mined = receipts.length > 0 && receipts.every((r) => r.receipt);
        if (mined && firstReceiptAt === null) firstReceiptAt = Date.now();
        text = await modalText();
        // A policy refusal happens before the wallet admits the request (no `calls` record); the harness wrapper records it.
        const refused = evidence.policyRefusals.length > refusalsBefore;
        const walletFailure = wallet.calls.slice(callsBefore).find((c) => ['failed', 'rejected', 'cancelled', 'unknown', 'response-lost'].includes(c.outcome)) || (refused ? { outcome: 'policy-refused' } : null);
        if (terminal.test(text)) { reason = 'ui-terminal'; break; }
        if (walletFailure && !expectTx) { reason = `wallet-${walletFailure.outcome}`; await sleep(1000); text = await modalText(); break; }
        if (walletFailure && expectTx && !mined) { reason = `wallet-${walletFailure.outcome}`; break; }
        const elapsed = Date.now() - t0;
        if (mined && Date.now() - firstReceiptAt > uiMs) { reason = 'receipt-mined-ui-silent'; break; }
        if (!mined && elapsed > receiptMs) { reason = expectTx ? 'no-receipt-within-budget' : 'no-terminal-within-budget'; break; }
        await sleep(500);
      }
      await guard();
      const submitted = wallet.submitted.slice(submittedBefore);
      if (submitted.length > receipts.length) { receipts = []; for (const h of submitted) receipts.push({ hash: h, receipt: await receiptOf(h) }); }
      step(`${label}.outcome`, 'observed', { reason, elapsedMs: Date.now() - t0, submitted: submitted.length, mined: receipts.filter((r) => r.receipt).length });
      return { reason, submitted, receipts, text, elapsedMs: Date.now() - t0 };
    };

    /** Exact market after a normal document load: text of the single market selector; fall back to the app's own switcher UI. */
    const verifyMarket = async (label) => {
      await page.waitForLoadState('load', { timeout: 120000 });
      const selector = page.locator('[data-cy=marketSelector]');
      await selector.waitFor({ state: 'visible', timeout: 120000 });
      await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 60000 });
      await sleep(1500); // the store applies selectedMarket on readyState=complete (src/store/root.ts:54-65)
      const before = L.verifyMarketText(await selector.innerText());
      let switched = false;
      if (!before.ok) {
        await selector.click();
        const item = page.locator(`[data-cy=marketSelector_${MARKET}]`);
        await item.waitFor({ state: 'visible', timeout: 20000 });
        await item.click();
        switched = true;
        await page.waitForFunction(() => /^BaseFork/.test((document.querySelector('[data-cy=marketSelector]')?.innerText || '').replace(/\s+/g, '')), null, { timeout: 30000 });
      }
      const after = L.verifyMarketText(await selector.innerText());
      const stored = await page.evaluate(() => localStorage.getItem('selectedMarket'));
      const result = { label, before: before.compact, switchedViaUi: switched, after: after.compact, stored, url: page.url() };
      if (!after.ok || stored !== MARKET) throw new Error(`market not Base Fork V3: ${JSON.stringify(result)}`);
      return result;
    };
    /** The header's connect button shows the connected account as 0x12...abcd (unique target; checked case-insensitively). */
    const verifyAccount = async () => {
      const re = L.shortAddressRegex(evidence.account);
      const target = page.locator('header').getByRole('button').filter({ hasText: re });
      await target.first().waitFor({ state: 'visible', timeout: 60000 });
      const count = await target.count();
      const text = (await target.first().innerText()).replace(/\s+/g, ' ').slice(0, 60);
      const connect = wallet.calls.find((c) => c.method === 'eth_requestAccounts' || c.method === 'wallet_requestPermissions');
      if (count !== 1 || !connect || connect.outcome !== 'approved') throw new Error(`account not shown exactly once with approved connect: count=${count} connect=${JSON.stringify(connect && { method: connect.method, outcome: connect.outcome })}`);
      return { headerText: text, connectRequest: { method: connect.method, outcome: connect.outcome }, walletAccount: wallet.account === evidence.account, chainId: wallet.chainId };
    };

    stage = 'acceptance';
    await run('ui.load', async () => {
      await page.goto(`${appOrigin}/?marketName=${MARKET}`, { waitUntil: 'load', timeout: 150000 });
      return verifyMarket('after-load');
    }, { fatal: true });
    evidence.selectedMarketBeforeActions = evidence.steps.at(-1).detail;

    await run('ui.connect', verifyAccount, { fatal: true });
    snapshot('afterConnect');

    const supplyRow = page.locator('[data-cy="dashboardSupplyListItem_ETH"]');
    await run('ui.dashboard.assets', async () => {
      await supplyRow.waitFor({ state: 'visible', timeout: 150000 });
      const market = await verifyMarket('before-supply');
      return { ethRowVisible: true, market, rpcKeys: Object.keys(evidence.rpcSummary).length };
    }, { fatal: true });

    let supplyResult;
    await run('ui.supply.ETH', async () => {
      if (budgetLeft() < 2 * 60 * 1000) throw new Error('budget exhausted before supply');
      const guard = await navGuard('supply');
      const balanceBefore = await aWethBalance();
      const submittedBefore = wallet.submitted.length;
      const refusalsBefore = evidence.policyRefusals.length;
      const unsupportedBefore = wallet.unsupported.length;
      await supplyRow.getByRole('button', { name: /^supply$/i }).first().click({ timeout: 30000 });
      await modal.waitFor({ state: 'visible', timeout: 30000 });
      const input = modal.locator('input[aria-label="amount input"]').first();
      await input.fill('0.5', { timeout: 20000 });
      const action = modal.locator('[data-cy=actionButton]');
      await action.waitFor({ state: 'visible', timeout: 30000 });
      await page.waitForFunction(() => { const b = document.querySelector('[data-cy=Modal] [data-cy=actionButton]'); return b && !b.disabled; }, null, { timeout: 60000 }).catch(() => {});
      await guard();
      await modalSnapshot('supply.beforeClick');
      await action.click({ timeout: 30000 });
      const outcome = await awaitOutcome({ submittedBefore, expectTx: true, guard, label: 'ui.supply.ETH' });
      snapshot('afterSupply');
      const { submitted, receipts, text } = outcome;
      const balanceAfter = await aWethBalance();
      const assertion = L.assertSupply({ submitted, receipts, balanceBeforeWei: balanceBefore, balanceAfterWei: balanceAfter, account: evidence.account, addresses: ADDR, supplyWei: SUPPLY_WEI });
      const hygiene = L.positiveRouteHygiene({ refusals: evidence.policyRefusals.slice(refusalsBefore), unsupported: wallet.unsupported.slice(unsupportedBefore) });
      supplyResult = { ...assertion, pass: assertion.pass && hygiene.pass, reasons: [...assertion.reasons, ...hygiene.reasons] };
      const detail = { outcome: outcome.reason, elapsedMs: outcome.elapsedMs, modalText: redact(text), submitted: receipts.map((r) => ({ hash: r.hash, status: r.receipt && r.receipt.status, to: r.receipt && r.receipt.to, gasUsed: r.receipt && r.receipt.gasUsed, logs: r.receipt && r.receipt.logs.length })), aWethBefore: balanceBefore, aWethAfter: balanceAfter, assertion: supplyResult, policyRefusals: evidence.policyRefusals.length - refusalsBefore, unsupported: wallet.unsupported.length - unsupportedBefore };
      if (!supplyResult.pass) { await modalSnapshot('supply.failed'); throw new Error(`supply not proven: ${supplyResult.reasons.join('; ')} | ${JSON.stringify(detail)}`); }
      await guard();
      return detail;
    });

    /** Closes the open modal through the app's own controls. The success/error views hide the close icon
     * (useHideModalCloseButton in TxResultActions) and offer a "Done"/"Close" button instead; an open MUI modal keeps the
     * dashboard aria-hidden, so staying open must fail loudly rather than silently. */
    const closeModal = async () => {
      if (!(await modal.isVisible().catch(() => false))) return 'already-closed';
      const attempts = [
        ['done-button', () => modal.getByRole('button', { name: /^(Done|Close)$/i }).first().click({ timeout: 5000 })],
        ['close-icon', () => modal.locator('[data-cy=close-button]').first().click({ timeout: 5000 })],
        ['escape', () => page.keyboard.press('Escape')],
      ];
      for (const [how, act] of attempts) {
        if (!(await modal.isVisible().catch(() => false))) return how;
        try { await act(); } catch { continue; }
        if (await modal.waitFor({ state: 'hidden', timeout: 5000 }).then(() => true, () => false)) return how;
      }
      if (await modal.isVisible().catch(() => false)) { const snap = await modalSnapshot('closeModal.failed'); throw new Error(`modal could not be closed: ${JSON.stringify(snap)}`); }
      return 'closed';
    };
    const suppliedRow = page.locator('[data-cy^="dashboardSuppliedListItem_WETH_"], [data-cy^="dashboardSuppliedListItem_ETH_"]').first();
    /** Opens the Withdraw modal from the supplied WETH row and sets the "Unwrap WETH" toggle to the requested state (via the app's own switch). */
    const openWithdrawModal = async (unwrap) => {
      await suppliedRow.waitFor({ state: 'visible', timeout: 120000 });
      await suppliedRow.getByRole('button', { name: /^withdraw$/i }).first().click({ timeout: 30000 });
      await modal.waitFor({ state: 'visible', timeout: 30000 });
      const sw = modal.locator('[data-cy=wrappedSwitcher]');
      await sw.waitFor({ state: 'visible', timeout: 30000 });
      const checkbox = modal.locator('[data-cy=wrappedSwitcher] input[type=checkbox]');
      const initially = await checkbox.isChecked();
      if (initially !== unwrap) {
        await sw.click({ timeout: 10000 });
        if ((await checkbox.isChecked()) !== unwrap) await checkbox.click({ timeout: 10000, force: true });
      }
      const checked = await checkbox.isChecked();
      if (checked !== unwrap) throw new Error(`unwrap switch could not be set to ${unwrap} (checked=${checked})`);
      const title = (await modal.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
      return { initiallyUnwrap: initially, unwrap: checked, titleText: redact(title) };
    };

    const gate = L.withdrawGate(supplyResult);
    if (!gate.allowed) { step('ui.withdraw.WETH', 'blocked', { reason: gate.reason }); step('ui.withdraw.ETH.native-refusal', 'blocked', { reason: gate.reason }); }
    else {
      // Accepted variant: Unwrap toggle OFF -> ordinary Pool.withdraw(WETH, 0.1 ETH, account). No approval exists on this route.
      let withdrawPassed = false;
      await run('ui.withdraw.WETH', async () => {
        if (budgetLeft() < 90 * 1000) throw new Error('budget exhausted before withdraw');
        await closeModal();
        const market = await verifyMarket('before-withdraw');
        const guard = await navGuard('withdraw.WETH');
        const aWethBefore = await aWethBalance();
        const wethBefore = await wethBalance();
        const submittedBefore = wallet.submitted.length;
        const refusalsBefore = evidence.policyRefusals.length;
        const unsupportedBefore = wallet.unsupported.length;
        const toggle = await openWithdrawModal(false);
        if (!/Withdraw\s+WETH/i.test(toggle.titleText)) throw new Error(`modal does not show the WETH route after toggling: ${toggle.titleText}`);
        await modal.locator('input[aria-label="amount input"]').first().fill('0.1', { timeout: 20000 });
        const approvalBtn = modal.locator('[data-cy=approvalButton]');
        const actionBtn = modal.locator('[data-cy=actionButton]');
        await page.waitForFunction(() => { const b = document.querySelector('[data-cy=Modal] [data-cy=actionButton]'); return b && !b.disabled; }, null, { timeout: 60000 }).catch(() => {});
        const before = await modalSnapshot('withdraw.WETH.beforeClick');
        if (await approvalBtn.isVisible().catch(() => false)) throw new Error(`unexpected approval step on the pool-weth route: ${JSON.stringify(before)}`);
        const actionText = (await actionBtn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (!/Withdraw\s+WETH/i.test(actionText)) throw new Error(`action button is not "Withdraw WETH": ${JSON.stringify(before)}`);
        if (await actionBtn.isDisabled()) throw new Error(`action button still disabled: ${JSON.stringify(before)}`);
        await guard();
        await actionBtn.click({ timeout: 30000 });
        const outcome = await awaitOutcome({ submittedBefore, expectTx: true, guard, label: 'ui.withdraw.WETH' });
        snapshot('afterWithdraw');
        const { submitted, receipts, text } = outcome;
        const aWethAfter = await aWethBalance();
        const wethAfter = await wethBalance();
        const withdrawAssertion = L.assertWithdraw({ submitted, receipts, balanceBeforeWei: aWethBefore, balanceAfterWei: aWethAfter, wethBeforeWei: wethBefore, wethAfterWei: wethAfter, account: evidence.account, addresses: ADDR, withdrawWei: WITHDRAW_WEI, route: 'pool-weth' });
        const hygiene = L.positiveRouteHygiene({ refusals: evidence.policyRefusals.slice(refusalsBefore), unsupported: wallet.unsupported.slice(unsupportedBefore) });
        const assertion = { ...withdrawAssertion, pass: withdrawAssertion.pass && hygiene.pass, reasons: [...withdrawAssertion.reasons, ...hygiene.reasons] };
        const detail = { route: 'pool-weth', market: market.after, toggle, outcome: outcome.reason, elapsedMs: outcome.elapsedMs, modalText: redact(text), submitted: receipts.map((r) => ({ hash: r.hash, status: r.receipt && r.receipt.status, to: r.receipt && r.receipt.to, gasUsed: r.receipt && r.receipt.gasUsed, logs: r.receipt && r.receipt.logs.length })), aWethBefore, aWethAfter, wethBefore, wethAfter, assertion, policyRefusals: evidence.policyRefusals.slice(refusalsBefore), unsupported: wallet.unsupported.length - unsupportedBefore };
        if (!assertion.pass) { await modalSnapshot('withdraw.WETH.failed'); throw new Error(`withdraw not proven: ${assertion.reasons.join('; ')} | ${JSON.stringify(detail)}`); }
        await guard();
        withdrawPassed = true;
        return detail;
      });

      // Negative check of the policy boundary on the real UI: Unwrap toggle ON (the app's default) must end in exactly one
      // policy refusal of the aWETH -> gateway MaxUint256 approval with nothing submitted. Its own pass/fail/blocked status
      // is the refusal check; native withdrawal capability is reported blocked separately (evidence.acceptance). A check
      // that is not attempted (WETH route failed, budget exhausted) is "blocked", which fails acceptance.
      if (!withdrawPassed) step('ui.withdraw.ETH.native-refusal', 'blocked', { reason: 'WETH route did not pass; refusal check not attempted' });
      else if (budgetLeft() < 60 * 1000) step('ui.withdraw.ETH.native-refusal', 'blocked', { reason: 'budget exhausted; refusal check not attempted' });
      else {
        await run('ui.withdraw.ETH.native-refusal', async () => {
          await closeModal();
          await verifyMarket('before-native-negative');
          const guard = await navGuard('withdraw.ETH.native-refusal');
          const aWethBefore = await aWethBalance();
          const submittedBefore = wallet.submitted.length;
          const refusalsBefore = evidence.policyRefusals.length;
          const unsupportedBefore = wallet.unsupported.length;
          const toggle = await openWithdrawModal(true);
          await modal.locator('input[aria-label="amount input"]').first().fill('0.1', { timeout: 20000 });
          const approvalBtn = modal.locator('[data-cy=approvalButton]');
          await page.waitForFunction(() => { const b = document.querySelector('[data-cy=Modal] [data-cy=approvalButton]'); return b && !b.disabled; }, null, { timeout: 60000 }).catch(() => {});
          const before = await modalSnapshot('withdraw.ETH.native.beforeClick');
          if (!(await approvalBtn.isVisible().catch(() => false))) throw new Error(`expected an approval step on the native route, none shown: ${JSON.stringify(before)}`);
          await guard();
          await approvalBtn.click({ timeout: 30000 });
          const outcome = await awaitOutcome({ submittedBefore, expectTx: false, guard, receiptMs: 45000, label: 'ui.withdraw.ETH.native-refusal' });
          const refusals = evidence.policyRefusals.slice(refusalsBefore);
          const unsupported = wallet.unsupported.slice(unsupportedBefore);
          const after = await modalSnapshot('withdraw.ETH.native.afterClick');
          const aWethAfter = await aWethBalance();
          const assertion = L.assertNativeRefusal({ submitted: outcome.submitted, refusals, unsupported, aWethBeforeWei: aWethBefore, aWethAfterWei: aWethAfter, addresses: ADDR });
          const detail = { toggle, outcome: outcome.reason, submitted: outcome.submitted.length, refusals, unsupported: unsupported.map((u) => u.method), aWethBefore, aWethAfter, modal: after, assertion, capability: evidence.withdrawRouteAnalysis['gateway-native'] };
          if (!assertion.pass) throw new Error(`native refusal not proven: ${assertion.reasons.join('; ')} | ${JSON.stringify(detail)}`);
          await guard();
          return { ...detail, verified: 'unlimited approval refused by policy; nothing submitted; balances unchanged' };
        });
        await run('ui.modal.close', closeModal);
      }
    }
  } catch (e) {
    fatalAt(null, e);
    console.error(`${stage === 'prerequisite' ? 'blocked' : 'failed'}:`, redact(e && e.message, 600));
  } finally {
    if (walletRef) {
      // Final wallet-side summary (methods/outcomes/codes only; hashes are local fork hashes).
      evidence.unsupported = [...new Set(walletRef.unsupported.map((u) => u.method))];
      evidence.calls = walletRef.calls.map((c) => ({ method: c.method, outcome: c.outcome, error: c.error && { code: c.error.code, message: redact(c.error.message, 200) } }));
      evidence.submitted = [...walletRef.submitted];
      // One connect request per document load: more than one means the page was reloaded during the run.
      evidence.connectRequests = walletRef.calls.filter((c) => c.method === 'eth_requestAccounts' || c.method === 'wallet_requestPermissions').length;
      evidence.webSockets.summary = { sessions: evidence.webSockets.sessions.length, denied: evidence.webSockets.denied.length, framesToServer: evidence.webSockets.sessions.reduce((a, s) => a + s.toServer, 0), framesFromServer: evidence.webSockets.sessions.reduce((a, s) => a + s.fromServer, 0) };
      evidence.navigationSummary = { mainFrame: evidence.navigations.length, urls: [...new Set(evidence.navigations.map((n) => n.url))] };
    }
    if (browser) { try { await browser.close(); close.browser = 'closed'; } catch (e) { close.browser = redact(e.message, 200); } }
    if (next) {
      // Owned app listeners: those proven at startup plus any current listener that still descends from our child
      // (snapshotted before the child is stopped, while the ancestry is still visible).
      const ownedPids = new Set((evidence.listeners.appPids || []).filter((p) => p.ownedByNext).map((p) => p.pid));
      for (const pid of listenerPids(evidence.listeners.app)) if (pid === next.pid || ancestors(pid).includes(next.pid)) ownedPids.add(pid);
      close.next = await stopChild(next);
      for (const pid of listenerPids(evidence.listeners.app)) if (ownedPids.has(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
      await sleep(1000);
      for (const pid of listenerPids(evidence.listeners.app)) if (ownedPids.has(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      await sleep(500);
      close.appListenerAfter = listenerPids(evidence.listeners.app);
      close.appPidsAlive = [...ownedPids].filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    }
    if (gateway) { try { evidence.gatewayStats = { ...gateway.stats }; await gateway.close(); close.gateway = 'closed'; } catch (e) { close.gateway = redact(e.message, 200); } }
    if (anvil) { close.anvil = await stopChild(anvil); close.anvilListenerAfter = listenerPids(anvilPort); }
    if (evidence.listeners.gateway) close.gatewayListenerAfter = listenerPids(evidence.listeners.gateway);
    if (tmpHome) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); close.tmpHome = 'removed'; } catch { close.tmpHome = 'left'; } }
    if (launched.aave) { const status = gitRead(['status', '--porcelain', '--untracked-files=no']); close.aaveTrackedCleanAfter = status === '' ? true : (status === null ? 'unknown' : status.split('\n').slice(0, 20)); }
    evidence.close = close;
    evidence.cleanup = L.cleanupVerdict(close, launched);
    evidence.launched = { ...launched };
    evidence.finishedAt = new Date().toISOString();
  }
}

/** Serializes evidence through the persistence sentinel; only submitted hashes, the fork block hash and the expected
 * calldata digest may appear as long hex. A hit is redacted and fails acceptance. */
function finalize() {
  const allowed = [...(evidence.submitted || []), evidence.forkBlockHash, evidence.expectedWithdrawCall && evidence.expectedWithdrawCall.dataSha256];
  const serialize = () => JSON.stringify(evidence, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  const { hits } = L.scrubEvidenceText(serialize(), allowed);
  evidence.redactionSentinel = { longHexRedacted: hits };
  evidence.acceptance = L.classifyAcceptance({ steps: evidence.steps, fatal: evidence.fatal, cleanup: evidence.cleanup, sentinelHits: hits });
  fs.writeFileSync(path.join(artifacts, 'evidence.json'), L.scrubEvidenceText(serialize(), allowed).text);
  const a = evidence.acceptance;
  console.log(`acceptance: ${a.overall} (exit ${a.exitCode}) supply=${a.supply} withdrawWETH=${a.withdrawWETH} nativeRouteRefusal=${a.nativeRouteRefusal} nativeRouteCapability=${a.nativeRouteCapability} diagnosticsDegraded=${a.diagnosticsDegraded} cleanup=${a.cleanup}`);
  if (a.reasons.length) console.log(`acceptance reasons: ${a.reasons.join(' | ')}`);
  console.log('evidence:', path.join(artifacts, 'evidence.json'));
  return a.exitCode;
}

main().catch((e) => { fatalAt(null, e); }).then(() => {
  try { process.exitCode = finalize(); } catch (e) { console.error('evidence finalization failed:', redact(e && e.message, 300)); process.exitCode = L.EXIT.FAILED; }
});
