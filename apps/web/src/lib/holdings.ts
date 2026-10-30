/**
 * Holdings across chains: the connected wallets' balances (read by the wallet runtime) joined with SODAX's token
 * list and reference prices. One row per asset, with a per-network breakdown (Clip's merged-portfolio model).
 */
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { canonicalSymbol } from "./catalog";
import { fromUnits } from "./format";
import { api, API_BASE, marketMap, useMarkets, useSodaxTokens, type ChartPayload, type ChartRange, type MarketRow } from "./api";
import { useWallet } from "./wallet";

export type HoldingLeg = { chainKey: string; tokenSymbol: string; address: string; decimals: number; units: string; amount: number; usd: number | null };
export type Holding = { symbol: string; amount: number; usd: number | null; price: number | null; change24h: number | null; legs: HoldingLeg[] };

export function useHoldings() {
  const wallet = useWallet();
  const { data: tokens, isLoading: tokensLoading } = useSodaxTokens();
  const { data: markets } = useMarkets();

  return useMemo(() => {
    const prices = marketMap(markets?.rows);
    const by = new Map<string, Holding>();
    if (tokens) {
      for (const [chainKey, list] of Object.entries(tokens)) {
        const bal = wallet.balances[chainKey];
        if (!bal || !Array.isArray(list)) continue;
        for (const t of list) {
          const raw = bal[t.address.toLowerCase()];
          if (!raw || raw === "0") continue;
          const symbol = canonicalSymbol(t.symbol) ?? t.symbol;
          const units = BigInt(raw);
          const amount = Number(fromUnits(units, t.decimals));
          const m: MarketRow | undefined = prices.get(symbol.toUpperCase());
          const leg: HoldingLeg = { chainKey, tokenSymbol: t.symbol, address: t.address, decimals: t.decimals, units: raw, amount, usd: m ? amount * m.price : null };
          const h = by.get(symbol) ?? { symbol, amount: 0, usd: null, price: m?.price ?? null, change24h: m?.change24h ?? null, legs: [] };
          h.amount += amount;
          if (leg.usd != null) h.usd = (h.usd ?? 0) + leg.usd;
          h.legs.push(leg);
          by.set(symbol, h);
        }
      }
    }
    const rows = [...by.values()].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
    for (const r of rows) r.legs.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    const total = rows.reduce((s, r) => s + (r.usd ?? 0), 0);
    // 24h change of the whole portfolio from each asset's 24h change.
    let before = 0;
    for (const r of rows) if (r.usd != null && r.change24h != null) before += r.usd / (1 + r.change24h / 100);
    const change24hUsd = before > 0 ? total - before : null;
    const change24hPct = before > 0 ? ((total - before) / before) * 100 : null;
    const balancesLoading = Object.values(wallet.accounts).some(Boolean) && Object.keys(wallet.balances).length === 0;
    return { rows, total, change24hUsd, change24hPct, loading: tokensLoading || balancesLoading };
  }, [wallet.balances, wallet.accounts, tokens, tokensLoading, markets]);
}

const STABLES = new Set(["USDC", "USDT", "DAI"]);
const SERIES_ASSETS = 8;

/**
 * Value of the current holdings over a range: each asset's amount times its price history (the eight largest
 * positions, stablecoins at $1). It shows how today's portfolio would have moved, not past balances, which the
 * hero's label says.
 */
export function usePortfolioSeries(rows: Holding[], range: ChartRange): { points: Array<[number, number]>; loading: boolean } {
  const priced = rows.filter(r => r.usd != null && r.usd > 0).slice(0, SERIES_ASSETS);
  const charted = priced.filter(r => !STABLES.has(r.symbol));
  const results = useQueries({
    queries: charted.map(r => ({
      queryKey: ["exclip", "chart", r.symbol, range],
      queryFn: ({ signal }: { signal: AbortSignal }) => api<ChartPayload>(`${API_BASE}/markets/${encodeURIComponent(r.symbol)}/chart?range=${range}`, { signal }),
      staleTime: range === "1H" || range === "1D" ? 60_000 : 600_000,
      retry: 1,
    })),
  });
  const loading = results.some(q => q.isLoading);
  const dataKey = results.map(q => q.dataUpdatedAt).join(",");

  // `results` is described by dataKey, and the holdings by the symbol:amount list.
  const points = useMemo(() => {
    const stableUsd = priced.filter(r => STABLES.has(r.symbol)).reduce((s, r) => s + (r.usd ?? 0), 0);
    const series = results.map((q, i) => ({ amount: charted[i]!.amount, pts: q.data?.status === "ok" ? q.data.points : [] })).filter(s => s.pts.length > 1);
    if (!series.length) return [] as Array<[number, number]>;
    // Use the longest series as the time axis and take each other asset's nearest earlier point.
    const axis = series.reduce((a, b) => (b.pts.length > a.pts.length ? b : a)).pts;
    const cursors = series.map(() => 0);
    return axis.map(([t]) => {
      let v = stableUsd;
      series.forEach((s, i) => {
        let c = cursors[i]!;
        while (c + 1 < s.pts.length && s.pts[c + 1]![0] <= t) c++;
        cursors[i] = c;
        v += s.amount * s.pts[c]![1];
      });
      return [t, v] as [number, number];
    });
  }, [dataKey, priced.map(r => `${r.symbol}:${r.amount}`).join(",")]);

  return { points, loading };
}
