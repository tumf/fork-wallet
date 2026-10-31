'use strict';
// In-memory doubles for unit tests: a scripted JSON-RPC node behind a stubbed global fetch (no sockets), a fake
// Playwright BrowserContext whose binding sources carry the real {page, frame} structural identity, and a VM runner
// for the page provider script. Nothing here touches a network, process, filesystem or browser.
const vm = require('node:vm');
const assert = require('node:assert/strict');

const account = '0x' + '11'.repeat(20);
const other = '0x' + '44'.repeat(20);
const target = '0x' + '22'.repeat(20);
const hash = '0x' + '33'.repeat(32);
const origin = 'http://127.0.0.1:12345';
const chainId = '0x7a69';
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** Installs (once per test) a fetch stub that routes http://127.0.0.1:<port> to scripted nodes; restored after the test. */
let shared = null;
function installFetch(t) {
  if (shared) return shared;
  const nodes = new Map();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const node = nodes.get(String(url));
    if (!node) throw new TypeError('fetch failed: connection refused');
    return node.serve(init);
  };
  shared = nodes;
  t.after(() => { globalThis.fetch = original; shared = null; });
  return nodes;
}

let nextPort = 20000;
/** Scripted node. Knobs change behaviour per call so each RPC-integrity and outcome path is exercised. */
function createNode(nodes, { chain = chainId, accounts = [account, other] } = {}) {
  const endpoint = 'http://127.0.0.1:' + nextPort++;
  const node = {
    endpoint, chain, client: 'anvil/v1.8.3', accounts, sends: 0, hash, requests: [], results: {},
    redirect: false, wrongID: false, status: 200, ambiguous: false, nonJSON: false, hangOn: null, errorOn: {}, bigResponse: 0,
    gate: null,
    async serve(init) {
      const q = JSON.parse(init.body);
      node.requests.push({ method: q.method, params: q.params });
      if (node.gate && q.method === node.gate.method) await node.gate.promise;
      if (node.hangOn === q.method) {
        return new Promise((_, reject) => {
          if (init.signal.aborted) { reject(init.signal.reason); return; }
          // Like real fetch's socket, keep Node alive until the timeout aborts this request.
          const alive = setInterval(() => {}, 1000);
          init.signal.addEventListener('abort', () => {
            clearInterval(alive);
            reject(init.signal.reason);
          }, { once: true });
        });
      }
      if (node.redirect) throw new TypeError('fetch failed: unexpected redirect');
      if (node.nonJSON) return new Response('not json', { status: 200 });
      if (node.bigResponse) {
        const size = node.bigResponse;
        let sent = 0;
        const stream = new ReadableStream({
          pull(controller) {
            if (sent >= size) { controller.close(); return; }
            const chunk = new Uint8Array(Math.min(1 << 20, size - sent)).fill(0x20);
            sent += chunk.length;
            controller.enqueue(chunk);
          },
        });
        return new Response(stream, { status: 200 });
      }
      const body = { jsonrpc: '2.0', id: node.wrongID ? q.id + 1 : q.id };
      const scripted = node.errorOn[q.method];
      if (scripted) body.error = scripted;
      else body.result = node.answer(q);
      if (node.ambiguous) { body.error = { code: -1, message: 'both' }; body.result = null; }
      return new Response(JSON.stringify(body), { status: node.status, headers: { 'Content-Type': 'application/json' } });
    },
    answer(q) {
      if (Object.hasOwn(node.results, q.method)) return node.results[q.method];
      switch (q.method) {
        case 'eth_chainId': return node.chain;
        case 'web3_clientVersion': return node.client;
        case 'eth_accounts': return node.accounts;
        case 'eth_sendTransaction': node.sends++; return node.hash;
        case 'eth_getTransactionByHash': return { hash: q.params[0], from: node.accounts[0], nonce: '0x' + Math.max(0, node.sends - 1).toString(16), type: '0x2' };
        case 'eth_getBlockByNumber': return { number: node.blockNumber || '0x10' };
        default: return '0x0';
      }
    },
    sent(method) { return node.requests.filter((r) => r.method === method).length; },
  };
  nodes.set(endpoint, node);
  return node;
}

/** A frame and page with Playwright's structural identity: page.mainFrame() === frame for the main frame only. */
function fakePage(url, { onEvaluate } = {}) {
  const page = { url: () => url, evaluate: async (fn, arg) => (onEvaluate ? onEvaluate(arg) : undefined) };
  const main = { url: () => url };
  page.mainFrame = () => main;
  page.frame = main;
  page.subframe = (subUrl) => ({ url: () => subUrl });
  return page;
}

function fakeContext(pages = []) {
  const ctx = { bindings: {}, scripts: [], pages: () => pages };
  ctx.exposeBinding = async (name, fn) => {
    assert.ok(name === '__forkWalletRequest' || name === '__forkWalletInit', name);
    assert.ok(!ctx.bindings[name], 'binding installed twice');
    ctx.bindings[name] = fn;
  };
  ctx.addInitScript = async (fn, args) => { ctx.scripts.push({ fn, args }); };
  ctx.page = fakePage(origin + '/');
  /** Request from the main frame of ctx.page (or of a page at another origin). */
  ctx.request = (method, params, { frameOrigin } = {}) => {
    const page = frameOrigin ? fakePage(frameOrigin + '/') : ctx.page;
    const request = params === undefined ? { method } : { method, params };
    return ctx.bindings.__forkWalletRequest({ page, frame: page.mainFrame() }, request);
  };
  ctx.raw = (source, request) => ctx.bindings.__forkWalletRequest(source, request);
  return ctx;
}

function baseOptions(node, extra = {}) {
  return { endpoint: node.endpoint, origin, chainId: node.chain, account, validateTransaction() {}, beforeSend() {}, ...extra };
}

/** Runs the page provider init script in a VM sandbox and returns its window. */
function runPageScript(script, { pageOrigin = origin, top = true, init = async () => ({ connected: true, chainId }), timers = setTimeout } = {}) {
  const handlers = new Map();
  const window = {
    addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    dispatchEvent(event) { for (const fn of handlers.get(event.type) || []) fn(event); return true; },
    __forkWalletInit: init,
  };
  window.top = top ? window : {};
  class CustomEvent { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } }
  const sandbox = { location: { origin: pageOrigin }, window, CustomEvent, queueMicrotask, setTimeout: timers, Map, Set, Error, Object, Promise };
  vm.runInNewContext('(' + script.fn.toString() + ')(' + JSON.stringify(script.args) + ')', sandbox);
  return window;
}

module.exports = { account, other, target, hash, origin, chainId, tick, installFetch, createNode, fakePage, fakeContext, baseOptions, runPageScript };
