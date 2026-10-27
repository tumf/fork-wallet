'use strict';
// Supervised acceptance gate for the Aave example: runs harness.js once, then inspects its evidence.json with
// lib.js gateVerdict. Harness exit 4 (DEGRADED: all three runtime checks and cleanup passed, a diagnostic degraded) is
// accepted as gate exit 0 only after that inspection, and is reported as DEGRADED-ACCEPTED, never as a clean PASS.
// Harness exit 2/3 propagate unchanged; an inspection failure is exit 2. The verdict is written next to the evidence.
// Usage: npm run test:aave   (node examples/aave/gate.js; same environment as harness.js)

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const L = require('./lib.js');

const artifactsRoot = path.join(__dirname, 'artifacts');

function runHarness() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'harness.js')], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
    let out = '';
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk); out += chunk; });
    child.on('error', (e) => resolve({ code: null, signal: null, out, error: e.message }));
    child.on('close', (code, signal) => resolve({ code, signal, out }));
  });
}

/** The evidence path the harness printed, accepted only inside this example's artifacts directory. */
function evidencePath(out) {
  const lines = out.split('\n').filter((l) => l.startsWith('evidence: '));
  if (lines.length !== 1) return null;
  const file = path.resolve(lines[0].slice('evidence: '.length).trim());
  return path.dirname(path.dirname(file)) === artifactsRoot && path.basename(file) === 'evidence.json' ? file : null;
}

(async () => {
  const run = await runHarness();
  const file = evidencePath(run.out);
  let evidence = null;
  if (file) { try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} }
  const verdict = L.gateVerdict({ harnessExit: run.code, evidence });
  const record = { ...verdict, harnessSignal: run.signal || null, evidence: file, inspectedAt: new Date().toISOString() };
  if (file) { try { fs.writeFileSync(path.join(path.dirname(file), 'gate-verdict.json'), JSON.stringify(record, null, 2)); } catch {} }
  const diag = verdict.degradedDiagnostics ? ` degradedDiagnostics=${verdict.degradedDiagnostics.map((d) => `${d.name}:${d.status}`).join(',')}` : '';
  console.log(`gate: ${verdict.verdict} (harness exit ${run.code}${run.signal ? ` signal ${run.signal}` : ''}, gate exit ${verdict.exitCode})${diag}`);
  if (verdict.verdict === 'DEGRADED-ACCEPTED') console.log('gate: degraded success of the warm path after evidence inspection; this is not a clean PASS');
  if (verdict.reasons.length) console.log(`gate reasons: ${verdict.reasons.join(' | ')}`);
  process.exitCode = verdict.exitCode;
})();
