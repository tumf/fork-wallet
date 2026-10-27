export type Mode = 'approve' | 'reject' | 'hold' | 'lost';
export type ReleaseOutcome = 'approve' | 'reject' | 'lost';
export type Method = 'eth_accounts' | 'eth_requestAccounts' | 'eth_chainId' | 'eth_sendTransaction';

/** Exactly the bytes the page sent: from/to required, value/data/chainId optional, nothing else. */
export interface Transaction {
  readonly from: string;
  readonly to: string;
  readonly value?: string;
  readonly data?: string;
  readonly chainId?: string;
}

export interface Call {
  /** Mode in force when the request was admitted. */
  mode: Mode;
  transaction: Transaction;
  outcome: 'pending' | 'submitted' | 'rejected' | 'lost' | 'failed';
  hash?: string;
  error?: { code: number; message: string };
}

export interface InstallOptions {
  /** http://127.0.0.1:<port> of your own loopback node. */
  endpoint: string;
  /** Exact http://127.0.0.1:<port> origin of the page that may use the wallet. */
  origin: string;
  /** Explicit chain ID (number or hex string). The node must report the same value. */
  chainId: number | string;
  /** Unlocked account of the loopback node that submits transactions. */
  account: string;
  /** Mandatory: throw to refuse the exact transaction bytes. Called before admission and again before submission. */
  validateTransaction(tx: Transaction): void | Promise<void>;
  /** Mandatory: throw when the node/listener is no longer yours. Called twice per preflight. */
  beforeSend(): void | Promise<void>;
  /** web3_clientVersion pattern. Default /^anvil\//i. */
  clientVersion?: RegExp;
  /** Per-RPC timeout. Default 15000. */
  timeoutMs?: number;
}

export interface ForkWallet {
  readonly calls: Call[];
  readonly submitted: string[];
  readonly chainId: string;
  readonly account: string;
  readonly mode: Mode;
  readonly connected: boolean;
  readonly held: boolean;
  setMode(mode: Mode): void;
  /** Resolves once a request is held (immediately if one already is). */
  whenHeld(): Promise<void>;
  release(outcome?: ReleaseOutcome): void;
  /** Blocks later sends, fails a held request with 4900 and emits accountsChanged([]) + disconnect. */
  disconnect(): Promise<void>;
}

/** Structural subset of playwright's BrowserContext used by the wallet. */
export interface ContextLike {
  exposeBinding(name: string, callback: (source: { frame: { url(): string } }, ...args: any[]) => any): Promise<void>;
  addInitScript(script: Function, arg?: any): Promise<void>;
  pages?(): Array<{ url(): string; evaluate(fn: any, arg?: any): Promise<any> }>;
}

export class ForkWalletError extends Error {
  code: number;
  constructor(code: number, message: string);
}

export const MODES: readonly Mode[];
export const METHODS: readonly Method[];
export const TRANSACTION_FIELDS: readonly (keyof Transaction)[];
export const CODES: {
  readonly USER_REJECTED: 4001;
  readonly UNSUPPORTED_METHOD: 4200;
  readonly DISCONNECTED: 4900;
  readonly REQUEST_PENDING: -32002;
  readonly INVALID_PARAMS: -32602;
  readonly INTERNAL: -32603;
};

export function installForkWallet(context: ContextLike, options: InstallOptions): Promise<ForkWallet>;
export function createLoopbackRpc(endpoint: string, options?: { timeoutMs?: number }): (method: string, params?: unknown[]) => Promise<any>;
export function requireLoopbackEndpoint(endpoint: string): string;
export function requireOrigin(origin: string): string;
export function normalizeChainId(chainId: number | string): string;
export function checkTransaction(params: unknown, account: string, chainId: string): Transaction;
