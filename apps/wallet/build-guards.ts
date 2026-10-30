/** The checks vite.config.ts runs before it bakes anything into the wallet bundle, in a module of their own so the
 * tests can run them without Vite. What the popup trusts is decided here, at build time: the page origin it answers,
 * its own origin, and the partner-fee receivers an intent may name (docs/embedded-wallet.md). */
import { fileURLToPath } from "node:url";
import { PLACEHOLDER_ORIGINS, parseOrigin, sharesRpId, usesPlaceholderOrigins, type ExclipConfig } from "@exclip/config";

/** The partner-fee receivers an intent may name: `fee-receivers.json`, committed with the code rather than taken from
 * the environment, so changing it takes a reviewed commit. Must contain exclip.config.ts fees.receiver when a partner
 * fee is set; empty → the wallet refuses any fee. */
export const FEE_RECEIVERS_FILE = fileURLToPath(new URL("./fee-receivers.json", import.meta.url));

export function parseFeeReceivers(json: string): string[] {
  const doc = JSON.parse(json) as { receivers?: unknown };
  const list = doc?.receivers;
  if (!Array.isArray(list)) throw new Error("fee-receivers.json: \"receivers\" must be an array");
  for (const a of list) if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`fee-receivers.json: not an address: ${String(a)}`);
  const lower = (list as string[]).map((a) => a.toLowerCase());
  if (new Set(lower).size !== lower.length) throw new Error("fee-receivers.json: duplicate receiver");
  return lower;
}

/** A production build answers exactly the origins it bakes in. Each must be an exact https origin (no http, path,
 * default port or upper case), and no parent may sit on the wallet's host or a subdomain of it: a page there could
 * claim the wallet's rpId, run its passkeys itself and derive the vault password from their PRF output, with no popup
 * involved. exclip.config.ts is validated the same way (resolveConfig); this is the last check before the values
 * reach the bundle. */
export function assertProductionOrigins(parentOrigins: readonly string[], walletOrigin: string): void {
  if (parseOrigin(walletOrigin) !== walletOrigin) throw new Error(`wallet origin: not an exact https origin: ${walletOrigin}`);
  if (!parentOrigins.length) throw new Error("no parent origin: the wallet would answer nobody");
  const walletHost = new URL(walletOrigin).hostname;
  for (const parent of parentOrigins) {
    if (parseOrigin(parent) !== parent) throw new Error(`parent origin: not an exact https origin: ${parent}`);
    if (sharesRpId(new URL(parent).hostname, walletHost)) {
      throw new Error(`parent origin ${parent} shares the wallet's rpId (${walletHost}): the wallet needs a host of its own`);
    }
  }
}

/** Settings a build accepts but should point out. `production`: vite build (development uses DEV_ORIGINS, so the
 * placeholder origins don't matter there). */
export function buildWarnings(config: ExclipConfig, feeReceivers: readonly string[], production: boolean): string[] {
  const warnings: string[] = [];
  if (production && usesPlaceholderOrigins(config)) {
    warnings.push(
      `exclip.config.ts: origins are still the examples (${PLACEHOLDER_ORIGINS.app}, ${PLACEHOLDER_ORIGINS.wallet}), ` +
        "which nobody can serve: this build works nowhere. Set origins.app and origins.wallet.",
    );
  }
  const fee = config.fees.partnerFee;
  if (fee && !feeReceivers.includes(fee.address.toLowerCase())) {
    warnings.push(
      `exclip.config.ts: the partner fee goes to ${fee.address}, which apps/wallet/fee-receivers.json does not list: ` +
        "the wallet will refuse every swap that carries a fee.",
    );
  }
  return warnings;
}
