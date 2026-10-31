# Contributing to ForkWallet

This guide is for people changing **ForkWallet itself**. To test your dApp with ForkWallet, use the
[README](README.md) and [API reference](docs/api.md). Writing a dApp test does not require changing this repository.

## Local setup

- Node >= 22 and npm. Runtime code uses the Node standard library only.
- Install the lockfile dependencies with `npm ci`.
- For browser/EVM checks: Anvil **1.8.3**, `lsof`, and Playwright Chromium (`npx playwright install chromium`).
  `PLAYWRIGHT_BROWSERS_PATH` is respected. macOS is the measured platform; do not claim Linux certification.
- Use a shell without credential variables. Never import a funded key or use real assets.

Dependency/browser installation can access the network. The normal test gates below use loopback only after setup.
The Aave fork example is an explicit exception, not part of the default gates. See
[examples/aave/README.md](examples/aave/README.md) for the separate pinned Base-fork experiment; it does not establish
general dApp support. Examples are repository-only and are not included in the installed package.

The timeout test double keeps Node alive until an abort, then clears its timer; an already-aborted signal is
rejected immediately. The ordinary unit suite, including the release-safety regressions, passed **33/33** on
Node 22.23.1 and 24.18.0 (mini/macOS, 2026-10-31). See [release checks](docs/release-0.3.0.md) for scope
and limitations. This is not a certification of every Node >= 22 release or OS.

The README example was also executed on Linux arm64 with Node 22.22.3, Playwright 1.56.1 Chromium 141.0.7390.37
and Anvil 1.8.3: one successful local receipt, recipient balance 1 wei, sender nonce 1, while the page received an error.
These results are narrow measurements, not full Node >= 22 / Linux certification.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/index.js` | Provider injection, RPC validation, permissions, approval lifecycle, event and error delivery. |
| `src/anvil.js` | Owned Anvil lifecycle, listener ownership and restricted browser read gateway. |
| `index.d.ts`, `anvil.d.ts` | Public types; keep them consistent with runtime and `docs/api.md`. |
| `test/` | Unit, browser/SDK, packaging and installed-consumer regression checks. |
| `examples/local-anvil/` | Generic repository-local dApp and static-server harness. |
| `examples/aave/` | Separate, pinned third-party UI acceptance example; see its own README. |
| `openspec/` | Behaviour specifications and archived changes, not installation instructions. |
| `docs/release-0.3.0.md` | Release-candidate checks and limitations; npm publication status is separate. |

## Change and verification

1. Keep changes narrow. Put dApp-specific targets, calldata policy and business assertions in the consumer, not the provider.
2. Add a regression check for behaviour changes. Check both accepted and rejected paths; count actual dispatches when testing cancellation.
3. Update runtime, declarations and consumer documentation together. Do not label synthetic results as real-chain evidence.
4. Run `npm test`, then the browser gate relevant to the change. For lifecycle/provider changes run `npm run test:sdk`
   and `npm run test:legacy`; for public exports/package changes also run `npm run test:pack:runtime`.
5. Review `git diff --check`, package contents and the final diff before sharing. A passing command does not prove a public release is safe.

## Tests

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm test` | `test/unit.test.js`, `test/provider.test.js`, `test/signing.test.js`, `test/legacy-provider.test.js`: option/request/frame refusals, transaction and read schemas, RPC integrity and bounds, preflight, modes, permissions, registered chains, epochs and late policy races, outcomes, events, page provider and EIP-6963 in a VM; the legacy `autoRefreshOnNetworkChange` / `enable()` surface on the actual serialized page script bound to the real request handler; signing opt-in, exact input bounds, handle order, approvals, pre/post-dispatch scope races and sentinel redaction (synthetic stub results, labelled as such; not cryptographic evidence). In-memory doubles only (stubbed `fetch`, fake context). | Node |
| `npm run test:sdk` | Bounded runner (`test/run-gate.js`, 180 s total) for `test/anvil.test.js` (owned lifecycle, fake-binary failures, foreign listener, gateway rules), `test/sdk-compat.test.js` (real Chromium + bundled ethers/viem/wagmi-core on two owned chains, receipts and state, revert data, logs, lost/fallback, switch, reload/reconnect, negative routing; signing stays 4200 there), `test/signing-compat.test.js` (own policy-enabled context: ethers/viem/wagmi-core sign both methods, ethers and viem recover in-page, refusals and races with dispatch counters, read gateway refusal, redaction of the evidence file) and `test/integration.test.js` (generic dApp regression). Evidence: `artifacts/sdk/<ts>/evidence.json`, `artifacts/signing/<ts>/evidence.json`, `artifacts/local-anvil/<ts>/`. | Anvil 1.8.3, Playwright Chromium (`PLAYWRIGHT_BROWSERS_PATH` honoured), `lsof` |
| `npm run test:integration` | Only the generic dApp regression, same bounded runner. | same |
| `npm run test:legacy` | Same bounded runner (separate from `test:sdk`) for `test/legacy-compat.test.js`: real Chromium runs the injected provider against a synthetic strict-module legacy API fixture (`test/fixtures/legacy-api`, not a third-party app) on one owned vanilla Anvil 31337. Strict render write, refused writes, `enable()` reject then connect, read-gateway agreement, one policy-approved native transfer checked by receipt, balances and nonce, then revoke with no new submission; external HTTP/WS blocked and owned listeners verified retired. | Anvil 1.8.3, Playwright Chromium, `lsof` |
| `npm run test:pack` | `npm pack`, install into a throwaway consumer outside the repo, load `fork-wallet` and `fork-wallet/anvil` from CJS and ESM, check that private paths are not exported, that there are no runtime dependencies and that signing is default-disabled and opt-in through the installed exports. | Node, npm |
| `npm run test:pack:runtime` | Opt-in heavy pack gate (`node test/pack-consumer.js --runtime`): everything `test:pack` checks, then the generic dApp regression (`test/integration.test.js` through the bounded `test/run-gate.js`, 180 s) runs with `fork-wallet` and `fork-wallet/anvil` resolved only from the installed temporary consumer (`FORK_WALLET_CONSUMER_DIR`, test-only; no source fallback). PASS needs child exit 0, evidence `result: PASS`, owned children stopped, no repository `src/` module loaded and installed realpaths matching the consumer. Evidence and the archive SHA-256 stay in `artifacts/pack-runtime/<run>/` (`evidence.json`, `pack-runtime.json`, `gate.log`, `final.png`) after the consumer is deleted. Not part of `test:pack` or any hook; run it explicitly. | Node >= 22, npm, installed devDependencies (`npm ci`), Anvil 1.8.3, Playwright Chromium (`PLAYWRIGHT_BROWSERS_PATH` honoured), `lsof` |
| `npm run test:aave:logic` | Example only (`examples/aave/selfcheck.js`): Aave acceptance policy/receipt logic, outcome and exit-status matrix, redaction/runner/pin sentinels and a real local redirect-denial control in headless Chromium (loopback only). | Node, Playwright Chromium, pinned Aave checkout (`AAVE_DIR`) |
| `npm run test:aave` | Example only (`examples/aave/gate.js` around `examples/aave/harness.js`): unchanged pinned Aave UI supplies ETH and withdraws WETH on an owned Base fork. The harness exits 0 PASS, 4 DEGRADED, 2 FAILED or 3 BLOCKED. The gate turns 4 into exit 0 (`DEGRADED-ACCEPTED`, not a clean PASS) only after inspecting the evidence; 2/3 propagate. See [examples/aave/README.md](examples/aave/README.md). | macOS `sandbox-exec`, Anvil 1.8.3, Playwright Chromium, pinned Aave checkout, public Base read RPC |

Missing tools are failures, never skips. Apart from `npm run test:aave` (its Anvil fork and one `eth_blockNumber` read
`https://mainnet.base.org`), no test contacts anything beyond 127.0.0.1.

## Packaging and release boundaries

Version **0.3.0** is licensed under **MIT** (see [LICENSE](LICENSE)). See the
[release checks and limitations](docs/release-0.3.0.md) for the verified scope.

`npm pack` builds a local archive from the current checkout; it does not publish a package.
Use the published npm version for consumer installation and pin it in a lockfile.
The archive includes runtime source, public declarations, README, LICENSE, the API reference and this contributor guide.
Tests, examples, execution reports and OpenSpec files are repository-only; links to those paths require a repository
checkout. Check the manifest with `npm pack --dry-run --json`.

Pin the archive and record its SHA-256 in downstream evidence. Do not silently upgrade existing consumers.
The installed-package gate checks CJS/ESM exports and then, in runtime mode, executes against the installed copy
without a repository-source fallback.

## Invariants to preserve

- Only the configured loopback origin's main frame may call the provider. No raw RPC passthrough.
- `beforeSend` must check ownership, and the consumer must validate the exact intended transaction. These are
  trusted callbacks, not cryptographic proofs or an OS sandbox.
- Scope changes invalidate pending work **before dispatch**. A dispatched transaction cannot be cancelled by
  disconnecting; keep its original chain/account attribution and reconcile it on that node.
- Never retry internally or claim exactly-once submission. `unknown` is not proof of no send.
- Signing is opt-in, restricted to disposable accounts on 31337/31338. Never retain signing payloads or signatures
  in evidence, traces, HAR, video or screenshots. A signature may remain valid outside the local chain.
- Keep synthetic unit results, real local-chain execution, fork execution and real-wallet compatibility separate.

## Privacy and confidential data

Before sharing a branch or archive, inspect both its current tree **and its Git history**:

- Check source, documentation, lockfiles, fixtures, commit messages, author/committer identities, tags and branch names.
- Look for credentials, mnemonic phrases, personal email addresses, home paths, private hosts/URLs and customer data.
  Label deliberate public fixtures; do not treat every 32-byte hash as a private key.
- `.gitignore` is not redaction. `artifacts/`, local screenshots, traces, archives and installed dependencies are not
  made safe by being ignored. Do not attach them wholesale to issues or releases.
- Deleting a file does not remove it from previous commits. Inspect remote refs separately from local branches,
  reflogs and unreachable objects; local inspection cannot certify remote caches, clones, issues or uploaded assets.
- Report a candidate by file/line and commit/blob ID, with its value redacted. Do not paste a discovered secret into
  a public issue. If an actual credential is found, arrange revocation/rotation before history cleanup.
- History rewriting, force-push, repository visibility changes and publication require explicit owner approval.

Use synthetic examples and portable relative paths in new documentation. Do not add internal handoff reports or
machine-specific execution paths to the consumer README.
