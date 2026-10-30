import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Minus, Plus } from "lucide-react";
import { useMarkets, type ChartRange, type MarketRow, CHART_RANGES } from "../lib/api";
import { BRAND } from "../lib/brand";
import { ASSETS, assetMeta } from "../lib/catalog";
import { amount as fmtAmount, direction, usd } from "../lib/format";
import { usePortfolioSeries, useHoldings } from "../lib/holdings";
import { openTrade, setTransfer } from "../lib/ui";
import { isConnected, requestWallet, useWallet } from "../lib/wallet";
import { AreaChart, type Point } from "../components/AreaChart";
import { Logo } from "../components/Mark";
import { AssetIcon, Change, EmptyState, Pills, Skeleton, Sparkline } from "../components/primitives";

const ACTIONS = [
  { key: "buy", label: "Buy", icon: Plus, run: () => openTrade("buy") },
  { key: "sell", label: "Sell", icon: Minus, run: () => openTrade("sell") },
  { key: "convert", label: "Convert", icon: ArrowLeftRight, run: () => openTrade("convert") },
  { key: "send", label: "Send", icon: ArrowUpRight, run: () => setTransfer("send") },
  { key: "receive", label: "Receive", icon: ArrowDownLeft, run: () => setTransfer("receive") },
] as const;

export function ActionButtons() {
  return (
    <div className="x-actions" role="group" aria-label="Actions">
      {ACTIONS.map(a => (
        <button key={a.key} type="button" className="x-action" onClick={a.run}>
          <span className="x-action-circle" aria-hidden="true"><a.icon size={22} /></span>
          <span className="x-action-label">{a.label}</span>
        </button>
      ))}
    </div>
  );
}

function BalanceHero() {
  const h = useHoldings();
  const [range, setRange] = useState<ChartRange>("1D");
  const [hover, setHover] = useState<Point | null>(null);
  const series = usePortfolioSeries(h.rows, range);
  const first = series.points[0]?.[1];
  const shown = hover ? hover[1] : h.total;
  const delta = range === "1D" && !hover ? h.change24hUsd : first != null ? shown - first : null;
  const deltaPct = range === "1D" && !hover ? h.change24hPct : first ? ((shown - first) / first) * 100 : null;
  const dir = direction(delta);

  return (
    <section className="x-hero" aria-labelledby="x-balance-label">
      <p id="x-balance-label" className="x-muted">Your balance</p>
      {h.loading ? <Skeleton w={220} h={44} /> : <p className="x-balance x-num" aria-live="polite">{usd(shown, { decimals: 2 })}</p>}
      <p className={`x-hero-change x-${dir}`}>
        {delta != null ? <><span className="x-num">{usd(delta, { sign: true, decimals: 2 })}</span> <Change value={deltaPct} /> <span className="x-muted">{hover ? "" : range === "ALL" ? "all time" : `past ${range === "1D" ? "day" : range}`}</span></> : <span className="x-muted">&nbsp;</span>}
      </p>
      <AreaChart points={series.points} height={200} onHover={setHover} label="Value of your current holdings" loading={series.loading || h.loading} />
      <Pills label="Chart range" value={range} options={CHART_RANGES} onChange={setRange} size="sm" />
      <p className="x-fine">Today's holdings valued at past prices.</p>
    </section>
  );
}

function ConnectHero() {
  return (
    <section className="x-hero x-hero-connect" aria-labelledby="x-connect-title">
      <Logo size={48} />
      <h1 id="x-connect-title" className="x-h1">Trade across every chain, from your own wallet</h1>
      <p className="x-muted">Buy, sell and convert 30+ assets across 20+ networks in one step. You keep your keys; SODAX solvers settle every trade.</p>
      <div className="x-hero-ctas">
        <button type="button" className="x-btn x-btn-primary x-btn-lg" onClick={() => requestWallet({ open: true })}>Connect wallet</button>
      </div>
    </section>
  );
}

function YourAssets() {
  const h = useHoldings();
  if (h.loading) return <section className="x-card" aria-busy="true"><h2 className="x-h2">Your assets</h2>{[0, 1, 2].map(i => <div key={i} className="x-row"><Skeleton w={36} h={36} r={18} /><Skeleton w="40%" /></div>)}</section>;
  return (
    <section className="x-card" aria-labelledby="x-assets-title">
      <div className="x-card-head"><h2 id="x-assets-title" className="x-h2">Your assets</h2><Link href="/portfolio" className="x-link">Portfolio</Link></div>
      {h.rows.length ? (
        <ul className="x-list">
          {h.rows.slice(0, 8).map(r => (
            <li key={r.symbol}>
              <Link href={`/asset/${r.symbol}`} className="x-row x-row-btn">
                <AssetIcon symbol={r.symbol} size={36} />
                <span className="x-row-main"><span className="x-row-title">{assetMeta(r.symbol)?.name ?? r.symbol}</span><span className="x-row-sub x-num">{fmtAmount(r.amount)} {r.symbol}{r.legs.length > 1 ? ` · ${r.legs.length} networks` : ""}</span></span>
                <span className="x-row-end"><span className="x-num">{usd(r.usd)}</span><Change value={r.change24h} /></span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No assets yet" action={<button type="button" className="x-btn x-btn-primary" onClick={() => openTrade("buy")}>Buy crypto</button>}>
          Supported assets in your connected wallets show up here.
        </EmptyState>
      )}
    </section>
  );
}

function MarketList({ rows, loading, limit }: { rows: MarketRow[]; loading: boolean; limit: number }) {
  const [, navigate] = useLocation();
  if (loading) {
    return <div className="x-list" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className="x-row"><Skeleton w={36} h={36} r={18} /><span className="x-row-main"><Skeleton w="50%" /><Skeleton w="25%" h={12} /></span><Skeleton w={96} h={32} className="x-hide-sm" /><Skeleton w={80} /></div>)}</div>;
  }
  return (
    <table className="x-table">
      <caption className="x-sr-only">Prices and 24-hour change</caption>
      <thead>
        <tr><th scope="col">Asset</th><th scope="col" className="x-hide-sm">Last 7 days</th><th scope="col" className="x-right">Price</th><th scope="col" className="x-right">24h</th></tr>
      </thead>
      <tbody>
        {rows.slice(0, limit).map(r => {
          const meta = assetMeta(r.symbol);
          return (
            <tr key={r.symbol} className="x-tr-link" onClick={() => navigate(`/asset/${r.symbol}`)}>
              <th scope="row">
                <Link href={`/asset/${r.symbol}`} className="x-asset-cell">
                  <AssetIcon symbol={r.symbol} size={32} />
                  <span className="x-row-main"><span className="x-row-title">{meta?.name ?? r.symbol}</span><span className="x-row-sub">{r.symbol}</span></span>
                </Link>
              </th>
              <td className="x-hide-sm"><Sparkline points={r.sparkline} dir={direction(r.change7d ?? r.change24h)} /></td>
              <td className="x-right x-num">{usd(r.price)}</td>
              <td className="x-right"><Change value={r.change24h} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function MiniCard({ title, rows, loading, empty }: { title: string; rows: MarketRow[]; loading: boolean; empty: string }) {
  return (
    <section className="x-card x-mini" aria-label={title}>
      <h3 className="x-h3">{title}</h3>
      {loading ? <div aria-busy="true">{[0, 1, 2].map(i => <div key={i} className="x-row"><Skeleton w={28} h={28} r={14} /><Skeleton w="60%" /></div>)}</div>
        : rows.length ? (
          <ul className="x-list">
            {rows.map(r => (
              <li key={r.symbol}>
                <Link href={`/asset/${r.symbol}`} className="x-row x-row-btn x-row-tight">
                  <AssetIcon symbol={r.symbol} size={28} />
                  <span className="x-row-main"><span className="x-row-title">{r.symbol}</span></span>
                  <span className="x-mini-quote"><span className="x-num">{usd(r.price)}</span><Change value={r.change24h} /></span>
                </Link>
              </li>
            ))}
          </ul>
        ) : <p className="x-muted x-small">{empty}</p>}
    </section>
  );
}

export function Markets({ title = "Explore" }: { title?: string }) {
  const { data, isLoading } = useMarkets();
  const [filter, setFilter] = useState<"all" | "gainers" | "losers" | "stable">("all");
  const listed = useMemo(() => {
    const known = new Set(ASSETS.map(a => a.symbol));
    return (data?.rows ?? []).filter(r => known.has(r.symbol.toUpperCase()));
  }, [data]);
  const cryptoOnly = listed.filter(r => assetMeta(r.symbol)?.kind !== "stable");
  const movers = [...cryptoOnly].filter(r => r.change24h != null).sort((a, b) => Math.abs(b.change24h!) - Math.abs(a.change24h!)).slice(0, 4);
  const trending = [...cryptoOnly].filter(r => r.volume24h != null).sort((a, b) => b.volume24h! - a.volume24h!).slice(0, 4);
  const fresh = cryptoOnly.filter(r => assetMeta(r.symbol)?.isNew).slice(0, 4);
  const filtered = useMemo(() => {
    const rows = [...listed].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
    if (filter === "gainers") return rows.filter(r => (r.change24h ?? 0) > 0).sort((a, b) => b.change24h! - a.change24h!);
    if (filter === "losers") return rows.filter(r => (r.change24h ?? 0) < 0).sort((a, b) => a.change24h! - b.change24h!);
    if (filter === "stable") return rows.filter(r => assetMeta(r.symbol)?.kind === "stable");
    return rows;
  }, [listed, filter]);
  const unavailable = !isLoading && (!data || data.status === "unavailable" || !listed.length);

  return (
    <>
      <div className="x-grid-3">
        <MiniCard title="Top movers" rows={movers} loading={isLoading} empty="Prices are unavailable right now." />
        <MiniCard title="Trending" rows={trending} loading={isLoading} empty="Prices are unavailable right now." />
        <MiniCard title={`New on ${BRAND.name}`} rows={fresh} loading={isLoading} empty="Nothing new this week." />
      </div>
      <section className="x-card" aria-labelledby="x-markets-title">
        <div className="x-card-head">
          <h2 id="x-markets-title" className="x-h2">{title}</h2>
          <Pills label="Filter markets" size="sm" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "gainers", label: "Gainers" }, { value: "losers", label: "Losers" }, { value: "stable", label: "Stablecoins" }]} />
        </div>
        {unavailable ? <EmptyState title="Prices are unavailable">Market data didn't load. Trading still works: quotes come straight from SODAX.</EmptyState>
          : <MarketList rows={filtered} loading={isLoading} limit={40} />}
        {data?.asOf ? <p className="x-fine">Reference prices, updated every minute. Your trade price comes from the SODAX quote.</p> : null}
      </section>
    </>
  );
}

export default function Home() {
  const wallet = useWallet();
  const connected = isConnected(wallet);
  return (
    <div className="x-page">
      {connected ? <h1 className="x-sr-only">{BRAND.name} home</h1> : null}
      <div className="x-home-top">
        <div className="x-card x-card-hero">
          {connected ? <BalanceHero /> : <ConnectHero />}
          <ActionButtons />
        </div>
        {connected ? <YourAssets /> : null}
      </div>
      <Markets />
    </div>
  );
}
