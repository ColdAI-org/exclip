/**
 * ExClip's wallet state, kept in the first-load bundle without any wallet SDK. The SODAX wallet and dapp kits are
 * loaded only when a visitor presses Connect or Preview (requestWallet), by mounting <WalletHost>, which imports
 * ./wallet-runtime. That module registers the real actions here, so pages call `walletActions()` without importing
 * the SDK themselves.
 */
import { useSyncExternalStore } from "react";

export type ChainFamily = "EVM" | "SOLANA" | "SUI" | "BITCOIN" | "ICON" | "INJECTIVE" | "STELLAR" | "NEAR" | "STACKS";

export type WalletStatus = "idle" | "loading" | "ready" | "failed";

export type SwapInput = {
  srcChainKey: string;
  dstChainKey: string;
  inputToken: string;
  outputToken: string;
  inputAmount: bigint;
  minOutputAmount: bigint;
  /** Seconds since epoch; 0n for a limit order with no expiry. */
  deadline: bigint;
  dstAddress?: string;
  kind: "market" | "limit";
};

export type SwapProgress =
  | { step: "approve" }
  | { step: "sign" }
  | { step: "submitted"; srcTxHash: string; srcChainKey: string }
  | { step: "solving"; srcTxHash: string; hubTxHash: string }
  | { step: "settled"; srcTxHash: string; hubTxHash: string; fillTxHash?: string }
  | { step: "failed"; message: string; srcTxHash?: string };

export type SwapOutcome = { srcTxHash: string; hubTxHash: string; intent: SerializedIntent };

/** An SDK Intent with bigints as decimal strings, so it can be kept in localStorage for cancel and history. */
export type SerializedIntent = Record<string, string | boolean>;

export type WalletActions = {
  swap(input: SwapInput, onProgress: (p: SwapProgress) => void): Promise<SwapOutcome>;
  cancel(order: { srcChainKey: string; intent: SerializedIntent; kind: "market" | "limit" }): Promise<string>;
  status(hubTxHash: string): Promise<{ code: number; fillTxHash?: string } | null>;
  disconnect(family: ChainFamily): Promise<void>;
  /** Wallet family that signs on this SODAX chain key. */
  familyOf(chainKey: string): ChainFamily | null;
  /** Same-network send from the embedded wallet (browser wallets use their own Send). Returns the tx hash.
   * Call it synchronously from the click handler: it opens the wallet popup before its first await. */
  embeddedSend(input: { chainKey: string; token: string; amount: bigint; to: string }): Promise<string>;
};

/** The passkey wallet's public session (docs/embedded-wallet.md). Addresses only, never a secret.
 * ExClip v1 uses only the EVM address: the wallet signs only on EVM networks, so its Solana/Sui/Stellar addresses
 * are not shown for deposits (funds sent there could only be moved after exporting the phrase). */
export type EmbeddedSession = { evm: string; backedUp: boolean };

export type WalletState = {
  status: WalletStatus;
  /** Set by requestWallet(): mounts <WalletHost>. */
  requested: boolean;
  sheetOpen: boolean;
  /** Connected address per chain family. */
  accounts: Partial<Record<ChainFamily, string>>;
  /** Base-unit balances (decimal strings) per chain key, then token address (lowercase). */
  balances: Record<string, Record<string, string>>;
  error: string | null;
  /** Set while signed in with the passkey wallet; `accounts` then holds only its EVM address. */
  embedded: EmbeddedSession | null;
};

let state: WalletState = { status: "idle", requested: false, sheetOpen: false, accounts: {}, balances: {}, error: null, embedded: null };
let actions: WalletActions | null = null;
const listeners = new Set<() => void>();

export function setWalletState(patch: Partial<WalletState> | ((s: WalletState) => Partial<WalletState>)) {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach(l => l());
}

export function getWalletState() { return state; }

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function useWallet(): WalletState {
  return useSyncExternalStore(subscribe, () => state);
}

export function registerWalletActions(a: WalletActions | null) { actions = a; }

/** The loaded runtime's actions, or null while the SDK is still loading. */
export function walletActions(): WalletActions | null { return actions; }

/** Starts loading the wallet SDK (once). With `open`, also opens the connect sheet. */
export function requestWallet({ open = false }: { open?: boolean } = {}) {
  setWalletState(s => ({ requested: true, sheetOpen: open || s.sheetOpen, status: s.status === "idle" || s.status === "failed" ? "loading" : s.status, error: null }));
}

export function closeWalletSheet() { setWalletState({ sheetOpen: false }); }

export function isConnected(s: WalletState = state): boolean { return Object.values(s.accounts).some(Boolean); }

/** The first connected address, for display. */
export function primaryAddress(s: WalletState = state): string | null {
  for (const f of ["EVM", "SOLANA", "SUI", "BITCOIN", "STELLAR", "NEAR", "INJECTIVE", "STACKS", "ICON"] as ChainFamily[]) {
    if (s.accounts[f]) return s.accounts[f]!;
  }
  return null;
}

/** Remember that a wallet was connected, so the SDK loads again on the next visit (after the first render, not
 * before). */
const RECONNECT_KEY = "exclip.reconnect";
export function rememberConnection(on: boolean) {
  try { if (on) window.localStorage.setItem(RECONNECT_KEY, "1"); else window.localStorage.removeItem(RECONNECT_KEY); } catch { /* blocked */ }
}
export function shouldReconnect(): boolean {
  try { return window.localStorage.getItem(RECONNECT_KEY) === "1"; } catch { return false; }
}

/** The embedded session lives in sessionStorage (this tab only, gone when it closes) and in memory. */
const EMBEDDED_KEY = "exclip.embedded.v1";

export function parseEmbeddedSession(raw: string | null): EmbeddedSession | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || Object.keys(v).length !== 2) return null;
    if (typeof v.evm !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v.evm) || typeof v.backedUp !== "boolean") return null;
    return { evm: v.evm, backedUp: v.backedUp };
  } catch { return null; }
}

/** Starts (or updates) the embedded session; null signs out and clears every address and balance. */
export function setEmbeddedSession(s: EmbeddedSession | null) {
  try {
    if (s) window.sessionStorage.setItem(EMBEDDED_KEY, JSON.stringify({ evm: s.evm, backedUp: s.backedUp }));
    else window.sessionStorage.removeItem(EMBEDDED_KEY);
  } catch { /* blocked: memory only */ }
  setWalletState(s ? { embedded: s, accounts: { EVM: s.evm }, balances: {} } : { embedded: null, accounts: {}, balances: {} });
}

export function storedEmbeddedSession(): EmbeddedSession | null {
  try { return parseEmbeddedSession(window.sessionStorage.getItem(EMBEDDED_KEY)); } catch { return null; }
}
