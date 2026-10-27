export interface StartAnvilOptions {
  /** Default 31337. */
  chainId?: number;
  /** Binary name or path. Default 'anvil'. Must be Anvil 1.8.3. */
  anvil?: string;
  /** Startup readiness bound, 100-120000. Default 10000. */
  timeoutMs?: number;
}

export interface OwnedAnvil {
  /** Private management endpoint for the test runner and installForkWallet. Never give it to the page. */
  readonly endpoint: string;
  /** Loopback read-only gateway for the browser (allowlisted reads only; CORS for the configured origin). */
  readonly publicEndpoint: string;
  /** Canonical hex chain ID. */
  readonly chainId: string;
  /** First unlocked account of the random mnemonic. */
  readonly account: string;
  /** PID of the owned child. */
  readonly pid: number;
  /** Ownership guard: throws unless the owned child is alive and is the only listener on its port. */
  beforeSend(): void;
  /** Allows exactly this http://127.0.0.1:<port> origin to call the gateway. Once; a different origin later throws. */
  configureOrigin(origin: string): void;
  /** Idempotent: closes the gateway, TERM then KILL of the owned child only, waits for exit and listener release. */
  stop(): Promise<void>;
}

export interface ReadGateway {
  readonly publicEndpoint: string;
  readonly port: number;
  readonly stats: { forwarded: number; refused: number };
  configureOrigin(origin: string): void;
  close(): Promise<void>;
}

export function startAnvil(options?: StartAnvilOptions): Promise<OwnedAnvil>;
/** Read gateway in front of any owned loopback endpoint (used by startAnvil). */
export function startReadGateway(options: { endpoint: string; beforeSend(): void | Promise<void>; timeoutMs?: number }): Promise<ReadGateway>;
export function requireNoCredentials(env?: Record<string, string | undefined>): void;
export function scrubbedEnv(env?: Record<string, string | undefined>): { PATH?: string; HOME?: string };
export function freePort(): Promise<number>;
export function listenerPids(port: number): number[];
export function requireOwnedPort(pid: number, port: number): void;
export const SUPPORTED_ANVIL: RegExp;
