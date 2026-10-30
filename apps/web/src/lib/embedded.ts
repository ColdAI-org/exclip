/**
 * The passkey wallet from ExClip's side: connect, back up, sign out (docs/embedded-wallet.md). No wallet SDK here, so
 * the backup banner works from the first-load bundle; trades and sends live in wallet-runtime.
 *
 * Every function that opens the popup must be called synchronously from a click handler: it opens the window before
 * its first await, or the browser blocks it.
 */
import type { ExclipPublicConfig } from "./api";
import { BRAND } from "./brand";
import { EmbeddedWalletError, WalletPopup } from "./embedded-client";
import type { ConnectIntent, ManageAction } from "./wallet-protocol";
import { getWalletState, rememberConnection, setEmbeddedSession, walletActions, type ChainFamily } from "./wallet";
import { buildWalletOrigin, trustedWalletOrigin, walletOfferedOn } from "./wallet-origin";

export const SELF_CUSTODY = `Self-custody: only your passkey can unlock this wallet; ${BRAND.operator || BRAND.name} stores an encrypted backup it cannot read.`;
export const DEFAULT_UNBACKED_LIMIT_USD = 100;

const DEV = import.meta.env.DEV;
/** Fixed at build time (wallet-origin.ts). The runtime config can't move it. */
const PINNED_WALLET_ORIGIN = buildWalletOrigin(__EXCLIP__.walletOrigin, DEV);

/** The build's wallet origin when the runtime config switches the embedded wallet on (and agrees); otherwise null. */
export function embeddedOrigin(config: ExclipPublicConfig | null | undefined): string | null {
  const page = typeof window === "undefined" ? null : window.location.origin;
  if (!walletOfferedOn(page, __EXCLIP__.appOrigin, DEV)) return null;
  return trustedWalletOrigin(PINNED_WALLET_ORIGIN, config);
}

export function unbackedLimitUsd(config: ExclipPublicConfig | null | undefined): number {
  const v = config?.unbackedLimitUsd;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_UNBACKED_LIMIT_USD;
}

/** Dev builds only: sign in the popup but never broadcast (localStorage "exclip.dev.signOnly" = "1"). */
export function devSignOnly(): boolean {
  if (!DEV) return false;
  try { return window.localStorage.getItem("exclip.dev.signOnly") === "1"; } catch { return false; }
}

/** User-facing text for anything the popup or the trade flow threw. */
export function embeddedErrorText(e: unknown): string {
  if (e instanceof EmbeddedWalletError) return e.message;
  if (e instanceof Error && e.name === "EmbeddedTradeError") return e.message;
  return "Something went wrong in the wallet window. Nothing was signed.";
}

/** Create or sign in. Replaces any browser-wallet connection: ExClip uses one wallet at a time. */
export function connectEmbedded(origin: string, intent: ConnectIntent): Promise<void> {
  let popup: WalletPopup;
  try {
    popup = WalletPopup.open(origin);
  } catch (e) {
    return Promise.reject(e);
  }
  return popup.connect(intent).then(async ({ accounts, backedUp }) => {
    const actions = walletActions();
    const s = getWalletState();
    if (actions && !s.embedded) {
      for (const family of Object.keys(s.accounts) as ChainFamily[]) await actions.disconnect(family).catch(() => undefined);
    }
    rememberConnection(false);
    setEmbeddedSession({ evm: accounts.evm, backedUp });
  });
}

/** Save the recovery phrase, add a passkey, move to Clip Wallet, or show the deposit address ("receive": the popup
 * shows it, never this page; `heldUsd` is what this page believes the wallet holds). Updates the backup state from
 * the answer. */
export function manageEmbedded(origin: string, action: ManageAction, opts: { heldUsd?: number } = {}): Promise<void> {
  let popup: WalletPopup;
  try {
    popup = WalletPopup.open(origin);
  } catch (e) {
    return Promise.reject(e);
  }
  return popup.manage(action, opts.heldUsd).then(({ backedUp }) => {
    const s = getWalletState().embedded;
    if (s && s.backedUp !== backedUp) setEmbeddedSession({ ...s, backedUp });
  });
}

/** Forgets the addresses in this tab. The wallet itself stays in the browser (and in the encrypted backup). */
export function signOutEmbedded() {
  setEmbeddedSession(null);
}
