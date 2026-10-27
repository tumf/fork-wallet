# Measured Aave acceptance example (macOS, pinned unchanged Aave interface, owned Base fork)

Repository-local, **macOS-only** acceptance example: fork-wallet drives the **unchanged** Aave interface at commit
`20fdc895a9e3925960b5cd111fe09535cf224085` against an owned, disposable Anvil fork of Base on chain 31337, with
signing disabled and capped approvals. The UI supplies exactly 0.5 ETH and withdraws exactly 0.1 WETH. Each step is
proven by mined receipts, exact events and balances read separately, never by success text alone. The UI's
default native-ETH withdrawal asks for an unlimited (MaxUint256) aWETH approval. The harness refuses it: the refusal is
an acceptance check, and native withdrawal capability is reported as **blocked**.

This is an example, not product code: `src/`, the declarations, the package version, dependencies, the API and the
timeouts are unchanged. It is not a production, mainnet, real-key or arbitrary-dApp acceptance. Exchange/swap,
borrow/repay, SIWE, Permit2/ERC-2612 and a positive native-ETH route are out of scope. Distribution and user
integration remain separate product work.

The example was promoted from the exploratory spike on branch `spike-aave-acceptance` (commit `eb01565`). Authorship
is in git history only. Evidence never names an author or a model: the current executor is recorded only from
`SPIKE_RUNNER` (or `null`).

## Files

- `lib.js` — logic with no direct I/O: transaction policy (exact destinations, selectors, values, byte-exact
  `Pool.withdraw`), receipt/event/balance assertions, native refusal check, positive-route hygiene (zero refusals, zero
  unsupported dispatches), diagnostic classification, cleanup verdict, aggregate outcome/exit code, Aave pin check,
  runner metadata, redaction and the evidence sentinel, and the browser egress route handler.
- `selfcheck.js` — `npm run test:aave:logic`. Positive and negative cases for all of the above, including the outcome
  matrix (missing step, blocked step, duplicated step, cleanup failure, prerequisite vs. UI-stage fatal, sentinel hit).
  It also runs a real local **redirect-denial control** in headless Chromium through the same route handler: owned
  ephemeral loopback servers only, no public calls. A missing Chromium is a FAIL, not a skip. It recomputes every
  selector/topic with ethers from the Aave checkout and checks the upstream withdraw-route sources.
- `harness.js` — `npm run test:aave:harness`: the end-to-end run. Writes only `artifacts/<timestamp>/` (gitignored).
- `gate.js` — `npm run test:aave`: the supervised acceptance gate. Runs `harness.js` once and inspects its
  `evidence.json` (`lib.js` `gateVerdict`), writing `gate-verdict.json` next to it. See [Supervised gate](#supervised-gate-gatejs).

## Prerequisites (not fetched or installed by the harness)

- macOS with `/usr/bin/sandbox-exec`, `/usr/sbin/lsof`, `/usr/bin/git`; Node 24 at `/opt/homebrew/opt/node@24/bin`
  (the sandbox controls run that exact binary).
- `anvil` 1.8.3 on `PATH`.
- `npm ci` in this repository and Playwright Chromium (`npx playwright install chromium`).
- Pinned Aave checkout with installed lockfile dependencies. Its default path is
  `/tmp/fork-wallet-aave-interface-20261027`; override it with `AAVE_DIR`:

  ```sh
  git clone https://github.com/aave/interface /tmp/fork-wallet-aave-interface-20261027
  git -C /tmp/fork-wallet-aave-interface-20261027 checkout --detach 20fdc895a9e3925960b5cd111fe09535cf224085
  (cd /tmp/fork-wallet-aave-interface-20261027 && pnpm install --frozen-lockfile)   # pnpm 10.18, Node 24
  ```

  Before anything starts, the harness refuses a checkout whose `HEAD` is not that commit or that has any modified
  tracked file (exit 3). It checks again after cleanup. Install/build artifacts (untracked) are fine. Aave sources are never
  modified.
- Network: Anvil's fork reads and the harness's single `eth_blockNumber` fork-pin read go to `https://mainnet.base.org`.
  Nothing else may reach a public endpoint.

## Run

```sh
npm run test:aave:logic
/usr/bin/env -i PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin HOME="$HOME" \
  SPIKE_RUNNER=<who-runs-this> node examples/aave/gate.js           # or: npm run test:aave (same script)
# raw harness exit status without the gate: node examples/aave/harness.js (npm run test:aave:harness)
```

The harness refuses credential-like environment variables. A full run takes about 3–4 minutes, mostly the cold-read
diagnostics.

## Exit status (from `evidence.acceptance`, computed by `lib.js` `classifyAcceptance`)

| Exit | `overall` | Meaning |
| --- | --- | --- |
| 0 | `PASS` | `supply`, `withdrawWETH` and `nativeRouteRefusal` all `passed`, cleanup verified, every `diag.*` step `passed`. |
| 4 | `DEGRADED` | All three runtime checks passed and cleanup was verified, but at least one diagnostic was degraded (`diagnostic-timeout`/`diagnostic-failed`). This is degraded success on the warm path, **never** a clean PASS. An acceptance gate may take 4 only after inspecting the evidence for all three runtime assertions and cleanup. |
| 2 | `FAILED` | Any runtime check `failed`, `blocked` or missing; a fatal error in the UI stage; any other failed step; cleanup not verified (leftover listener, live owned PID, unremoved temp HOME, dirty Aave after the run); or the evidence sentinel had to redact a value. |
| 3 | `BLOCKED` | A prerequisite or launch stage stopped the run (credentials in env, missing sandbox, unpinned/dirty Aave, upstream, Anvil, gateway, sandbox controls, Next, browser) and cleanup was verified. |

Each runtime check passes only if exactly one step with its name exists and that step is `passed`. A missing,
duplicated or skipped step never yields 0 or 4. If the native refusal check is not attempted (for example because of
the budget or a failed WETH route), it is `blocked`, which fails acceptance. `nativeRouteCapability` is always
`blocked`: the refusal check proves the block and does not provide native withdrawal. Diagnostics keep their error
class and timing (`evidence.diagnostics`, `diag.*` steps).

## Supervised gate (`gate.js`)

A supervisor that only sees exit codes would read the harness's exit 4 as a failure. `gate.js` performs the evidence
inspection that exit 4 requires, so the declared verification runs the gate, not the raw harness. It derives the outcome
again from the raw evidence (`steps`, `fatal`, `close` + `launched` through `cleanupVerdict`, redaction sentinel) and
does not trust `evidence.acceptance`. It requires that the derived outcome, the recorded outcome and the harness exit
code agree. It also requires that `supply`, `withdrawWETH` and `nativeRouteRefusal` passed, that cleanup was verified,
that the Aave checkout was pinned and tracked-clean before and after the run, and that `nativeRouteCapability` is
`blocked`.

| Harness exit | Gate verdict | Gate exit |
| --- | --- | --- |
| 0 and inspection holds | `PASS` | 0 |
| 4 and inspection holds | `DEGRADED-ACCEPTED`: degraded success of the warm path, **not** a clean PASS. The degraded diagnostics are listed. | 0 |
| 0/4 and any inspection mismatch, missing or unreadable evidence | `NOT-ACCEPTED` | 2 |
| 2, 3 or anything else | `NOT-ACCEPTED` | unchanged (2/3 can never complete the change) |

## What `harness.js` does

1. Pin check and tracked-clean check of the Aave checkout. Only after that are the app's address-book addresses
   loaded.
2. Reads `eth_blockNumber` from `https://mainnet.base.org` once and pins the fork 5 blocks behind it. Spawns one owned
   `anvil --fork-url ... --chain-id 31337 --mnemonic-random --silent --no-cors --no-storage-caching` with a temporary
   `HOME`. It verifies the version, an exclusive listener and the chain, and checks that every Aave V3 Base address
   has code on the fork.
3. Starts fork-wallet's unchanged read gateway (15 s product timeout) in-process.
4. Diagnostics on the same block (`UiPoolDataProvider.getReservesData` cold through the gateway; if that times out, once
   directly at Anvil with 60 s, then through the gateway again; warming of the other dashboard reads). Each `diag.*`
   step is classified separately.
5. Seatbelt profile for the app server: network only to the owned app port and the gateway port. Controls run through
   the same profile first: public upstream and the Anvil port must be denied, the gateway port allowed.
6. Unchanged `next dev` under `sandbox-exec`, with the keys from the tracked `.env.development` shadowed. It proves the
   app listener descends from the owned child and that the server API routes fail closed.
7. Headless Chromium. Service workers are blocked. HTTP is allowed only to the app origin and the gateway origin,
   through `lib.js` `makeEgressHandler`. The only WebSocket is the app's own `ws://<app>/_next/webpack-hmr`.
   fork-wallet is installed with the policy from `lib.js`: exact `depositETH` of 0.5 ETH, byte-exact
   `Pool.withdraw(WETH, 0.1 ETH, account)` with value 0 and no approval (Unwrap toggle OFF). The native route is not
   whitelisted. A navigation guard fails any flow during which the document reloads.
8. Supply (0.5 ETH) → withdraw 0.1 WETH (toggle OFF) → native refusal check (toggle ON, click the approval: exactly one
   MaxUint256 refusal, zero sends, aWETH unchanged). Then the modal is closed through the app's own controls.
9. Cleanup: closes the browser, stops `next` and its owned listener descendants, the gateway and Anvil, and removes
   the temp HOME. Then it records the listeners left on every owned port, the owned PIDs still alive and the Aave
   tracked status (`evidence.close`, `evidence.cleanup`).

### Redirects

Both proxy sites fetch with `route.fetch({ maxRedirects: 0 })`, so Playwright never follows a redirect on its own. A
3xx is also never handed to the browser. Measured with Playwright 1.56 Chromium, a fulfilled navigation redirect is
followed natively **without** re-entering the route handler. So the handler applies the allowlist to every hop itself:
a hop to the app or gateway origin is fetched again with `maxRedirects: 0` (at most 5 hops). Any other target, a
malformed `Location` or too many hops aborts the request. The unchanged Next dev server answers some same-origin
requests with 308, which is why allowed hops are followed rather than all aborted (aborting them raised the Next error
overlay over the dashboard). `evidence.redirects` and `evidence.denied` record each decision. The selfcheck proves zero
destination requests, and two controls show that the destination *is* reached with default `route.fetch` and with a
handed-over 3xx.

### Evidence and secrets

`evidence.json` keeps methods, targets, selectors, amounts, counts, statuses, timings, local transaction hashes and the
fork block hash. It never keeps keys, mnemonics, messages, signatures or calldata (the expected withdraw call is stored
as its SHA-256 only). Console, error and modal text is redacted: every run of 64 or more hex characters is replaced,
which covers calldata (selector + one word = 72), keys and signatures. Before writing, a sentinel scans the serialized
evidence. Any long hex value that is not an allowed hash is replaced and fails acceptance (exit 2).

## Measured result (2026-10-27)

Fresh run `artifacts/2026-10-27T12-56-42-755Z`, runner `conflux`, exit **4 DEGRADED**:

- `supply` passed: one receipt (status 0x1) to the WETH gateway with a Pool `Supply(WETH, account, 0.5 ETH)` log; aWETH
  0 → 499999999999999999 (1 wei aToken rounding).
- `withdrawWETH` passed: one receipt (status 0x1) to the Pool, Pool `Withdraw` and WETH `Transfer(aWETH → account)`
  logs; WETH 0 → 100000000000000000; aWETH dropped by 99999998701434998 (interest within tolerance); no approval, no
  refusal, no unsupported dispatch.
- `nativeRouteRefusal` passed: exactly one refusal `approve amount MaxUint256 (unlimited) exceeds cap
  100000000000000000 wei`, 0 submitted, aWETH unchanged. `nativeRouteCapability`: blocked.
- `diagnosticsDegraded`: true. `diag.gateway.cold` timed out after 15 s and `diag.direct.60s` after 60 s (both
  `transport-timeout`, cold upstream state fetching). After warming, the gateway answered in about 5 s.
- Cleanup verified: no listener on the Anvil, gateway or app ports, no owned app PID alive, temp HOME removed, Aave
  still tracked-clean. 1 connect request, no reload, 1 HMR socket, 0 denied WebSockets. 8 same-origin 308 hops were
  followed after the allowlist check, with none going elsewhere. Every public host the app tried was denied in the
  browser. Sentinel: 0 values redacted.
