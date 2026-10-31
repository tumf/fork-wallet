# Contributing to fork-wallet

This guide is for developers changing fork-wallet itself. To use the published package in dApp tests,
start with the [README](README.md).

## Development setup

Use Node.js >= 22 and npm. From a repository checkout:

```sh
npm ci
npx playwright install chromium
```

The integration test also requires Anvil and `lsof`. Use disposable local accounts and an owned loopback node;
never provide real private keys or funded accounts. Installing dependencies and Chromium requires network access.

## Runnable repository example

The repository-only runnable example `test/integration.test.js` starts a vanilla Anvil (chain 31337), serves the generic dApp in
`examples/local-anvil/dapp/` from an ephemeral loopback HTTP server and asserts receipts, balances and nonces for
every mode. Run it with `npm run test:integration` (requires `anvil`, Playwright Chromium and `lsof`).

## Tests

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm test` | `test/unit.test.js`: option refusals, method/params/field allowlists, preflight and RPC-integrity refusals (chain, client, account, redirect, wrong id, HTTP error, ambiguous, non-JSON), every mode including concurrent hold, cancellation, ownership loss during a hold, repeated lifecycle, disconnect, and the page provider script in a VM sandbox. Uses a scripted HTTP double and a fake context. | Node only |
| `npm run test:integration` | `test/integration.test.js`: real Chromium + vanilla Anvil (chain 31337) + the example dApp. Reject (no submission), approve (receipt, exact balance and gas accounting), fail-closed through the real page, hold with a refused concurrent request, cancellation, release, lost response reconciled by hash and nonce (no duplicate), disconnect events. Writes `artifacts/local-anvil/<timestamp>/evidence.json` and `final.png`. Verifies port ownership with `lsof`, runs Anvil with a scrubbed environment and stops only its own child. | `anvil`, Playwright Chromium (`PLAYWRIGHT_BROWSERS_PATH` honoured), `lsof` |
| `npm run test:pack` | `test/pack-consumer.js`: `npm pack`, install the tarball into a throwaway consumer outside the repo, load it from CommonJS and ESM. Pass a path argument to keep the tarball. | Node, npm |

Missing tools are failures, never skips.

## Packaging

`npm pack` produces `fork-wallet-<version>.tgz` containing `src/index.js`, `index.d.ts`, `README.md`,
`LICENSE` and `package.json`. Version 0.1.1 is published on npm and tagged on GitHub. Consumers can pin
the npm version and lockfile. Tests that require archive evidence should record the tarball SHA-256 and the
installed `src/index.js` SHA-256.
