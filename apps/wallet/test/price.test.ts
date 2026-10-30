/** Price sanity (src/sodax/price.ts). The SODAX quote is never fetched for real: every test injects a fetch. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WALLET_CSP, walletSecurityHeaders } from "@exclip/config";
import {
  PRICE_BANDS, QUOTE_TIMEOUT_MS, SODAX_QUOTE_URL, USD_STABLES, fetchSodaxQuote, priceVerdict, stableMinimumTooLow, type QuoteFetch, type SwapFacts,
} from "../src/sodax/price.ts";
import { findToken } from "../src/sodax/policy.ts";
import { SONIC_RPC_URL } from "../src/sodax/hub.ts";
import { SODAX_TOKENS } from "../src/sodax/tokens.ts";

const token = (chainKey: string, symbol: string) => findToken(chainKey, SODAX_TOKENS[chainKey]!.find(([, s]) => s === symbol)![0])!;
const USDC = token("0x2105.base", "USDC"); // 6 decimals
const USDT = token("ethereum", "USDT"); // 6
const BNUSD = token("0xa4b1.arbitrum", "bnUSD"); // 18
const WETH = token("sonic", "WETH"); // 18
const CBBTC = token("0x2105.base", "cbBTC"); // 8
const SODA = token("0x2105.base", "SODA"); // no band
const facts = (input = USDC, output = WETH, gross = 1_000_000_000n, minOut = 1n, net = gross): SwapFacts => ({ input, output, gross, net, minOut });

test("stable floor: 97% of the gross input, exact across decimals, only between plain USD stables", () => {
  assert.equal(stableMinimumTooLow(facts(USDC, USDT, 1_000_000n, 970_000n)), false);
  assert.equal(stableMinimumTooLow(facts(USDC, USDT, 1_000_000n, 969_999n)), true);
  assert.equal(stableMinimumTooLow(facts(USDC, BNUSD, 1_000_000n, 97n * 10n ** 16n)), false);
  assert.equal(stableMinimumTooLow(facts(USDC, BNUSD, 1_000_000n, 97n * 10n ** 16n - 1n)), true);
  assert.equal(stableMinimumTooLow(facts(BNUSD, USDC, 10n ** 18n, 969_999n)), true);
  assert.equal(stableMinimumTooLow(facts(USDC, WETH, 1_000_000n, 1n)), false, "not a stable pair");
  // Yield-bearing and euro stables are not "1 token = 1 dollar".
  for (const s of ["sUSDS", "sUSDe", "sUSDat", "EURC"]) assert.equal(USD_STABLES.has(s), false, s);
  // Every listed stable exists in the token table (no typo silently disabling the floor).
  const symbols = new Set(Object.values(SODAX_TOKENS).flat().map(([, s]) => s));
  for (const s of USD_STABLES) assert.ok(symbols.has(s), s);
  for (const s of Object.keys(PRICE_BANDS)) assert.ok(symbols.has(s), s);
});

test("quote reference: more than 5% below it is 'low', with the shortfall; the quote can't excuse anything else", () => {
  const quote = 400_000_000_000_000_000n; // 0.4 WETH for 1,000 USDC
  assert.deepEqual(priceVerdict(facts(USDC, WETH, 1_000_000_000n, (quote * 95n) / 100n), quote), { level: "ok", source: "quote" });
  const low = priceVerdict(facts(USDC, WETH, 1_000_000_000n, (quote * 80n) / 100n), quote);
  assert.deepEqual(low, { level: "low", source: "quote", reference: quote, belowPct: 20 });
  assert.equal((priceVerdict(facts(USDC, WETH, 1_000_000_000n, 1n), quote) as { belowPct: number }).belowPct, 100);
  // Stable pairs are the policy's (refused below 97%), whatever a quote says.
  assert.deepEqual(priceVerdict(facts(USDC, USDT, 1_000_000n, 990_000n), 1n), { level: "ok", source: "stable" });
  // A zero quote is no quote.
  assert.equal(priceVerdict(facts(USDC, SODA, 1_000_000n, 1n), 0n).level, "unchecked");
});

test("band table fallback (no quote): catches gross mispricing only, never a fair price", () => {
  // 1,000 USDC → 0.000…1 WETH: low even at WETH's $50,000 ceiling.
  assert.deepEqual(priceVerdict(facts(USDC, WETH, 1_000_000_000n, 1n), null), { level: "low", source: "table" });
  // 1,000 USDC → 0.25 WETH (ETH at $4,000): fine.
  assert.deepEqual(priceVerdict(facts(USDC, WETH, 1_000_000_000n, 25n * 10n ** 16n), null), { level: "ok", source: "table" });
  // The edge: 1,000 USDC at its $0.95 floor is $950, so "low" means the minimum is worth under $902.50 even at
  // WETH's $50,000 ceiling, i.e. under 0.01805 WETH.
  assert.equal(priceVerdict(facts(USDC, WETH, 1_000_000_000n, 18_050n * 10n ** 12n), null).level, "ok");
  assert.equal(priceVerdict(facts(USDC, WETH, 1_000_000_000n, 18_050n * 10n ** 12n - 1n), null).level, "low");
  // 1 WETH → 1 USDC: worth at least $300 in, at most $1.05 out.
  assert.equal(priceVerdict(facts(WETH, USDC, 10n ** 18n, 1_000_000n), null).level, "low");
  // 1 cbBTC (8 decimals) → 60,000 USDC: fine; → 100 USDC: low.
  assert.equal(priceVerdict(facts(CBBTC, USDC, 10n ** 8n, 60_000_000_000n), null).level, "ok");
  assert.equal(priceVerdict(facts(CBBTC, USDC, 10n ** 8n, 100_000_000n), null).level, "low");
  // A token without a band can't be checked offline.
  assert.deepEqual(priceVerdict(facts(USDC, SODA, 1_000_000n, 1n), null), { level: "unchecked" });
  // The fee comes off before the swap: the band check uses the net input.
  assert.equal(priceVerdict(facts(USDC, WETH, 1_000_000_000n, 18n * 10n ** 15n), null).level, "low");
  assert.equal(priceVerdict(facts(USDC, WETH, 1_000_000_000n, 18n * 10n ** 15n, 990_000_000n), null).level, "ok");
});

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: QuoteFetch; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, fetch: async (url, init) => { const call = { url, init }; calls.push(call); return respond(call); } };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("fetchSodaxQuote: exact URL and body (hub assets, net amount, no address, no credentials), strict parsing", async () => {
  const f = facts(USDC, WETH, 1_000_000_000n, 1n, 990_000_000n);
  const ok = fakeFetch(() => json({ quoted_amount: "400000000000000000" }));
  assert.equal(await fetchSodaxQuote(ok.fetch, f), 400_000_000_000_000_000n);
  const [{ url, init }] = ok.calls as [Call];
  assert.equal(url, SODAX_QUOTE_URL);
  assert.equal(url, "https://api.sodax.com/v1/intent/quote");
  assert.equal(init.method, "POST");
  assert.equal(init.credentials, "omit");
  assert.equal(init.redirect, "error");
  assert.equal(init.referrerPolicy, "no-referrer");
  assert.deepEqual(JSON.parse(init.body as string), { token_src: USDC.hubAsset, token_dst: WETH.hubAsset, amount: "990000000", quote_type: "exact_input" });
  assert.deepEqual(init.headers, { "content-type": "application/json" }, "no API key, nothing identifying");

  assert.equal(await fetchSodaxQuote(fakeFetch(() => json({ quoted_amount: 12345 })).fetch, f), 12345n);
  for (const bad of [
    json({ quoted_amount: "0" }), json({ quoted_amount: "-1" }), json({ quoted_amount: "1e18" }), json({ quoted_amount: "01" }),
    json({ quoted_amount: 2 ** 60 }), json({ quoted_amount: 1.5 }), json({}), json(null), json({ quoted_amount: "1" }, 500),
    new Response("not json"), new Response("x".repeat(5000)),
  ]) {
    assert.equal(await fetchSodaxQuote(fakeFetch(() => bad).fetch, f), null);
  }
  assert.equal(await fetchSodaxQuote(fakeFetch(() => { throw new TypeError("Failed to fetch (CORS or offline)"); }).fetch, f), null);
});

test("fetchSodaxQuote: a slow answer is abandoned after the timeout", async () => {
  assert.equal(QUOTE_TIMEOUT_MS, 5_000);
  let aborted = false;
  const hang = fakeFetch(({ init }) => new Promise<Response>((_, reject) => {
    init.signal!.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); });
  }));
  assert.equal(await fetchSodaxQuote(hang.fetch, facts(), 20), null);
  assert.equal(aborted, true);
});

test("the popup's CSP allows exactly two cross-origin URLs (the quote endpoint, Sonic's RPC), wherever the wallet is served", () => {
  // One definition (@exclip/config) for Vite preview and apps/server, over http and https alike.
  for (const secure of [false, true]) assert.equal(walletSecurityHeaders(secure)["content-security-policy"], WALLET_CSP);
  const connect = WALLET_CSP.split("; ").find((d) => d.startsWith("connect-src "));
  assert.equal(connect, `connect-src 'self' ${SODAX_QUOTE_URL} ${SONIC_RPC_URL}`);
  assert.doesNotMatch(WALLET_CSP, /https:(?!\/\/api\.sodax\.com\/v1\/intent\/quote |\/\/rpc\.soniclabs\.com;)/);
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /quote: \(facts\) => fetchSodaxQuote\(/);
  assert.match(main, /hubWallet: \(chainKey, evm\) => fetchHubWallet\(/);
});
