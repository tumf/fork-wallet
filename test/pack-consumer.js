'use strict';
// Packs this package and installs the tarball into a throwaway consumer outside the repository, then loads both
// published entry points (fork-wallet and fork-wallet/anvil) from CommonJS and ESM.
// Proves the tarball is self-contained: no test/example files, no private file imports, no absolute paths, no
// runtime dependencies and no P-256 code.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const npm = (args, cwd) => execFileSync('npm', [...args, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-wallet-pack-'));
try {
  const packDir = path.join(work, 'pack');
  fs.mkdirSync(packDir);
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', packDir], ROOT));
  const tarball = path.join(packDir, packed.filename);
  const files = packed.files.map((f) => f.path).sort();
  assert.deepEqual(files, ['README.md', 'anvil.d.ts', 'index.d.ts', 'package.json', 'src/anvil.js', 'src/index.js'], 'tarball contents');
  assert.equal(packed.version, '0.2.0');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, 'UNLICENSED');
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
    assert.ok(w.METHODS.includes('eth_sendTransaction') && w.METHODS.includes('eth_getLogs') && !w.METHODS.includes('personal_sign'));
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
    console.log('esm ok');
  `);
  const out = [execFileSync('node', ['check.cjs'], { cwd: consumer, encoding: 'utf8' }), execFileSync('node', ['check.mjs'], { cwd: consumer, encoding: 'utf8' })];
  assert.deepEqual(out.map((s) => s.trim()), ['cjs ok', 'esm ok']);
  const keep = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (keep) { fs.mkdirSync(path.dirname(keep), { recursive: true }); fs.copyFileSync(tarball, keep); }
  console.log(JSON.stringify({ result: 'PASS', filename: packed.filename, version: packed.version, sha256, size: packed.size, unpackedSize: packed.unpackedSize, files, copiedTo: keep }, null, 2));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
