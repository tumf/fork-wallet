'use strict';
// Example harness: one loopback static server for the dApp under test. Anvil ownership (child lifecycle, listener
// PID checks, read gateway) lives in the packaged fork-wallet/anvil helper; nothing is copied here.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_CSP = "default-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Serves only the files directly in one directory on a free loopback port with an explicit CSP (self-only by default).
 * `requireOwnedPort` may be injected (the installed-package gate passes the installed fork-wallet/anvil export); the
 * repository source helper is loaded lazily only when it is absent.
 */
async function startStaticServer(root, { csp = DEFAULT_CSP, requireOwnedPort } = {}) {
  const ownedPort = requireOwnedPort || require('../../src/anvil.js').requireOwnedPort;
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    const file = path.join(root, name);
    const type = types[path.extname(name)];
    if (req.method !== 'GET' || !type || path.dirname(file) !== root || !fs.existsSync(file)) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': csp, 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  ownedPort(process.pid, port);
  return {
    origin: `http://127.0.0.1:${port}`, port,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

module.exports = { startStaticServer, sleep, DEFAULT_CSP };
