'use strict';
// fork-wallet/anvil: starts and stops only its own vanilla Anvil child and serves a restricted, loopback-only
// read gateway for the browser. The management endpoint stays private to the test runner; the gateway forwards only
// the validated read allowlist (never admin, signing or write methods, including inside batches).

const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const {
  createLoopbackRpc, requireLoopbackEndpoint, requireOrigin, validateReadRequest, ForkWalletError, READ_METHODS, CODES, LIMITS,
} = require('./index.js');

/** Signing credentials must not be present: only Anvil's random disposable unlocked accounts are used. */
const CREDENTIAL_KEYS = /PRIVATE_KEY|MNEMONIC|SEED_PHRASE|KEYSTORE|ETH_FROM|ETH_PASSWORD|^FOUNDRY_|^ANVIL_|^CAST_|DEPLOYER/i;
const SUPPORTED_ANVIL = /^anvil\/v1\.8\.3(?:$|[-+\s])/;
const START_OPTIONS = ['chainId', 'anvil', 'timeoutMs'];
const STOP_WAIT_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireNoCredentials(env = process.env) {
  const found = Object.keys(env).filter((key) => CREDENTIAL_KEYS.test(key) && env[key]);
  if (found.length) throw new Error(`refusing to run with credential-like environment: ${found.join(', ')}`);
}

/** Minimal child environment: PATH to find the binary, HOME for the toolchain, nothing else. */
function scrubbedEnv(env = process.env) {
  const out = {};
  if (env.PATH !== undefined) out.PATH = env.PATH;
  if (env.HOME !== undefined) out.HOME = env.HOME;
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** PIDs with a LISTEN socket on the TCP port (lsof is required; a missing lsof fails closed). */
function listenerPids(port) {
  const lsof = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
  let output = '';
  try {
    output = execFileSync(lsof, ['-nP', '-a', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', timeout: 5000 });
  } catch (error) {
    if (error.status === 1 && !error.stdout) return []; // lsof exits 1 when nothing matches
    throw error;
  }
  return [...new Set(output.split('\n').filter((line) => line.startsWith('p')).map((line) => Number(line.slice(1))))];
}

/** The only LISTEN socket on the port belongs to the given PID. */
function requireOwnedPort(pid, port) {
  const pids = listenerPids(port);
  if (pids.length !== 1 || pids[0] !== pid) throw new Error(`listener on ${port} is ${JSON.stringify(pids)}, not owned pid ${pid}`);
}

function running(child) {
  return Boolean(child && child.pid && !child.launchError && child.exitCode === null && child.signalCode === null);
}

function requireRunning(child) {
  if (!running(child)) throw new Error('owned child is not running');
  process.kill(child.pid, 0);
}

const within = (promise, ms) => Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

/** TERM then (bounded) KILL of this exact ChildProcess only; resolves true once it has exited. */
async function stopChild(child, exited) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return true;
  child.kill('SIGTERM');
  if (await within(exited, STOP_WAIT_MS)) return true;
  child.kill('SIGKILL');
  return within(exited, STOP_WAIT_MS);
}

/** Reads at most `max` bytes; resolves null (leaving the stream paused, not destroyed) when the body is larger. */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const onData = (chunk) => {
      total += chunk.length;
      if (total > max) { cleanup(); req.pause(); resolve(null); return; }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/** 413 without reading the body into memory: discard at most a bounded tail so the client sees the status, then close. */
function tooLarge(req, res, headers) {
  res.writeHead(413, { ...headers, Connection: 'close' });
  res.flushHeaders();
  // Let an in-flight upload finish before closing, or Node 22 fetch can see EPIPE instead of 413.
  const timer = setTimeout(() => req.destroy(), 1000);
  timer.unref();
  res.once('close', () => clearTimeout(timer));
  let discarded = 0;
  req.on('data', (chunk) => { discarded += chunk.length; if (discarded > 4 * LIMITS.requestBytes) req.destroy(); });
  req.once('end', () => res.end());
  if (req.readableEnded) res.end();
  else req.resume();
}

const rpcError = (id, code, message, data) => {
  const error = { code, message: String(message).slice(0, 4096) };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
};

/**
 * Loopback-only JSON-RPC read gateway in front of one owned management endpoint. Exact path '/', POST/OPTIONS only,
 * application/json, bounded request and response, batch <= LIMITS.batch, no notifications, CORS only for the one
 * origin passed to configureOrigin(). `beforeSend` (ownership) runs before every forwarded item.
 */
async function startReadGateway({ endpoint, beforeSend, timeoutMs = LIMITS.timeoutMs } = {}) {
  requireLoopbackEndpoint(endpoint);
  if (typeof beforeSend !== 'function') throw new ForkWalletError(CODES.INVALID_PARAMS, 'beforeSend() ownership guard is mandatory');
  const rpc = createLoopbackRpc(endpoint, { timeoutMs });
  let allowedOrigin = null;
  const stats = { forwarded: 0, refused: 0 };

  async function one(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return rpcError(null, CODES.INVALID_REQUEST, 'request must be an object');
    const extra = Object.keys(item).filter((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key));
    const { id } = item;
    const idOk = Object.hasOwn(item, 'id') && (id === null || (typeof id === 'string' && id.length <= 256) || (typeof id === 'number' && Number.isSafeInteger(id)));
    if (!idOk) { stats.refused++; return rpcError(null, CODES.INVALID_REQUEST, 'notifications and malformed ids are refused'); }
    if (extra.length || item.jsonrpc !== '2.0' || typeof item.method !== 'string') { stats.refused++; return rpcError(id, CODES.INVALID_REQUEST, 'invalid JSON-RPC 2.0 request'); }
    if (Object.hasOwn(item, 'params') && !Array.isArray(item.params)) { stats.refused++; return rpcError(id, CODES.INVALID_PARAMS, 'params must be an array'); }
    try {
      try { await beforeSend(); } catch (error) { throw new ForkWalletError(CODES.CHAIN_DISCONNECTED, `node ownership check failed: ${error.message}`); }
      if (!READ_METHODS.includes(item.method)) throw new ForkWalletError(CODES.UNSUPPORTED_METHOD, `unsupported method ${item.method.slice(0, 100)}`);
      const params = await validateReadRequest(item.method, item.params, rpc);
      const result = await rpc(item.method, params);
      stats.forwarded++;
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (!(error && error.kind === 'upstream')) stats.refused++;
      return rpcError(id, Number.isInteger(error && error.code) ? error.code : CODES.INTERNAL, error && error.message, error && error.data);
    }
  }

  const server = http.createServer(async (req, res) => {
    const reply = (status, body, headers = {}) => {
      if (body === undefined) { res.writeHead(status, headers); res.end(); return; }
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
      res.end(text);
    };
    try {
      const requestOrigin = req.headers.origin;
      if (requestOrigin !== undefined && (allowedOrigin === null || requestOrigin !== allowedOrigin)) { reply(403); return; }
      const cors = requestOrigin === undefined ? {} : { 'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin' };
      if (req.url !== '/') { reply(404, undefined, cors); return; }
      if (req.method === 'OPTIONS') {
        if (requestOrigin === undefined) { reply(403); return; }
        reply(204, undefined, { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '60' });
        return;
      }
      if (req.method !== 'POST') { reply(405, undefined, { ...cors, Allow: 'POST, OPTIONS' }); return; }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) { reply(415, undefined, cors); return; }
      const declared = Number(req.headers['content-length']);
      const text = Number.isFinite(declared) && declared > LIMITS.requestBytes ? null : await readBody(req, LIMITS.requestBytes);
      if (text === null) { tooLarge(req, res, cors); return; }
      let body;
      try { body = JSON.parse(text); } catch { reply(200, rpcError(null, -32700, 'parse error'), cors); return; }
      let out;
      if (Array.isArray(body)) {
        if (body.length === 0 || body.length > LIMITS.batch) out = rpcError(null, CODES.INVALID_REQUEST, `batch must contain 1-${LIMITS.batch} requests`);
        else { out = []; for (const item of body) out.push(await one(item)); }
      } else out = await one(body);
      if (Buffer.byteLength(JSON.stringify(out)) > LIMITS.responseBytes) out = rpcError(null, CODES.INTERNAL, 'response exceeds 16 MiB');
      reply(200, out, cors);
    } catch {
      if (!res.headersSent) reply(500);
      else res.destroy();
    }
  });
  server.requestTimeout = timeoutMs + 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  const publicEndpoint = `http://127.0.0.1:${port}`;
  let closing = null;
  return {
    publicEndpoint, port, stats,
    configureOrigin(origin) {
      requireOrigin(origin);
      if (allowedOrigin !== null && allowedOrigin !== origin) throw new ForkWalletError(CODES.INVALID_PARAMS, `gateway origin already configured as ${allowedOrigin}`);
      allowedOrigin = origin;
    },
    close() {
      if (!closing) {
        closing = new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      return closing;
    },
  };
}

function checkStartOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new ForkWalletError(CODES.INVALID_PARAMS, 'options must be an object');
  const extra = Object.keys(options).filter((key) => !START_OPTIONS.includes(key));
  if (extra.length) throw new ForkWalletError(CODES.INVALID_PARAMS, `unsupported startAnvil options: ${extra.join(', ')} (no CLI arguments or credentials are accepted)`);
  const { chainId = 31337, anvil = 'anvil', timeoutMs = 10000 } = options;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new ForkWalletError(CODES.INVALID_PARAMS, 'chainId must be a positive integer');
  if (typeof anvil !== 'string' || anvil === '' || anvil.startsWith('-')) throw new ForkWalletError(CODES.INVALID_PARAMS, 'anvil must be a binary name or path');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new ForkWalletError(CODES.INVALID_PARAMS, 'timeoutMs must be 100-120000');
  return { chainId, anvil, timeoutMs };
}

/**
 * Starts one vanilla Anvil 1.8.3 child on a free loopback port (random mnemonic, CORS off, scrubbed env) and a read
 * gateway in this process. Returns only after client, chain, exclusive listener PID and unlocked accounts are verified;
 * any startup failure stops the child it started. `stop()` is idempotent and never signals anything but that child.
 */
async function startAnvil(options = {}) {
  const { chainId, anvil, timeoutMs } = checkStartOptions(options);
  requireNoCredentials(process.env);
  const deadline = Date.now() + timeoutMs;
  const port = await freePort();
  const endpoint = requireLoopbackEndpoint(`http://127.0.0.1:${port}`);
  const args = ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId), '--mnemonic-random', '--silent', '--no-cors'];
  const child = spawn(anvil, args, { stdio: 'ignore', env: scrubbedEnv(process.env) });
  const exited = new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', (error) => { child.launchError = error; resolve(); });
  });
  let gateway = null;
  const owned = () => {
    requireRunning(child);
    requireOwnedPort(child.pid, port);
    requireRunning(child);
  };
  let account;
  try {
    let version = null;
    while (version === null) {
      if (child.launchError) throw new Error(`cannot start ${anvil}: ${child.launchError.message}`);
      if (!running(child)) throw new Error(`${anvil} exited during startup (code ${child.exitCode}, signal ${child.signalCode})`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${anvil} did not become ready within ${timeoutMs}ms`);
      try {
        version = await createLoopbackRpc(endpoint, { timeoutMs: Math.max(1, Math.min(1000, remaining)) })('web3_clientVersion');
      } catch { await sleep(Math.min(100, Math.max(1, deadline - Date.now()))); }
    }
    if (typeof version !== 'string' || !SUPPORTED_ANVIL.test(version)) throw new Error(`unsupported client ${JSON.stringify(version)}: anvil/v1.8.3 required`);
    owned();
    const rpc = createLoopbackRpc(endpoint, { timeoutMs: Math.max(1, Math.min(LIMITS.timeoutMs, deadline - Date.now())) });
    const reported = await rpc('eth_chainId');
    if (typeof reported !== 'string' || reported.toLowerCase() !== '0x' + chainId.toString(16)) throw new Error(`anvil chain ${reported} is not ${chainId}`);
    const accounts = await rpc('eth_accounts');
    if (!Array.isArray(accounts) || accounts.length === 0 || !accounts.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a))) throw new Error('anvil reports no unlocked accounts');
    [account] = accounts;
    owned();
    gateway = await startReadGateway({ endpoint, beforeSend: owned });
    requireOwnedPort(process.pid, gateway.port);
  } catch (error) {
    if (gateway) await gateway.close();
    const stopped = await stopChild(child, exited);
    if (!stopped) error.message += ` (and owned child ${child.pid} did not exit)`;
    throw error;
  }

  let stopping = null;
  async function stop() {
    if (!stopping) {
      stopping = (async () => {
        const failures = [];
        try { await gateway.close(); } catch (error) { failures.push(`gateway: ${error.message}`); }
        if (!(await stopChild(child, exited))) failures.push(`owned child ${child.pid} did not exit`);
        try {
          if (listenerPids(port).includes(child.pid)) failures.push(`owned child ${child.pid} still listens on ${port}`);
        } catch (error) { failures.push(`listener check: ${error.message}`); }
        if (failures.length) throw new Error(`stop failed: ${failures.join('; ')}`);
      })();
    }
    return stopping;
  }

  return Object.freeze({
    endpoint, publicEndpoint: gateway.publicEndpoint, chainId: '0x' + chainId.toString(16), account, pid: child.pid,
    beforeSend: owned, configureOrigin: gateway.configureOrigin, stop,
  });
}

module.exports = { startAnvil, startReadGateway, requireNoCredentials, scrubbedEnv, freePort, listenerPids, requireOwnedPort, SUPPORTED_ANVIL };
