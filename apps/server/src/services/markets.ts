/** Reference prices for ExClip's Markets lists and charts: CoinGecko, cached in process. On any upstream failure the
 * answer is an explicit empty state, never invented numbers. The executable price always comes from a SODAX quote,
 * not from here. */
import type { ServerConfig } from "./config.ts";
import type { FetchLike } from "./sodaxProxy.ts";

/** ExClip symbol → CoinGecko id. Only these ids are ever requested (clients cannot name others). */
export const COINGECKO_IDS: Readonly<Record<string, string>> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin", HBAR: "hedera-hashgraph",
  USDC: "usd-coin", USDT: "tether", AVAX: "avalanche-2", SUI: "sui", XLM: "stellar", NEAR: "near",
  INJ: "injective-protocol", POL: "polygon-ecosystem-token", HYPE: "hyperliquid", S: "sonic-3",
  ICX: "icon", STX: "blockstack", KAIA: "kaia", LINK: "chainlink", AAVE: "aave", UNI: "uniswap",
  DOGE: "dogecoin", XRP: "ripple", ADA: "cardano", DOT: "polkadot", PEPE: "pepe", ENA: "ethena",
  ARB: "arbitrum", OP: "optimism", CAKE: "pancakeswap-token", JUP: "jupiter-exchange-solana",
  BONK: "bonk", PYTH: "pyth-network", DAI: "dai", ZEC: "zcash", CRV: "curve-dao-token",
};

export const CHART_RANGES = ["1H", "1D", "1W", "1M", "1Y", "ALL"] as const;
export type ChartRange = typeof CHART_RANGES[number];
const RANGE_DAYS: Record<ChartRange, string> = { "1H": "1", "1D": "1", "1W": "7", "1M": "30", "1Y": "365", ALL: "max" };
const RANGE_TTL: Record<ChartRange, number> = { "1H": 60_000, "1D": 120_000, "1W": 600_000, "1M": 1_800_000, "1Y": 3_600_000, ALL: 3_600_000 };

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

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Thin a series to at most `max` points (keeps first and last) so sparklines stay small on the wire. */
export function downsample<T>(values: readonly T[], max: number): T[] {
  if (values.length <= max) return [...values];
  const out: T[] = [];
  const step = (values.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)]!);
  return out;
}

export function createMarkets(options: { config: ServerConfig; fetch?: FetchLike; now?: () => number; timeoutMs?: number }) {
  const { config } = options;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const bySymbol = new Map(Object.entries(COINGECKO_IDS).map(([s, id]) => [id, s]));
  let markets: { expires: number; payload: MarketsPayload } | null = null;
  let marketsInflight: Promise<MarketsPayload> | null = null;
  const charts = new Map<string, { expires: number; payload: ChartPayload }>();

  async function getJson(path: string): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (config.coingeckoKey) headers["x-cg-pro-api-key"] = config.coingeckoKey;
    const res = await doFetch(`${config.coingeckoBase}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    return res.json();
  }

  async function loadMarkets(): Promise<MarketsPayload> {
    const ids = Object.values(COINGECKO_IDS).join(",");
    try {
      const raw = await getJson(`/coins/markets?vs_currency=usd&ids=${ids}&sparkline=true&price_change_percentage=1h,24h,7d&per_page=250`);
      if (!Array.isArray(raw)) throw new Error("shape");
      const rows: MarketRow[] = [];
      for (const r of raw as Array<Record<string, unknown>>) {
        const symbol = bySymbol.get(String(r.id));
        const price = num(r.current_price);
        if (!symbol || price === null) continue;
        const spark = (r.sparkline_in_7d as { price?: unknown } | undefined)?.price;
        rows.push({
          symbol, price,
          change24h: num(r.price_change_percentage_24h_in_currency) ?? num(r.price_change_percentage_24h),
          change1h: num(r.price_change_percentage_1h_in_currency),
          change7d: num(r.price_change_percentage_7d_in_currency),
          marketCap: num(r.market_cap), volume24h: num(r.total_volume),
          circulatingSupply: num(r.circulating_supply), totalSupply: num(r.total_supply), maxSupply: num(r.max_supply),
          high24h: num(r.high_24h), low24h: num(r.low_24h), rank: num(r.market_cap_rank),
          sparkline: Array.isArray(spark) ? downsample(spark.filter((v): v is number => typeof v === "number" && Number.isFinite(v)), 42) : [],
        });
      }
      const payload: MarketsPayload = { status: "ok", asOf: now(), rows };
      markets = { expires: now() + 60_000, payload };
      return payload;
    } catch {
      // Keep serving the last good answer for a while; otherwise say so plainly.
      if (markets && now() - (markets.payload.asOf ?? 0) < 15 * 60_000) return markets.payload;
      const payload: MarketsPayload = { status: "unavailable", asOf: null, rows: [] };
      markets = { expires: now() + 15_000, payload };
      return payload;
    }
  }

  return {
    async list(): Promise<MarketsPayload> {
      if (markets && markets.expires > now()) return markets.payload;
      marketsInflight ??= loadMarkets().finally(() => { marketsInflight = null; });
      return marketsInflight;
    },
    async chart(symbol: string, range: ChartRange): Promise<ChartPayload | null> {
      const id = COINGECKO_IDS[symbol];
      if (!id) return null;
      const key = `${symbol}|${range}`;
      const hit = charts.get(key);
      if (hit && hit.expires > now()) return hit.payload;
      try {
        const raw = await getJson(`/coins/${id}/market_chart?vs_currency=usd&days=${RANGE_DAYS[range]}`) as { prices?: unknown };
        if (!Array.isArray(raw.prices)) throw new Error("shape");
        let points = (raw.prices as unknown[]).filter((p): p is [number, number] =>
          Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number" && Number.isFinite(p[1]));
        if (range === "1H") { const cut = (points.at(-1)?.[0] ?? 0) - 3_600_000; points = points.filter(p => p[0] >= cut); }
        const payload: ChartPayload = { status: "ok", symbol, range, points: downsample(points, 240) };
        charts.set(key, { expires: now() + RANGE_TTL[range], payload });
        if (charts.size > 500) charts.delete(charts.keys().next().value!);
        return payload;
      } catch {
        if (hit) return hit.payload;
        return { status: "unavailable", symbol, range, points: [] };
      }
    },
  };
}

export type Markets = ReturnType<typeof createMarkets>;
