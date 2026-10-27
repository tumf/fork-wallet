'use strict';
// fork-wallet: a test-only EIP-1193 / EIP-6963 wallet injected into a Playwright BrowserContext.
// It submits only through owned loopback JSON-RPC nodes (Anvil by default) using their unlocked accounts. It holds
// no key and computes no signature itself: opt-in personal_sign / eth_signTypedData_v4 are forwarded to the owned
// node's unlocked account. It forwards only an allowlist of bounded read methods and never imports product code.

const crypto = require('node:crypto');

const MODES = Object.freeze(['approve', 'reject', 'hold', 'lost']);
const RELEASE_OUTCOMES = Object.freeze(['approve', 'reject', 'lost']);
/** Read methods forwarded (after per-method validation) by the provider and by the public read gateway. */
const READ_METHODS = Object.freeze([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt',
  'eth_getTransactionCount', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas',
  'eth_feeHistory', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionByHash',
  'eth_getTransactionReceipt', 'eth_getLogs',
]);
/** Signing methods. Supported capability only: each install enables them solely through the `signing` option. */
const SIGNING_METHODS = Object.freeze(['personal_sign', 'eth_signTypedData_v4']);
/** Local chain IDs (31337, 31338) on which signing may be enabled. Not a mainnet-ID fork isolation design. */
const SIGNING_CHAINS = Object.freeze(['0x7a69', '0x7a6a']);
/** Wallet methods that need a control-mode decision (approve / reject / hold / lost). */
const APPROVAL_METHODS = Object.freeze(['eth_requestAccounts', 'wallet_requestPermissions', 'wallet_switchEthereumChain', 'eth_sendTransaction',
  ...SIGNING_METHODS]);
const WALLET_METHODS = Object.freeze(['eth_accounts', 'wallet_getPermissions', 'wallet_revokePermissions', ...APPROVAL_METHODS]);
const METHODS = Object.freeze([...WALLET_METHODS, ...READ_METHODS]);
const TRANSACTION_FIELDS = Object.freeze(['from', 'to', 'value', 'data', 'chainId', 'gas', 'gasPrice', 'maxFeePerGas',
  'maxPriorityFeePerGas', 'nonce', 'type', 'accessList']);
const CALL_FIELDS = TRANSACTION_FIELDS;
const TRANSACTION_TYPES = Object.freeze(['0x0', '0x1', '0x2']);
const STATES = Object.freeze(['admitted', 'held', 'dispatching', 'submitted', 'rejected', 'response-lost', 'unknown',
  'failed', 'cancelled', 'approved', 'signed', 'signed-discarded']);
const CODES = Object.freeze({
  USER_REJECTED: 4001, UNAUTHORIZED: 4100, UNSUPPORTED_METHOD: 4200, DISCONNECTED: 4900, CHAIN_DISCONNECTED: 4901,
  UNRECOGNIZED_CHAIN: 4902, REQUEST_PENDING: -32002, INVALID_REQUEST: -32600, INVALID_PARAMS: -32602, INTERNAL: -32603,
});
const LIMITS = Object.freeze({
  requestBytes: 1024 * 1024, responseBytes: 16 * 1024 * 1024, errorDataBytes: 64 * 1024, batch: 20, logRange: 10000,
  logAddresses: 20, topicPositions: 4, topicAlternatives: 20, feeHistoryBlocks: 1024, feeHistoryPercentiles: 100,
  accessListItems: 1024, timeoutMs: 15000, signMessageBytes: 65536, typedDataBytes: 65536, typedDataDepth: 32,
  typedDataNodes: 4096, typedDataTypes: 64, typedDataFields: 64, typedDataNameChars: 128,
});
const DEFAULT_CLIENT = /^anvil\//i;
const DEFAULT_TIMEOUT_MS = LIMITS.timeoutMs;
const BLOCK_TAGS = Object.freeze(['latest', 'earliest', 'pending', 'safe', 'finalized']);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const PROVIDER_INFO = Object.freeze({
  name: 'Fork Wallet',
  rdns: 'dev.forkwallet.test',
  // Constant inline SVG (a grey square); never fetched.
  icon: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#6b7280"/></svg>').toString('base64'),
});

class ForkWalletError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'ForkWalletError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

const fail = (code, message, data) => { throw new ForkWalletError(code, message, data); };
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const codeOf = (error) => (error && Number.isInteger(error.code) ? error.code : CODES.INTERNAL);
const messageOf = (error) => String(error && error.message !== undefined ? error.message : error).slice(0, 4096);
const byteLength = (value) => Buffer.byteLength(value, 'utf8');

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** Copy of upstream error data only if it is plain JSON within LIMITS.errorDataBytes; otherwise undefined. */
function safeErrorData(data) {
  if (data === undefined) return undefined;
  try {
    const text = JSON.stringify(data);
    if (text === undefined || byteLength(text) > LIMITS.errorDataBytes) return undefined;
    return JSON.parse(text);
  } catch { return undefined; }
}

/** Exact loopback HTTP JSON-RPC endpoint: http://127.0.0.1:<port> with an optional trailing slash and nothing else. */
function requireLoopbackEndpoint(endpoint) {
  let url;
  try { url = new URL(String(endpoint)); } catch { fail(CODES.INVALID_PARAMS, `refusing endpoint ${endpoint}: not a URL`); }
  const ok = typeof endpoint === 'string' && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== ''
    && !url.username && !url.password && url.search === '' && url.hash === '' && (url.pathname === '/' || url.pathname === '');
  if (!ok) fail(CODES.INVALID_PARAMS, `refusing endpoint ${endpoint}: only http://127.0.0.1:<port> is allowed`);
  return endpoint;
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
  if (typeof chainId === 'string' && /^0x[1-9a-fA-F][0-9a-fA-F]{0,15}$/.test(chainId)) return chainId.toLowerCase();
  fail(CODES.INVALID_PARAMS, `chainId must be a positive integer or canonical hex string, got ${JSON.stringify(chainId)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Parameter validation. Every validator builds a fresh value from allowlisted fields; untrusted objects are never
// spread or forwarded as received.

const bad = (what) => fail(CODES.INVALID_PARAMS, what);
function address(value, what) { if (typeof value !== 'string' || !ADDRESS.test(value)) bad(`${what} must be a 20-byte address`); return value; }
function hash32(value, what) { if (typeof value !== 'string' || !HASH.test(value)) bad(`${what} must be a 32-byte hex value`); return value; }
function quantity(value, what) { if (typeof value !== 'string' || !QUANTITY.test(value)) bad(`${what} must be a canonical hex quantity`); return value; }
function bytes(value, what) { if (typeof value !== 'string' || !BYTES.test(value)) bad(`${what} must be even-length hex bytes`); return value; }
function bool(value, what) { if (typeof value !== 'boolean') bad(`${what} must be a boolean`); return value; }
function blockRef(value, what) {
  if (typeof value === 'string' && (BLOCK_TAGS.includes(value) || QUANTITY.test(value))) return value;
  return bad(`${what} must be a block tag (${BLOCK_TAGS.join('/')}) or canonical hex quantity`);
}
/** Storage slot: a canonical quantity or a full 32-byte word. */
function slot(value, what) {
  if (typeof value === 'string' && (QUANTITY.test(value) || HASH.test(value))) return value;
  return bad(`${what} must be a canonical quantity or 32-byte word`);
}

function accessList(value, what) {
  if (!Array.isArray(value)) bad(`${what} must be an array`);
  let total = 0;
  return value.map((entry, i) => {
    if (!isPlainObject(entry) || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'address') || !Object.hasOwn(entry, 'storageKeys')) {
      bad(`${what}[${i}] must be exactly {address, storageKeys}`);
    }
    if (!Array.isArray(entry.storageKeys)) bad(`${what}[${i}].storageKeys must be an array`);
    total += 1 + entry.storageKeys.length;
    if (total > LIMITS.accessListItems) bad(`${what} exceeds ${LIMITS.accessListItems} entries/keys`);
    return { address: address(entry.address, `${what}[${i}].address`), storageKeys: entry.storageKeys.map((k, j) => hash32(k, `${what}[${i}].storageKeys[${j}]`)) };
  });
}

/** Builds a new object from the allowlisted fields of a call/transaction object, checking each field's format. */
function pickFields(input, fields, what) {
  if (!isPlainObject(input)) bad(`${what} must be an object`);
  const unknown = Object.keys(input).filter((key) => !fields.includes(key));
  if (unknown.length) bad(`unsupported ${what} fields: ${unknown.slice(0, 10).join(', ')}`);
  const out = {};
  for (const key of fields) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    const label = `${what}.${key}`;
    if (key === 'from' || key === 'to') out[key] = address(value, label);
    else if (key === 'data') out[key] = bytes(value, label);
    else if (key === 'type') {
      if (!TRANSACTION_TYPES.includes(value)) bad(`${label} must be one of ${TRANSACTION_TYPES.join(', ')}`);
      out[key] = value;
    } else if (key === 'accessList') out[key] = accessList(value, label);
    else out[key] = quantity(value, label);
  }
  return out;
}

/**
 * Validates exact eth_sendTransaction params and returns a deep-frozen copy of the allowlisted fields, unchanged in
 * value. `from` must be the active account; deployment (no `to`) needs non-empty data; fee fields must agree with type.
 */
function checkTransaction(params, account, chainId) {
  if (!Array.isArray(params) || params.length !== 1 || !isPlainObject(params[0])) {
    bad('eth_sendTransaction expects exactly one transaction object');
  }
  const tx = pickFields(params[0], TRANSACTION_FIELDS, 'transaction');
  if (!Object.hasOwn(tx, 'from') || !same(tx.from, account)) bad('transaction.from must be the wallet account');
  if (!Object.hasOwn(tx, 'to') && (!Object.hasOwn(tx, 'data') || tx.data === '0x')) bad('transaction.to is required unless deploying non-empty data');
  if (Object.hasOwn(tx, 'chainId') && tx.chainId.toLowerCase() !== chainId) bad(`transaction.chainId must be ${chainId}`);
  const has1559 = Object.hasOwn(tx, 'maxFeePerGas') || Object.hasOwn(tx, 'maxPriorityFeePerGas');
  const hasGasPrice = Object.hasOwn(tx, 'gasPrice');
  if (has1559 && hasGasPrice) bad('transaction mixes gasPrice with EIP-1559 fee fields');
  if (has1559 && (tx.type === '0x0' || tx.type === '0x1')) bad(`transaction type ${tx.type} cannot carry EIP-1559 fee fields`);
  if (hasGasPrice && tx.type === '0x2') bad('transaction type 0x2 cannot carry gasPrice');
  if (tx.type === '0x0' && Object.hasOwn(tx, 'accessList')) bad('transaction type 0x0 cannot carry accessList');
  if (Object.hasOwn(tx, 'maxFeePerGas') && Object.hasOwn(tx, 'maxPriorityFeePerGas') && BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas)) {
    bad('transaction.maxPriorityFeePerGas exceeds maxFeePerGas');
  }
  return deepFreeze(tx);
}

function noParams(method, params) {
  if (params !== undefined && !(Array.isArray(params) && params.length === 0)) bad(`${method} takes no params (omit them or pass [])`);
  return [];
}

function arity(method, params, min, max = min) {
  if (!Array.isArray(params) || params.length < min || params.length > max) {
    bad(`${method} expects ${min === max ? min : `${min}-${max}`} params`);
  }
  return params;
}

async function resolveHeight(ref, rpc, what) {
  if (ref === 'earliest') return 0n;
  if (QUANTITY.test(ref)) return BigInt(ref);
  const block = await rpc('eth_getBlockByNumber', [ref, false]);
  if (!isPlainObject(block) || typeof block.number !== 'string' || !QUANTITY.test(block.number)) bad(`${what} ${ref} could not be resolved`);
  return BigInt(block.number);
}

async function logFilter(input, rpc) {
  if (!isPlainObject(input)) bad('eth_getLogs filter must be an object');
  const allowed = ['address', 'topics', 'fromBlock', 'toBlock', 'blockHash'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) bad(`unsupported filter fields: ${unknown.slice(0, 10).join(', ')}`);
  const out = {};
  if (Object.hasOwn(input, 'address')) {
    if (Array.isArray(input.address)) {
      if (input.address.length < 1 || input.address.length > LIMITS.logAddresses) bad(`filter.address must list 1-${LIMITS.logAddresses} addresses`);
      out.address = input.address.map((a, i) => address(a, `filter.address[${i}]`));
    } else out.address = address(input.address, 'filter.address');
  }
  if (Object.hasOwn(input, 'topics')) {
    if (!Array.isArray(input.topics) || input.topics.length > LIMITS.topicPositions) bad(`filter.topics must have at most ${LIMITS.topicPositions} positions`);
    out.topics = input.topics.map((topic, i) => {
      if (topic === null) return null;
      if (Array.isArray(topic)) {
        if (topic.length < 1 || topic.length > LIMITS.topicAlternatives) bad(`filter.topics[${i}] must list 1-${LIMITS.topicAlternatives} alternatives`);
        return topic.map((t, j) => hash32(t, `filter.topics[${i}][${j}]`));
      }
      return hash32(topic, `filter.topics[${i}]`);
    });
  }
  if (Object.hasOwn(input, 'blockHash')) {
    if (Object.hasOwn(input, 'fromBlock') || Object.hasOwn(input, 'toBlock')) bad('filter.blockHash excludes fromBlock/toBlock');
    out.blockHash = hash32(input.blockHash, 'filter.blockHash');
    return out;
  }
  const fromRef = blockRef(Object.hasOwn(input, 'fromBlock') ? input.fromBlock : 'latest', 'filter.fromBlock');
  const toRef = blockRef(Object.hasOwn(input, 'toBlock') ? input.toBlock : 'latest', 'filter.toBlock');
  // Tags are resolved to explicit heights so the forwarded range is exactly the bounded one that was checked.
  const from = await resolveHeight(fromRef, rpc, 'filter.fromBlock');
  const to = await resolveHeight(toRef, rpc, 'filter.toBlock');
  if (to < from) bad('filter.toBlock is below fromBlock');
  if (to - from + 1n > BigInt(LIMITS.logRange)) bad(`filter block range exceeds ${LIMITS.logRange} blocks`);
  out.fromBlock = '0x' + from.toString(16);
  out.toBlock = '0x' + to.toString(16);
  return out;
}

function percentiles(value) {
  if (!Array.isArray(value) || value.length > LIMITS.feeHistoryPercentiles) bad(`reward percentiles must be an array of at most ${LIMITS.feeHistoryPercentiles}`);
  value.forEach((p, i) => {
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) bad(`reward percentile ${i} must be a finite number in [0,100]`);
    if (i > 0 && p < value[i - 1]) bad('reward percentiles must be sorted ascending');
  });
  return [...value];
}

/**
 * Validates one allowlisted read request and returns fresh, bounded params to forward. `rpc` resolves eth_getLogs
 * block tags against the same node. Unknown methods fail with 4200; malformed params with -32602.
 */
async function validateReadRequest(method, params, rpc) {
  if (!READ_METHODS.includes(method)) fail(CODES.UNSUPPORTED_METHOD, `unsupported method ${String(method).slice(0, 100)}`);
  switch (method) {
    case 'eth_chainId': case 'net_version': case 'eth_blockNumber': case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas':
      return noParams(method, params);
    case 'eth_getBalance': case 'eth_getCode': case 'eth_getTransactionCount': {
      const [who, block] = arity(method, params, 2);
      return [address(who, `${method} address`), blockRef(block, `${method} block`)];
    }
    case 'eth_getStorageAt': {
      const [who, position, block] = arity(method, params, 3);
      return [address(who, 'eth_getStorageAt address'), slot(position, 'eth_getStorageAt slot'), blockRef(block, 'eth_getStorageAt block')];
    }
    case 'eth_call': case 'eth_estimateGas': {
      // No third (state override) parameter is accepted.
      const list = arity(method, params, 1, 2);
      const call = pickFields(list[0], CALL_FIELDS, 'call');
      return list.length === 2 ? [call, blockRef(list[1], `${method} block`)] : [call];
    }
    case 'eth_feeHistory': {
      const [count, newest, rewards] = arity(method, params, 3);
      quantity(count, 'eth_feeHistory blockCount');
      if (BigInt(count) < 1n || BigInt(count) > BigInt(LIMITS.feeHistoryBlocks)) bad(`eth_feeHistory blockCount must be 1-${LIMITS.feeHistoryBlocks}`);
      return [count, blockRef(newest, 'eth_feeHistory newestBlock'), percentiles(rewards)];
    }
    case 'eth_getBlockByNumber': {
      const [block, full] = arity(method, params, 2);
      return [blockRef(block, 'eth_getBlockByNumber block'), bool(full, 'eth_getBlockByNumber fullTransactions')];
    }
    case 'eth_getBlockByHash': {
      const [block, full] = arity(method, params, 2);
      return [hash32(block, 'eth_getBlockByHash hash'), bool(full, 'eth_getBlockByHash fullTransactions')];
    }
    case 'eth_getTransactionByHash': case 'eth_getTransactionReceipt':
      return [hash32(arity(method, params, 1)[0], `${method} hash`)];
    case 'eth_getLogs':
      return [await logFilter(arity(method, params, 1)[0], rpc)];
    default:
      return fail(CODES.UNSUPPORTED_METHOD, `unsupported method ${method}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Signing input validation. Messages are constants: page-supplied keys, type names and values are never echoed.

/** Errors whose message is a constant, safe to return from a signing path. Anything else is replaced. */
const FIXED_ERRORS = new WeakSet();
function signFail(code, message) {
  const error = new ForkWalletError(code, message);
  FIXED_ERRORS.add(error);
  throw error;
}
const SIGNING_MESSAGES = Object.freeze({
  [CODES.USER_REJECTED]: 'user rejected the request', [CODES.UNAUTHORIZED]: 'signing account permission changed or missing',
  [CODES.DISCONNECTED]: 'wallet disconnected', [CODES.CHAIN_DISCONNECTED]: 'selected chain changed or unavailable',
  [CODES.REQUEST_PENDING]: 'another approval request is outstanding', [CODES.INVALID_PARAMS]: 'invalid signing request',
});
/** Signing-path error with a constant message and the numeric code only (no data, no upstream or thrown text). */
function signingError(error) {
  if (FIXED_ERRORS.has(error)) return error;
  const code = codeOf(error);
  const fixed = new ForkWalletError(code, SIGNING_MESSAGES[code] || 'signing request failed');
  FIXED_ERRORS.add(fixed);
  return fixed;
}

const TYPED_DATA_KEYS = Object.freeze(['domain', 'message', 'primaryType', 'types']);
/** EIP712Domain field types for the only domain keys accepted. */
const DOMAIN_FIELDS = Object.freeze({ name: 'string', version: 'string', chainId: 'uint256', verifyingContract: 'address', salt: 'bytes32' });
const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'prototype', 'constructor']);
const badSign = (message) => signFail(CODES.INVALID_PARAMS, message);

/**
 * Fresh JSON-safe copy: own plain objects/arrays, strings, booleans, null and safe integers only, bounded by
 * LIMITS.typedDataDepth and LIMITS.typedDataNodes. Rejects getters, holes, symbols, prototype keys and any other value.
 */
function jsonSafe(value, budget, depth) {
  if (++budget.nodes > LIMITS.typedDataNodes) badSign(`typed data exceeds ${LIMITS.typedDataNodes} values`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) badSign('typed data numbers must be safe integers (use decimal or hex strings for large values)');
    return value;
  }
  if (typeof value !== 'object') badSign('typed data must contain only JSON values');
  if (depth > LIMITS.typedDataDepth) badSign(`typed data exceeds depth ${LIMITS.typedDataDepth}`);
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length) badSign('typed data must contain only JSON values');
  const own = (key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) badSign('typed data must contain only plain data properties');
    return descriptor.value;
  };
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || names.length !== value.length + 1) badSign('typed data arrays must be dense plain arrays');
    const out = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) badSign('typed data arrays must be dense plain arrays');
      out.push(jsonSafe(own(String(i)), budget, depth + 1));
    }
    return out;
  }
  if (!isPlainObject(value)) badSign('typed data must contain only plain objects');
  const out = {};
  for (const key of names) {
    if (FORBIDDEN_KEYS.includes(key)) badSign('typed data must not use __proto__, prototype or constructor keys');
    out[key] = jsonSafe(own(key), budget, depth + 1);
  }
  return out;
}

const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const shortName = (value) => typeof value === 'string' && value.length > 0 && value.length <= LIMITS.typedDataNameChars;

/** Structural EIP-712 checks on the normalized value. Anvil stays authoritative for type syntax and value encoding. */
function checkTypedData(typedData, chainId) {
  if (!isPlainObject(typedData) || !exactKeys(typedData, TYPED_DATA_KEYS)) badSign('typed data must have exactly types, primaryType, domain and message');
  const { types, primaryType, domain, message } = typedData;
  if (!isPlainObject(types)) badSign('typed data types must be an object');
  const typeNames = Object.keys(types);
  if (typeNames.length > LIMITS.typedDataTypes) badSign(`typed data defines more than ${LIMITS.typedDataTypes} types`);
  for (const name of typeNames) {
    if (!shortName(name)) badSign(`typed data type names must be 1-${LIMITS.typedDataNameChars} characters`);
    const fields = types[name];
    if (!Array.isArray(fields) || fields.length > LIMITS.typedDataFields) badSign(`typed data type definitions must be arrays of at most ${LIMITS.typedDataFields} fields`);
    const seen = new Set();
    for (const field of fields) {
      if (!isPlainObject(field) || !exactKeys(field, ['name', 'type']) || !shortName(field.name) || !shortName(field.type)) {
        badSign(`typed data fields must be exactly {name, type} with 1-${LIMITS.typedDataNameChars} character strings`);
      }
      if (seen.has(field.name)) badSign('typed data field names must be unique within a type');
      seen.add(field.name);
    }
  }
  if (!Object.hasOwn(types, 'EIP712Domain')) badSign('typed data types must define EIP712Domain');
  if (typeof primaryType !== 'string' || primaryType === 'EIP712Domain' || !Object.hasOwn(types, primaryType)) {
    badSign('typed data primaryType must name a defined type other than EIP712Domain');
  }
  if (!isPlainObject(domain)) badSign('typed data domain must be an object');
  const domainKeys = Object.keys(domain);
  if (!domainKeys.every((key) => Object.hasOwn(DOMAIN_FIELDS, key))) badSign('typed data domain allows only name, version, chainId, verifyingContract and salt');
  const declared = types.EIP712Domain;
  if (declared.length !== domainKeys.length || !declared.every((field) => Object.hasOwn(domain, field.name) && DOMAIN_FIELDS[field.name] === field.type)) {
    badSign('typed data EIP712Domain fields must declare exactly the domain keys with their standard types');
  }
  if (!Object.hasOwn(domain, 'chainId')) badSign('typed data domain.chainId is required');
  const id = domain.chainId;
  const valid = (typeof id === 'number' && id >= 0) || (typeof id === 'string' && (DECIMAL.test(id) || QUANTITY.test(id)));
  if (!valid) badSign('typed data domain.chainId must be a safe integer, decimal string or canonical hex quantity');
  if (BigInt(id) !== BigInt(chainId)) badSign('typed data domain.chainId must equal the active chain');
  for (const key of ['name', 'version']) if (Object.hasOwn(domain, key) && typeof domain[key] !== 'string') badSign(`typed data domain.${key} must be a string`);
  if (Object.hasOwn(domain, 'verifyingContract') && (typeof domain.verifyingContract !== 'string' || !ADDRESS.test(domain.verifyingContract))) {
    badSign('typed data domain.verifyingContract must be a 20-byte address');
  }
  if (Object.hasOwn(domain, 'salt') && (typeof domain.salt !== 'string' || !HASH.test(domain.salt))) badSign('typed data domain.salt must be 32 bytes');
  if (!isPlainObject(message)) badSign('typed data message must be an object');
}

/**
 * Validates exact personal_sign / eth_signTypedData_v4 params for the active account and chain and returns the
 * deep-frozen SignatureRequest given to the policy and forwarded to the node. personal_sign: [0x bytes, address].
 * eth_signTypedData_v4: [address, JSON text or plain object]; JSON text is parsed exactly once.
 */
function checkSignatureRequest(method, params, account, chainId) {
  if (!SIGNING_METHODS.includes(method)) signFail(CODES.UNSUPPORTED_METHOD, 'unsupported signing method');
  if (!Array.isArray(params) || params.length !== 2) badSign(`${method} expects exactly two params`);
  if (method === 'personal_sign') {
    const [message, who] = params;
    if (typeof message !== 'string' || !BYTES.test(message)) badSign('personal_sign message must be even-length 0x hex bytes');
    if ((message.length - 2) / 2 > LIMITS.signMessageBytes) badSign(`personal_sign message exceeds ${LIMITS.signMessageBytes} bytes`);
    if (typeof who !== 'string' || !ADDRESS.test(who) || !same(who, account)) badSign('personal_sign address must be the active authorized account');
    return deepFreeze({ method, account, message });
  }
  const [who, input] = params;
  if (typeof who !== 'string' || !ADDRESS.test(who) || !same(who, account)) badSign('eth_signTypedData_v4 address must be the active authorized account');
  let parsed = input;
  if (typeof input === 'string') {
    if (byteLength(input) > LIMITS.typedDataBytes) badSign(`typed data exceeds ${LIMITS.typedDataBytes} bytes`);
    try { parsed = JSON.parse(input); } catch { badSign('typed data is not valid JSON'); }
  } else if (!isPlainObject(input)) badSign('typed data must be a JSON string or a plain object');
  const typedData = jsonSafe(parsed, { nodes: 0 }, 1);
  if (byteLength(JSON.stringify(typedData)) > LIMITS.typedDataBytes) badSign(`typed data exceeds ${LIMITS.typedDataBytes} bytes`);
  checkTypedData(typedData, chainId);
  return deepFreeze({ method, account, typedData });
}

// ---------------------------------------------------------------------------------------------------------------
// Loopback JSON-RPC client.

async function readBounded(response, max) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > max) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    fail(CODES.INTERNAL, `loopback RPC response exceeds ${max} bytes`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* ignore */ }
      fail(CODES.INTERNAL, `loopback RPC response exceeds ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const withKind = (error, kind) => Object.assign(error, { kind });

/**
 * Strict JSON-RPC 2.0 client for one loopback endpoint: no redirects, bounded request/response, matched IDs, exactly
 * one of result/error. Thrown errors carry `kind`: 'upstream' (the node answered with a JSON-RPC error; code, message
 * and size-bounded data are preserved), 'transport' (no usable answer: network, timeout, HTTP status) or 'integrity'.
 * Never retries.
 */
function createLoopbackRpc(endpoint, { timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = LIMITS.responseBytes } = {}) {
  requireLoopbackEndpoint(endpoint);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) fail(CODES.INVALID_PARAMS, `timeoutMs must be 1-${LIMITS.timeoutMs}`);
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > LIMITS.responseBytes) {
    fail(CODES.INVALID_PARAMS, `maxResponseBytes must be 1-${LIMITS.responseBytes}`);
  }
  let id = 0;
  return function rpc(method, params = []) {
    const requestID = ++id;
    const body = JSON.stringify({ jsonrpc: '2.0', id: requestID, method, params });
    if (byteLength(body) > LIMITS.requestBytes) return Promise.reject(withKind(new ForkWalletError(CODES.INVALID_PARAMS, 'request exceeds 1 MiB'), 'integrity'));
    // fetch() is started synchronously so callers can transition state immediately before invoking rpc().
    const pending = fetch(endpoint, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs), body,
    });
    return (async () => {
      let text;
      try {
        const response = await pending;
        if (!response.ok) fail(CODES.INTERNAL, `loopback RPC HTTP ${response.status}`);
        text = await readBounded(response, maxResponseBytes);
      } catch (error) {
        throw withKind(new ForkWalletError(CODES.INTERNAL, `loopback RPC transport failure: ${messageOf(error)}`), 'transport');
      }
      let reply;
      try { reply = JSON.parse(text); } catch { throw withKind(new ForkWalletError(CODES.INTERNAL, 'loopback RPC returned non-JSON'), 'integrity'); }
      if (!isPlainObject(reply) || reply.jsonrpc !== '2.0' || reply.id !== requestID) throw withKind(new ForkWalletError(CODES.INTERNAL, 'mismatched RPC response'), 'integrity');
      if (Object.hasOwn(reply, 'result') === Object.hasOwn(reply, 'error')) throw withKind(new ForkWalletError(CODES.INTERNAL, 'ambiguous RPC response'), 'integrity');
      if (Object.hasOwn(reply, 'error')) {
        const e = reply.error;
        if (!isPlainObject(e) || !Number.isInteger(e.code) || typeof e.message !== 'string') {
          throw withKind(new ForkWalletError(CODES.INTERNAL, 'malformed RPC error object'), 'integrity');
        }
        throw withKind(new ForkWalletError(e.code, e.message.slice(0, 4096), safeErrorData(e.data)), 'upstream');
      }
      return reply.result;
    })();
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Wallet.

const REGISTRATION_KEYS = ['endpoint', 'chainId', 'account', 'beforeSend'];

/** `signing` option: absent disables both signing methods; present must be exactly {validateSignature}. */
function makeSigning(value) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) fail(CODES.INVALID_PARAMS, 'signing must be an object {validateSignature}');
  const extra = Object.keys(value).filter((key) => key !== 'validateSignature');
  if (extra.length) fail(CODES.INVALID_PARAMS, `signing has unsupported fields: ${extra.slice(0, 10).join(', ')}`);
  if (typeof value.validateSignature !== 'function') fail(CODES.INVALID_PARAMS, 'signing.validateSignature(request) is mandatory');
  return Object.freeze({ validateSignature: value.validateSignature });
}

function makeRegistration(entry, what, timeoutMs) {
  if (!isPlainObject(entry)) fail(CODES.INVALID_PARAMS, `${what} must be an object`);
  const extra = Object.keys(entry).filter((key) => !REGISTRATION_KEYS.includes(key));
  if (extra.length) fail(CODES.INVALID_PARAMS, `${what} has unsupported fields: ${extra.join(', ')}`);
  const endpoint = requireLoopbackEndpoint(entry.endpoint);
  const chainId = normalizeChainId(entry.chainId);
  if (typeof entry.account !== 'string' || !ADDRESS.test(entry.account)) fail(CODES.INVALID_PARAMS, `${what}.account must be an address`);
  if (typeof entry.beforeSend !== 'function') fail(CODES.INVALID_PARAMS, `${what}.beforeSend() ownership guard is mandatory`);
  return Object.freeze({ endpoint, chainId, account: entry.account, beforeSend: entry.beforeSend, rpc: createLoopbackRpc(endpoint, { timeoutMs }) });
}

/** The page-side provider. Serialized into the page by addInitScript; must stay self-contained. */
function pageScript({ origin: allowed, info }) {
  if (location.origin !== allowed || window.top !== window) return; // main frame of the exact origin only
  const listeners = new Map();
  const call = (fn, payload) => { try { fn(payload); } catch (error) { setTimeout(() => { throw error; }); } };
  const provider = {
    isForkWallet: true,
    on(name, fn) {
      if (typeof fn !== 'function') return provider;
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
        if (reply.error.data !== undefined) error.data = reply.error.data;
        throw error;
      }
      return reply.result;
    },
  };
  provider.off = provider.removeListener;
  Object.freeze(provider);
  const detail = Object.freeze({ info: Object.freeze({ ...info }), provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.ethereum = provider;
  window.__forkWalletEmit = (name, payload) => {
    for (const fn of [...(listeners.get(name) || [])]) call(fn, payload);
  };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  Promise.resolve(window.__forkWalletInit()).then((state) => {
    if (state && state.connected) queueMicrotask(() => window.__forkWalletEmit('connect', { chainId: state.chainId }));
  }, () => {});
}

/**
 * Installs the wallet into a Playwright BrowserContext (anything with exposeBinding/addInitScript/pages).
 * Returns the Node-only control handle. See README for options, modes, errors and trust boundaries.
 */
async function installForkWallet(context, options) {
  if (!context || typeof context.exposeBinding !== 'function' || typeof context.addInitScript !== 'function') {
    fail(CODES.INVALID_PARAMS, 'a Playwright BrowserContext is required');
  }
  if (!isPlainObject(options)) fail(CODES.INVALID_PARAMS, 'options object required');
  const { origin, validateTransaction, clientVersion = DEFAULT_CLIENT, timeoutMs = DEFAULT_TIMEOUT_MS, chains = [] } = options;
  requireOrigin(origin);
  if (typeof validateTransaction !== 'function') fail(CODES.INVALID_PARAMS, 'validateTransaction(tx) is mandatory');
  if (!(clientVersion instanceof RegExp)) fail(CODES.INVALID_PARAMS, 'clientVersion must be a RegExp');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) fail(CODES.INVALID_PARAMS, `timeoutMs must be 1-${LIMITS.timeoutMs}`);
  if (!Array.isArray(chains)) fail(CODES.INVALID_PARAMS, 'chains must be an array');
  const initial = makeRegistration({ endpoint: options.endpoint, chainId: options.chainId, account: options.account, beforeSend: options.beforeSend }, 'options', timeoutMs);
  const registry = new Map([[initial.chainId, initial]]);
  chains.forEach((entry, i) => {
    const registration = makeRegistration(entry, `chains[${i}]`, timeoutMs);
    if (registry.has(registration.chainId)) fail(CODES.INVALID_PARAMS, `chain ${registration.chainId} is registered twice`);
    registry.set(registration.chainId, registration);
  });
  const signing = makeSigning(options.signing);
  if (signing) {
    const refused = [...registry.keys()].filter((id) => !SIGNING_CHAINS.includes(id));
    if (refused.length) fail(CODES.INVALID_PARAMS, `signing is limited to local chain IDs 31337/31338; refusing ${refused.join(', ')}`);
  }

  const info = Object.freeze({ uuid: crypto.randomUUID(), ...PROVIDER_INFO });
  const calls = [];
  const submitted = [];
  const unsupported = [];
  const accounts = new Map([...registry.values()].map((r) => [r.chainId, r.account]));
  const overrides = [];
  const holdWaiters = [];
  let active = initial;
  let mode = 'approve';
  let connected = true;
  let authorized = false;
  let epoch = 0;
  let lastScopeChange = null; // { code, message } of the most recent bumpEpoch
  let outstanding = null;

  const activeAccount = () => accounts.get(active.chainId);
  const descriptor = () => ({ invoker: origin, parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [activeAccount()] }] });
  const recordUnsupported = (method, reason) => {
    if (unsupported.length < 1000) unsupported.push({ method: String(method).slice(0, 100), reason, at: new Date().toISOString() });
  };

  async function emit(name, payload) {
    const pages = typeof context.pages === 'function' ? context.pages() : [];
    await Promise.allSettled(pages
      .filter((page) => { try { return new URL(page.url()).origin === origin; } catch { return false; } })
      .map((page) => page.evaluate(([n, p]) => window.__forkWalletEmit?.(n, p), [name, payload])));
  }

  /**
   * Scope change: new epoch, and the outstanding approval (unless already dispatching or finished, or `except`) is
   * cancelled with the given error. Its continuation sees the stale epoch and stops before any dispatch.
   */
  function bumpEpoch(code, message, except = null) {
    epoch++;
    lastScopeChange = { code, message };
    const record = outstanding;
    if (!record || record === except || !['admitted', 'held'].includes(record.outcome)) return;
    record.outcome = 'cancelled';
    record.error = { code, message };
    record.invalidation = new ForkWalletError(code, message);
    outstanding = null;
    if (record.resolveHold) record.resolveHold('invalidated');
  }

  /** Synchronous liveness check. No await may occur between this call and the state transition that follows it. */
  function assertLive(record) {
    if (record.invalidation) throw record.invalidation;
    if (record.epoch !== epoch || outstanding !== record) {
      record.invalidation = new ForkWalletError(CODES.INTERNAL, 'request is stale');
      throw record.invalidation;
    }
    if (!connected) fail(CODES.DISCONNECTED, 'wallet disconnected');
  }

  async function preflight(chain, account, { requireConnected = true } = {}) {
    if (requireConnected && !connected) fail(CODES.DISCONNECTED, 'wallet disconnected');
    try {
      await chain.beforeSend();
      const reported = await chain.rpc('eth_chainId');
      if (typeof reported !== 'string' || reported.toLowerCase() !== chain.chainId) fail(CODES.CHAIN_DISCONNECTED, `node chain ${reported} is not ${chain.chainId}`);
      const version = await chain.rpc('web3_clientVersion');
      if (typeof version !== 'string' || !clientVersion.test(version)) fail(CODES.CHAIN_DISCONNECTED, `refusing client ${version}`);
      const unlocked = await chain.rpc('eth_accounts');
      if (!Array.isArray(unlocked) || !unlocked.some((a) => same(a, account))) fail(CODES.CHAIN_DISCONNECTED, 'account is not unlocked on the loopback node');
      await chain.beforeSend();
    } catch (error) {
      if (error instanceof ForkWalletError && error.code === CODES.CHAIN_DISCONNECTED) throw error;
      throw new ForkWalletError(CODES.CHAIN_DISCONNECTED, `selected node unavailable: ${messageOf(error)}`);
    }
    if (requireConnected && !connected) fail(CODES.DISCONNECTED, 'wallet disconnected');
  }

  function takeMode(method) {
    // Signing never downgrades lost to approve: a global lost mode refuses it before admission, consuming nothing.
    if (SIGNING_METHODS.includes(method) && mode === 'lost' && !overrides.some((o) => o.method === method)) {
      signFail(CODES.INVALID_PARAMS, 'lost mode is not supported for signing');
    }
    const index = overrides.findIndex((o) => o.method === method);
    const chosen = index >= 0 ? overrides.splice(index, 1)[0].mode : mode;
    return chosen === 'lost' && method !== 'eth_sendTransaction' ? 'approve' : chosen;
  }

  /**
   * One approval at a time. Admission is recorded before any dispatch; the decision (mode or held release) comes
   * next and `execute` runs the method-specific continuation. Failures settle the record unless already settled.
   * `sanitize` (signing) maps every error to a constant message before it is recorded or thrown.
   */
  async function runApproval(method, fields, execute, sanitize = (error) => error) {
    if (outstanding) fail(CODES.REQUEST_PENDING, 'another approval request is outstanding');
    const record = {
      requestId: crypto.randomUUID(), method, epoch, origin, chainId: active.chainId, endpoint: active.endpoint,
      account: activeAccount(), mode: takeMode(method), outcome: 'admitted', admittedAt: new Date().toISOString(), ...fields,
    };
    Object.defineProperty(record, 'resolveHold', { value: null, writable: true, enumerable: false });
    Object.defineProperty(record, 'invalidation', { value: null, writable: true, enumerable: false });
    outstanding = record;
    calls.push(record);
    try {
      let decision = record.mode;
      if (decision === 'hold') {
        record.outcome = 'held';
        decision = await new Promise((resolve) => {
          record.resolveHold = resolve;
          for (const waiter of holdWaiters.splice(0)) waiter(record.requestId);
        });
        record.resolveHold = null;
      }
      assertLive(record);
      if (decision === 'reject') {
        record.outcome = 'rejected';
        fail(CODES.USER_REJECTED, 'user rejected the request');
      }
      return await execute(record, decision);
    } catch (raw) {
      const error = sanitize(raw);
      if (['admitted', 'held'].includes(record.outcome)) record.outcome = 'failed';
      if (!record.error) record.error = { code: codeOf(error), message: messageOf(error) };
      throw error;
    } finally {
      if (outstanding === record) outstanding = null;
    }
  }

  async function enrich(record, chain) {
    try {
      const tx = await chain.rpc('eth_getTransactionByHash', [record.hash]);
      if (isPlainObject(tx)) {
        if (typeof tx.from === 'string') record.sender = tx.from;
        if (typeof tx.nonce === 'string') record.nonce = tx.nonce;
        if (typeof tx.type === 'string') record.type = tx.type;
      }
    } catch (error) {
      record.enrichError = messageOf(error); // never turns a recorded hash into "not sent"
    }
  }

  async function sendTransaction(params) {
    if (!authorized) fail(CODES.UNAUTHORIZED, 'eth_sendTransaction requires an authorized account (eth_requestAccounts)');
    const tx = checkTransaction(params, activeAccount(), active.chainId);
    const inputHash = crypto.createHash('sha256').update(JSON.stringify(params[0])).digest('hex');
    const admittedEpoch = epoch;
    try { await validateTransaction(tx); } catch (error) { fail(CODES.INTERNAL, `transaction refused by policy: ${messageOf(error)}`); }
    // A scope change during the policy check fails with its own cause: 4900 disconnect, 4901 chain switch, 4100 otherwise.
    if (!connected) fail(CODES.DISCONNECTED, 'wallet disconnected');
    if (!authorized) fail(CODES.UNAUTHORIZED, 'authorization changed during policy check');
    if (epoch !== admittedEpoch) {
      const { code, message } = lastScopeChange;
      if (code === CODES.DISCONNECTED || code === CODES.CHAIN_DISCONNECTED) fail(code, message);
      fail(CODES.UNAUTHORIZED, 'authorization changed during policy check');
    }
    return runApproval('eth_sendTransaction', { transaction: tx, inputHash }, async (record, decision) => {
      const chain = registry.get(record.chainId);
      await preflight(chain, record.account);
      assertLive(record);
      try { await validateTransaction(tx); } catch (error) { fail(CODES.INTERNAL, `transaction refused by policy: ${messageOf(error)}`); }
      assertLive(record);
      record.outcome = 'dispatching';
      record.dispatchedAt = new Date().toISOString();
      let hash;
      try {
        hash = await chain.rpc('eth_sendTransaction', [tx]);
      } catch (error) {
        if (error && error.kind === 'upstream') {
          record.outcome = 'failed';
          record.error = { code: error.code, message: messageOf(error) };
          throw error;
        }
        record.outcome = 'unknown';
        record.error = { code: CODES.INTERNAL, message: messageOf(error) };
        throw new ForkWalletError(CODES.INTERNAL, `submission outcome unknown: ${messageOf(error)}`);
      }
      if (typeof hash !== 'string' || !HASH.test(hash)) {
        record.outcome = 'unknown';
        record.error = { code: CODES.INTERNAL, message: 'node returned no transaction hash' };
        fail(CODES.INTERNAL, 'submission outcome unknown: node returned no transaction hash');
      }
      record.hash = hash;
      submitted.push(hash);
      await enrich(record, chain);
      if (decision === 'lost') {
        record.outcome = 'response-lost';
        record.error = { code: CODES.INTERNAL, message: 'wallet response lost after local submission' };
        fail(CODES.INTERNAL, 'wallet response lost after local submission');
      }
      record.outcome = 'submitted';
      return hash;
    });
  }

  /** Scope-change code for a request whose epoch moved: 4900 disconnect, 4901 chain switch, 4100 otherwise. */
  function scopeCode() {
    const code = lastScopeChange && lastScopeChange.code;
    return code === CODES.DISCONNECTED || code === CODES.CHAIN_DISCONNECTED ? code : CODES.UNAUTHORIZED;
  }

  async function signaturePolicy(request) {
    try { await signing.validateSignature(request); } catch { signFail(CODES.INTERNAL, 'signature refused by policy'); }
  }

  /**
   * personal_sign / eth_signTypedData_v4 for the active authorized account, forwarded to the owned node's unlocked
   * account. The record never holds the message, typed data or signature. No retry; ambiguity is 'unknown'.
   */
  async function signRequest(method, params) {
    try {
      if (!authorized) signFail(CODES.UNAUTHORIZED, `${method} requires an authorized account (eth_requestAccounts)`);
      const request = checkSignatureRequest(method, params, activeAccount(), active.chainId);
      if (mode === 'lost' && !overrides.some((o) => o.method === method)) signFail(CODES.INVALID_PARAMS, 'lost mode is not supported for signing');
      const forward = method === 'personal_sign' ? [request.message, request.account] : [request.account, JSON.stringify(request.typedData)];
      const fields = { inputHash: crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex'), signatureReturned: false, delivered: false };
      if (request.typedData) {
        const { domain } = request.typedData;
        fields.domain = { chainId: '0x' + BigInt(domain.chainId).toString(16) };
        if (Object.hasOwn(domain, 'verifyingContract')) fields.domain.verifyingContract = domain.verifyingContract;
      }
      const admittedEpoch = epoch;
      await signaturePolicy(request);
      if (!connected) signFail(CODES.DISCONNECTED, 'wallet disconnected');
      if (!authorized) signFail(CODES.UNAUTHORIZED, 'authorization changed during policy check');
      if (epoch !== admittedEpoch) signFail(scopeCode(), 'scope changed during policy check');
      return await runApproval(method, fields, async (record) => {
        const chain = registry.get(record.chainId);
        await preflight(chain, record.account);
        assertLive(record);
        await signaturePolicy(request);
        assertLive(record);
        record.outcome = 'dispatching';
        record.dispatchedAt = new Date().toISOString();
        let signature;
        try {
          signature = await chain.rpc(method, forward);
        } catch (error) {
          if (error && error.kind === 'upstream') {
            // The node answered with an error: no signature. Its message/data may echo the payload and are dropped.
            record.outcome = 'failed';
            record.error = { code: error.code, message: 'node refused the signing request' };
            signFail(error.code, 'node refused the signing request');
          }
          record.outcome = 'unknown';
          record.error = { code: CODES.INTERNAL, message: 'signing outcome unknown: no usable node response' };
          signFail(CODES.INTERNAL, 'signing outcome unknown: no usable node response');
        }
        if (typeof signature !== 'string' || !SIGNATURE.test(signature)) {
          record.outcome = 'unknown';
          record.error = { code: CODES.INTERNAL, message: 'signing outcome unknown: node returned no well-formed signature' };
          signFail(CODES.INTERNAL, 'signing outcome unknown: node returned no well-formed signature');
        }
        record.signatureReturned = true;
        // Synchronous recheck: a signature generated for an outdated scope is discarded, never delivered.
        if (record.epoch !== epoch || !connected || !authorized || active.chainId !== record.chainId || !same(activeAccount(), record.account)) {
          const code = scopeCode();
          record.outcome = 'signed-discarded';
          record.error = { code, message: 'scope changed after signing; signature discarded' };
          signFail(code, 'scope changed after signing; signature discarded');
        }
        record.outcome = 'signed';
        record.delivered = true;
        return signature;
      }, signingError);
    } catch (error) {
      throw signingError(error);
    }
  }

  async function grant(method) {
    return runApproval(method, {}, async (record) => {
      await preflight(active, record.account);
      assertLive(record);
      const changed = !authorized;
      authorized = true;
      record.outcome = 'approved';
      if (changed) {
        bumpEpoch(CODES.INTERNAL, 'authorization changed', record);
        await emit('accountsChanged', [activeAccount()]);
      }
      return method === 'eth_requestAccounts' ? [activeAccount()] : [descriptor()];
    });
  }

  function permissionRequest(params, method) {
    const ok = Array.isArray(params) && params.length === 1 && isPlainObject(params[0]) && Object.keys(params[0]).length === 1
      && isPlainObject(params[0].eth_accounts) && Object.keys(params[0].eth_accounts).length === 0;
    if (!ok) bad(`${method} expects exactly [{eth_accounts: {}}]`);
  }

  async function revokeAuthorization() {
    if (!authorized) return;
    authorized = false;
    bumpEpoch(CODES.UNAUTHORIZED, 'account permission revoked');
    await emit('accountsChanged', []);
  }

  async function applySwitch(target, except) {
    const previous = activeAccount();
    active = target;
    bumpEpoch(CODES.CHAIN_DISCONNECTED, `active chain switched to ${target.chainId}`, except);
    await emit('chainChanged', target.chainId);
    if (authorized && !same(previous, activeAccount())) await emit('accountsChanged', [activeAccount()]);
  }

  async function switchRequest(params) {
    if (!Array.isArray(params) || params.length !== 1 || !isPlainObject(params[0]) || Object.keys(params[0]).length !== 1
      || typeof params[0].chainId !== 'string' || !/^0x[1-9a-fA-F][0-9a-fA-F]{0,15}$/.test(params[0].chainId)) {
      bad('wallet_switchEthereumChain expects exactly [{chainId: <canonical hex>}]');
    }
    if (!authorized) fail(CODES.UNAUTHORIZED, 'wallet_switchEthereumChain requires an authorized account');
    const chainId = params[0].chainId.toLowerCase();
    const target = registry.get(chainId);
    if (!target) fail(CODES.UNRECOGNIZED_CHAIN, `chain ${chainId} is not registered`);
    if (target === active) return null;
    return runApproval('wallet_switchEthereumChain', { target: chainId }, async (record) => {
      await preflight(target, accounts.get(chainId));
      assertLive(record);
      record.outcome = 'approved';
      await applySwitch(target, record);
      return null;
    });
  }

  async function read(method, params) {
    if (method === 'eth_chainId') { noParams(method, params); return active.chainId; }
    const chain = active;
    try { await chain.beforeSend(); } catch (error) { fail(CODES.CHAIN_DISCONNECTED, `selected node unavailable: ${messageOf(error)}`); }
    const forward = await validateReadRequest(method, params, chain.rpc);
    return chain.rpc(method, forward);
  }

  function guardSource(source) {
    let frameOrigin = null;
    try {
      const ok = source && source.page && source.frame && typeof source.page.mainFrame === 'function' && source.frame === source.page.mainFrame();
      frameOrigin = new URL(source.frame.url()).origin;
      if (ok && frameOrigin === origin) return;
    } catch { /* fall through */ }
    recordUnsupported('<binding>', 'caller-frame');
    fail(CODES.UNSUPPORTED_METHOD, `refusing caller frame ${frameOrigin}: only the main frame of ${origin} may use the wallet`);
  }

  async function handle(source, request) {
    guardSource(source);
    let text;
    try { text = JSON.stringify(request); } catch { fail(CODES.INVALID_REQUEST, 'request is not JSON'); }
    if (text === undefined || byteLength(text) > LIMITS.requestBytes) fail(CODES.INVALID_REQUEST, 'request missing or larger than 1 MiB');
    if (!isPlainObject(request)) fail(CODES.INVALID_REQUEST, 'request object required');
    const unknown = Object.keys(request).filter((key) => key !== 'method' && key !== 'params');
    if (unknown.length) fail(CODES.INVALID_REQUEST, `unsupported request fields: ${unknown.slice(0, 10).join(', ')}`);
    const { method, params } = request;
    if (typeof method !== 'string') fail(CODES.INVALID_REQUEST, 'method must be a string');
    if (!METHODS.includes(method)) {
      recordUnsupported(method, 'unsupported-method');
      fail(CODES.UNSUPPORTED_METHOD, `unsupported method ${method.slice(0, 100)}`);
    }
    if (SIGNING_METHODS.includes(method) && !signing) {
      recordUnsupported(method, 'signing-disabled');
      fail(CODES.UNSUPPORTED_METHOD, `${method} is disabled: install the wallet with a signing policy to enable it`);
    }
    if (params !== undefined && !Array.isArray(params)) fail(CODES.INVALID_PARAMS, 'params must be an array');
    if (method === 'wallet_getPermissions') { noParams(method, params); return authorized ? [descriptor()] : []; }
    if (method === 'wallet_revokePermissions') { permissionRequest(params, method); await revokeAuthorization(); return null; }
    if (!connected) {
      if (method === 'eth_accounts') { noParams(method, params); return []; }
      fail(CODES.DISCONNECTED, 'wallet disconnected');
    }
    switch (method) {
      case 'eth_accounts': noParams(method, params); return authorized ? [activeAccount()] : [];
      case 'eth_requestAccounts': noParams(method, params); return authorized ? [activeAccount()] : grant(method);
      case 'wallet_requestPermissions': permissionRequest(params, method); return grant(method);
      case 'wallet_switchEthereumChain': return switchRequest(params);
      case 'eth_sendTransaction': return sendTransaction(params);
      case 'personal_sign': case 'eth_signTypedData_v4': return signRequest(method, params);
      default: return read(method, params);
    }
  }

  await context.exposeBinding('__forkWalletRequest', async (source, request) => {
    try {
      return { result: await handle(source, request) };
    } catch (error) {
      const reply = { code: codeOf(error), message: messageOf(error) };
      const data = safeErrorData(error && error.data);
      if (data !== undefined) reply.data = data;
      return { error: reply };
    }
  });
  await context.exposeBinding('__forkWalletInit', async (source) => {
    try { guardSource(source); } catch { return null; }
    return { connected, chainId: active.chainId };
  });
  await context.addInitScript(pageScript, { origin, info });

  const handle_ = {
    calls, submitted, unsupported, info,
    get chainId() { return active.chainId; },
    get account() { return activeAccount(); },
    get chains() { return [...registry.keys()]; },
    get mode() { return mode; },
    get signing() { return Boolean(signing); },
    get connected() { return connected; },
    get authorized() { return authorized; },
    get epoch() { return epoch; },
    get held() { return Boolean(outstanding && outstanding.outcome === 'held'); },
    get heldRequestId() { return outstanding && outstanding.outcome === 'held' ? outstanding.requestId : null; },
    setMode(value) {
      if (!MODES.includes(value)) fail(CODES.INVALID_PARAMS, `unknown mode ${String(value)}`);
      mode = value;
    },
    nextRequest({ method, mode: value } = {}) {
      if (!APPROVAL_METHODS.includes(method)) fail(CODES.INVALID_PARAMS, `nextRequest method must be one of ${APPROVAL_METHODS.join(', ')}`);
      if (!MODES.includes(value)) fail(CODES.INVALID_PARAMS, `unknown mode ${String(value)}`);
      if (SIGNING_METHODS.includes(method) && !signing) fail(CODES.INVALID_PARAMS, `${method} is disabled: no signing policy installed`);
      if (value === 'lost' && method !== 'eth_sendTransaction') fail(CODES.INVALID_PARAMS, 'lost applies only to eth_sendTransaction');
      overrides.push(Object.freeze({ method, mode: value }));
    },
    whenHeld() {
      if (outstanding && outstanding.outcome === 'held') return Promise.resolve(outstanding.requestId);
      return new Promise((resolve) => holdWaiters.push(resolve));
    },
    release(requestId, outcome = 'approve') {
      if (typeof requestId !== 'string') fail(CODES.INVALID_PARAMS, 'release(requestId, outcome) requires the held requestId');
      if (!RELEASE_OUTCOMES.includes(outcome)) fail(CODES.INVALID_PARAMS, `unknown release outcome ${String(outcome)}`);
      const record = outstanding;
      if (!record || record.outcome !== 'held' || !record.resolveHold) fail(CODES.INTERNAL, 'no held request');
      if (record.requestId !== requestId) fail(CODES.INVALID_PARAMS, `request ${requestId} is not the held request`);
      if (outcome === 'lost' && record.method !== 'eth_sendTransaction') fail(CODES.INVALID_PARAMS, 'lost applies only to eth_sendTransaction');
      record.outcome = 'admitted';
      const resolve = record.resolveHold;
      record.resolveHold = null;
      resolve(outcome);
    },
    async revoke() { await revokeAuthorization(); },
    async disconnect() {
      if (!connected) return;
      connected = false;
      bumpEpoch(CODES.DISCONNECTED, 'wallet disconnected');
      await emit('disconnect', { code: CODES.DISCONNECTED, message: 'wallet disconnected' });
    },
    async reconnect() {
      if (connected) return;
      await preflight(active, activeAccount(), { requireConnected: false });
      if (connected) return;
      connected = true;
      await emit('connect', { chainId: active.chainId });
    },
    async setAccount(value) {
      if (typeof value !== 'string' || !ADDRESS.test(value)) fail(CODES.INVALID_PARAMS, 'setAccount requires an address');
      await active.beforeSend();
      const unlocked = await active.rpc('eth_accounts');
      if (!Array.isArray(unlocked) || !unlocked.some((a) => same(a, value))) fail(CODES.INVALID_PARAMS, `${value} is not unlocked on the active owned node`);
      if (same(value, activeAccount())) return;
      accounts.set(active.chainId, value);
      bumpEpoch(CODES.UNAUTHORIZED, 'active account changed');
      if (authorized) await emit('accountsChanged', [value]);
    },
    async switchChain(value) {
      const target = registry.get(normalizeChainId(value));
      if (!target) fail(CODES.UNRECOGNIZED_CHAIN, `chain ${String(value)} is not registered`);
      if (target === active) return;
      await preflight(target, accounts.get(target.chainId));
      await applySwitch(target, null);
    },
  };
  return handle_;
}

module.exports = {
  installForkWallet, createLoopbackRpc, requireLoopbackEndpoint, requireOrigin, normalizeChainId, checkTransaction,
  checkSignatureRequest, validateReadRequest, ForkWalletError, MODES, RELEASE_OUTCOMES, METHODS, READ_METHODS, WALLET_METHODS,
  APPROVAL_METHODS, SIGNING_METHODS, SIGNING_CHAINS, TRANSACTION_FIELDS, TRANSACTION_TYPES, STATES, CODES, LIMITS, PROVIDER_INFO,
};
