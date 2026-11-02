/** The checks vite.config.ts runs before it bakes anything into the wallet bundle, in a module of their own so the
 * tests can run them without Vite. What the popup trusts is decided here, at build time: the page origin it answers,
 * its own origin, and where an intent's partner fee may go, the plain receivers and the fee splits
 * (docs/embedded-wallet.md, docs/fee-split.md). */
import { fileURLToPath } from "node:url";
import { PLACEHOLDER_ORIGINS, parseOrigin, sharesRpId, usesPlaceholderOrigins, type ExclipConfig } from "@exclip/config";
import { parseFeeAllowList, sameAddress, type FeeAllowList } from "@exclip/config/fee-split";
import type { FeeSplitTerms } from "./src/config.ts";

/** The fee allow-list: `fee-receivers.json`, committed with the code rather than taken from the environment, so
 * changing it takes a reviewed commit. Its receivers must contain exclip.config.ts fees.receiver when a partner fee is
 * set, and its splits the config's fees.split when a split is set; empty → the wallet refuses any fee. The config
 * check reads the same file for the factories a split may use. */
export const FEE_RECEIVERS_FILE = fileURLToPath(new URL("./fee-receivers.json", import.meta.url));

/** The plain-fee receivers an intent may name, in lower case. The whole file is checked (parseFeeAllowList), so the
 * build stops on a factory or split entry that is malformed, or that its factory would refuse. */
export function parseFeeReceivers(json: string): string[] {
  return [...parseFeeAllowList(json).receivers];
}

/** What the wallet window needs of each split the allow-list lists: its factory's values, the platform's name, and
 * the operator's address and rate. Not the splitter's address: the policy works it out from these itself. */
export function feeSplitTerms(list: FeeAllowList): FeeSplitTerms[] {
  return list.splits.map((split) => {
    const factory = list.factories.find((f) => sameAddress(f.address, split.factory));
    if (!factory) throw new Error(`fee-receivers.json: factory ${split.factory} is not in "factories"`);
    const { address, platform, platformName, platformRate, maxTotalRate } = factory;
    return { factory: address, platform, platformName, platformRate, maxTotalRate, operator: split.operator, operatorRate: split.operatorRate };
  });
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

/** Settings a build accepts but should point out. `allowList`: fee-receivers.json, parsed. `production`: vite build
 * (development uses DEV_ORIGINS, so the placeholder origins don't matter there). */
export function buildWarnings(config: ExclipConfig, allowList: FeeAllowList, production: boolean): string[] {
  const warnings: string[] = [];
  if (production && usesPlaceholderOrigins(config)) {
    warnings.push(
      `exclip.config.ts: origins are still the examples (${PLACEHOLDER_ORIGINS.app}, ${PLACEHOLDER_ORIGINS.wallet}), ` +
        "which nobody can serve: this build works nowhere. Set origins.app and origins.wallet.",
    );
  }
  const fee = config.fees.partnerFee;
  if (fee && !allowList.receivers.includes(fee.address.toLowerCase())) {
    warnings.push(
      `exclip.config.ts: the partner fee goes to ${fee.address}, which apps/wallet/fee-receivers.json does not list: ` +
        "the wallet will refuse every swap that carries a fee.",
    );
  }
  const split = config.fees.split;
  if (split && !allowList.splits.some((s) => sameAddress(s.splitter, split.splitter))) {
    warnings.push(
      `exclip.config.ts: the fee split goes to the splitter ${split.splitter} (operator ${split.operator}, operatorRate ${split.operatorRate}), ` +
        `whose split apps/wallet/fee-receivers.json does not list under "splits": the wallet will refuse every swap that carries the split's fee.`,
    );
  }
  // On a swap with a tokenised stock, the server pins the operator's own plain fee instead, which goes to a receiver.
  if (config.stocks.enabled && split?.stockFee && !allowList.receivers.includes(split.stockFee.address.toLowerCase())) {
    warnings.push(
      `exclip.config.ts: the fee on swaps with a tokenised stock goes to ${split.stockFee.address}, which apps/wallet/fee-receivers.json ` +
        `does not list under "receivers": the wallet will refuse every such swap that carries a fee.`,
    );
  }
  return warnings;
}
