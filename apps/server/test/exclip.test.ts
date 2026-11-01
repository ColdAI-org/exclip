/** /api/exclip: SODAX key proxy (allow-list, key handling, fee pinning, caches, 429 backoff, the trading switch and
 * the tokenised-stock checks), the stock eligibility routes and the markets empty state. Upstream fetch is stubbed;
 * the key and the secrets are fake. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  ConfigError, PARTNER_FEE_MAX_BPS, STOCK_REFUSALS, STOCK_STATEMENTS, STOCKS_ATTESTATION_HEADER, STOCKS_BASELINE_COUNTRIES,
  resolveConfig, type Env, type ExclipConfigInput,
} from "@exclip/config";
import { createExclipRouter } from "../src/routes/exclip.ts";
import { serverConfig } from "../src/services/config.ts";
import { createSodaxProxy, matchSodaxRoute } from "../src/services/sodaxProxy.ts";
import { createStockGate } from "../src/services/stocks.ts";
import { createMemoryWalletStore } from "../src/services/walletBackup.ts";
import { createMemoryKv } from "../src/kv.ts";
import { publicRateLimit } from "../src/rateLimit.ts";

const FAKE_KEY = "test-sodax-key-not-real-0123456789";
const RECEIVER = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x2222222222222222222222222222222222222222";
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8"));
type Quote = { tokenSrc: string; tokenSrcChainKey: string; tokenDst: string; tokenDstChainKey: string; amount: string; quoteType: string };
const TOKENS = fixture("swaps_tokens_hedera_subset.json");
const QUOTE_HBAR_BASE = fixture("quote_2_req.json") as Quote;
const QUOTE_USDC_NVDA = fixture("quote_3_req.json") as Quote;
const HEDERA_USDC = "0x000000000000000000000000000000000006f89a";
const HEDERA_AAPL = "0x0000000000000000000000000000000000a567e1";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | (() => Promise<never>);
type ErrorBody = { error: { code: string; message: string } };
const json = async <T>(res: Response) => (await res.json()) as T;

/** Fee 30 bps to RECEIVER, trading off, passkey wallet off: every switch that matters set by hand. */
const BASE: ExclipConfigInput = { fees: { partnerFeeBps: 30, receiver: RECEIVER }, features: { trading: false, embeddedWallet: false } };
const pass: express.RequestHandler = (_req, _res, next) => next();

async function serve(options: { input?: ExclipConfigInput; env?: Env; route?: (url: string, call: Call) => Reply | undefined;
  proxyLimit?: express.RequestHandler; stocksLimit?: express.RequestHandler; clock?: { t: number } } = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const clock = options.clock ?? { t: Date.UTC(2026, 9, 16, 12) };
  const fetchMock = async (url: string, init?: RequestInit) => {
    const call: Call = { url, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const reply = options.route?.(url, call) ?? (url.includes("/swaps/tokens") ? { body: TOKENS }
      : url.includes("/swaps/quote") ? { body: { quotedAmount: "42943543" } }
      : url.includes("/swaps/deadline") ? { body: fixture("swaps_deadline.json") } : { body: {} });
    if (typeof reply === "function") return reply();
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json", ...reply.headers } });
  };
  const { config, secrets } = resolveConfig({ ...BASE, ...options.input }, { SODAX_API_KEY: FAKE_KEY, ...options.env });
  const app = express();
  app.set("trust proxy", true);
  app.use("/api/exclip", createExclipRouter({
    config: serverConfig(config, secrets, false), kv: createMemoryKv(), walletStore: createMemoryWalletStore(),
    fetch: fetchMock, sleep: async (ms) => { sleeps.push(ms); }, now: () => clock.t, readLimit: pass, proxyLimit: options.proxyLimit ?? pass,
    stocksLimit: options.stocksLimit ?? pass,
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/exclip`;
  const get = (p: string, headers: Record<string, string> = {}) => fetch(base + p, { headers });
  const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  return { get, post, calls, sleeps, clock, close: () => new Promise((r) => server.close(r)) };
}

// ---- allow-list -------------------------------------------------------------------------------------------

test("the allow-list admits the documented SODAX swap paths and nothing else (no money-market routes in v1)", () => {
  for (const [m, p] of [["GET", "swaps/tokens"], ["GET", "swaps/tokens/0x2105.base"], ["POST", "swaps/quote"], ["GET", "swaps/deadline"],
    ["GET", "swaps/fees/partner"], ["POST", "swaps/intents"], ["POST", "swaps/intents/status"], ["POST", "swaps/intents/submit"],
    ["POST", "swaps/intents/cancel"], ["POST", "swaps/limit-orders"], ["GET", "bridge/tokens"], ["GET", "be/config/all"]] as const) {
    assert.ok(matchSodaxRoute(m, p), `${m} ${p} allowed`);
  }
  for (const [m, p] of [["GET", "swaps/quote"], ["POST", "swaps/tokens"], ["GET", "admin/keys"], ["GET", "swaps/tokens/../admin"],
    ["GET", "swaps//tokens"], ["GET", "swaps/tokens/a%2fb"], ["DELETE", "swaps/intents"], ["GET", "be/config/all/../../x"],
    ["GET", "partners/me"], ["PUT", "swaps/quote"], ["GET", "https://evil.example/swaps/tokens"],
    ["GET", "be/config/money-market/tokens"], ["GET", "be/config/money-market/sonic/tokens"], ["GET", "be/moneymarket/asset/all"],
    ["POST", "moneymarket/supply"]] as const) {
    assert.equal(matchSodaxRoute(m, p), null, `${m} ${p} refused`);
  }
});

test("a path outside the allow-list is refused with 404 and never reaches SODAX", async (t) => {
  const s = await serve(); t.after(s.close);
  for (const p of ["/sodax/admin/keys", "/sodax/swaps/tokens/..%2f..%2fadmin", "/sodax/v2/be/config/all", "/sodax/partners/fees",
    "/sodax/be/moneymarket/asset/all"]) {
    const res = await s.get(p);
    assert.equal(res.status, 404, p);
    assert.equal((await json<ErrorBody>(res)).error.code, "NOT_ALLOWED");
  }
  const wrongMethod = await s.post("/sodax/swaps/tokens", {});
  assert.equal(wrongMethod.status, 404);
  assert.equal(s.calls.length, 0);
});

test("only the route's own query parameters are forwarded", async (t) => {
  const s = await serve(); t.after(s.close);
  await s.get("/sodax/swaps/deadline?offsetSeconds=120&apiKey=x&callback=evil");
  assert.equal(s.calls[0]!.url, "https://api.sodax.com/v1/swaps/deadline?offsetSeconds=120");
});

// ---- the key ----------------------------------------------------------------------------------------------

test("the server key is sent upstream, a client key is ignored, and the key is never echoed back", async (t) => {
  const s = await serve({ route: (url) => url.includes("/swaps/fees/partner")
    ? { status: 400, body: { message: `bad key ${FAKE_KEY} for request`, error: "Bad Request", statusCode: 400 } } : undefined });
  t.after(s.close);
  const res = await s.get("/sodax/swaps/tokens", { "x-api-key": "client-supplied" });
  assert.equal(res.status, 200);
  assert.equal(s.calls[0]!.headers["x-api-key"], FAKE_KEY);
  const text = await res.text();
  assert.ok(!text.includes(FAKE_KEY));
  for (const [k, v] of res.headers) assert.ok(!v.includes(FAKE_KEY), `header ${k}`);

  const echoed = await s.get("/sodax/swaps/fees/partner");
  assert.equal(echoed.status, 400);
  const body = await echoed.text();
  assert.ok(!body.includes(FAKE_KEY), "upstream echo is redacted");
  assert.match(body, /\[redacted\]/);
});

test("the real 400 for a partner-fee request without amount passes through unchanged", async (t) => {
  const s = await serve({ route: (url) => url.includes("/swaps/fees/partner") ? { status: 400, body: fixture("swaps_fees_partner_400.json") } : undefined });
  t.after(s.close);
  const res = await s.get("/sodax/swaps/fees/partner");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), fixture("swaps_fees_partner_400.json"));
});

test("without a SODAX key the proxy answers 503 with a clear message and calls nobody", async (t) => {
  const s = await serve({ env: { SODAX_API_KEY: undefined } }); t.after(s.close);
  const res = await s.post("/sodax/swaps/quote", QUOTE_HBAR_BASE);
  assert.equal(res.status, 503);
  const body = await json<ErrorBody>(res);
  assert.equal(body.error.code, "SODAX_NOT_CONFIGURED");
  assert.match(body.error.message, /no SODAX API key is set/);
  assert.equal(s.calls.length, 0);
  const config = await json<{ sodaxConfigured: boolean }>(await s.get("/config"));
  assert.equal(config.sodaxConfigured, false);
  assert.ok(!JSON.stringify(config).includes(FAKE_KEY));
});

test("/config exposes flags and the fee rate, never the key", async (t) => {
  const s = await serve(); t.after(s.close);
  const res = await s.get("/config");
  assert.equal(res.headers.get("cache-control"), "public, max-age=30");
  assert.deepEqual(await res.json(), { tradingEnabled: false, sodaxConfigured: true, partnerFeeBps: 30, feeReceiver: RECEIVER,
    embeddedWallet: false, walletOrigin: null, unbackedLimitUsd: 100, stocksEnabled: false, stocksTermsVersion: null });
});

// ---- partner fee ------------------------------------------------------------------------------------------

test("the configured partner fee is pinned and a client-supplied fee is stripped", async (t) => {
  const s = await serve(); t.after(s.close);
  const res = await s.post("/sodax/swaps/quote", { ...QUOTE_HBAR_BASE, partnerFee: { address: ATTACKER, percentage: 0 }, hook: { kind: "deposit", to: ATTACKER } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), fixture("quote_2.json"));
  const sent = s.calls.find((c) => c.url.endsWith("/swaps/quote"))!.body as Record<string, unknown>;
  assert.deepEqual(sent.partnerFee, { address: RECEIVER, percentage: 30 });
  assert.equal(sent.hook, undefined);
  assert.equal(sent.amount, QUOTE_HBAR_BASE.amount);
});

test("with no fee configured the field is omitted, even when the client sends one", async (t) => {
  const s = await serve({ input: { fees: {} } }); t.after(s.close);
  await s.post("/sodax/swaps/quote", { ...QUOTE_HBAR_BASE, partnerFee: { address: ATTACKER, percentage: 100 } });
  const sent = s.calls.find((c) => c.url.endsWith("/swaps/quote"))!.body as Record<string, unknown>;
  assert.equal("partnerFee" in sent, false);
});

test("without a fee: with trading on, quote → build → submit → status reach SODAX without a partner fee", async (t) => {
  const s = await serve({ input: { fees: {}, features: { trading: true, embeddedWallet: false } } });
  t.after(s.close);
  const config = await json<{ tradingEnabled: boolean; partnerFeeBps: number; feeReceiver: string | null }>(await s.get("/config"));
  assert.deepEqual([config.tradingEnabled, config.partnerFeeBps, config.feeReceiver], [true, 0, null]);
  // The intent the passkey wallet signs: no fee, no hook, empty data.
  const own = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
  const intent = { srcChainKey: "hedera", inputToken: QUOTE_HBAR_BASE.tokenSrc, dstChainKey: "0x2105.base", outputToken: QUOTE_HBAR_BASE.tokenDst,
    inputAmount: QUOTE_HBAR_BASE.amount, minOutputAmount: "42000000", deadline: "1800000300", allowPartialFill: false,
    srcAddress: own, dstAddress: own, solver: "0x0000000000000000000000000000000000000000", data: "0x" };
  const txHash = `0x${"ab".repeat(32)}`;
  const steps: Array<[string, object]> = [
    ["swaps/quote", { ...QUOTE_HBAR_BASE, partnerFee: { address: ATTACKER, percentage: 100 } }],
    ["swaps/intents", { ...intent, partnerFee: { address: ATTACKER, percentage: 100 } }],
    ["swaps/intents/submit", { srcChainKey: "hedera", txHash }],
    ["swaps/intents/status", { txHash }],
  ];
  for (const [p, body] of steps) assert.equal((await s.post(`/sodax/${p}`, body)).status, 200, p);
  const sent = s.calls.filter((c) => c.method === "POST");
  assert.deepEqual(sent.map((c) => c.url), steps.map(([p]) => `https://api.sodax.com/v1/${p}`));
  for (const c of sent) assert.equal("partnerFee" in (c.body as object), false, c.url);
  assert.deepEqual(sent[1]!.body, intent, "the intent goes upstream as built");
});

test("a half-set or out-of-range fee stops the server at start instead of running with a fee nobody asked for", () => {
  assert.throws(() => resolveConfig({ fees: { partnerFeeBps: 30 } }), ConfigError);
  assert.throws(() => resolveConfig({ fees: { partnerFeeBps: PARTNER_FEE_MAX_BPS + 1, receiver: RECEIVER } }), ConfigError);
  assert.throws(() => resolveConfig({ fees: { partnerFeeBps: 2.5, receiver: RECEIVER } }), ConfigError);
  assert.throws(() => resolveConfig({ fees: { partnerFeeBps: 30, receiver: "0.0.12345" } }), ConfigError);
  const { config, secrets } = resolveConfig({ fees: { partnerFeeBps: 30, receiver: RECEIVER } });
  assert.deepEqual(serverConfig(config, secrets, false).partnerFee, { address: RECEIVER, percentage: 30 });
  const none = resolveConfig({ fees: { partnerFeeBps: 0, receiver: RECEIVER } });
  assert.equal(serverConfig(none.config, none.secrets, false).partnerFee, null, "a receiver alone pins nothing");
});

// ---- caches -----------------------------------------------------------------------------------------------

test("tokens are cached for 5 minutes and the deadline for 30 seconds", async (t) => {
  const s = await serve(); t.after(s.close);
  const count = (part: string) => s.calls.filter((c) => c.url.includes(part)).length;
  const first = await s.get("/sodax/swaps/tokens");
  assert.equal(first.headers.get("x-cache"), "miss");
  const second = await s.get("/sodax/swaps/tokens");
  assert.equal(second.headers.get("x-cache"), "hit");
  assert.deepEqual(await second.json(), TOKENS);
  assert.equal(count("/swaps/tokens"), 1);

  await s.get("/sodax/swaps/deadline"); await s.get("/sodax/swaps/deadline");
  assert.equal(count("/swaps/deadline"), 1);
  s.clock.t += 31_000;
  await s.get("/sodax/swaps/deadline");
  assert.equal(count("/swaps/deadline"), 2);
  await s.get("/sodax/swaps/tokens");
  assert.equal(count("/swaps/tokens"), 1, "tokens still fresh after 31 s");
  s.clock.t += 5 * 60_000;
  await s.get("/sodax/swaps/tokens");
  assert.equal(count("/swaps/tokens"), 2);
});

test("errors are not cached and quotes are never cached", async (t) => {
  let fail = true;
  const s = await serve({ route: (url) => url.includes("/swaps/tokens") && fail ? { status: 404, body: { message: "nope" } } : undefined });
  t.after(s.close);
  assert.equal((await s.get("/sodax/swaps/tokens")).status, 404);
  fail = false;
  assert.equal((await s.get("/sodax/swaps/tokens")).status, 200);
  await s.post("/sodax/swaps/quote", QUOTE_HBAR_BASE); await s.post("/sodax/swaps/quote", QUOTE_HBAR_BASE);
  assert.equal(s.calls.filter((c) => c.url.endsWith("/swaps/quote")).length, 2);
});

// ---- 429 backoff ------------------------------------------------------------------------------------------

test("a 429 from SODAX is retried with growing backoff and then succeeds", async (t) => {
  let n = 0;
  const s = await serve({ route: (url) => url.endsWith("/swaps/quote") && ++n <= 2 ? { status: 429, body: { message: "Too Many Requests" } } : undefined });
  t.after(s.close);
  const res = await s.post("/sodax/swaps/quote", QUOTE_HBAR_BASE);
  assert.equal(res.status, 200);
  assert.equal(n, 3);
  assert.equal(s.sleeps.length, 2);
  assert.ok(s.sleeps[1]! > s.sleeps[0]! / 2 && s.sleeps[0]! >= 125 && s.sleeps[1]! >= 250, `backoff ${s.sleeps.join(", ")}`);
});

test("Retry-After is honoured (capped) and persistent 429s surface as a clean 429", async (t) => {
  const s = await serve({ route: (url) => url.endsWith("/swaps/intents/status") ? { status: 429, body: {}, headers: { "retry-after": "60" } } : undefined });
  t.after(s.close);
  const res = await s.post("/sodax/swaps/intents/status", { txHash: "0xabc" });
  assert.equal(res.status, 429);
  assert.equal((await json<ErrorBody>(res)).error.code, "SODAX_RATE_LIMITED");
  assert.equal(res.headers.get("retry-after"), "5");
  assert.deepEqual(s.sleeps, [5000, 5000, 5000]);
});

test("SODAX's 'key verification unavailable' 503 is retried; other 5xx on writes are not", async (t) => {
  let guard = 0, submit = 0;
  const s = await serve({ route: (url) => {
    if (url.endsWith("/swaps/deadline") && ++guard === 1) return { status: 503, body: { message: "API key verification is temporarily unavailable" } };
    if (url.endsWith("/swaps/intents/submit")) { submit++; return { status: 500, body: { message: "boom" } }; }
    return undefined;
  } });
  t.after(s.close);
  assert.equal((await s.get("/sodax/swaps/deadline")).status, 200);
  const res = await s.post("/sodax/swaps/intents/submit", { chainId: "146", txHash: "0xabc" });
  assert.equal(res.status, 502);
  assert.equal(submit, 1, "a write is sent once");
});

// ---- trading switch and tokenised stocks ------------------------------------------------------------------

test("with trading off, building a transaction is refused but status and cancel stay open", async (t) => {
  const s = await serve(); t.after(s.close);
  for (const p of ["/sodax/swaps/intents", "/sodax/swaps/limit-orders", "/sodax/swaps/approve", "/sodax/swaps/quote?includeTxData=true"]) {
    const res = await s.post(p, { srcChainKey: "hedera", inputToken: "0x0", dstChainKey: "0x2105.base", outputToken: "0x1", tokenSrc: "0x0", tokenSrcChainKey: "hedera" });
    assert.equal(res.status, 403, p);
    assert.equal((await json<ErrorBody>(res)).error.code, "TRADING_DISABLED");
  }
  assert.equal((await s.post("/sodax/swaps/intents/status", { txHash: "0xabc" })).status, 200);
  assert.equal((await s.post("/sodax/swaps/intents/cancel", { srcChainKey: "hedera", intent: {} })).status, 200);
  assert.equal((await s.post("/sodax/swaps/quote", QUOTE_HBAR_BASE)).status, 200, "plain quotes work");
});

test("tokenised stocks off (the default): any quote or intent with a stock leg is refused (451) before SODAX sees it", async (t) => {
  const s = await serve({ input: { features: { trading: true, embeddedWallet: false } } }); t.after(s.close);
  const res = await s.post("/sodax/swaps/quote", QUOTE_USDC_NVDA);
  assert.equal(res.status, 451);
  assert.deepEqual(await res.json(), { error: { code: "STOCKS_DISABLED", message: "Tokenised stocks are not available here." } });
  // As the source, as the output of an intent, and in another letter case: refused the same way.
  assert.equal((await s.post("/sodax/swaps/quote", { ...QUOTE_HBAR_BASE, tokenSrc: HEDERA_AAPL, tokenSrcChainKey: "hedera" })).status, 451);
  const intent = { srcChainKey: "hedera", inputToken: HEDERA_USDC, dstChainKey: "hedera", outputToken: QUOTE_USDC_NVDA.tokenDst.toUpperCase().replace("0X", "0x"),
    inputAmount: "50000000", minOutputAmount: "1", deadline: "1800000300", allowPartialFill: false };
  assert.equal((await s.post("/sodax/swaps/intents", intent)).status, 451);
  assert.equal((await s.post("/sodax/swaps/allowance/check", intent)).status, 451);
  assert.equal(s.calls.filter((c) => !c.url.endsWith("/swaps/tokens")).length, 0, "only the token list was read");
  // A plain crypto pair still works.
  assert.equal((await s.post("/sodax/swaps/quote", QUOTE_HBAR_BASE)).status, 200);
});

test("a token list that can't be read refuses a request with token legs (fail closed)", async (t) => {
  const s = await serve({ route: (url) => url.endsWith("/swaps/tokens") ? { status: 500, body: { message: "down" } } : undefined });
  t.after(s.close);
  const res = await s.post("/sodax/swaps/quote", QUOTE_HBAR_BASE);
  assert.equal(res.status, 503);
  assert.equal((await json<ErrorBody>(res)).error.code, "TOKEN_LIST_UNAVAILABLE");
  assert.equal(s.calls.filter((c) => c.url.endsWith("/swaps/quote")).length, 0);
});

// ---- tokenised stocks switched on ---------------------------------------------------------------------------

const EDGE = "edge-secret-for-tests-only";
const SIGNING = "attestation-secret-for-tests-only-0123456789";
const STOCK_ENV = { EXCLIP_EDGE_SECRET: EDGE, EXCLIP_ATTESTATION_SECRET: SIGNING };
const ATT = STOCKS_ATTESTATION_HEADER;
const STATEMENT_IDS = STOCK_STATEMENTS.map((s) => s.id);
const CONFIRM = { termsVersion: "1", statements: STATEMENT_IDS };
/** Behind a proxy that names the country in cf-ipcountry; Canada refused on top of the baseline. */
const STOCKS = { enabled: true, countryHeader: "cf-ipcountry", blockedCountries: ["CA"] };
/** A request as the reverse proxy passes it on from a visitor in `country`. */
const via = (country: string, extra: Record<string, string> = {}) => ({ "cf-ipcountry": country, "x-exclip-edge-secret": EDGE, ...extra });
type EligibilityBody = { eligible: boolean; code: string | null; message: string | null; country: string | null; termsVersion: string | null; expiresAt: string | null };

function stocksOn(o: { stocks?: ExclipConfigInput["stocks"]; input?: ExclipConfigInput; env?: Env; clock?: { t: number };
  route?: (url: string, call: Call) => Reply | undefined; stocksLimit?: express.RequestHandler } = {}) {
  return serve({ input: { ...o.input, stocks: { ...STOCKS, ...o.stocks } }, env: { ...STOCK_ENV, ...o.env }, clock: o.clock, route: o.route, stocksLimit: o.stocksLimit });
}

/** Confirms every statement from `country` and returns the attestation the app keeps. */
async function attestationFrom(s: Awaited<ReturnType<typeof serve>>, country = "DE"): Promise<string> {
  const res = await s.post("/stocks/attest", CONFIRM, via(country));
  assert.equal(res.status, 200);
  return (await json<{ attestation: string }>(res)).attestation;
}

test("stocks off: a stock leg is refused (451 STOCKS_DISABLED) whatever the request carries, and nothing is signed", async (t) => {
  const s = await serve({ env: STOCK_ENV }); t.after(s.close);
  const res = await s.post("/sodax/swaps/quote", QUOTE_USDC_NVDA, via("DE", { [ATT]: "a.b" }));
  assert.equal(res.status, 451);
  assert.deepEqual(await res.json(), { error: { code: "STOCKS_DISABLED", message: "Tokenised stocks are not available here." } });
  assert.deepEqual(await json(await s.get("/stocks/eligibility", via("DE"))), {
    eligible: false, code: "STOCKS_DISABLED", message: "Tokenised stocks are not available here.", country: null, termsVersion: null, expiresAt: null,
  });
  const attest = await s.post("/stocks/attest", CONFIRM, via("DE"));
  assert.equal(attest.status, 451);
  assert.equal((await json<ErrorBody>(attest)).error.code, "STOCKS_DISABLED");

  // EXCLIP_DISABLE_STOCKS switches off what the file switched on.
  const braked = await stocksOn({ env: { EXCLIP_DISABLE_STOCKS: "1" } }); t.after(braked.close);
  const quote = await braked.post("/sodax/swaps/quote", QUOTE_USDC_NVDA, via("DE"));
  assert.equal(quote.status, 451);
  assert.equal((await json<ErrorBody>(quote)).error.code, "STOCKS_DISABLED");
  assert.equal((await json<{ stocksEnabled: boolean }>(await braked.get("/config"))).stocksEnabled, false);
  assert.equal(s.calls.filter((c) => c.url.endsWith("/swaps/quote")).length + braked.calls.filter((c) => c.url.endsWith("/swaps/quote")).length, 0);
});

test("stocks on: a country counts only with the edge secret; none, a forged one or an unassigned code is COUNTRY_UNKNOWN", async (t) => {
  const s = await stocksOn(); t.after(s.close);
  const attestation = await attestationFrom(s, "DE");
  const cases: Array<[string, Record<string, string>]> = [
    ["no country header", { "x-exclip-edge-secret": EDGE }],
    ["a country header the visitor set, without the edge secret", { "cf-ipcountry": "DE" }],
    ["a wrong edge secret", via("DE", { "x-exclip-edge-secret": "edge-secret-guess" })],
    ["the edge secret with more after it", via("DE", { "x-exclip-edge-secret": `${EDGE}x` })],
    ["the edge secret sent twice", via("DE", { "x-exclip-edge-secret": `${EDGE}, ${EDGE}` })],
    ["Cloudflare's code for unknown", via("XX")],
    ["Cloudflare's code for Tor", via("T1")],
    ["a name, not a code", via("Germany")],
    ["two countries", via("DE, FR")],
    ["an empty header", via("")],
  ];
  for (const [label, headers] of cases) {
    const withAttestation = { ...headers, [ATT]: attestation };
    const quote = await s.post("/sodax/swaps/quote", QUOTE_USDC_NVDA, withAttestation);
    assert.equal(quote.status, 451, label);
    assert.deepEqual(await quote.json(), { error: { code: "COUNTRY_UNKNOWN", message: STOCK_REFUSALS.COUNTRY_UNKNOWN } }, label);
    const e = await json<EligibilityBody>(await s.get("/stocks/eligibility", withAttestation));
    assert.deepEqual([e.eligible, e.code, e.country], [false, "COUNTRY_UNKNOWN", null], label);
    assert.equal((await s.post("/stocks/attest", CONFIRM, headers)).status, 451, label);
  }
  assert.equal(s.calls.filter((c) => c.url.endsWith("/swaps/quote")).length, 0, "no stock quote reached SODAX");
});

test("stocks on: the baseline and the operator's own list are COUNTRY_RESTRICTED, and nothing is signed there", async (t) => {
  const s = await stocksOn(); t.after(s.close);
  for (const country of [...STOCKS_BASELINE_COUNTRIES, "CA", "ca"]) {
    const quote = await s.post("/sodax/swaps/quote", QUOTE_USDC_NVDA, via(country));
    assert.equal(quote.status, 451, country);
    assert.deepEqual(await quote.json(), { error: { code: "COUNTRY_RESTRICTED", message: STOCK_REFUSALS.COUNTRY_RESTRICTED } }, country);
    const e = await json<EligibilityBody>(await s.get("/stocks/eligibility", via(country)));
    assert.deepEqual([e.eligible, e.code, e.country], [false, "COUNTRY_RESTRICTED", country.toUpperCase()], country);
    const attest = await s.post("/stocks/attest", CONFIRM, via(country));
    assert.equal(attest.status, 451, country);
    assert.equal((await json<ErrorBody>(attest)).error.code, "COUNTRY_RESTRICTED", country);
  }
  // A self-certification made elsewhere doesn't open a restricted country.
  const fromGermany = await attestationFrom(s, "DE");
  const res = await s.post("/sodax/swaps/quote", QUOTE_USDC_NVDA, via("US", { [ATT]: fromGermany }));
  assert.equal((await json<ErrorBody>(res)).error.code, "COUNTRY_RESTRICTED");
  // The operator's list adds to the baseline: a country on neither may go on to the statements.
  assert.equal((await json<EligibilityBody>(await s.get("/stocks/eligibility", via("GB")))).code, "SELF_CERT_REQUIRED");
  assert.equal(s.calls.filter((c) => c.url.endsWith("/swaps/quote")).length, 0);
});

test("stocks on: a missing, altered, expired, foreign, future or old-terms attestation is SELF_CERT_REQUIRED", async (t) => {
  const clock = { t: Date.UTC(2026, 10, 2, 12) };
  const s = await stocksOn({ clock }); t.after(s.close);
  const attestation = await attestationFrom(s, "DE");
  const [payload, signature] = attestation.split(".") as [string, string];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const resigned = (changes: object) => `${Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url")}.${signature}`;
  const refused = async (label: string, country: string, token?: string) => {
    const headers = via(country, token === undefined ? {} : { [ATT]: token });
    const quote = await s.post("/sodax/swaps/quote", QUOTE_USDC_NVDA, headers);
    assert.equal(quote.status, 451, label);
    assert.deepEqual(await quote.json(), { error: { code: "SELF_CERT_REQUIRED", message: STOCK_REFUSALS.SELF_CERT_REQUIRED } }, label);
    const e = await json<EligibilityBody>(await s.get("/stocks/eligibility", headers));
    assert.deepEqual([e.eligible, e.code, e.country, e.termsVersion, e.expiresAt], [false, "SELF_CERT_REQUIRED", country, "1", null], label);
  };
  await refused("none", "DE");
  await refused("made in another country", "FR", attestation);
  await refused("its country changed", "FR", resigned({ c: "FR" }));
  await refused("its date moved on", "DE", resigned({ iat: Number(claims.iat) + 86_400 }));
  await refused("its terms changed", "DE", resigned({ t: "2" }));
  await refused("another signature", "DE", `${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`);
  await refused("no signature", "DE", payload);
  await refused("a third part", "DE", `${attestation}.x`);
  await refused("not an attestation", "DE", "not an attestation");
  await refused("too long", "DE", `${attestation}${"A".repeat(600)}`);

  // Signed by another deployment (another secret), or under terms this server has moved on from.
  const other = await stocksOn({ clock, env: { EXCLIP_ATTESTATION_SECRET: "another-deployments-secret-0123456789abcdef" } }); t.after(other.close);
  await refused("another deployment's", "DE", await attestationFrom(other, "DE"));
  const newTerms = await stocksOn({ clock, stocks: { termsVersion: "2" } }); t.after(newTerms.close);
  const old = await newTerms.post("/sodax/swaps/quote", QUOTE_USDC_NVDA, via("DE", { [ATT]: attestation }));
  assert.equal((await json<ErrorBody>(old)).error.code, "SELF_CERT_REQUIRED", "terms version 1 under terms version 2");
  const stale = await newTerms.post("/stocks/attest", CONFIRM, via("DE"));
  assert.equal(stale.status, 409);
  assert.equal((await json<ErrorBody>(stale)).error.code, "TERMS_CHANGED");

  // Dated ahead: a few minutes (another server's clock) count, an hour doesn't.
  const ahead = { t: clock.t + 4 * 60_000 };
  const soon = await stocksOn({ clock: ahead }); t.after(soon.close);
  assert.equal((await s.post("/sodax/swaps/quote", QUOTE_USDC_NVDA, via("DE", { [ATT]: await attestationFrom(soon) }))).status, 200);
  ahead.t = clock.t + 60 * 60_000;
  await refused("dated an hour ahead", "DE", await attestationFrom(soon));

  // Thirty days: the last second counts, the next doesn't.
  clock.t += 30 * 86_400_000 - 1000;
  assert.equal((await s.post("/sodax/swaps/quote", QUOTE_USDC_NVDA, via("DE", { [ATT]: attestation }))).status, 200);
  clock.t += 1000;
  await refused("30 days old", "DE", attestation);
});

test("stocks on: a valid attestation lets a stock leg through to SODAX, and nothing of the check travels upstream", async (t) => {
  const s = await stocksOn({ input: { features: { trading: true, embeddedWallet: false } } }); t.after(s.close);
  const attest = await s.post("/stocks/attest", { termsVersion: "1", statements: [...STATEMENT_IDS].reverse() }, via("DE"));
  assert.equal(attest.status, 200);
  assert.equal(attest.headers.get("cache-control"), "no-store");
  const issued = await json<{ attestation: string; country: string; termsVersion: string; expiresAt: string }>(attest);
  assert.deepEqual({ ...issued, attestation: "" }, { attestation: "", country: "DE", termsVersion: "1", expiresAt: "2026-11-15T12:00:00.000Z" });
  assert.match(issued.attestation, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(JSON.parse(Buffer.from(issued.attestation.split(".")[0]!, "base64url").toString("utf8")),
    { v: 1, t: "1", c: "DE", iat: Date.UTC(2026, 9, 16, 12) / 1000 });

  const headers = via("DE", { [ATT]: issued.attestation });
  const e = await s.get("/stocks/eligibility", headers);
  assert.equal(e.headers.get("cache-control"), "no-store");
  assert.deepEqual(await e.json(), { eligible: true, code: null, message: null, country: "DE", termsVersion: "1", expiresAt: "2026-11-15T12:00:00.000Z" });

  const quote = await s.post("/sodax/swaps/quote", QUOTE_USDC_NVDA, headers);
  assert.equal(quote.status, 200);
  assert.deepEqual(await quote.json(), { quotedAmount: "42943543" });
  assert.equal((await s.post("/sodax/swaps/quote", QUOTE_USDC_NVDA, via("de", { [ATT]: issued.attestation }))).status, 200, "the proxy's case doesn't matter");
  const intent = { srcChainKey: "hedera", inputToken: HEDERA_USDC, dstChainKey: "hedera", outputToken: HEDERA_AAPL,
    inputAmount: "50000000", minOutputAmount: "1", deadline: "1800000300", allowPartialFill: false };
  assert.equal((await s.post("/sodax/swaps/intents", intent, headers)).status, 200);

  const upstream = s.calls.filter((c) => !c.url.endsWith("/swaps/tokens"));
  assert.equal(upstream.length, 3);
  for (const call of upstream) {
    assert.deepEqual(Object.keys(call.headers).sort(), ["accept", "content-type", "x-api-key"], call.url);
    for (const secret of [EDGE, SIGNING, issued.attestation]) assert.ok(!JSON.stringify(call).includes(secret), call.url);
  }
});

test("stocks: the confirmation needs every statement, for the current terms, and nothing else", async (t) => {
  const s = await stocksOn(); t.after(s.close);
  const bad: Array<[string, unknown, number, string]> = [
    ["three statements", { termsVersion: "1", statements: STATEMENT_IDS.slice(1) }, 400, "STATEMENTS_REQUIRED"],
    ["one of them twice", { termsVersion: "1", statements: [...STATEMENT_IDS.slice(1), STATEMENT_IDS[1]] }, 400, "STATEMENTS_REQUIRED"],
    ["one that doesn't exist", { termsVersion: "1", statements: [...STATEMENT_IDS.slice(1), "anything"] }, 400, "STATEMENTS_REQUIRED"],
    ["five", { termsVersion: "1", statements: [...STATEMENT_IDS, STATEMENT_IDS[0]] }, 400, "STATEMENTS_REQUIRED"],
    ["not a list", { termsVersion: "1", statements: STATEMENT_IDS.join(",") }, 400, "STATEMENTS_REQUIRED"],
    ["no statements", { termsVersion: "1" }, 400, "STATEMENTS_REQUIRED"],
    ["no terms version", { statements: STATEMENT_IDS }, 400, "BAD_BODY"],
    ["a field more", { ...CONFIRM, country: "FR" }, 400, "BAD_BODY"],
    ["a list", [CONFIRM], 400, "BAD_BODY"],
    ["other terms", { ...CONFIRM, termsVersion: "0" }, 409, "TERMS_CHANGED"],
  ];
  for (const [label, body, status, code] of bad) {
    const res = await s.post("/stocks/attest", body, via("DE"));
    assert.equal(res.status, status, label);
    assert.equal((await json<ErrorBody>(res)).error.code, code, label);
  }
  // The answers carry no secret.
  const all = JSON.stringify(await json(await s.post("/stocks/attest", CONFIRM, via("DE")))) + JSON.stringify(await json(await s.get("/config")));
  for (const secret of [EDGE, SIGNING]) assert.ok(!all.includes(secret));
});

test("stocks in every state: a crypto-only swap is untouched, and the stock check isn't even asked", async (t) => {
  const on = await stocksOn({ input: { features: { trading: true, embeddedWallet: false } } }); t.after(on.close);
  const off = await serve({ input: { features: { trading: true, embeddedWallet: false } }, env: STOCK_ENV }); t.after(off.close);
  const attestation = await attestationFrom(on, "DE");
  const states: Array<[string, typeof on, Record<string, string>]> = [
    ["off", off, via("DE")],
    ["on, no country", on, {}],
    ["on, a country without the edge secret", on, { "cf-ipcountry": "DE" }],
    ["on, a restricted country", on, via("US")],
    ["on, not yet confirmed", on, via("DE")],
    ["on, an altered attestation", on, via("DE", { [ATT]: `${attestation}x` })],
    ["on, confirmed", on, via("DE", { [ATT]: attestation })],
  ];
  const intent = { srcChainKey: "hedera", inputToken: HEDERA_USDC, dstChainKey: "0x2105.base", outputToken: QUOTE_HBAR_BASE.tokenDst,
    inputAmount: "50000000", minOutputAmount: "1", deadline: "1800000300", allowPartialFill: false };
  for (const [label, s, headers] of states) {
    assert.equal((await s.post("/sodax/swaps/quote", QUOTE_HBAR_BASE, headers)).status, 200, label);
    assert.equal((await s.post("/sodax/swaps/intents", intent, headers)).status, 200, label);
  }

  // The proxy asks only about a stock leg.
  const { config, secrets } = resolveConfig({ ...BASE, stocks: STOCKS }, { SODAX_API_KEY: FAKE_KEY, ...STOCK_ENV });
  const proxy = createSodaxProxy({ config: serverConfig(config, secrets, false), fetch: async (url) => Response.json(url.includes("/swaps/tokens") ? TOKENS : {}) });
  let asked = 0;
  const ask = () => { asked++; return { eligible: false, code: "COUNTRY_RESTRICTED", country: "US" } as const; };
  assert.equal((await proxy.handle("POST", "swaps/quote", {}, QUOTE_HBAR_BASE, ask)).status, 200);
  assert.equal(asked, 0);
  assert.equal((await proxy.handle("POST", "swaps/quote", {}, QUOTE_USDC_NVDA, ask)).status, 451);
  assert.equal(asked, 1);
});

test("stocks on: a token list that can't be read refuses stock and crypto legs alike (503), even when confirmed", async (t) => {
  const s = await stocksOn({ route: (url) => (url.endsWith("/swaps/tokens") ? { status: 500, body: { message: "down" } } : undefined) });
  t.after(s.close);
  const headers = via("DE", { [ATT]: await attestationFrom(s, "DE") });
  for (const quote of [QUOTE_USDC_NVDA, QUOTE_HBAR_BASE]) {
    const res = await s.post("/sodax/swaps/quote", quote, headers);
    assert.equal(res.status, 503);
    assert.equal((await json<ErrorBody>(res)).error.code, "TOKEN_LIST_UNAVAILABLE");
  }
  assert.equal(s.calls.filter((c) => c.url.endsWith("/swaps/quote")).length, 0);
});

test("stocks: /config says they're on and which terms apply; the routes are rate limited per IP", async (t) => {
  const counts = new Map<string, number>();
  const limit = publicRateLimit("exclip-test-stocks", 2, async (key) => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n <= 2; });
  const s = await stocksOn({ stocks: { termsVersion: "2026-11-01" }, stocksLimit: limit }); t.after(s.close);
  const config = await json<{ stocksEnabled: boolean; stocksTermsVersion: string | null }>(await s.get("/config"));
  assert.deepEqual([config.stocksEnabled, config.stocksTermsVersion], [true, "2026-11-01"]);

  const ip = { "x-forwarded-for": "203.0.113.9" };
  assert.equal((await s.get("/stocks/eligibility", via("DE", ip))).status, 200);
  assert.equal((await s.get("/stocks/eligibility", via("DE", ip))).status, 200);
  assert.equal((await s.post("/stocks/attest", { ...CONFIRM, termsVersion: "2026-11-01" }, via("DE", ip))).status, 429);
  assert.equal((await s.get("/stocks/eligibility", via("DE", { "x-forwarded-for": "203.0.113.10" }))).status, 200);
});

test("stocks on without the two secrets can't be built, even by a caller that skipped the loader", () => {
  const { config, secrets } = resolveConfig({ stocks: STOCKS }, {});
  assert.throws(() => createStockGate(serverConfig(config, secrets, false).stocks), /EXCLIP_EDGE_SECRET/);
  const short = resolveConfig({ stocks: STOCKS }, { ...STOCK_ENV, EXCLIP_ATTESTATION_SECRET: "x".repeat(31) });
  assert.throws(() => createStockGate(serverConfig(short.config, short.secrets, false).stocks), /EXCLIP_ATTESTATION_SECRET/);
  const off = resolveConfig({}, {});
  assert.doesNotThrow(() => createStockGate(serverConfig(off.config, off.secrets, false).stocks));
});

// ---- limits, markets --------------------------------------------------------------------------------------

test("bodies over 32kb are refused with 413, malformed JSON with 400", async (t) => {
  const s = await serve(); t.after(s.close);
  const res = await s.post("/sodax/swaps/quote", { ...QUOTE_HBAR_BASE, pad: "x".repeat(40_000) });
  assert.equal(res.status, 413);
  assert.equal((await json<ErrorBody>(res)).error.code, "BODY_TOO_LARGE");
  const bad = await s.post("/sodax/swaps/quote", "{\"tokenSrc\":");
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: { code: "BAD_JSON", message: "The request body is not valid JSON." } });
  assert.equal(s.calls.length, 0);
});

test("the proxy is rate limited per IP", async (t) => {
  const counts = new Map<string, number>();
  const limit = publicRateLimit("exclip-test", 2, async (key) => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n <= 2; });
  const s = await serve({ proxyLimit: limit }); t.after(s.close);
  const ip = { "x-forwarded-for": "203.0.113.9" };
  assert.equal((await s.get("/sodax/swaps/deadline", ip)).status, 200);
  assert.equal((await s.get("/sodax/swaps/deadline", ip)).status, 200);
  assert.equal((await s.get("/sodax/swaps/deadline", ip)).status, 429);
  assert.equal((await s.get("/sodax/swaps/deadline", { "x-forwarded-for": "203.0.113.10" })).status, 200);
});

test("markets: CoinGecko rows are mapped; a failure is an explicit empty state, never invented numbers", async (t) => {
  let up = true;
  const s = await serve({ route: (url) => {
    if (!url.includes("coingecko")) return undefined;
    if (!up) return { status: 503, body: {} };
    if (url.includes("/market_chart")) return { body: { prices: [[1, 100], [2, 101], [3, 99.5]] } };
    return { body: [{ id: "hedera-hashgraph", current_price: 0.1834, price_change_percentage_24h_in_currency: -2.4, market_cap: 7.7e9,
      total_volume: 1.2e8, circulating_supply: 4.2e10, sparkline_in_7d: { price: [0.18, 0.19, 0.1834] } }, { id: "not-ours", current_price: 1 }] };
  } });
  t.after(s.close);
  type Markets = { status: string; asOf: number | null; rows: Array<{ symbol: string; change24h: number | null; sparkline: number[] }> };
  type Chart = { status: string; points: Array<[number, number]> };
  const ok = await json<Markets>(await s.get("/markets"));
  assert.equal(ok.status, "ok");
  assert.equal(ok.rows.length, 1);
  assert.equal(ok.rows[0]!.symbol, "HBAR");
  assert.equal(ok.rows[0]!.change24h, -2.4);
  assert.deepEqual(ok.rows[0]!.sparkline, [0.18, 0.19, 0.1834]);
  const chart = await json<Chart>(await s.get("/markets/HBAR/chart?range=1W"));
  assert.equal(chart.points.length, 3);
  assert.equal((await s.get("/markets/HBAR/chart?range=5Y")).status, 400);
  assert.equal((await s.get("/markets/NOPE/chart?range=1D")).status, 404);

  up = false;
  s.clock.t += 20 * 60_000;
  const down = await json<Markets>(await s.get("/markets"));
  assert.deepEqual(down, { status: "unavailable", asOf: null, rows: [] });
  const downChart = await json<Chart>(await s.get("/markets/ETH/chart?range=1D"));
  assert.deepEqual(downChart.points, []);
  assert.equal(downChart.status, "unavailable");
});
