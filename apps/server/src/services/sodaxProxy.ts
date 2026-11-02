/** SODAX key proxy. An allow-list, not a pass-through: only the routes below reach api.sodax.com, with the server's
 * x-api-key added and the partner fee pinned server-side. */
import { STOCK_REFUSALS } from "@exclip/config";
import { splitFee } from "@exclip/config/fee-split";
import type { PartnerFee, ServerConfig } from "./config.ts";
import type { Eligibility } from "./stocks.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Method = "GET" | "POST";

export type SodaxRoute = {
  method: Method;
  /** Anchored, relative to the SODAX base (no leading slash). */
  pattern: RegExp;
  /** Query parameters forwarded; everything else is dropped. */
  query?: readonly string[];
  /** Cache successful responses this long (ms). */
  ttlMs?: number;
  /** Body carries SwapExtras: any client partnerFee is removed and the configured one pinned (feeFor). */
  fee?: boolean;
  /** Builds an unsigned transaction: refused while features.trading is off. Status, submit and cancel never are, so
   * an intent that was already signed can always be followed or recovered. */
  builds?: boolean;
  /** Where the token legs are, for the tokenised-stock refusal, and the amount sold, for a fee rate or a split: tokenSrc,
   * tokenDst and amount on a quote; inputToken, outputToken and inputAmount on an intent. */
  legs?: "quote" | "intent";
  /** Safe to retry on a 5xx (429 is always retried: a rate-limited request was not processed). */
  idempotent?: boolean;
};

const CHAIN = "[A-Za-z0-9][A-Za-z0-9.-]{0,39}";
const HASH = "[A-Za-z0-9]{16,128}";
const FIVE_MIN = 5 * 60_000;

export const SODAX_ROUTES: readonly SodaxRoute[] = [
  { method: "GET", pattern: /^swaps\/tokens$/, ttlMs: FIVE_MIN, idempotent: true },
  { method: "GET", pattern: new RegExp(`^swaps/tokens/${CHAIN}$`), ttlMs: FIVE_MIN, idempotent: true },
  { method: "POST", pattern: /^swaps\/quote$/, query: ["includeTxData"], fee: true, legs: "quote", idempotent: true },
  { method: "GET", pattern: /^swaps\/deadline$/, query: ["offsetSeconds"], ttlMs: 30_000, idempotent: true },
  { method: "GET", pattern: /^swaps\/fees\/partner$/, query: ["amount"], idempotent: true },
  { method: "GET", pattern: /^swaps\/fees\/solver$/, query: ["amount"], idempotent: true },
  { method: "POST", pattern: /^swaps\/allowance\/check$/, fee: true, legs: "intent", idempotent: true },
  { method: "POST", pattern: /^swaps\/approve$/, fee: true, builds: true, legs: "intent" },
  { method: "POST", pattern: /^swaps\/intents$/, fee: true, builds: true, legs: "intent" },
  { method: "POST", pattern: /^swaps\/limit-orders$/, fee: true, builds: true, legs: "intent" },
  { method: "POST", pattern: /^swaps\/intents\/submit$/ },
  { method: "POST", pattern: /^swaps\/intents\/status$/, idempotent: true },
  { method: "POST", pattern: /^swaps\/intents\/cancel$/ },
  { method: "GET", pattern: new RegExp(`^swaps/intents/${HASH}$`), idempotent: true },
  { method: "GET", pattern: new RegExp(`^swaps/intents/${HASH}/fill$`), idempotent: true },
  { method: "POST", pattern: /^swaps\/submit-tx$/ },
  { method: "GET", pattern: /^swaps\/submit-tx\/status$/, query: ["txHash", "srcChainKey"], idempotent: true },
  { method: "GET", pattern: /^bridge\/tokens$/, ttlMs: FIVE_MIN, idempotent: true },
  { method: "GET", pattern: /^be\/config\/all$/, ttlMs: FIVE_MIN, idempotent: true },
];

export function matchSodaxRoute(method: string, path: string): SodaxRoute | null {
  if (path.length > 300 || path.includes("..") || path.includes("//") || /%2f|%5c|\\/i.test(path)) return null;
  return SODAX_ROUTES.find(r => r.method === method && r.pattern.test(path)) ?? null;
}

export type TokenLeg = { chainKey: string; address: string };

export function legsOf(route: SodaxRoute, body: unknown): TokenLeg[] {
  if (!route.legs || typeof body !== "object" || body === null) return [];
  const b = body as Record<string, unknown>;
  const pairs = route.legs === "quote"
    ? [[b.tokenSrcChainKey, b.tokenSrc], [b.tokenDstChainKey, b.tokenDst]]
    : [[b.srcChainKey, b.inputToken], [b.dstChainKey, b.outputToken]];
  return pairs.filter(([c, a]) => typeof c === "string" && typeof a === "string")
    .map(([c, a]) => ({ chainKey: c as string, address: a as string }));
}

export type ProxyResult = { status: number; body: unknown; headers?: Record<string, string> };

export type SodaxProxyOptions = {
  config: ServerConfig;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  maxAttempts?: number;
  timeoutMs?: number;
};

type CacheEntry = { expires: number; status: number; body: unknown };

const fail = (status: number, code: string, message: string, extra: Record<string, string> = {}): ProxyResult =>
  ({ status, body: { error: { code, message } }, headers: { "Cache-Control": "no-store", ...extra } });

/** Never let the key travel back, even if the upstream echoes it in a body or an error message. The key is looked for
 * as it appears inside a JSON string, which is how the response body would carry it. */
export function redact(value: unknown, key: string | null): unknown {
  if (!key) return value;
  const text = JSON.stringify(value);
  const needle = JSON.stringify(key).slice(1, -1);
  if (text === undefined || !text.includes(needle)) return value;
  return JSON.parse(text.split(needle).join("[redacted]"));
}

/** A partner fee as SODAX's request bodies carry it (PartnerFeeV2): a percentage in basis points, or an amount of the
 * token sold in its smallest units, as a decimal string. */
type PinnedFee = PartnerFee | { address: string; amount: string };

/** An amount in smallest units as a decimal string: no sign, point or leading zero, and at most 78 digits, a uint256's. */
const UNITS = /^(?:0|[1-9][0-9]{0,77})$/;

/** The fee pinned on a fee route. A plain fee in basis points is pinned as configured, on every swap. A fee rate
 * (docs/fees.md) or a split (docs/fee-split.md) pins the amount sold × its rate ÷ 100,000, rounded down, to the
 * receiver or the splitter, with no percentage, and nothing when that rounds to 0. On a swap with a tokenised stock on
 * either side, each pins its own fee on stock swaps, or none: never the splitter. "BAD_AMOUNT": such a request without
 * an amount sold to work the fee out from. */
function feeFor(config: ServerConfig, route: SodaxRoute, body: Record<string, unknown>, stockLeg: boolean): PinnedFee | null | "BAD_AMOUNT" {
  const split = config.feeSplit;
  const rated = split ? { address: split.splitter, rate: split.totalRate, stockFee: split.stockFee } : config.rateFee;
  if (!rated) return config.partnerFee;
  if (stockLeg) return rated.stockFee;
  const sold = body[route.legs === "quote" ? "amount" : "inputAmount"];
  if (typeof sold !== "string" || !UNITS.test(sold)) return "BAD_AMOUNT";
  const amount = splitFee(BigInt(sold), rated.rate);
  return amount > 0n ? { address: rated.address, amount: amount.toString() } : null;
}

function pinFee(body: Record<string, unknown>, partnerFee: PinnedFee | null): Record<string, unknown> {
  // A client-supplied fee (and a delivery hook ExClip never uses) is dropped; the server's fee, if any, is pinned.
  const { partnerFee: _client, hook: _hook, ...rest } = body;
  return partnerFee ? { ...rest, partnerFee: { ...partnerFee } } : rest;
}

export function createSodaxProxy(options: SodaxProxyOptions) {
  const { config } = options;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = options.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? 4;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<ProxyResult>>();

  /** Exponential backoff with full jitter; honours a short Retry-After. */
  const backoff = (attempt: number, retryAfter: string | null) => {
    const hinted = Number(retryAfter);
    if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, 5_000);
    return Math.round(Math.min(4_000, 250 * 2 ** attempt) * (0.5 + random() / 2));
  };

  async function upstream(route: SodaxRoute, url: string, body: unknown): Promise<ProxyResult> {
    const key = config.sodaxApiKey!;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: route.method,
          headers: { accept: "application/json", "x-api-key": key, ...(route.method === "POST" ? { "content-type": "application/json" } : {}) },
          body: route.method === "POST" ? JSON.stringify(body ?? {}) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        if (route.idempotent && attempt + 1 < maxAttempts) { await sleep(backoff(attempt, null)); continue; }
        return timedOut ? fail(504, "SODAX_TIMEOUT", "The exchange network did not answer in time. Try again.")
          : fail(502, "SODAX_UNREACHABLE", "The exchange network could not be reached. Try again.");
      }
      const text = await res.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      const guard = res.status === 503 && typeof parsed === "object" && parsed !== null
        && (parsed as { message?: unknown }).message === "API key verification is temporarily unavailable";
      const retryable = res.status === 429 || guard || (route.idempotent && res.status >= 500);
      if (retryable && attempt + 1 < maxAttempts) { await sleep(backoff(attempt, res.headers.get("retry-after"))); continue; }
      if (res.status === 429) return fail(429, "SODAX_RATE_LIMITED", "The exchange network is busy. Try again in a moment.", { "Retry-After": "5" });
      if (parsed === null && text) return fail(502, "SODAX_BAD_RESPONSE", "The exchange network sent an unreadable answer.");
      if (res.status >= 500) return fail(502, "SODAX_UPSTREAM", "The exchange network had a problem. Try again.");
      // Only the status and the (redacted) body go back: no upstream header is ever copied onto the response.
      return { status: res.status, body: redact(parsed, key), headers: { "Cache-Control": "no-store" } };
    }
  }

  let rwaIndex: { expires: number; set: Set<string> } | null = null;
  /** chainKey|address (lower-case) of every token SODAX flags as a real-world asset (the tokenised stocks). */
  async function stockTokens(): Promise<Set<string> | null> {
    if (rwaIndex && rwaIndex.expires > now()) return rwaIndex.set;
    const result = await handle("GET", "swaps/tokens", {}, undefined);
    if (result.status !== 200 || typeof result.body !== "object" || result.body === null) return null;
    const set = new Set<string>();
    for (const tokens of Object.values(result.body as Record<string, unknown>)) {
      if (!Array.isArray(tokens)) continue;
      for (const t of tokens as Array<Record<string, unknown>>) {
        if (t && t.isRwa === true && typeof t.chainKey === "string" && typeof t.address === "string") set.add(`${t.chainKey}|${t.address}`.toLowerCase());
      }
    }
    rwaIndex = { expires: now() + FIVE_MIN, set };
    return set;
  }

  /** `stockCheck`: asked only when a leg is a tokenised stock (services/stocks.ts). Without one, stocks are refused. */
  async function handle(method: string, path: string, query: Record<string, unknown>, body: unknown,
    stockCheck?: () => Eligibility): Promise<ProxyResult> {
    const route = matchSodaxRoute(method, path);
    if (!route) return fail(404, "NOT_ALLOWED", "This exchange endpoint is not available.");
    if (!config.sodaxApiKey) return fail(503, "SODAX_NOT_CONFIGURED", "Trading data is unavailable: the exchange network is not configured on this server (no SODAX API key is set).");

    const params = new URLSearchParams();
    for (const name of route.query ?? []) {
      const v = query[name];
      if (typeof v === "string" && v.length <= 200) params.set(name, v);
    }
    if (route.builds || (route.fee && params.get("includeTxData") === "true")) {
      if (!config.tradingEnabled) return fail(403, "TRADING_DISABLED", "Trading is switched off on this server. Quotes, prices and order status still work.");
    }

    if (route.method === "POST" && (typeof body !== "object" || body === null || Array.isArray(body))) {
      return fail(400, "BAD_BODY", "Expected a JSON object.");
    }

    // Tokenised stocks (the tokens SODAX flags isRwa): a request with a stock leg reaches SODAX only when the stock
    // check passes it, and is refused with 451 and the check's reason otherwise. A token list that can't be read refuses
    // every request with a token leg (fail closed), rather than letting a stock through unchecked.
    const legs = legsOf(route, body);
    let stockLeg = false;
    if (legs.length) {
      const stocks = await stockTokens();
      if (!stocks) return fail(503, "TOKEN_LIST_UNAVAILABLE", "The token list could not be checked. Try again shortly.");
      stockLeg = legs.some(l => stocks.has(`${l.chainKey}|${l.address}`.toLowerCase()));
      if (stockLeg) {
        const verdict: Eligibility = stockCheck?.() ?? { eligible: false, code: "STOCKS_DISABLED", country: null };
        if (!verdict.eligible) return fail(451, verdict.code, STOCK_REFUSALS[verdict.code]);
      }
    }

    // After the stock check: a fee rate's or a split's fee depends on whether either leg is a stock.
    let outBody: unknown = body;
    if (route.fee) {
      const fee = feeFor(config, route, body as Record<string, unknown>, stockLeg);
      if (fee === "BAD_AMOUNT") {
        const field = route.legs === "quote" ? "amount" : "inputAmount";
        return fail(400, "BAD_AMOUNT", `Expected ${field} as a whole number of the token's smallest units, written in digits.`);
      }
      outBody = pinFee(body as Record<string, unknown>, fee);
    }

    const qs = params.toString();
    const url = `${config.sodaxBase}/${path}${qs ? `?${qs}` : ""}`;
    if (!route.ttlMs) return upstream(route, url, outBody);

    const cacheKey = `${method} ${path}?${qs}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > now()) return { status: hit.status, body: hit.body, headers: { "Cache-Control": "public, max-age=30", "X-Cache": "hit" } };
    const pending = inflight.get(cacheKey);
    if (pending) return pending;
    const p = upstream(route, url, outBody).then(result => {
      if (result.status === 200) {
        cache.set(cacheKey, { expires: now() + route.ttlMs!, status: 200, body: result.body });
        return { ...result, headers: { "Cache-Control": "public, max-age=30", "X-Cache": "miss" } };
      }
      return result;
    }).finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, p);
    return p;
  }

  return { handle, stockTokens };
}

export type SodaxProxy = ReturnType<typeof createSodaxProxy>;
