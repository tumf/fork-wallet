'use strict';
// Packs this package and installs the tarball into a throwaway consumer outside the repository, then loads both
// published entry points (fork-wallet and fork-wallet/anvil) from CommonJS and ESM.
// Proves the tarball is self-contained: no test/example files, no private file imports, no absolute paths, no
// runtime dependencies and no P-256 code. Signing (0.3.0) is checked through the installed exports only: absent is
// 4200, opt-in needs exactly {validateSignature} on chains 31337/31338.
// Usage: node test/pack-consumer.js [--runtime] [tarball-copy-path]
// --runtime (`npm run test:pack:runtime`, opt-in, heavy) additionally runs the generic real browser + owned Anvil
// regression (test/integration.test.js through the bounded test/run-gate.js) against the installed exports only,
// keeps its evidence under artifacts/pack-runtime/<run>/ and fails closed on any child, evidence or cleanup problem.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { selectInstalled } = require('./installed-exports.js');

const ROOT = path.join(__dirname, '..');
const RUNTIME_BOUND_MS = 180000; // enforced by test/run-gate.js on the real runtime child
const OUTER_BOUND_MS = RUNTIME_BOUND_MS + 20000; // supervision margin for run-gate's own prerequisite checks and kill

/** Returns { runtime, keep } or throws a usage error: only --runtime (once) and at most one output path. */
function parseArgs(argv) {
  let runtime = false;
  const positional = [];
  for (const arg of argv) {
    if (arg === '--runtime') {
      if (runtime) throw new Error('duplicate --runtime');
      runtime = true;
    } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error(`expected at most one tarball output path, got ${positional.length}`);
  return { runtime, keep: positional.length ? path.resolve(positional[0]) : null };
}

/** Returns the list of reasons the installed-runtime run is not a PASS (empty list = PASS). Pure. */
function judgeRuntime({ exit, timedOut, elapsedMs, evidence, expected, anvilAlive }) {
  const problems = [];
  if (timedOut) problems.push(`runtime child exceeded ${OUTER_BOUND_MS} ms`);
  if (exit.code !== 0 || exit.signal) problems.push(`runtime child ended with ${exit.signal || 'exit ' + exit.code}`);
  if (!(elapsedMs <= OUTER_BOUND_MS)) problems.push(`elapsed ${elapsedMs} ms`);
  if (!evidence) return [...problems, 'evidence.json missing or unreadable'];
  if (evidence.result !== 'PASS') problems.push(`evidence result ${evidence.result}`);
  if (evidence.childrenStopped !== true) problems.push('owned children not reported stopped');
  if (evidence.cleanupError !== undefined) problems.push(`cleanupError ${evidence.cleanupError}`);
  if (evidence.stopError !== undefined) problems.push(`stopError ${evidence.stopError}`);
  if (!Array.isArray(evidence.sourceModulesLoaded) || evidence.sourceModulesLoaded.length) problems.push(`repository source loaded: ${JSON.stringify(evidence.sourceModulesLoaded)}`);
  const got = evidence.installed || {};
  for (const key of ['consumer', 'packageDir', 'index', 'anvil']) if (got[key] !== expected[key]) problems.push(`installed.${key} ${got[key]} != ${expected[key]}`);
  if (got.requireOwnedPortSupplier !== expected.anvil) problems.push(`requireOwnedPort supplier ${got.requireOwnedPortSupplier}`);
  for (const file of [got.index, got.anvil, got.requireOwnedPortSupplier]) {
    if (typeof file !== 'string' || !file.startsWith(expected.packageDir + path.sep)) problems.push(`supplier outside consumer: ${file}`);
  }
  if (anvilAlive) problems.push(`owned anvil pid ${evidence.chain?.anvilPid} still alive`);
  return problems;
}

/** Fast negative checks of the fail-closed paths; run before anything is packed or launched in --runtime mode. */
function selfCheck(work) {
  for (const bad of [['--runtime', '--runtime'], ['--bogus'], ['a', 'b'], ['--runtime', 'a', 'b']]) assert.throws(() => parseArgs(bad), Error, bad.join(' '));
  assert.deepEqual(parseArgs([]), { runtime: false, keep: null });
  assert.deepEqual(parseArgs(['--runtime', 'x.tgz']), { runtime: true, keep: path.resolve('x.tgz') });
  assert.throws(() => selectInstalled(undefined), /absolute/);
  assert.throws(() => selectInstalled('relative/consumer'), /absolute/);
  assert.throws(() => selectInstalled(path.join(work, 'missing')), /missing/);
  const empty = path.join(work, 'empty-consumer');
  fs.mkdirSync(empty);
  assert.throws(() => selectInstalled(empty), /not physically installed/);
  // A consumer whose fork-wallet is a link back to this repository must not be accepted as installed.
  const linked = path.join(work, 'linked-consumer');
  fs.mkdirSync(path.join(linked, 'node_modules'), { recursive: true });
  fs.symlinkSync(ROOT, path.join(linked, 'node_modules', 'fork-wallet'), 'dir');
  assert.throws(() => selectInstalled(linked), /not physically installed/);
  const expected = { consumer: '/c', packageDir: '/c/node_modules/fork-wallet', index: '/c/node_modules/fork-wallet/src/index.js', anvil: '/c/node_modules/fork-wallet/src/anvil.js' };
  const good = { result: 'PASS', childrenStopped: true, sourceModulesLoaded: [], installed: { ...expected, requireOwnedPortSupplier: expected.anvil }, chain: { anvilPid: 1 } };
  const ok = { exit: { code: 0, signal: null }, timedOut: false, elapsedMs: 1, evidence: good, expected, anvilAlive: false };
  assert.deepEqual(judgeRuntime(ok), []);
  for (const bad of [{ exit: { code: 1, signal: null } }, { exit: { code: null, signal: 'SIGTERM' } }, { timedOut: true }, { evidence: null },
    { evidence: { ...good, result: 'FAIL' } }, { evidence: { ...good, childrenStopped: false } }, { evidence: { ...good, cleanupError: 'x' } },
    { evidence: { ...good, sourceModulesLoaded: ['src/index.js'] } }, { evidence: { ...good, installed: { ...good.installed, index: path.join(ROOT, 'src/index.js') } } },
    { evidence: { ...good, installed: { ...good.installed, requireOwnedPortSupplier: path.join(ROOT, 'src/anvil.js') } } }, { anvilAlive: true }]) {
    assert.notDeepEqual(judgeRuntime({ ...ok, ...bad }), [], JSON.stringify(bad));
  }
  // A printed PASS with a failing child exit is still a failure.
  assert.match(judgeRuntime({ ...ok, exit: { code: 1, signal: null } }).join(), /exit 1/);
}

const alive = (pid) => {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/** Runs the bounded integration gate against the installed consumer; returns the parent-side runtime record. */
async function runInstalledRuntime(consumer, sha256) {
  const expected = selectInstalled(consumer);
  const run = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const evidenceDir = path.join(ROOT, 'artifacts', 'pack-runtime', run);
  fs.mkdirSync(path.dirname(evidenceDir), { recursive: true });
  fs.mkdirSync(evidenceDir); // non-recursive: a colliding run directory fails instead of being shared
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || os.tmpdir(),
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
    FORK_WALLET_CONSUMER_DIR: expected.consumer, FORK_WALLET_EVIDENCE_DIR: evidenceDir };
  const started = Date.now();
  const log = fs.openSync(path.join(evidenceDir, 'gate.log'), 'w');
  let timedOut = false;
  const exit = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'run-gate.js'), 'test/integration.test.js'], { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tee = (stream, target) => stream.on('data', (chunk) => { target.write(chunk); fs.writeSync(log, chunk); });
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, 5000).unref();
    }, OUTER_BOUND_MS);
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, signal: null, error: error.message }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  fs.closeSync(log);
  const elapsedMs = Date.now() - started;
  let evidence = null;
  try { evidence = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'evidence.json'), 'utf8')); } catch { /* judged as missing */ }
  const anvilAlive = alive(evidence?.chain?.anvilPid);
  const problems = judgeRuntime({ exit, timedOut, elapsedMs, evidence, expected, anvilAlive });
  return { result: problems.length ? 'FAIL' : 'PASS', problems, exit, timedOut, elapsedMs, boundMs: RUNTIME_BOUND_MS, sha256, evidenceDir,
    installed: expected, steps: evidence?.steps?.map((s) => s.name) };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) {
    console.error(`usage: node test/pack-consumer.js [--runtime] [tarball-copy-path]: ${error.message}`);
    process.exit(2);
  }
  const npm = (args, cwd) => execFileSync('npm', [...args, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-wallet-pack-'));
  let summary;
  let runtime = null;
  try {
    if (options.runtime) selfCheck(work);
    const packDir = path.join(work, 'pack');
    fs.mkdirSync(packDir);
    const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', packDir], ROOT));
    const tarball = path.join(packDir, packed.filename);
    const files = packed.files.map((f) => f.path).sort();
    assert.deepEqual(files, ['CONTRIBUTING.md', 'LICENSE', 'README.md', 'anvil.d.ts', 'docs/api.md', 'index.d.ts', 'package.json', 'src/anvil.js', 'src/index.js'], 'tarball contents');
    assert.match(fs.readFileSync(path.join(ROOT, 'docs/api.md'), 'utf8'), /# ForkWallet API reference/);
    assert.equal(packed.version, '0.3.0');
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.notEqual(manifest.private, true);
    assert.equal(manifest.license, 'MIT');
    assert.match(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'), /^MIT License/);
    assert.equal(manifest.dependencies, undefined, 'zero runtime dependencies');
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, manifest.version, 'lockfile root version matches package.json');
    assert.equal(lock.packages[''].version, manifest.version, 'lockfile packages[""] version matches package.json');
    for (const file of ['src/index.js', 'src/anvil.js', 'index.d.ts', 'anvil.d.ts']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(!/\/Users\/|\/home\//.test(text), `no absolute paths in ${file}`);
      assert.ok(!/p256|P-?256|safe-global/i.test(text), `no P-256/Safe code in ${file}`);
      const requires = [...text.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
      assert.ok(requires.every((r) => r.startsWith('node:') || r === './index.js'), `${file} requires only node: builtins and ./index.js: ${requires}`);
    }
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    assert.ok(listing.split('\n').filter(Boolean).every((entry) => entry.startsWith('package/')));
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');

    const consumer = path.join(work, 'consumer');
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, version: '0.0.0' }));
    npm(['install', tarball], consumer);
    assert.deepEqual(fs.readdirSync(path.join(consumer, 'node_modules')).filter((d) => !d.startsWith('.')), ['fork-wallet'], 'nothing else installed');
    fs.writeFileSync(path.join(consumer, 'check.cjs'), `
      const w = require('fork-wallet');
      const anvil = require('fork-wallet/anvil');
      const assert = require('node:assert/strict');
      assert.equal(typeof w.installForkWallet, 'function');
      assert.ok(w.METHODS.includes('eth_sendTransaction') && w.METHODS.includes('eth_getLogs'));
      assert.deepEqual([...w.SIGNING_METHODS], ['personal_sign', 'eth_signTypedData_v4']);
      assert.ok(w.SIGNING_METHODS.every((m) => w.METHODS.includes(m) && w.APPROVAL_METHODS.includes(m)), 'static capability lists');
      assert.deepEqual([...w.SIGNING_CHAINS], ['0x7a69', '0x7a6a']);
      assert.ok(w.STATES.includes('signed') && w.STATES.includes('signed-discarded'));
      assert.equal(w.LIMITS.signMessageBytes, 65536);
      assert.equal(w.checkSignatureRequest('personal_sign', ['0x00', '0x${'11'.repeat(20)}'], '0x${'11'.repeat(20)}', '0x7a69').message, '0x00');
      assert.equal(w.normalizeChainId(31337), '0x7a69');
      assert.throws(() => w.requireLoopbackEndpoint('http://localhost:8545'), (e) => e.code === -32602);
      assert.deepEqual(w.checkTransaction([{ from: '0x${'11'.repeat(20)}', data: '0x6000' }], '0x${'11'.repeat(20)}', '0x7a69'), { from: '0x${'11'.repeat(20)}', data: '0x6000' });
      assert.equal(typeof anvil.startAnvil, 'function');
      assert.equal(typeof anvil.startReadGateway, 'function');
      assert.throws(() => require('fork-wallet/src/index.js'), /ERR_PACKAGE_PATH_NOT_EXPORTED|not exported/, 'private file paths are not importable');
      assert.equal(require('fork-wallet/package.json').version, ${JSON.stringify(packed.version)});
      anvil.startAnvil({ args: ['--fork-url', 'x'] }).then(() => { throw new Error('accepted CLI args'); }, (e) => { assert.equal(e.code, -32602); console.log('cjs ok'); });
    `);
    fs.writeFileSync(path.join(consumer, 'check.mjs'), `
      import { installForkWallet, CODES, ForkWalletError, validateReadRequest } from 'fork-wallet';
      import { startAnvil, requireNoCredentials } from 'fork-wallet/anvil';
      import assert from 'node:assert/strict';
      assert.equal(typeof installForkWallet, 'function');
      assert.equal(CODES.UNAUTHORIZED, 4100);
      assert.equal(CODES.UNRECOGNIZED_CHAIN, 4902);
      const error = new ForkWalletError(3, 'x', '0x08c379a0');
      assert.equal(error.data, '0x08c379a0');
      await assert.rejects(installForkWallet({}, {}), (e) => e.code === CODES.INVALID_PARAMS);
      await assert.rejects(validateReadRequest('anvil_mine', [], async () => null), (e) => e.code === 4200);
      assert.equal(typeof startAnvil, 'function');
      assert.throws(() => requireNoCredentials({ PRIVATE_KEY: 'x' }));
      // Signing through the installed package with a structural context (no browser, no node).
      const fakeContext = () => {
        const bindings = {};
        const frame = { url: () => 'http://127.0.0.1:1234/' };
        const page = { url: () => 'http://127.0.0.1:1234/', mainFrame: () => frame };
        return { bindings, pages: () => [], exposeBinding: async (name, fn) => { bindings[name] = fn; }, addInitScript: async () => {},
          call: (method, params) => bindings.__forkWalletRequest({ page, frame }, { method, params }) };
      };
      const account = '0x${'11'.repeat(20)}';
      const base = { endpoint: 'http://127.0.0.1:9', origin: 'http://127.0.0.1:1234', chainId: 31337, account, validateTransaction() {}, beforeSend() {} };
      const disabled = fakeContext();
      const off = await installForkWallet(disabled, base);
      assert.equal(off.signing, false);
      assert.equal((await disabled.call('personal_sign', ['0x00', account])).error.code, 4200, 'default-disabled signing');
      assert.equal(off.unsupported[0].reason, 'signing-disabled');
      await assert.rejects(installForkWallet(fakeContext(), { ...base, signing: {} }), (e) => e.code === CODES.INVALID_PARAMS);
      await assert.rejects(installForkWallet(fakeContext(), { ...base, chainId: 1, signing: { validateSignature() {} } }), (e) => e.code === CODES.INVALID_PARAMS);
      const enabled = fakeContext();
      const on = await installForkWallet(enabled, { ...base, signing: { validateSignature() {} } });
      assert.equal(on.signing, true);
      assert.equal((await enabled.call('personal_sign', ['0x00', account])).error.code, 4100, 'opt-in still needs account permission');
      console.log('esm ok');
    `);
    const out = [execFileSync('node', ['check.cjs'], { cwd: consumer, encoding: 'utf8' }), execFileSync('node', ['check.mjs'], { cwd: consumer, encoding: 'utf8' })];
    assert.deepEqual(out.map((s) => s.trim()), ['cjs ok', 'esm ok']);
    if (options.runtime) runtime = await runInstalledRuntime(consumer, sha256);
    const keep = options.keep;
    if (keep) { fs.mkdirSync(path.dirname(keep), { recursive: true }); fs.copyFileSync(tarball, keep); }
    summary = { result: 'PASS', filename: packed.filename, version: packed.version, sha256, size: packed.size, unpackedSize: packed.unpackedSize, files, copiedTo: keep };
  } finally {
    let removeError = null;
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (error) { removeError = error; }
    if (runtime) {
      // Evidence already lives outside the consumer; record whether the consumer really retired.
      runtime.consumerRemoved = !removeError && !fs.existsSync(work);
      if (!runtime.consumerRemoved) { runtime.result = 'FAIL'; runtime.problems.push(`temporary consumer not removed: ${work} ${removeError?.message || ''}`.trim()); }
      fs.writeFileSync(path.join(runtime.evidenceDir, 'pack-runtime.json'), JSON.stringify(runtime, null, 2) + '\n');
    } else if (removeError) throw removeError;
  }
  if (!runtime) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  summary.result = runtime.result;
  summary.runtime = runtime;
  console.log(JSON.stringify(summary, null, 2));
  if (runtime.result !== 'PASS') process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
