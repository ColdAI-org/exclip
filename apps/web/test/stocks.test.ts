/** Tokenised stocks in the app (docs/tokenised-stocks.md). Off, nothing names or offers a stock. On, the Stocks screen
 * shows SODAX's listing with the badge, the disclaimer and where the visitor stands; the eligibility form shows the
 * disclosures and the four statements; and every refusal reads as its own message. src/lib/brand.ts reads __EXCLIP__
 * when it loads, so the build's value is set first and the app's modules imported after it. All data is made up. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, type UseQueryResult } from "@tanstack/react-query";
import { resolveConfig, webBuildConfig } from "@exclip/config";
import {
  STOCK_BADGE, STOCK_REFUSALS, STOCK_STATEMENTS, STOCKS_ATTESTATION_HEADER, stocksDisclaimer, stocksDisclosures, type StockRefusal,
} from "@exclip/config/stocks";
import type { TokensByChain } from "../src/lib/api.ts";
import type { StockEligibility } from "../src/lib/stocks.ts";

Object.assign(globalThis, { __EXCLIP__: webBuildConfig(resolveConfig({ brand: { name: "Acme Swap", operator: "Acme Ltd" } }).config, false) });
const { api, ApiError, API_BASE, SODAX_BASE } = await import("../src/lib/api.ts");
const { setStockPass, stockRefusalOf, stockRefusalText } = await import("../src/lib/stock-gate.ts");
const { stockListings, tradableAssets } = await import("../src/lib/stocks.ts");
const { EligibilityForm, StockAccess, StockDisclaimer } = await import("../src/components/Stocks.tsx");
const { default: StocksPage } = await import("../src/pages/Stocks.tsx");

/** Text as React writes it into markup. */
const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
/** App.tsx, Shell.tsx and TradeSheet.tsx load the wallet code, which only runs under Vite: their rules are read here. */
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
/** SODAX's token list in its own shape: a coin on two networks, two stocks (one on two networks), and a stock listed under
 * a coin's symbol. */
const TOKENS: TokensByChain = {
  hedera: [
    { symbol: "USDC", name: "USD Coin", decimals: 6, address: address(1), chainKey: "hedera" },
    { symbol: "EXMP", name: "Example Holdings", decimals: 8, address: address(2), chainKey: "hedera", isRwa: true },
    { symbol: "FICT", name: "Fictional Motors", decimals: 8, address: address(3), chainKey: "hedera", isRwa: true },
    { symbol: "ETH", name: "Lookalike Equity", decimals: 8, address: address(4), chainKey: "hedera", isRwa: true },
  ],
  sonic: [
    { symbol: "ETH", name: "Ether", decimals: 18, address: address(5), chainKey: "sonic" },
    { symbol: "EXMP", name: "Example Holdings", decimals: 8, address: address(6), chainKey: "sonic", isRwa: true },
    { symbol: "USDC", name: "USD Coin", decimals: 6, address: address(7), chainKey: "sonic" },
  ],
};

const CONFIG = { tradingEnabled: true, sodaxConfigured: true, partnerFeeBps: 0, feeReceiver: null, stocksEnabled: true, stocksTermsVersion: "2026-11" };

const verdict = (code: StockRefusal | null): StockEligibility => ({
  eligible: code === null,
  code,
  message: code ? STOCK_REFUSALS[code] : null,
  country: code === "COUNTRY_UNKNOWN" ? null : "DE",
  termsVersion: "2026-11",
  expiresAt: code === null ? "2026-12-01T12:00:00.000Z" : null,
});

/** Renders with the server's answers already in the query cache, as they'd be once loaded. */
function render(node: ReactNode, eligibility: StockEligibility) {
  const client = new QueryClient();
  client.setQueryData(["exclip", "config"], CONFIG);
  client.setQueryData(["exclip", "sodax", "tokens"], TOKENS);
  client.setQueryData(["exclip", "stocks", "eligibility", null], eligibility);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, node));
}

const answer = (data: StockEligibility | undefined, rest: { isLoading?: boolean; error?: Error | null } = {}) =>
  ({ data, error: null, isLoading: false, refetch: async () => undefined, ...rest }) as unknown as UseQueryResult<StockEligibility, Error>;

const disabledTrade = /<button[^>]*disabled=""[^>]*>Trade<\/button>/g;

test("off: no stock among the trade sheet's assets, no Stocks screen and no link to one", () => {
  const offered = tradableAssets(TOKENS, new Map());
  assert.deepEqual([...offered.keys()].sort(), ["ETH", "USDC"]);
  assert.ok([...offered.values()].flat().every(t => !t.isRwa));
  assert.deepEqual(offered.get("ETH")?.map(t => t.address), [address(5)], "a stock under a coin's symbol never joins the coin");

  const trade = source("../src/components/TradeSheet.tsx");
  assert.match(trade, /stocksOn \? stockListings\(tokens\) : NO_STOCKS/);
  // /stocks is the 404 unless the server says stocks are on, and shows nothing about them while it hasn't said yet.
  const app = source("../src/App.tsx");
  assert.match(app, /section === "stocks" && seg\.length === 1 && stocks !== false/);
  assert.match(app, /if \(stocks === undefined\) return \{ key: "stocks", title: name, description: "", render: \(\) => <div className="x-page" aria-busy="true" \/> \};/);
  assert.match(app, /screenFor\(path, config \? !!config\.stocksEnabled : isError \? false : undefined\)/);
  // Both menus come from one list, which has Stocks only when the server says they're on.
  const shell = source("../src/components/Shell.tsx");
  assert.match(shell, /return NAV\.filter\(n => !\("stocks" in n\) \|\| stocksEnabled === true\);/);
  assert.match(shell, /const nav = navFor\(config\?\.stocksEnabled\);/);
  assert.equal(shell.match(/\{nav\.map\(/g)?.length, 2);
  assert.equal(shell.match(/NAV\.map\(/g), null);
});

test("on: each stock once, under SODAX's symbol and name, on every network SODAX lists it; never under a coin's symbol", () => {
  const stocks = stockListings(TOKENS);
  assert.deepEqual([...stocks.keys()], ["EXMP", "FICT"]);
  assert.deepEqual(stocks.get("EXMP"), { symbol: "EXMP", name: "Example Holdings", tokens: [TOKENS.hedera![1], TOKENS.sonic![1]] });
  const offered = tradableAssets(TOKENS, stocks);
  assert.deepEqual([...offered.keys()].sort(), ["ETH", "EXMP", "FICT", "USDC"]);
  assert.ok(offered.get("ETH")?.every(t => !t.isRwa));
});

test("on: the Stocks screen shows the disclaimer, SODAX's listing with the badge and no logos, and the way to confirm", () => {
  const disclaimer = `<p class="x-banner x-banner-warn x-stock-note" role="note">${html(stocksDisclaimer("Acme Ltd"))}</p>`;
  assert.equal(renderToStaticMarkup(createElement(StockDisclaimer)), disclaimer);

  const page = render(createElement(StocksPage), verdict("SELF_CERT_REQUIRED"));
  assert.ok(page.includes(disclaimer));
  assert.match(page, /<h1 class="x-h1">Tokenised stocks<\/h1>/);
  for (const [name, symbol] of [["Example Holdings", "EXMP"], ["Fictional Motors", "FICT"]]) {
    assert.ok(page.includes(`<span class="x-row-title">${name}</span><span class="x-stock-tag">${STOCK_BADGE}</span>`), name);
    assert.ok(page.includes(`aria-label="Trade ${name} (${symbol})"`), symbol);
  }
  assert.ok(page.includes("on Hedera, Sonic"), "each stock's networks, for screen readers too");
  assert.ok(!page.includes("Lookalike"), "no stock under a coin's symbol");
  assert.ok(!page.includes("<img"), "no company logos");
  assert.ok(page.includes(html(STOCK_REFUSALS.SELF_CERT_REQUIRED)));
  assert.match(page, />Read and confirm<\/button>/);
  assert.equal(page.match(disabledTrade), null, "the trade sheet asks for the confirmation itself");
});

test("a visitor the check refuses outright is told why and can't start a trade", () => {
  for (const code of ["COUNTRY_RESTRICTED", "COUNTRY_UNKNOWN", "STOCKS_DISABLED"] as const) {
    const page = render(createElement(StocksPage), verdict(code));
    assert.ok(page.includes(`<p class="x-banner x-banner-warn" role="status">${html(STOCK_REFUSALS[code])}</p>`), code);
    assert.equal(page.match(disabledTrade)?.length, 2, code);
    assert.ok(!page.includes("Read and confirm"), code);
  }
});

test("where the visitor stands: checking, unreachable, confirmed", () => {
  const onConfirm = () => {};
  const shown = (eligibility: UseQueryResult<StockEligibility, Error>) => renderToStaticMarkup(createElement(StockAccess, { eligibility, onConfirm }));
  assert.equal(shown(answer(undefined, { isLoading: true })), `<p class="x-muted" role="status">Checking whether you can trade tokenised stocks…</p>`);
  const failed = shown(answer(undefined, { error: new Error("The exchange network had a problem. Try again.") }));
  assert.match(failed, /role="alert"><p>The exchange network had a problem\. Try again\.<\/p><button[^>]*>Try again<\/button>/);
  const confirmed = shown(answer(verdict(null)));
  assert.match(confirmed, /<p>You&#x27;ve confirmed the statements for [^<]+, until [^<]*2026\.<\/p>/);
  assert.match(confirmed, />Read them again<\/button>/);
});

test("the eligibility form: the disclosures, then an unticked checkbox for each statement, labelled by it", () => {
  const form = render(createElement(EligibilityForm, { termsVersion: "2026-11", onDone: () => {} }), verdict("SELF_CERT_REQUIRED"));
  for (const text of stocksDisclosures("Acme Ltd")) assert.ok(form.includes(`<p>${html(text)}</p>`), text);
  assert.match(form, /<fieldset class="x-stock-statements"><legend class="x-strong">Confirm each statement<\/legend>/);
  for (const s of STOCK_STATEMENTS) assert.ok(form.includes(`<label class="x-check"><input type="checkbox"/><span>${html(s.text)}</span></label>`), s.id);
  assert.equal(form.match(/<input /g)?.length, STOCK_STATEMENTS.length);
  assert.ok(!form.includes("checked"), "nothing is ticked for the user");
  assert.match(form, /Terms version 2026-11\./);
  assert.match(form, /<button type="submit"[^>]*>Confirm<\/button>/);
});

test("the trade review of a stock leg shows the badge and the disclaimer, and waits for the server's yes", () => {
  const trade = source("../src/components/TradeSheet.tsx");
  assert.match(trade, /\{stockLeg \? <StockDisclaimer \/> : null\}\s*\{cta\}/, "the disclaimer sits just above the confirm button");
  assert.match(trade, /if \(stockBlocked\) cta = <StockAccess eligibility=\{eligibility\} onConfirm=\{\(\) => setStep\("eligibility"\)\} \/>;/);
  assert.match(trade, /const stockBlocked = stockLeg && eligibility\.data\?\.eligible !== true;/);
  assert.match(trade, /const quoteEnabled = [^;]*&& !stockBlocked;/, "no quote, so no preview, until then");
  assert.match(trade, /\{fromStock \? <StockBadge \/> :/);
  assert.match(trade, /\{toStock \? <StockBadge \/> :/);
});

/* ------------------------------------------------------------------ requests and refusals */

const sent: { url: string; headers: Record<string, string> }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
globalThis.fetch = (async (url: string, init: RequestInit) => {
  sent.push({ url, headers: init.headers as Record<string, string> });
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

test("the self-certification goes to SODAX's routes and the stock check's own, nowhere else, and not once expired", async () => {
  sent.length = 0;
  reply = { status: 200, body: {} };
  setStockPass({ attestation: "payload.signature", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  for (const path of [`${SODAX_BASE}/swaps/quote`, `${API_BASE}/stocks/eligibility`, `${API_BASE}/config`, `${API_BASE}/markets`]) await api(path);
  assert.deepEqual(sent.map(s => s.headers[STOCKS_ATTESTATION_HEADER] ?? null), ["payload.signature", "payload.signature", null, null]);

  sent.length = 0;
  setStockPass({ attestation: "payload.signature", expiresAt: new Date(Date.now() - 1).toISOString() });
  await api(`${SODAX_BASE}/swaps/quote`);
  assert.equal(sent[0]?.headers[STOCKS_ATTESTATION_HEADER], undefined);
  setStockPass(null);
});

test("each refusal reads as its own message, from this server's API or inside an SDK's error; nothing else does", async () => {
  for (const code of Object.keys(STOCK_REFUSALS) as StockRefusal[]) {
    reply = { status: 451, body: { error: { code, message: "the server's own words" } } };
    await assert.rejects(api(`${SODAX_BASE}/swaps/quote`, { body: {} }), (e: unknown) => e instanceof ApiError && e.code === code && e.message === STOCK_REFUSALS[code]);
    assert.equal(stockRefusalText(new ApiError(451, code, "")), STOCK_REFUSALS[code]);
    // An SDK's HTTP error keeps the response in its context, and may itself be the cause of another error.
    assert.equal(stockRefusalText({ message: "failed", cause: { context: { status: 451, body: { error: { code } } } } }), STOCK_REFUSALS[code]);
  }
  assert.equal(stockRefusalOf(new ApiError(403, "COUNTRY_RESTRICTED", "")), null, "only a 451 is the stock check's");
  assert.equal(stockRefusalOf({ context: { status: 400, body: { error: { code: "COUNTRY_RESTRICTED" } } } }), null);
  assert.equal(stockRefusalOf(new ApiError(451, "SOMETHING_ELSE", "")), null);
  assert.equal(stockRefusalOf(new Error("boom")), null);
});
