'use strict';
// Example harness: owns one vanilla Anvil child and one loopback static server for the dApp.
// Everything here is test infrastructure for the example; it is not part of the package API.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { createLoopbackRpc, requireLoopbackEndpoint } = require('../../src/index.js');

// Blockchain signing credentials must not be present: this example only uses Anvil's disposable unlocked accounts.
const CREDENTIAL_KEYS = /PRIVATE_KEY|MNEMONIC|SEED_PHRASE|KEYSTORE|ETH_FROM|ETH_PASSWORD|^FOUNDRY_|^ANVIL_|^CAST_|DEPLOYER/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireNoCredentials(env = process.env) {
  const found = Object.keys(env).filter((key) => CREDENTIAL_KEYS.test(key) && env[key]);
  if (found.length) throw new Error(`refusing to run with credential-like environment: ${found.join(', ')}`);
}

/** Minimal child environment: PATH to find the binary, HOME for the toolchain, nothing else. */
function scrubbedEnv(env = process.env) {
  return { PATH: env.PATH, HOME: env.HOME };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function alive(child) {
  if (!child || !child.pid || child.launchError || child.exitCode !== null || child.signalCode !== null || child.killed) {
    throw new Error('owned child is not running');
  }
  process.kill(child.pid, 0);
}

/** The only LISTEN socket on the port belongs to the given PID (lsof is required; a missing lsof fails closed). */
function listenerPids(port) {
  const lsof = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
  let output = '';
  try {
    output = execFileSync(lsof, ['-nP', '-a', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' });
  } catch (error) {
    if (error.status === 1 && !error.stdout) return []; // lsof exits 1 when nothing matches
    throw error;
  }
  return [...new Set(output.split('\n').filter((line) => line.startsWith('p')).map((line) => Number(line.slice(1))))];
}

function requireOwnedPort(pid, port) {
  const pids = listenerPids(port);
  if (pids.length !== 1 || pids[0] !== pid) throw new Error(`listener on ${port} is ${JSON.stringify(pids)}, not owned pid ${pid}`);
}

function ownsPort(child, port) {
  alive(child);
  requireOwnedPort(child.pid, port);
  alive(child);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  child.kill('SIGTERM');
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

/** Spawns a vanilla (non-forking) Anvil on a free loopback port with a scrubbed environment and waits until ready. */
async function startAnvil({ chainId = 31337, anvil = 'anvil', env = process.env } = {}) {
  requireNoCredentials(env);
  const port = await freePort();
  const endpoint = requireLoopbackEndpoint(`http://127.0.0.1:${port}`);
  const args = ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId), '--silent'];
  const child = spawn(anvil, args, { stdio: 'ignore', env: scrubbedEnv(env) });
  child.on('error', (error) => { child.launchError = error; });
  const rpc = createLoopbackRpc(endpoint);
  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    if (child.launchError) throw child.launchError;
    try { version = await rpc('web3_clientVersion'); } catch { await sleep(100); }
  }
  if (!version) { await stopChild(child); throw new Error('anvil did not become ready'); }
  if (!/^anvil\//i.test(version)) { await stopChild(child); throw new Error(`refusing client ${version}`); }
  const reported = await rpc('eth_chainId');
  if (BigInt(reported) !== BigInt(chainId)) { await stopChild(child); throw new Error(`anvil chain ${reported} is not ${chainId}`); }
  ownsPort(child, port);
  return { child, port, endpoint, rpc, version, chainId: reported, args, stop: () => stopChild(child) };
}

/** Serves only the files in one directory on a free loopback port with a self-only CSP. */
async function startStaticServer(root) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    const file = path.join(root, name);
    const type = types[path.extname(name)];
    if (req.method !== 'GET' || !type || path.dirname(file) !== root || !fs.existsSync(file)) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': "default-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'" });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  requireOwnedPort(process.pid, port);
  return { origin: `http://127.0.0.1:${port}`, port, close: () => new Promise((resolve) => server.close(resolve)) };
}

module.exports = { requireNoCredentials, scrubbedEnv, freePort, alive, ownsPort, requireOwnedPort, listenerPids, stopChild, startAnvil, startStaticServer, sleep };
