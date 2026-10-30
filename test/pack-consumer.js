'use strict';
// Packs this package and installs the tarball into a throwaway consumer outside the repository, then loads it from
// both CommonJS and ESM. Proves the tarball is self-contained: no test/example files, no absolute paths, no repo access.
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
  assert.deepEqual(files, ['LICENSE', 'README.md', 'index.d.ts', 'package.json', 'src/index.js'], 'tarball contents');
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  assert.ok(!/\/Users\/|\/home\//.test(fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8')), 'no absolute paths in source');
  assert.ok(listing.split('\n').filter(Boolean).every((entry) => entry.startsWith('package/')));
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');

  const consumer = path.join(work, 'consumer');
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, version: '0.0.0' }));
  npm(['install', tarball], consumer);
  fs.writeFileSync(path.join(consumer, 'check.cjs'), `
    const w = require('fork-wallet');
    const assert = require('node:assert/strict');
    assert.equal(typeof w.installForkWallet, 'function');
    assert.deepEqual(w.METHODS, ['eth_accounts', 'eth_requestAccounts', 'eth_chainId', 'eth_sendTransaction']);
    assert.equal(w.normalizeChainId(31337), '0x7a69');
    assert.throws(() => w.requireLoopbackEndpoint('http://localhost:8545'), (e) => e.code === -32602);
    assert.equal(require('fork-wallet/package.json').version, ${JSON.stringify(packed.version)});
    console.log('cjs ok');
  `);
  fs.writeFileSync(path.join(consumer, 'check.mjs'), `
    import { installForkWallet, CODES, ForkWalletError } from 'fork-wallet';
    import assert from 'node:assert/strict';
    assert.equal(typeof installForkWallet, 'function');
    assert.equal(CODES.DISCONNECTED, 4900);
    assert.equal(new ForkWalletError(1, 'x').code, 1);
    await assert.rejects(installForkWallet({}, {}), (e) => e.code === CODES.INVALID_PARAMS);
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
