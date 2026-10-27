'use strict';
// Deterministic hand-assembled EVM fixture for the SDK gate. No compiler: every opcode is listed below, and
// `node test/fixtures/probe-contract.js` regenerates probe-contract.json byte-for-byte (the SDK test asserts that, and
// that the deployed runtime code hashes to `runtimeKeccak`).
//
// ABI behaviour:
//   value() view returns (uint256)   -> 42
//   fail()  view                     -> reverts with custom error Nope(uint256 code) where code = 7
//   ping(uint256 x)                  -> SSTORE(slot 0, x); emits Pinged(address indexed sender, uint256 x)
//   anything else                    -> empty revert
const fs = require('node:fs');
const path = require('node:path');
const { id } = require('ethers');

const selector = (signature) => id(signature).slice(2, 10);
const ABI = [
  'function value() view returns (uint256)',
  'function fail() view',
  'function ping(uint256 x)',
  'error Nope(uint256 code)',
  'event Pinged(address indexed sender, uint256 x)',
];
const OP = { STOP: '00', EQ: '14', ISZERO: '15', SHL: '1b', SHR: '1c', CALLER: '33', CALLDATALOAD: '35', CODECOPY: '39', MSTORE: '52',
  SSTORE: '55', JUMPI: '57', JUMPDEST: '5b', DUP1: '80', LOG2: 'a2', RETURN: 'f3', REVERT: 'fd' };
const push = (hex) => (0x5f + hex.length / 2).toString(16) + hex;
const byte = (n) => n.toString(16).padStart(2, '0');

function assemble(program) {
  // Two passes: first collect label offsets (all jump targets fit in PUSH1), then emit.
  const labels = {};
  let offset = 0;
  for (const item of program) {
    if (item.label) labels[item.label] = offset;
    else offset += item.ref ? 2 : item.length / 2;
  }
  return program.filter((item) => !item.label).map((item) => (item.ref ? push(byte(labels[item.ref])) : item)).join('');
}

const runtimeProgram = [
  push('00'), OP.CALLDATALOAD, push('e0'), OP.SHR, // selector
  OP.DUP1, push(selector('value()')), OP.EQ, { ref: 'value' }, OP.JUMPI,
  OP.DUP1, push(selector('fail()')), OP.EQ, { ref: 'fail' }, OP.JUMPI,
  OP.DUP1, push(selector('ping(uint256)')), OP.EQ, { ref: 'ping' }, OP.JUMPI,
  push('00'), OP.DUP1, OP.REVERT,
  { label: 'value' }, OP.JUMPDEST, push('2a'), push('00'), OP.MSTORE, push('20'), push('00'), OP.RETURN,
  { label: 'fail' }, OP.JUMPDEST, push(selector('Nope(uint256)')), push('e0'), OP.SHL, push('00'), OP.MSTORE,
  push('07'), push('04'), OP.MSTORE, push('24'), push('00'), OP.REVERT,
  { label: 'ping' }, OP.JUMPDEST, push('04'), OP.CALLDATALOAD, OP.DUP1, push('00'), OP.SSTORE, push('00'), OP.MSTORE,
  OP.CALLER, push(id('Pinged(address,uint256)').slice(2)), push('20'), push('00'), OP.LOG2, OP.STOP,
];

function build() {
  const runtime = assemble(runtimeProgram);
  const length = byte(runtime.length / 2);
  // CODECOPY(dest 0, offset <init length>, size <runtime length>); RETURN(0, size). Init code is 12 bytes.
  const init = push(length) + push('0c') + push('00') + OP.CODECOPY + push(length) + push('00') + OP.RETURN;
  if (init.length / 2 !== 12) throw new Error('init code length changed');
  return {
    explanation: 'Hand-assembled by test/fixtures/probe-contract.js; see the opcode listing there. Not compiled Solidity.',
    abi: ABI,
    selectors: { value: selector('value()'), fail: selector('fail()'), ping: selector('ping(uint256)'), Nope: selector('Nope(uint256)') },
    pingedTopic: id('Pinged(address,uint256)'),
    initcode: '0x' + init + runtime,
    runtime: '0x' + runtime,
    runtimeKeccak: require('ethers').keccak256('0x' + runtime),
  };
}

module.exports = { build, file: path.join(__dirname, 'probe-contract.json') };

if (require.main === module) {
  fs.writeFileSync(module.exports.file, JSON.stringify(build(), null, 2) + '\n');
  console.log('wrote', module.exports.file);
}
