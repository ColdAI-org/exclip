/**
 * ExClip's browser client for /api/exclip (apps/server). The SODAX key never reaches the browser: SODAX calls go
 * through /api/exclip/sodax/*, which adds it server-side. Every query runs in the browser through react-query, so a
 * page shows skeletons until its data arrives.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { canonicalSymbol } from "./catalog";
import { stockPassHeaders, stockRefusalText } from "./stock-gate";

export const API_BASE = "/api/exclip";
export const SODAX_BASE = `${API_BASE}/sodax`;

export type ExclipPublicConfig = {
  tradingEnabled: boolean;
  sodaxConfigured: boolean;
  /** A plain fee in basis points (fees.partnerFeeBps): 0 without one, with a fee rate and with a fee split. */
  partnerFeeBps: number;
  /** A plain fee's receiver (fees.receiver), in basis points or as a rate: null without one, and with a fee split. */
  feeReceiver: string | null;
  /** A plain fee given as a rate (fees.rate), or null: per 100,000 of the amount sold (docs/fees.md), and its own fee
   * in basis points on a swap with a tokenised stock on either side, 0 for none. */
  feeRate?: { rate: number; stockFeeBps: number } | null;
  /** Who the review names as getting a plain fee (fees.receiverName, or brand.name): null without one. */
  feeReceiverName?: string | null;
  /** A fee split (fees.split), or null. Rates are per 100,000 of the amount sold (docs/fee-split.md). */
  feeSplit?: PublicFeeSplit | null;
  /** Whether this server offers the passkey wallet (features.embeddedWallet). */
  embeddedWallet?: boolean;
  /** The wallet popup's exact origin, or null when the passkey wallet is off. */
  walletOrigin?: string | null;
  /** Until a passkey wallet is backed up, its owner is asked to keep it under this many US dollars. */
  unbackedLimitUsd?: number;
  /** Whether this server offers tokenised stocks (stocks.enabled). Off: no Stocks screen, and no stock in any list. */
  stocksEnabled?: boolean;
  /** The terms the user confirms before trading stocks (stocks.termsVersion), or null while stocks are off. */
  stocksTermsVersion?: string | null;
};

/** /config's feeSplit: one fee to the splitter, which pays the platform and the operator their shares. */
export type PublicFeeSplit = {
  /** The splitter's address, the fee's one receiver. */
  receiver: string;
  /** platform.rate + operator.rate. */
  totalRate: number;
  /** The platform's name comes from its factory's entry on the wallet's fee allow-list. */
  platform: { name: string; rate: number };
  operator: { name: string; rate: number };
  /** The operator's own plain fee on a swap with a tokenised stock on either side, which never pays the splitter; null
   * for no fee on those swaps. */
  stockFee: { receiver: string; bps: number } | null;
};

export type ChartRange = "1H" | "1D" | "1W" | "1M" | "1Y" | "ALL";
export const CHART_RANGES: ChartRange[] = ["1H", "1D", "1W", "1M", "1Y", "ALL"];

export type MarketRow = {
  symbol: string;
  price: number;
  change24h: number | null;
  change1h: number | null;
  change7d: number | null;
  marketCap: number | null;
  volume24h: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  high24h: number | null;
  low24h: number | null;
  rank: number | null;
  sparkline: number[];
};
export type MarketsPayload = { status: "ok" | "unavailable"; asOf: number | null; rows: MarketRow[] };
export type ChartPayload = { status: "ok" | "unavailable"; symbol: string; range: ChartRange; points: Array<[number, number]> };

export type SodaxToken = {
  symbol: string;
  name: string;
  decimals: number;
  address: string;
  chainKey: string;
  isRwa?: boolean;
  hubAsset?: string;
  vault?: string;
};

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfter?: number) { super(message); }
}

/** Plain-language messages for the codes the server returns; never echoes upstream bodies. */
function friendly(status: number, code: string, fallback: string): string {
  switch (code) {
    case "SODAX_NOT_CONFIGURED": return "Trading isn't connected on this server yet.";
    case "SODAX_RATE_LIMITED": return "The exchange network is busy. Trying again in a few seconds usually works.";
    case "TRADING_DISABLED": return "Trading is paused on this server. Quotes still work.";
    default:
      if (status === 451) return stockRefusalText({ status, code }) ?? (fallback || "This isn't available to you here.");
      if (status >= 500) return "The exchange network had a problem. Try again.";
      return fallback || "Something went wrong. Try again.";
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  // The stock check reads the self-certification on SODAX requests and on its own routes; nothing else gets it.
  const stockAware = path.startsWith(`${SODAX_BASE}/`) || path.startsWith(`${API_BASE}/stocks/`);
  const headers: Record<string, string> = { accept: "application/json", ...(stockAware ? stockPassHeaders() : {}) };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
    credentials: "same-origin",
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    const code = err?.code ?? (typeof (data as { code?: unknown })?.code === "string" ? (data as { code: string }).code : `HTTP_${res.status}`);
    const retry = Number(res.headers.get("retry-after"));
    throw new ApiError(res.status, code, friendly(res.status, code, err?.message ?? ""), Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  return data as T;
}

const sodax = <T>(path: string, init?: Parameters<typeof api>[1]) => api<T>(`${SODAX_BASE}/${path}`, init);

type Q<T> = Omit<UseQueryOptions<T, Error, T>, "queryKey" | "queryFn">;

export function useExclipConfig() {
  return useQuery({
    queryKey: ["exclip", "config"],
    queryFn: ({ signal }) => api<ExclipPublicConfig>(`${API_BASE}/config`, { signal }),
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * The SODAX SDK's options: its API calls go through this server's key proxy. It gets no partner fee of its own: each
 * swap passes the fee ./fees.ts works out (createIntent's extras.partnerFee), because a split's fee is an amount that
 * depends on the swap, and a swap with a stock in it must not fall back to one. A swap without a fee gets intents with
 * empty data, the only kind the wallet popup signs unless the receiver is on its reviewed fee allow-list.
 */
export function sodaxOptions(origin: string) {
  return { api: { baseURL: `${origin}${SODAX_BASE}` } };
}

export function useMarkets(opts: Q<MarketsPayload> = {}) {
  return useQuery({
    queryKey: ["exclip", "markets"],
    queryFn: ({ signal }) => api<MarketsPayload>(`${API_BASE}/markets`, { signal }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
    ...opts,
  });
}

export function useChart(symbol: string | undefined, range: ChartRange) {
  return useQuery({
    queryKey: ["exclip", "chart", symbol, range],
    queryFn: ({ signal }) => api<ChartPayload>(`${API_BASE}/markets/${encodeURIComponent(symbol!)}/chart?range=${range}`, { signal }),
    enabled: !!symbol,
    staleTime: range === "1H" || range === "1D" ? 60_000 : 600_000,
    placeholderData: prev => (prev && prev.symbol === symbol ? prev : undefined),
    retry: 1,
  });
}

export type TokensByChain = Record<string, SodaxToken[]>;

export function useSodaxTokens() {
  return useQuery({
    queryKey: ["exclip", "sodax", "tokens"],
    queryFn: ({ signal }) => sodax<TokensByChain>("swaps/tokens", { signal }),
    staleTime: 5 * 60_000,
    retry: (n, e) => n < 1 && !(e instanceof ApiError && e.status === 503),
  });
}

/** Every SODAX token that is one of the catalog's assets, grouped by catalog symbol. */
export function tokensBySymbol(tokens: TokensByChain | undefined): Map<string, SodaxToken[]> {
  const out = new Map<string, SodaxToken[]>();
  if (!tokens) return out;
  for (const [chainKey, list] of Object.entries(tokens)) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      const sym = canonicalSymbol(t.symbol);
      if (!sym) continue;
      const entry = { ...t, chainKey: t.chainKey ?? chainKey };
      out.set(sym, [...(out.get(sym) ?? []), entry]);
    }
  }
  return out;
}

export type QuoteRequest = {
  tokenSrc: string;
  tokenSrcChainKey: string;
  tokenDst: string;
  tokenDstChainKey: string;
  amount: string;
  quoteType: "exact_input";
};

export function fetchQuote(req: QuoteRequest, signal?: AbortSignal) {
  return sodax<{ quotedAmount: string }>("swaps/quote", { body: req, signal });
}

export function fetchPartnerFee(amount: string, signal?: AbortSignal) {
  return sodax<{ fee?: string; feeAmount?: string } & Record<string, unknown>>(`swaps/fees/partner?amount=${encodeURIComponent(amount)}`, { signal });
}

export function marketMap(rows: MarketRow[] | undefined): Map<string, MarketRow> {
  return new Map((rows ?? []).map(r => [r.symbol.toUpperCase(), r]));
}
