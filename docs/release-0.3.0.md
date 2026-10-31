# 0.3.0 release candidate

Status: prepared and tested on macOS; **not published to npm**. npm latest remains 0.1.1.

## Changes since 0.1.1

- EIP-6963 discovery, permissions, bounded read RPC, registered-chain switching and account lifecycle.
- Expanded transaction schemas and installed Anvil lifecycle/read-gateway exports (`fork-wallet/anvil`).
- Opt-in local-account message/typed-data signing with policy checks and stale-result handling.
- Frozen legacy provider compatibility (`enable`, `autoRefreshOnNetworkChange`).
- Consumer quickstart, API reference, MIT license and official npm publish configuration.

This candidate integrates the latest development history and the existing public main history. Public declarations and core provider source match development commit `2ec35f0`. Release changes reconcile docs,
licensing, registry metadata, package contents and a timeout test double. The Anvil read gateway additionally fixes
HTTP 413 delivery during in-flight uploads on Node 22, with bounded draining and an incomplete-upload regression. Existing unrelated worktrees are preserved.

## Executed verification (2026-10-31, mini/macOS)

| Check | Result |
| --- | --- |
| `npm test` | 30 passed, zero failed/cancelled/skipped, on Node 22.23.1, 24.18.0 and 26.12.1 |
| `npm run test:sdk` | 20 passed; actual Chromium, Anvil 1.8.3, ethers 6.17.0, viem 2.57.12, wagmi core 2.22.1 |
| `npm run test:legacy` | 1 passed; synthetic legacy UI fixture, actual local transaction and cleanup |
| `npm run test:pack:runtime` | PASS; CJS/ESM, both installed exports, real local transaction lifecycle; no repository-source fallback |
| `npm run test:pack` on Node 22 | PASS; 9 allowlisted files, MIT included, zero runtime dependencies |
| README runnable JavaScript example | PASS; lost response, exactly one local transaction, 1 wei balance and nonce 1 |
| `npm run test:aave:logic` with pinned `AAVE_DIR` | 60/60 passed after provisioning the missing upstream checkout |
| `npm run test:aave` | DEGRADED-ACCEPTED, not clean PASS; see below |
| `npm publish --dry-run --registry=https://registry.npmjs.org/` | PASS; no publication performed |
| `git diff --check`, relative doc links, credential-pattern scan of reachable history | No findings in these bounded checks; not a comprehensive secret/security audit |

The first Aave logic run failed 2/60 because its upstream checkout was absent. No assertions were removed or
relaxed; rerunning against the specified upstream commit passed 60/60.

## Aave limitation

Fresh unchanged Aave UI at `20fdc895a9e3925960b5cd111fe09535cf224085` on an owned disposable Base fork:

- Supply 0.5 ETH and withdraw 0.1 WETH passed receipt/event/balance assertions.
- Native withdrawal's unlimited approval was refused, zero transactions submitted; native route remains blocked.
- Cold gateway read exceeded 15 seconds; direct cold diagnostic exceeded 60 seconds. Warm reads succeeded.
- Cleanup verified; upstream remained tracked-clean; evidence redaction sentinel count was zero.
- Harness exited 4 (`DEGRADED`); gate inspected evidence and exited 0 (`DEGRADED-ACCEPTED`).

Evidence is retained locally under `artifacts/` and `examples/aave/artifacts/`, not shipped in the package.
This does not establish arbitrary dApp support, real-wallet compatibility or production readiness.

## Publication boundary

GitHub main can expose the tested candidate; npm publication is a separate owner-authorized operation.
Do not move `v0.1.1`, overwrite 0.1.1, merge exploratory spike branches wholesale, or silently upgrade consumers.
The README distinguishes the GitHub candidate from the still-published npm 0.1.1.
