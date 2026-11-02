/** Price sanity for swaps. The minimum a swap pays out is the one economic field ExClip fully controls, so the popup
 * checks it against references of its own:
 *  1. USD stablecoin ↔ USD stablecoin: refused when the minimum is below STABLE_FLOOR_BPS of what goes in (policy.ts).
 *  2. Any other pair: a SODAX solver quote the popup fetches itself (SODAX_QUOTE_URL, the only cross-origin URL the
 *     popup's CSP allows besides the Sonic RPC). A minimum more than (100% − REFERENCE_FLOOR_BPS) below that quote
 *     shows a red full-screen warning that needs an extra tap.
 *  3. No quote (offline, blocked, error, timeout): a coarse build-time USD band table (PRICE_BANDS). It catches only
 *     gross mispricing (a minimum worth under 95% of the input even at the most generous prices in the bands).
 *  4. Neither: a plain warning that the price couldn't be checked.
 * The quote can only add a warning, never remove a refusal, so a wrong or missing answer leaves the user no worse off
 * than without it. Pure except fetchSodaxQuote, whose fetch is injected. */
import type { Token } from "./policy.ts";

/** Stable↔stable: the minimum must be at least 97% of the gross input (fee ≤ 1% + slippage ≤ 1% + solver 0.1%). A fee
 * split may reach its factory's cap, 1.875%, which leaves almost no room at 1% slippage: an open decision
 * (docs/fee-split.md, "Decisions for the owner"). */
export const STABLE_FLOOR_BPS = 9_700n;
/** Other pairs: warn when the minimum is more than 5% below the reference. */
export const REFERENCE_FLOOR_BPS = 9_500n;

/** Plain USD stablecoins (1 token ≈ 1 US dollar). Yield-bearing wrappers (sUSDS, sUSDe, sUSDat) are worth more than a
 * dollar and are deliberately left out, as are euro stables. A symbol here comes from the build-time token table
 * (tokens.ts), keyed by address, so a request can't relabel a token. */
export const USD_STABLES: ReadonlySet<string> = new Set([
  "USDC", "USDT", "USDT0", "DAI", "USDS", "PYUSD", "USD1", "USDG", "FDUSD", "bnUSD",
]);

/** Coarse USD bands in cents, [floor, ceiling], for the offline fallback only. Wide on purpose (set 2026-10): they must
 * hold for years without updates, so they never warn about a fair price and only catch a minimum that is off by
 * orders of magnitude. Wrapped and liquid-staked forms are within these bands of their base asset. */
const ETH_BAND = [30_000n, 5_000_000n] as const; // $300 … $50,000
const BTC_BAND = [500_000n, 100_000_000n] as const; // $5,000 … $1,000,000
const USD_BAND = [95n, 105n] as const;
export const PRICE_BANDS: Readonly<Record<string, readonly [bigint, bigint]>> = Object.freeze({
  ...Object.fromEntries([...USD_STABLES].map((s) => [s, USD_BAND])),
  ...Object.fromEntries(["ETH", "WETH", "WETH.e", "ETHB", "UETH", "sodaETH", "weETH", "wstETH", "rETH", "cbETH"].map((s) => [s, ETH_BAND])),
  ...Object.fromEntries(["BTC", "WBTC", "cbBTC", "tBTC", "BTCB", "BTC.b", "UBTC", "sodaWBTC", "BTC.LL"].map((s) => [s, BTC_BAND])),
});

/** What the price check needs from a swap the policy already accepted (amounts in each token's smallest unit). */
export type SwapFacts = {
  input: Token;
  output: Token;
  /** What the user pays, fee included. */
  gross: bigint;
  /** What the intent swaps (gross minus the partner fee). */
  net: bigint;
  minOut: bigint;
};

export type PriceVerdict =
  | { level: "ok"; source: "stable" | "quote" | "table" }
  | { level: "low"; source: "quote"; reference: bigint; belowPct: number }
  | { level: "low"; source: "table" }
  | { level: "unchecked" };

const WAD_DECIMALS = 36;
/** Amount in units of 10^-36 token, so tokens with different decimals compare exactly. */
const wad = (raw: bigint, decimals: number): bigint => raw * 10n ** BigInt(WAD_DECIMALS - decimals);

export const isUsdStable = (t: Pick<Token, "symbol">): boolean => USD_STABLES.has(t.symbol);

/** True when a USD-stable ↔ USD-stable swap's minimum is below STABLE_FLOOR_BPS of the gross input. */
export function stableMinimumTooLow(f: Pick<SwapFacts, "input" | "output" | "gross" | "minOut">): boolean {
  if (!isUsdStable(f.input) || !isUsdStable(f.output)) return false;
  return wad(f.minOut, f.output.decimals) * 10_000n < wad(f.gross, f.input.decimals) * STABLE_FLOOR_BPS;
}

/** The verdict from a quote (in output units, for `net` in) or, without one, from the band table. */
export function priceVerdict(f: SwapFacts, quote: bigint | null): PriceVerdict {
  if (isUsdStable(f.input) && isUsdStable(f.output)) return { level: "ok", source: "stable" }; // the policy refused below the floor
  if (quote !== null && quote > 0n) {
    if (f.minOut * 10_000n >= quote * REFERENCE_FLOOR_BPS) return { level: "ok", source: "quote" };
    const belowPct = Number(((quote - f.minOut) * 1000n + quote / 2n) / quote) / 10; // rounded to 0.1%
    return { level: "low", source: "quote", reference: quote, belowPct };
  }
  const inBand = Object.hasOwn(PRICE_BANDS, f.input.symbol) ? PRICE_BANDS[f.input.symbol]! : null;
  const outBand = Object.hasOwn(PRICE_BANDS, f.output.symbol) ? PRICE_BANDS[f.output.symbol]! : null;
  if (!inBand || !outBand) return { level: "unchecked" };
  // Most generous reading: the input at its floor, the output at its ceiling. Below 95% even then → certainly low.
  const inValue = wad(f.net, f.input.decimals) * inBand[0];
  const outValue = wad(f.minOut, f.output.decimals) * outBand[1];
  return outValue * 10_000n < inValue * REFERENCE_FLOOR_BPS ? { level: "low", source: "table" } : { level: "ok", source: "table" };
}

/* ------------------------------------------------------------------ the popup's own quote */

/** SODAX's solver quote endpoint, as the SDK calls it: SolverApiService.getQuote POSTs `${solverApiEndpoint}/quote`
 * with hub-asset addresses (node_modules/@sodax/sdk/dist/index.mjs:30041-30075, solverApiEndpoint at :5275). Pinned
 * in the popup's CSP connect-src as this exact URL. No API key: the SDK sends one only when configured. */
export const SODAX_QUOTE_URL = "https://api.sodax.com/v1/intent/quote";
export const QUOTE_TIMEOUT_MS = 5_000;
const MAX_QUOTE_BYTES = 4_096;

export type QuoteFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The quoted output for `net` of the input, or null on any problem. Sends no address and no credentials: only the
 * token pair (hub assets) and the amount. */
export async function fetchSodaxQuote(fetchFn: QuoteFetch, f: SwapFacts, timeoutMs = QUOTE_TIMEOUT_MS): Promise<bigint | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(SODAX_QUOTE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token_src: f.input.hubAsset, token_dst: f.output.hubAsset, amount: f.net.toString(), quote_type: "exact_input" }),
      signal: ctrl.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_QUOTE_BYTES) return null;
    const q = (JSON.parse(text) as { quoted_amount?: unknown } | null)?.quoted_amount;
    if (typeof q === "number") return Number.isSafeInteger(q) && q > 0 ? BigInt(q) : null;
    return typeof q === "string" && /^[1-9][0-9]{0,77}$/.test(q) ? BigInt(q) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
