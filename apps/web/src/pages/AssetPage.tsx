import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, CandlestickChart } from "lucide-react";
import { CHART_RANGES, marketMap, tokensBySymbol, useChart, useMarkets, useSodaxTokens, type ChartRange } from "../lib/api";
import { BRAND } from "../lib/brand";
import { assetMeta, networkMeta, QUOTE_SYMBOL } from "../lib/catalog";
import { amount as fmtAmount, compact, direction, usd, usdCompact } from "../lib/format";
import { useHoldings } from "../lib/holdings";
import { openTrade } from "../lib/ui";
import { AreaChart, type Point } from "../components/AreaChart";
import { AssetIcon, Change, EmptyState, NetworkBadge, Pills, Skeleton } from "../components/primitives";

const RANGE_WORDS: Record<ChartRange, string> = { "1H": "past hour", "1D": "past day", "1W": "past week", "1M": "past month", "1Y": "past year", ALL: "all time" };

export function timeFormatter(range: ChartRange) {
  return (t: number) => new Date(t).toLocaleString(undefined, range === "1H" || range === "1D"
    ? { hour: "numeric", minute: "2-digit" }
    : range === "1W" || range === "1M" ? { month: "short", day: "numeric", hour: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export default function AssetPage({ symbol: raw }: { symbol: string }) {
  const symbol = raw.toUpperCase();
  const meta = assetMeta(symbol);
  const [range, setRange] = useState<ChartRange>("1D");
  const [hover, setHover] = useState<Point | null>(null);
  const { data: markets, isLoading: marketsLoading } = useMarkets();
  const chart = useChart(meta ? symbol : undefined, range);
  const { data: tokens } = useSodaxTokens();
  const holdings = useHoldings();

  const row = useMemo(() => marketMap(markets?.rows).get(symbol), [markets, symbol]);
  const networks = useMemo(() => {
    const list = tokensBySymbol(tokens).get(symbol) ?? [];
    return [...new Map(list.map(t => [t.chainKey, t])).values()];
  }, [tokens, symbol]);
  const held = holdings.rows.find(h => h.symbol === symbol);

  if (!meta) {
    return (
      <div className="x-page">
        <EmptyState title="We don't list that asset" action={<Link href="/" className="x-btn x-btn-primary">Back to markets</Link>}>
          {BRAND.name} lists assets that SODAX can settle. Search with ⌘K to find one.
        </EmptyState>
      </div>
    );
  }

  const points = chart.data?.status === "ok" ? chart.data.points : [];
  const first = points[0]?.[1];
  const shown = hover ? hover[1] : row?.price ?? null;
  const rangeChange = range === "1D" && !hover ? row?.change24h ?? null : first && shown != null ? ((shown - first) / first) * 100 : null;
  const rangeDelta = first != null && shown != null ? shown - first : null;
  const isStable = meta.kind === "stable";

  return (
    <div className="x-page x-page-asset">
      <Link href="/" className="x-back"><ArrowLeft size={18} aria-hidden="true" /> Home</Link>
      <div className="x-asset-layout">
        <div className="x-asset-main">
          <header className="x-asset-head">
            <AssetIcon symbol={symbol} size={48} />
            <div>
              <h1 className="x-h1 x-asset-name">{meta.name} <span className="x-muted x-asset-ticker">{symbol}</span></h1>
            </div>
          </header>
          <section className="x-card" aria-label={`${meta.name} price chart`}>
            {marketsLoading && !row ? <Skeleton w={200} h={40} /> : <p className="x-price x-num" aria-live="polite">{usd(shown)}</p>}
            <p className={`x-hero-change x-${direction(rangeChange)}`}>
              {rangeChange != null ? <><span className="x-num">{usd(rangeDelta, { sign: true })}</span> <Change value={rangeChange} /> <span className="x-muted">{hover ? "" : RANGE_WORDS[range]}</span></> : <span className="x-muted">&nbsp;</span>}
            </p>
            <AreaChart points={points} height={280} onHover={setHover} label={`${meta.name} price, ${RANGE_WORDS[range]}`} formatTime={timeFormatter(range)} loading={chart.isLoading} />
            <div className="x-chart-foot">
              <Pills label="Chart range" value={range} options={CHART_RANGES} onChange={setRange} size="sm" />
              {!isStable ? <Link href={`/trade/${symbol}-${QUOTE_SYMBOL}`} className="x-link x-small"><CandlestickChart size={16} aria-hidden="true" /> Advanced trade</Link> : null}
            </div>
          </section>

          {held ? (
            <section className="x-card" aria-labelledby="x-your-pos">
              <h2 id="x-your-pos" className="x-h2">Your {symbol}</h2>
              <dl className="x-stats">
                <div><dt className="x-muted x-small">Balance</dt><dd className="x-num x-strong">{fmtAmount(held.amount)} {symbol}</dd></div>
                <div><dt className="x-muted x-small">Value</dt><dd className="x-num x-strong">{usd(held.usd)}</dd></div>
              </dl>
              <ul className="x-chips-row" aria-label="By network">
                {held.legs.map(l => <li key={l.chainKey} className="x-net-chip"><NetworkBadge chainKey={l.chainKey} size={16} /> {networkMeta(l.chainKey).short} <span className="x-num x-muted">{fmtAmount(l.amount)}</span></li>)}
              </ul>
            </section>
          ) : null}

          <section className="x-card" aria-labelledby="x-stats-title">
            <h2 id="x-stats-title" className="x-h2">Market stats</h2>
            <dl className="x-stats">
              <div><dt className="x-muted x-small">Market cap</dt><dd className="x-num">{usdCompact(row?.marketCap)}</dd></div>
              <div><dt className="x-muted x-small">Volume (24h)</dt><dd className="x-num">{usdCompact(row?.volume24h)}</dd></div>
              <div><dt className="x-muted x-small">Circulating supply</dt><dd className="x-num">{row?.circulatingSupply != null ? `${compact(row.circulatingSupply)} ${symbol}` : "—"}</dd></div>
              <div><dt className="x-muted x-small">Max supply</dt><dd className="x-num">{row?.maxSupply != null ? `${compact(row.maxSupply)} ${symbol}` : "No cap"}</dd></div>
              <div><dt className="x-muted x-small">24h high</dt><dd className="x-num">{usd(row?.high24h)}</dd></div>
              <div><dt className="x-muted x-small">24h low</dt><dd className="x-num">{usd(row?.low24h)}</dd></div>
              <div><dt className="x-muted x-small">Popularity</dt><dd className="x-num">{row?.rank ? `#${row.rank}` : "—"}</dd></div>
              <div><dt className="x-muted x-small">7d change</dt><dd><Change value={row?.change7d} /></dd></div>
            </dl>
          </section>

          <section className="x-card" aria-labelledby="x-about-title">
            <h2 id="x-about-title" className="x-h2">About {meta.name}</h2>
            <p className="x-prose">{meta.about}</p>
            <h3 className="x-h3">Available on</h3>
            {networks.length ? (
              <ul className="x-chips-row" aria-label="Networks">
                {networks.map(t => <li key={t.chainKey} className="x-net-chip" title={t.symbol}><NetworkBadge chainKey={t.chainKey} size={16} /> {networkMeta(t.chainKey).short}</li>)}
              </ul>
            ) : tokens ? <p className="x-muted x-small">Not tradable on SODAX right now.</p> : <Skeleton w="70%" h={24} />}
          </section>
        </div>

        <aside className="x-asset-side" aria-label={`Trade ${symbol}`}>
          <div className="x-card x-trade-card">
            <h2 className="x-h3">Trade {meta.name}</h2>
            <p className="x-muted x-small">Pay with any of {networks.length || "20+"} networks. Settled by SODAX solvers, straight to your wallet.</p>
            <button type="button" className="x-btn x-btn-primary x-btn-block x-btn-lg" onClick={() => openTrade("buy", symbol)} disabled={isStable && symbol === QUOTE_SYMBOL}>Buy {symbol}</button>
            <button type="button" className="x-btn x-btn-ghost x-btn-block x-btn-lg" onClick={() => openTrade("sell", symbol)}>Sell {symbol}</button>
            <button type="button" className="x-btn x-btn-ghost x-btn-block" onClick={() => openTrade("convert", symbol)}>Convert</button>
          </div>
        </aside>
      </div>

      <div className="x-sticky-bar" role="region" aria-label={`Trade ${symbol}`}>
        <button type="button" className="x-btn x-btn-primary x-btn-lg" onClick={() => openTrade("buy", symbol)}>Buy</button>
        <button type="button" className="x-btn x-btn-ghost x-btn-lg" onClick={() => openTrade("sell", symbol)}>Sell</button>
      </div>
    </div>
  );
}
