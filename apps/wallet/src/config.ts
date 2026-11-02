/** Build-time configuration (vite.config.ts `define`, declared in defines.d.ts) and the wallet origin's identity.
 * The values come from exclip.config.ts and fee-receivers.json when the wallet is built.
 * Nothing here is read from the URL, the opener, or a message: an attacker who controls those controls nothing below. */

// `typeof` guards: under tsx (tests) nothing is defined and every list is empty, which refuses everything.
/** Exact origins allowed to open the popup and exchange messages with it. */
export const PARENT_ORIGINS: readonly string[] = Object.freeze(typeof __EXCLIP_PARENT_ORIGINS__ === "undefined" ? [] : [...__EXCLIP_PARENT_ORIGINS__]);
/** Partner-fee receivers an intent may name (lower-case). Empty: an intent must carry no partner fee. */
export const FEE_RECEIVERS: readonly string[] = Object.freeze(
  typeof __EXCLIP_FEE_RECEIVERS__ === "undefined" ? [] : __EXCLIP_FEE_RECEIVERS__.map((a) => a.toLowerCase()),
);
/** A fee split fee-receivers.json lists, with its factory's values (build-guards.ts feeSplitTerms). No splitter
 * address: the policy works it out from these itself, and names the platform by `platformName`. */
export type FeeSplitTerms = {
  factory: string; platform: string; platformName: string; platformRate: number; maxTotalRate: number; operator: string; operatorRate: number;
};
/** Fee splits whose splitter an intent's fee may go to. Empty: no fee to a splitter is signed. */
export const FEE_SPLITS: readonly FeeSplitTerms[] = Object.freeze(
  typeof __EXCLIP_FEE_SPLITS__ === "undefined" ? [] : __EXCLIP_FEE_SPLITS__.map((s) => Object.freeze({ ...s })),
);
/** A plain fee given as a rate (exclip.config.ts fees.rate, per 100,000 of the amount paid) and its fee on swaps with
 * a tokenised stock on either side (fees.stockFeeBps, in basis points; 0 for none). */
export type FeeRateTerms = { rate: number; stockFeeBps: number };
/** This build's fee rate: a fee to a listed receiver must be exactly the rate of the amount paid, rounded down, or on a
 * swap with a tokenised stock exactly the fee on stock swaps. Null: a plain fee is held to the cap only. */
export const FEE_RATE: FeeRateTerms | null =
  typeof __EXCLIP_FEE_RATE__ === "undefined" || __EXCLIP_FEE_RATE__ === null ? null : Object.freeze({ ...__EXCLIP_FEE_RATE__ });
/** Dev build (vite serve): allows http://localhost. */
export const DEV: boolean = typeof __EXCLIP_DEV__ === "undefined" ? false : __EXCLIP_DEV__;
/** The origin this build is configured to be served from (exclip.config.ts origins.wallet). Only for what the screens
 * show: the passkey is always bound to the page's real host (rpIdFor(location.origin)). Empty under tsx. */
export const WALLET_ORIGIN: string = typeof __EXCLIP_WALLET_ORIGIN__ === "undefined" ? "" : __EXCLIP_WALLET_ORIGIN__;
/** Product name in passkey labels, the window title and the copy (exclip.config.ts brand.name). */
export const BRAND_NAME: string = typeof __EXCLIP_BRAND_NAME__ === "undefined" || !__EXCLIP_BRAND_NAME__ ? "ExClip" : __EXCLIP_BRAND_NAME__;
/** Who runs this deployment (exclip.config.ts brand.operator), or "" when not set. */
export const OPERATOR: string = typeof __EXCLIP_OPERATOR__ === "undefined" ? "" : __EXCLIP_OPERATOR__;
/** Who the copy names when it says what the service can and can't see: the operator, else the product. */
export const OPERATOR_NAME: string = OPERATOR || BRAND_NAME;
/** Who the review names as getting a plain fee (exclip.config.ts fees.receiverName, which defaults to brand.name; with
 * a fee split, the operator). OPERATOR_NAME when not defined. */
export const FEE_RECEIVER_NAME: string =
  typeof __EXCLIP_FEE_RECEIVER_NAME__ === "undefined" || !__EXCLIP_FEE_RECEIVER_NAME__ ? OPERATOR_NAME : __EXCLIP_FEE_RECEIVER_NAME__;
/** How many US dollars a wallet that isn't backed up yet may hold before the popup stops showing its deposit address
 * (exclip.config.ts wallet.unbackedLimitUsd, a whole number resolveConfig has checked; nothing stops a transfer from
 * elsewhere). Where the popup applies it: wallet.ts UNBACKED_LIMIT_USD. 100 when not defined. */
export const UNBACKED_LIMIT_USD: number =
  typeof __EXCLIP_UNBACKED_LIMIT_USD__ === "number" && Number.isSafeInteger(__EXCLIP_UNBACKED_LIMIT_USD__) && __EXCLIP_UNBACKED_LIMIT_USD__ >= 0
    ? __EXCLIP_UNBACKED_LIMIT_USD__
    : 100;
/** Whether this build signs swaps and sends of tokenised stocks (exclip.config.ts stocks.enabled): only then does the
 * policy read sodax/stock-tokens.ts. Off when not defined. */
export const STOCKS: boolean = typeof __EXCLIP_STOCKS__ === "undefined" ? false : __EXCLIP_STOCKS__ === true;

/** The WebAuthn rpId for this page: always its own host, never a parent domain (docs/embedded-wallet.md).
 * With a parent domain as rpId (example.com for wallet.example.com), every subdomain of it could run the passkey and
 * read the same PRF output. */
export function rpIdFor(origin: string, dev = DEV): string {
  const url = new URL(origin);
  if (url.origin !== origin) throw new Error("not an origin");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(dev && local && url.protocol === "http:")) throw new Error("the wallet must be served over https");
  return url.hostname;
}

/** Throws unless `rpId` is exactly this origin's host. Every WebAuthn call goes through it. */
export function assertRpId(rpId: string, origin: string, dev = DEV): void {
  if (rpId !== rpIdFor(origin, dev)) throw new Error("passkey must be bound to the wallet host");
}
