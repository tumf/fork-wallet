'use strict';
// Test-only selection of the installed fork-wallet public entry points inside one external consumer directory, used
// by `npm run test:pack:runtime`. Resolves `fork-wallet` and `fork-wallet/anvil` from that consumer only and fails
// (never falls back to repository source) unless both realpaths lie inside <consumer>/node_modules/fork-wallet.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const SOURCE_FILES = ['src/index.js', 'src/anvil.js'].map((p) => path.join(__dirname, '..', p));

function selectInstalled(consumerDir) {
  if (typeof consumerDir !== 'string' || !path.isAbsolute(consumerDir)) throw new Error(`consumer directory must be an absolute path: ${consumerDir}`);
  if (!fs.existsSync(consumerDir) || !fs.statSync(consumerDir).isDirectory()) throw new Error(`consumer directory missing: ${consumerDir}`);
  const consumer = fs.realpathSync(consumerDir);
  const expected = path.join(consumer, 'node_modules', 'fork-wallet');
  if (!fs.existsSync(expected) || fs.realpathSync(expected) !== expected) throw new Error(`fork-wallet is not physically installed in ${consumer}`);
  // Resolve as the consumer's own module would: a plain require.resolve from here self-references this repository.
  const consumerRequire = createRequire(path.join(consumer, 'package.json'));
  const resolve = (request) => {
    const file = fs.realpathSync(consumerRequire.resolve(request));
    if (!file.startsWith(expected + path.sep)) throw new Error(`${request} resolved outside the consumer: ${file}`);
    return file;
  };
  return { consumer, packageDir: expected, index: resolve('fork-wallet'), anvil: resolve('fork-wallet/anvil') };
}

/** Repository production files present in this process's module cache (must be empty in installed mode). */
const loadedSourceModules = () => SOURCE_FILES.filter((file) => Object.prototype.hasOwnProperty.call(require.cache, file)).map((file) => path.relative(path.join(__dirname, '..'), file));

module.exports = { selectInstalled, loadedSourceModules };
