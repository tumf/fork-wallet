'use strict';
// fork-wallet: a test-only EIP-1193 wallet injected into a Playwright BrowserContext.
// It submits only through an owned loopback JSON-RPC node (Anvil by default) using that node's
// unlocked account. It holds no key, signs nothing itself and never imports product code.

const MODES = Object.freeze(['approve', 'reject', 'hold', 'lost']);
const RELEASE_OUTCOMES = Object.freeze(['approve', 'reject', 'lost']);
const METHODS = Object.freeze(['eth_accounts', 'eth_requestAccounts', 'eth_chainId', 'eth_sendTransaction']);
const TRANSACTION_FIELDS = Object.freeze(['from', 'to', 'value', 'data', 'chainId']);
const CODES = Object.freeze({
  USER_REJECTED: 4001, UNSUPPORTED_METHOD: 4200, DISCONNECTED: 4900,
  REQUEST_PENDING: -32002, INVALID_PARAMS: -32602, INTERNAL: -32603,
});
const DEFAULT_CLIENT = /^anvil\//i;
const DEFAULT_TIMEOUT_MS = 15000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

class ForkWalletError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForkWalletError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new ForkWalletError(code, message); };
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Exact loopback HTTP JSON-RPC endpoint: http://127.0.0.1:<port> with an optional trailing slash and nothing else. */
function requireLoopbackEndpoint(endpoint) {
  let url;
  try { url = new URL(String(endpoint)); } catch { fail(CODES.INVALID_PARAMS, `refusing endpoint ${endpoint}: not a URL`); }
  const ok = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && !url.username
    && !url.password && url.search === '' && url.hash === '' && (url.pathname === '/' || url.pathname === '');
  if (!ok) fail(CODES.INVALID_PARAMS, `refusing endpoint ${endpoint}: only http://127.0.0.1:<port> is allowed`);
  return String(endpoint);
}

/** Exact loopback page origin: http://127.0.0.1:<port> (no path, query, fragment or credentials). */
function requireOrigin(origin) {
  let url;
  try { url = new URL(String(origin)); } catch { fail(CODES.INVALID_PARAMS, `refusing origin ${origin}: not a URL`); }
  if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '') {
    fail(CODES.INVALID_PARAMS, `refusing origin ${origin}: exact http://127.0.0.1:<port> origin required`);
  }
  return origin;
}

/** Canonical lowercase hex chain ID (no leading zeros) from a positive integer or hex string. No default. */
function normalizeChainId(chainId) {
  if (Number.isSafeInteger(chainId) && chainId > 0) return '0x' + chainId.toString(16);
  if (typeof chainId === 'string' && /^0x[1-9a-fA-F][0-9a-fA-F]*$/.test(chainId)) return chainId.toLowerCase();
  fail(CODES.INVALID_PARAMS, `chainId must be a positive integer or canonical hex string, got ${JSON.stringify(chainId)}`);
}

/** Validates the exact eth_sendTransaction params shape and returns a frozen copy of the request bytes. */
function checkTransaction(params, account, chainId) {
  if (!Array.isArray(params) || params.length !== 1 || !isPlainObject(params[0])) {
    fail(CODES.INVALID_PARAMS, 'eth_sendTransaction expects exactly one transaction object');
  }
  const tx = Object.freeze(structuredClone(params[0]));
  const unknown = Object.keys(tx).filter((key) => !TRANSACTION_FIELDS.includes(key));
  if (unknown.length) fail(CODES.INVALID_PARAMS, `unsupported transaction fields: ${unknown.join(', ')}`);
  if (typeof tx.from !== 'string' || !ADDRESS.test(tx.from) || tx.from.toLowerCase() !== account.toLowerCase()) {
    fail(CODES.INVALID_PARAMS, 'transaction.from must be the wallet account');
  }
  if (typeof tx.to !== 'string' || !ADDRESS.test(tx.to)) fail(CODES.INVALID_PARAMS, 'transaction.to must be an address');
  if (Object.hasOwn(tx, 'value') && (typeof tx.value !== 'string' || !QUANTITY.test(tx.value))) {
    fail(CODES.INVALID_PARAMS, 'transaction.value must be a canonical hex quantity');
  }
  if (Object.hasOwn(tx, 'data') && (typeof tx.data !== 'string' || !BYTES.test(tx.data))) {
    fail(CODES.INVALID_PARAMS, 'transaction.data must be hex bytes');
  }
  if (Object.hasOwn(tx, 'chainId') && (typeof tx.chainId !== 'string' || tx.chainId.toLowerCase() !== chainId)) {
    fail(CODES.INVALID_PARAMS, `transaction.chainId must be ${chainId}`);
  }
  return tx;
}

/** Strict JSON-RPC 2.0 client for one loopback endpoint: no redirects, matched IDs, exactly one of result/error. */
function createLoopbackRpc(endpoint, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  requireLoopbackEndpoint(endpoint);
  let id = 0;
  return async function rpc(method, params = []) {
    const requestID = ++id;
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ jsonrpc: '2.0', id: requestID, method, params }),
    });
    if (!response.ok) fail(CODES.INTERNAL, `loopback RPC HTTP ${response.status}`);
    let body;
    try { body = await response.json(); } catch { fail(CODES.INTERNAL, 'loopback RPC returned non-JSON'); }
    if (!isPlainObject(body) || body.jsonrpc !== '2.0' || body.id !== requestID) fail(CODES.INTERNAL, 'mismatched RPC response');
    if (Object.hasOwn(body, 'result') === Object.hasOwn(body, 'error')) fail(CODES.INTERNAL, 'ambiguous RPC response');
    if (body.error) {
      const code = isPlainObject(body.error) && Number.isInteger(body.error.code) ? body.error.code : CODES.INTERNAL;
      throw Object.assign(new ForkWalletError(code, String(body.error && body.error.message)), { data: body.error.data });
    }
    return body.result;
  };
}

/**
 * Installs the wallet into a Playwright BrowserContext (anything with exposeBinding/addInitScript/pages).
 * Returns the control handle. See README for options, modes, errors and trust boundaries.
 */
async function installForkWallet(context, options) {
  if (!context || typeof context.exposeBinding !== 'function' || typeof context.addInitScript !== 'function') {
    fail(CODES.INVALID_PARAMS, 'a Playwright BrowserContext is required');
  }
  if (!isPlainObject(options)) fail(CODES.INVALID_PARAMS, 'options object required');
  const { endpoint, origin, account, validateTransaction, beforeSend, clientVersion = DEFAULT_CLIENT,
    timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  requireLoopbackEndpoint(endpoint);
  requireOrigin(origin);
  const chainId = normalizeChainId(options.chainId);
  if (typeof account !== 'string' || !ADDRESS.test(account)) fail(CODES.INVALID_PARAMS, 'account must be an address');
  if (typeof validateTransaction !== 'function') fail(CODES.INVALID_PARAMS, 'validateTransaction(tx) is mandatory');
  if (typeof beforeSend !== 'function') fail(CODES.INVALID_PARAMS, 'beforeSend() ownership guard is mandatory');
  if (!(clientVersion instanceof RegExp)) fail(CODES.INVALID_PARAMS, 'clientVersion must be a RegExp');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) fail(CODES.INVALID_PARAMS, 'timeoutMs must be a positive integer');

  const rpc = createLoopbackRpc(endpoint, { timeoutMs });
  const calls = [];
  const submitted = [];
  let mode = 'approve';
  let connected = true;
  let release = null;
  const holdWaiters = [];

  async function preflight() {
    if (!connected) fail(CODES.DISCONNECTED, 'wallet disconnected');
    await beforeSend();
    const chain = await rpc('eth_chainId');
    if (typeof chain !== 'string' || chain.toLowerCase() !== chainId) fail(CODES.INTERNAL, `node chain ${chain} is not ${chainId}`);
    const version = await rpc('web3_clientVersion');
    if (typeof version !== 'string' || !clientVersion.test(version)) fail(CODES.INTERNAL, `refusing client ${version}`);
    const accounts = await rpc('eth_accounts');
    if (!Array.isArray(accounts) || !accounts.some((a) => typeof a === 'string' && a.toLowerCase() === account.toLowerCase())) {
      fail(CODES.INTERNAL, 'account is not unlocked on the loopback node');
    }
    await beforeSend();
    if (!connected) fail(CODES.DISCONNECTED, 'wallet disconnected');
  }

  async function sendTransaction(params) {
    const tx = checkTransaction(params, account, chainId);
    await validateTransaction(tx);
    await preflight();
    const call = { mode, transaction: tx, outcome: 'pending' };
    calls.push(call);
    try {
      let outcome = mode;
      if (outcome === 'hold') {
        if (release) fail(CODES.REQUEST_PENDING, 'a held request is already pending');
        outcome = await new Promise((resolve) => {
          release = resolve;
          for (const waiter of holdWaiters.splice(0)) waiter();
        });
        if (!connected) fail(CODES.DISCONNECTED, 'wallet disconnected while held');
      }
      if (outcome === 'reject') fail(CODES.USER_REJECTED, 'user rejected the request');
      if (!['approve', 'lost'].includes(outcome)) fail(CODES.INTERNAL, `unknown outcome ${outcome}`);
      await validateTransaction(tx);
      await preflight();
      const hash = await rpc('eth_sendTransaction', [tx]);
      if (typeof hash !== 'string' || !HASH.test(hash)) fail(CODES.INTERNAL, 'node returned no transaction hash');
      submitted.push(hash);
      call.hash = hash;
      if (outcome === 'lost') {
        call.outcome = 'lost';
        fail(CODES.INTERNAL, 'wallet response lost after local submission');
      }
      call.outcome = 'submitted';
      return hash;
    } catch (error) {
      if (call.outcome === 'pending') call.outcome = error && error.code === CODES.USER_REJECTED ? 'rejected' : 'failed';
      call.error = { code: error && Number.isInteger(error.code) ? error.code : CODES.INTERNAL, message: String(error && error.message) };
      throw error;
    }
  }

  async function handle(source, request) {
    const callerOrigin = new URL(source.frame.url()).origin;
    if (callerOrigin !== origin) fail(CODES.UNSUPPORTED_METHOD, `wrong caller origin ${callerOrigin}`);
    if (!isPlainObject(request)) fail(CODES.INVALID_PARAMS, 'request object required');
    const unknown = Object.keys(request).filter((key) => key !== 'method' && key !== 'params');
    if (unknown.length) fail(CODES.INVALID_PARAMS, `unsupported request fields: ${unknown.join(', ')}`);
    const { method, params = [] } = request;
    if (!METHODS.includes(method)) fail(CODES.UNSUPPORTED_METHOD, `unsupported method ${String(method)}`);
    if (!Array.isArray(params)) fail(CODES.INVALID_PARAMS, 'params must be an array');
    if (!connected) {
      if (method === 'eth_accounts') return [];
      fail(CODES.DISCONNECTED, 'wallet disconnected');
    }
    if (method === 'eth_sendTransaction') return sendTransaction(params);
    if (params.length !== 0) fail(CODES.INVALID_PARAMS, `${method} takes no params`);
    return method === 'eth_chainId' ? chainId : [account];
  }

  await context.exposeBinding('__forkWalletRequest', async (source, request) => {
    try {
      return { result: await handle(source, request) };
    } catch (error) {
      const code = error && Number.isInteger(error.code) ? error.code : CODES.INTERNAL;
      return { error: { code, message: String(error && error.message) } };
    }
  });

  await context.addInitScript(({ origin: allowed }) => {
    if (location.origin !== allowed) return;
    const listeners = new Map();
    const provider = {
      isForkWallet: true,
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
        return provider;
      },
      removeListener(name, fn) {
        if (listeners.has(name)) listeners.get(name).delete(fn);
        return provider;
      },
      async request(request) {
        const reply = await window.__forkWalletRequest(request);
        if (reply.error) {
          const error = new Error(reply.error.message);
          error.code = reply.error.code;
          throw error;
        }
        return reply.result;
      },
    };
    window.ethereum = provider;
    window.__forkWalletEmit = (name, payload) => {
      for (const fn of [...(listeners.get(name) || [])]) fn(payload);
    };
  }, { origin });

  async function emit(name, payload) {
    const pages = typeof context.pages === 'function' ? context.pages() : [];
    await Promise.allSettled(pages
      .filter((page) => { try { return new URL(page.url()).origin === origin; } catch { return false; } })
      .map((page) => page.evaluate(([n, p]) => window.__forkWalletEmit?.(n, p), [name, payload])));
  }

  return {
    calls, submitted, chainId, account,
    get mode() { return mode; },
    get connected() { return connected; },
    get held() { return Boolean(release); },
    setMode(value) {
      if (!MODES.includes(value)) fail(CODES.INVALID_PARAMS, `unknown mode ${String(value)}`);
      mode = value;
    },
    whenHeld() {
      return release ? Promise.resolve() : new Promise((resolve) => holdWaiters.push(resolve));
    },
    release(outcome = 'approve') {
      if (!RELEASE_OUTCOMES.includes(outcome)) fail(CODES.INVALID_PARAMS, `unknown release outcome ${String(outcome)}`);
      if (!release) fail(CODES.INTERNAL, 'no held request');
      const resolve = release;
      release = null;
      resolve(outcome);
    },
    async disconnect() {
      connected = false;
      if (release) {
        const resolve = release;
        release = null;
        resolve('reject'); // the held request observes the disconnect and fails with 4900
      }
      await emit('accountsChanged', []);
      await emit('disconnect', { code: CODES.DISCONNECTED, message: 'wallet disconnected' });
    },
  };
}

module.exports = {
  installForkWallet, createLoopbackRpc, requireLoopbackEndpoint, requireOrigin, normalizeChainId, checkTransaction,
  ForkWalletError, MODES, METHODS, TRANSACTION_FIELDS, CODES,
};
