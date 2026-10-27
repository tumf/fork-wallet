'use strict';
// Bounded runner for `npm run test:sdk`: checks prerequisites (missing tools are FAIL, never skip), then runs the
// given node:test files in its own process group with a total wall-clock bound (default 180 s). On timeout it kills
// only that process group.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const BOUND_MS = 180000;
const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: node test/run-gate.js <test files...>'); process.exit(2); }

function prerequisite(label, check) {
  try { return check(); } catch (error) {
    console.error(`FAIL prerequisite ${label}: ${error.message}`);
    process.exit(1);
  }
}

const versions = {
  node: prerequisite('Node >= 22', () => { if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(process.version); return process.version; }),
  anvil: prerequisite('anvil 1.8.3 on PATH', () => {
    const out = execFileSync('anvil', ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (!/^anvil Version: 1\.8\.3\b/m.test(out)) throw new Error('found ' + out.split('\n')[0]);
    return out.split('\n')[0];
  }),
  lsof: prerequisite('lsof', () => (fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : execFileSync('which', ['lsof'], { encoding: 'utf8' }).trim())),
  chromium: prerequisite('Playwright Chromium (run `npx playwright install chromium`, PLAYWRIGHT_BROWSERS_PATH is honoured)', () => {
    const executable = require('playwright').chromium.executablePath();
    if (!fs.existsSync(executable)) throw new Error('missing ' + executable);
    return executable;
  }),
};
console.log('gate prerequisites ' + JSON.stringify(versions));

const started = Date.now();
const child = spawn(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', `--test-timeout=${BOUND_MS}`, ...files],
  { stdio: 'inherit', detached: true, cwd: path.join(__dirname, '..') });
const timer = setTimeout(() => {
  console.error(`FAIL gate exceeded ${BOUND_MS} ms; terminating its process group`);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, 5000).unref();
}, BOUND_MS);
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  const elapsed = Date.now() - started;
  console.log(`gate finished in ${elapsed} ms (bound ${BOUND_MS} ms) with ${signal || 'exit ' + code}`);
  process.exit(code === 0 && elapsed <= BOUND_MS ? 0 : 1);
});
