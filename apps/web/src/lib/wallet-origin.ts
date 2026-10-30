/**
 * Which origin ExClip treats as "the wallet" (docs/embedded-wallet.md, threat model).
 *
 * The origin is fixed when apps/web is built (exclip.config.ts `origins.wallet`; http://localhost:5311 in dev). The
 * server's `/api/exclip/config` may only switch the embedded wallet on or off: if it names a different origin, the
 * wallet stays off. Otherwise whoever controls the server could point ExClip at a look-alike popup and hand out its
 * own deposit addresses.
 *
 * No build-time globals here, so tests can import it directly; embedded.ts passes the build values in.
 */
import { validWalletOrigin } from "./embedded-client";

/** The origin this build trusts, or null (off) when the build value isn't an exact origin. */
export function buildWalletOrigin(raw: unknown, dev: boolean): string | null {
  return typeof raw === "string" && validWalletOrigin(raw, dev) ? raw : null;
}

/**
 * Whether a production build offers the embedded wallet on this page: only on the exact app origin it was built for
 * (exclip.config.ts `origins.app`). The wallet popup only answers that origin (its build-time parent list), so a copy
 * of this bundle served from any other origin keeps the browser-wallet path only. Dev builds offer it anywhere: the
 * dev popup trusts localhost.
 */
export function walletOfferedOn(pageOrigin: string | null | undefined, appOrigin: string | null | undefined, dev: boolean): boolean {
  return dev || (!!appOrigin && pageOrigin === appOrigin);
}

type RuntimeConfig = { embeddedWallet?: boolean; walletOrigin?: string | null } | null | undefined;

/** The pinned origin when the runtime config switches the wallet on and doesn't contradict the build; otherwise null. */
export function trustedWalletOrigin(pinned: string | null, config: RuntimeConfig): string | null {
  if (!pinned || !config?.embeddedWallet) return null;
  if (config.walletOrigin != null && config.walletOrigin !== pinned) return null;
  return pinned;
}
