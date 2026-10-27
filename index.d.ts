export type Mode = 'approve' | 'reject' | 'hold' | 'lost';
export type ReleaseOutcome = 'approve' | 'reject' | 'lost';
export type ApprovalMethod = 'eth_requestAccounts' | 'wallet_requestPermissions' | 'wallet_switchEthereumChain' | 'eth_sendTransaction';
export type ReadMethod =
  | 'eth_chainId' | 'net_version' | 'eth_blockNumber' | 'eth_getBalance' | 'eth_getCode' | 'eth_getStorageAt'
  | 'eth_getTransactionCount' | 'eth_call' | 'eth_estimateGas' | 'eth_gasPrice' | 'eth_maxPriorityFeePerGas'
  | 'eth_feeHistory' | 'eth_getBlockByNumber' | 'eth_getBlockByHash' | 'eth_getTransactionByHash'
  | 'eth_getTransactionReceipt' | 'eth_getLogs';
export type WalletMethod = 'eth_accounts' | 'wallet_getPermissions' | 'wallet_revokePermissions' | ApprovalMethod;
export type Method = WalletMethod | ReadMethod;

export interface AccessListEntry {
  readonly address: string;
  readonly storageKeys: readonly string[];
}

/**
 * Exactly the allowlisted fields the page sent, unchanged in value (deep-frozen). `from` is required; `to` may be
 * omitted only for a deployment with non-empty `data`. Quantities are canonical hex; `type` is 0x0, 0x1 or 0x2.
 */
export interface Transaction {
  readonly from: string;
  readonly to?: string;
  readonly value?: string;
  readonly data?: string;
  readonly chainId?: string;
  readonly gas?: string;
  readonly gasPrice?: string;
  readonly maxFeePerGas?: string;
  readonly maxPriorityFeePerGas?: string;
  readonly nonce?: string;
  readonly type?: '0x0' | '0x1' | '0x2';
  readonly accessList?: readonly AccessListEntry[];
}

/**
 * Request lifecycle state (0.2.0). Transactions: admitted → held? → dispatching → submitted | response-lost |
 * unknown | failed, or rejected / cancelled / failed before dispatch. Non-transaction approvals end in approved,
 * rejected, cancelled or failed. `unknown` means the node may have executed it; it is never proof of no send.
 */
export type CallState =
  | 'admitted' | 'held' | 'dispatching' | 'submitted' | 'rejected' | 'response-lost' | 'unknown' | 'failed'
  | 'cancelled' | 'approved';

/** One admitted approval request. Field set is versioned with the package (0.2.0); see README migration. */
export interface Call {
  requestId: string;
  method: ApprovalMethod;
  /** Epoch at admission; any scope change (account, chain, permission, transport) increments the wallet epoch. */
  epoch: number;
  origin: string;
  /** Chain registration the request is bound to; a dispatched write stays attributed to it. */
  chainId: string;
  endpoint: string;
  account: string;
  /** Mode in force when the request was admitted (after one-shot nextRequest overrides). */
  mode: Mode;
  outcome: CallState;
  admittedAt: string;
  dispatchedAt?: string;
  /** eth_sendTransaction only. */
  transaction?: Transaction;
  /** sha256 hex of the exact JSON the page sent as the transaction object. */
  inputHash?: string;
  /** wallet_switchEthereumChain only. */
  target?: string;
  hash?: string;
  /** Read back from the node by hash when available. */
  sender?: string;
  nonce?: string;
  type?: string;
  enrichError?: string;
  error?: { code: number; message: string };
}

export interface UnsupportedRecord {
  method: string;
  reason: 'unsupported-method' | 'caller-frame';
  at: string;
}

export interface ChainRegistration {
  /** http://127.0.0.1:<port> management endpoint of an owned node. Never exposed to the page. */
  endpoint: string;
  chainId: number | string;
  /** Unlocked account of that node. */
  account: string;
  /** Mandatory ownership guard for that node. */
  beforeSend(): void | Promise<void>;
}

export interface InstallOptions {
  /** http://127.0.0.1:<port> of your own loopback node (initial chain). */
  endpoint: string;
  /** Exact http://127.0.0.1:<port> origin whose main frame may use the wallet. */
  origin: string;
  /** Explicit chain ID (number or hex string). The node must report the same value. */
  chainId: number | string;
  /** Unlocked account of the loopback node that submits transactions. */
  account: string;
  /** Mandatory: throw to refuse the exact transaction. Called before admission and again right before dispatch. */
  validateTransaction(tx: Transaction): void | Promise<void>;
  /** Mandatory: throw when the node/listener is no longer yours. Called before reads and twice per preflight. */
  beforeSend(): void | Promise<void>;
  /** Additional pre-registered chains (unique chain IDs, not repeating the initial chain). */
  chains?: ChainRegistration[];
  /** web3_clientVersion pattern. Default /^anvil\//i. */
  clientVersion?: RegExp;
  /** Per-RPC timeout, 1-15000. Default 15000. */
  timeoutMs?: number;
}

export interface ProviderInfo {
  readonly uuid: string;
  readonly name: 'Fork Wallet';
  readonly rdns: 'dev.forkwallet.test';
  readonly icon: string;
}

/** Node-only control handle. Nothing here is exposed to the page. */
export interface ForkWallet {
  readonly calls: Call[];
  /** Every hash the node returned, including response-lost ones. */
  readonly submitted: string[];
  /** Refused unsupported methods and caller frames (bounded to 1000 entries). */
  readonly unsupported: UnsupportedRecord[];
  readonly info: ProviderInfo;
  readonly chainId: string;
  readonly account: string;
  readonly chains: string[];
  readonly mode: Mode;
  readonly connected: boolean;
  readonly authorized: boolean;
  readonly epoch: number;
  readonly held: boolean;
  readonly heldRequestId: string | null;
  /** Default decision for approval requests. 'lost' applies to transactions only (others approve). */
  setMode(mode: Mode): void;
  /** One-shot decision consumed by the next matching approval request; reads never consume it. */
  nextRequest(next: { method: ApprovalMethod; mode: Mode }): void;
  /** Resolves with the held requestId (immediately if one is held). No timeout: race it with a deadline. */
  whenHeld(): Promise<string>;
  /** Releases exactly the held request; a wrong ID, a second release or an invalidated request fails. */
  release(requestId: string, outcome?: ReleaseOutcome): void;
  /** Clears the account permission, invalidates pending requests, emits accountsChanged([]). Not a disconnect. */
  revoke(): Promise<void>;
  /** Transport loss: invalidates pending requests (4900), emits disconnect once. Permission is kept. */
  disconnect(): Promise<void>;
  /** Preflights the active node, restores transport and emits connect({chainId}). Never regrants a revoked permission. */
  reconnect(): Promise<void>;
  /** Switches to another account unlocked on the active owned node; invalidates pending requests. */
  setAccount(address: string): Promise<void>;
  /** Switches to a registered chain after target preflight; invalidates pending requests. */
  switchChain(chainId: number | string): Promise<void>;
}

export interface FrameLike { url(): string }
export interface PageLike { url(): string; mainFrame(): FrameLike; evaluate(fn: any, arg?: any): Promise<any> }

/** Structural subset of playwright's BrowserContext used by the wallet. */
export interface ContextLike {
  exposeBinding(name: string, callback: (source: { page: PageLike; frame: FrameLike }, ...args: any[]) => any): Promise<void>;
  addInitScript(script: Function, arg?: any): Promise<void>;
  pages?(): PageLike[];
}

export class ForkWalletError extends Error {
  code: number;
  data?: unknown;
  /** Set by createLoopbackRpc: 'upstream' (node JSON-RPC error), 'transport' or 'integrity'. */
  kind?: 'upstream' | 'transport' | 'integrity';
  constructor(code: number, message: string, data?: unknown);
}

export const MODES: readonly Mode[];
export const RELEASE_OUTCOMES: readonly ReleaseOutcome[];
export const METHODS: readonly Method[];
export const READ_METHODS: readonly ReadMethod[];
export const WALLET_METHODS: readonly WalletMethod[];
export const APPROVAL_METHODS: readonly ApprovalMethod[];
export const TRANSACTION_FIELDS: readonly (keyof Transaction)[];
export const TRANSACTION_TYPES: readonly ('0x0' | '0x1' | '0x2')[];
export const STATES: readonly CallState[];
export const CODES: {
  readonly USER_REJECTED: 4001;
  readonly UNAUTHORIZED: 4100;
  readonly UNSUPPORTED_METHOD: 4200;
  readonly DISCONNECTED: 4900;
  readonly CHAIN_DISCONNECTED: 4901;
  readonly UNRECOGNIZED_CHAIN: 4902;
  readonly REQUEST_PENDING: -32002;
  readonly INVALID_REQUEST: -32600;
  readonly INVALID_PARAMS: -32602;
  readonly INTERNAL: -32603;
};
export const LIMITS: {
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly errorDataBytes: number;
  readonly batch: number;
  readonly logRange: number;
  readonly logAddresses: number;
  readonly topicPositions: number;
  readonly topicAlternatives: number;
  readonly feeHistoryBlocks: number;
  readonly feeHistoryPercentiles: number;
  readonly accessListItems: number;
  readonly timeoutMs: number;
};
export const PROVIDER_INFO: { readonly name: string; readonly rdns: string; readonly icon: string };

export type Rpc = (method: string, params?: unknown[]) => Promise<any>;

export function installForkWallet(context: ContextLike, options: InstallOptions): Promise<ForkWallet>;
export function createLoopbackRpc(endpoint: string, options?: { timeoutMs?: number; maxResponseBytes?: number }): Rpc;
export function requireLoopbackEndpoint(endpoint: string): string;
export function requireOrigin(origin: string): string;
export function normalizeChainId(chainId: number | string): string;
export function checkTransaction(params: unknown, account: string, chainId: string): Transaction;
/** Validates an allowlisted read and returns fresh bounded params (eth_getLogs tags resolved through `rpc`). */
export function validateReadRequest(method: string, params: unknown, rpc: Rpc): Promise<unknown[]>;
