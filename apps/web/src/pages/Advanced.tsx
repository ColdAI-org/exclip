import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Info, Loader2 } from "lucide-react";
import {
  CHART_RANGES, fetchQuote, marketMap, tokensBySymbol, useChart, useExclipConfig, useMarkets, useSodaxTokens, type ChartRange,
} from "../lib/api";
import { BRAND } from "../lib/brand";
import { assetMeta, HUB_TX_URL, nameOf, networkMeta, pairOf, QUOTE_SYMBOL, TRADE_PAIRS } from "../lib/catalog";
import { amount as fmtAmount, fromUnits, pct, plain, toUnits, usd, usdCompact } from "../lib/format";
import { addActivity, isOpen, updateActivity, useActivity, type Activity } from "../lib/activity";
import { balanceOf, pickChain } from "../lib/tokens";
import { openTrade } from "../lib/ui";
import { isConnected, requestWallet, useWallet, walletActions } from "../lib/wallet";
import { AreaChart, type Point } from "../components/AreaChart";
import { AssetIcon, Change, EmptyState, NetworkBadge, Pills, Skeleton, Tabs } from "../components/primitives";
import { timeFormatter } from "./AssetPage";

type Side = "buy" | "sell";
type OrderType = "market" | "limit";
const EXPIRY = [
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "1 day" },
  { value: "604800", label: "7 days" },
  { value: "2592000", label: "30 days" },
  { value: "0", label: "No expiry" },
] as const;

function OrderPanel({ base, quote, price }: { base: string; quote: string; price: number | null }) {
  const wallet = useWallet();
  const { data: config } = useExclipConfig();
  const { data: tokens } = useSodaxTokens();
  const bySymbol = useMemo(() => tokensBySymbol(tokens), [tokens]);
  const [side, setSide] = useState<Side>("buy");
  const [type, setType] = useState<OrderType>("limit");
  const [qty, setQty] = useState("");
  const [limit, setLimit] = useState("");
  const [expiry, setExpiry] = useState<string>("86400");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const baseList = bySymbol.get(base) ?? [];
  const quoteList = bySymbol.get(quote) ?? [];
  const baseChain = pickChain(baseList, wallet);
  const quoteChain = pickChain(quoteList, wallet, baseChain);
  const baseToken = baseList.find(t => t.chainKey === baseChain) ?? null;
  const quoteToken = quoteList.find(t => t.chainKey === quoteChain) ?? null;
  const pay = side === "buy" ? quoteToken : baseToken;
  const get = side === "buy" ? baseToken : quoteToken;

  const qtyN = Number(qty.replace(/,/g, ""));
  const limitN = Number((limit || (price ? plain(price, 6) : "")).replace(/,/g, ""));
  const totalQuote = Number.isFinite(qtyN) && Number.isFinite(limitN) ? qtyN * limitN : NaN;
  const vsMarket = price && limitN ? ((limitN - price) / price) * 100 : null;
  const payBal = pay ? balanceOf(wallet, pay) : 0n;

  const amounts = () => {
    if (!baseToken || !quoteToken || !(qtyN > 0) || !(limitN > 0)) return null;
    const baseUnits = toUnits(plain(qtyN, Math.min(baseToken.decimals, 10)), baseToken.decimals);
    const quoteUnits = toUnits(plain(totalQuote, Math.min(quoteToken.decimals, 8)), quoteToken.decimals);
    if (!baseUnits || !quoteUnits) return null;
    return side === "buy" ? { input: quoteUnits, minOut: baseUnits } : { input: baseUnits, minOut: quoteUnits };
  };
  const a = amounts();
  const insufficient = isConnected(wallet) && !!a && a.input > payBal;

  const place = async () => {
    setMsg(null);
    if (type === "market") { openTrade(side, base); return; }
    const actions = walletActions();
    if (!actions || !isConnected(wallet)) { requestWallet({ open: true }); return; }
    if (!a || !pay || !get) return;
    const secs = Number(expiry);
    const expiresAt = secs ? Math.floor(Date.now() / 1000) + secs : null;
    const id = `limit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setBusy(true);
    try {
      const out = await actions.swap({
        srcChainKey: pay.chainKey, dstChainKey: get.chainKey, inputToken: pay.address, outputToken: get.address,
        inputAmount: a.input, minOutputAmount: a.minOut, deadline: BigInt(expiresAt ?? 0), kind: "limit",
      }, () => {});
      addActivity({
        id, kind: "limit", status: "open",
        from: { symbol: side === "buy" ? quote : base, chainKey: pay.chainKey, amount: fromUnits(a.input, pay.decimals) },
        to: { symbol: side === "buy" ? base : quote, chainKey: get.chainKey, amount: fromUnits(a.minOut, get.decimals), minAmount: fromUnits(a.minOut, get.decimals) },
        limitPrice: plain(limitN, 8), expiresAt, srcTxHash: out.srcTxHash, hubTxHash: out.hubTxHash, intent: out.intent,
      });
      setMsg({ kind: "ok", text: "Limit order placed. It fills when a solver can meet your price." });
      setQty("");
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "The order wasn't placed." });
    } finally { setBusy(false); }
  };

  const tradingOff = config && !config.tradingEnabled;
  return (
    <section className="x-card x-order" aria-labelledby="x-order-title">
      <h2 id="x-order-title" className="x-sr-only">Place an order</h2>
      <Tabs idBase="x-side" label="Side" value={side} onChange={setSide} options={[{ value: "buy", label: `Buy ${base}` }, { value: "sell", label: `Sell ${base}` }]} />
      <div id="x-side-panel" role="tabpanel" aria-labelledby={`x-side-tab-${side}`} className="x-stack">
        <Pills label="Order type" value={type} onChange={setType} options={[{ value: "market", label: "Market" }, { value: "limit", label: "Limit" }]} size="sm" />
        {type === "limit" ? (
          <label className="x-field">
            <span className="x-small x-muted">Limit price ({quote} per {base})</span>
            <input className="x-input x-num" inputMode="decimal" value={limit} placeholder={price ? plain(price, 6) : "0"} onChange={e => setLimit(e.target.value.replace(/[^\d.,]/g, ""))} />
            {vsMarket != null && Number.isFinite(vsMarket) ? <span className="x-fine">{pct(vsMarket)} vs. reference price</span> : null}
          </label>
        ) : null}
        <label className="x-field">
          <span className="x-small x-muted">Amount ({base})</span>
          <input className="x-input x-num" inputMode="decimal" value={qty} placeholder="0" onChange={e => setQty(e.target.value.replace(/[^\d.,]/g, ""))} />
        </label>
        {type === "limit" ? (
          <label className="x-field">
            <span className="x-small x-muted">Expires</span>
            <select className="x-input" value={expiry} onChange={e => setExpiry(e.target.value)}>
              {EXPIRY.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        ) : null}
        <dl className="x-dl x-dl-tight">
          <div className="x-dl-row"><dt>{side === "buy" ? "You pay (max)" : "You receive (min)"}</dt><dd className="x-num">{Number.isFinite(totalQuote) && totalQuote > 0 ? `${fmtAmount(totalQuote)} ${quote}` : "—"}</dd></div>
          <div className="x-dl-row"><dt>Pay from</dt><dd>{pay ? <span className="x-route"><NetworkBadge chainKey={pay.chainKey} /> {networkMeta(pay.chainKey).short}</span> : "—"}</dd></div>
          <div className="x-dl-row"><dt>Receive on</dt><dd>{get ? <span className="x-route"><NetworkBadge chainKey={get.chainKey} /> {networkMeta(get.chainKey).short}</span> : "—"}</dd></div>
          {isConnected(wallet) && pay ? <div className="x-dl-row"><dt>Available</dt><dd className="x-num">{fmtAmount(Number(fromUnits(payBal, pay.decimals)))} {side === "buy" ? quote : base}</dd></div> : null}
        </dl>
        {insufficient ? <p className="x-warn-text x-small" role="alert">Not enough {side === "buy" ? quote : base} on {networkMeta(pay!.chainKey).short}.</p> : null}
        {msg ? <p className={msg.kind === "ok" ? "x-banner" : "x-banner x-banner-warn"} role={msg.kind === "ok" ? "status" : "alert"}>{msg.text}</p> : null}
        <button
          type="button"
          className={`x-btn x-btn-block x-btn-lg ${side === "buy" ? "x-btn-primary" : "x-btn-sell"}`}
          onClick={place}
          disabled={busy || (type === "limit" && (!a || insufficient || !!tradingOff))}
        >
          {busy ? <><Loader2 size={18} className="x-spin" aria-hidden="true" /> Confirm in wallet…</>
            : type === "market" ? `Review market ${side}`
            : tradingOff ? "Trading is paused"
            : !isConnected(wallet) ? "Connect wallet"
            : `Place limit ${side}`}
        </button>
        {type === "limit" ? <p className="x-fine">A limit order is a SODAX intent with your minimum price. It can fill partly, in pieces, until it's complete, cancelled or expired.</p> : null}
      </div>
    </section>
  );
}

function BestRoute({ base, quote, price }: { base: string; quote: string; price: number | null }) {
  const wallet = useWallet();
  const { data: tokens } = useSodaxTokens();
  const bySymbol = useMemo(() => tokensBySymbol(tokens), [tokens]);
  const baseList = bySymbol.get(base) ?? [];
  const quoteList = bySymbol.get(quote) ?? [];
  const baseChain = pickChain(baseList, wallet);
  const quoteChain = pickChain(quoteList, wallet, baseChain);
  const bt = baseList.find(t => t.chainKey === baseChain);
  const qt = quoteList.find(t => t.chainKey === quoteChain);
  const one = bt ? (10n ** BigInt(bt.decimals)) : null;
  const q = useQuery({
    queryKey: ["exclip", "best", bt?.address, baseChain, qt?.address, quoteChain],
    queryFn: ({ signal }) => fetchQuote({ tokenSrc: bt!.address, tokenSrcChainKey: baseChain!, tokenDst: qt!.address, tokenDstChainKey: quoteChain!, amount: one!.toString(), quoteType: "exact_input" }, signal),
    enabled: !!bt && !!qt && !!one,
    refetchInterval: 30_000,
    staleTime: 20_000,
    retry: 1,
  });
  const out = q.data?.quotedAmount && qt && /^\d+$/.test(q.data.quotedAmount) ? Number(fromUnits(BigInt(q.data.quotedAmount), qt.decimals)) : null;
  const spread = out && price ? ((out - price) / price) * 100 : null;

  return (
    <section className="x-card" aria-labelledby="x-route-title">
      <h2 id="x-route-title" className="x-h3">Best route now</h2>
      {q.isLoading ? <Skeleton w="80%" h={20} /> : out ? (
        <>
          <p className="x-num x-strong">1 {base} → {fmtAmount(out)} {quote}</p>
          <p className="x-small x-muted"><span className="x-route"><NetworkBadge chainKey={baseChain!} /> {networkMeta(baseChain!).short} → <NetworkBadge chainKey={quoteChain!} /> {networkMeta(quoteChain!).short}</span>{spread != null ? <> · <span className="x-num">{pct(spread)}</span> vs. reference</> : null}</p>
        </>
      ) : <p className="x-muted x-small">No live quote for this pair right now.</p>}
      <details className="x-details">
        <summary><Info size={14} aria-hidden="true" /> Why there's no order book</summary>
        <p className="x-small x-muted">{BRAND.name} doesn't run a matching engine. Every order is an intent that SODAX solvers compete to fill from liquidity across all connected networks. There are no resting bids and asks to show, so we show what you'd actually get: the live best route, and your own fills below.</p>
      </details>
    </section>
  );
}

function statusLabel(a: Activity) {
  switch (a.status) {
    case "open": return "Open";
    case "pending": return "Submitting";
    case "solving": return "Solving";
    case "settled": return "Filled";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    case "expired": return "Expired";
  }
}

function Orders({ base, quote }: { base: string; quote: string }) {
  const list = useActivity().filter(a => [a.from.symbol, a.to?.symbol].includes(base) && [a.from.symbol, a.to?.symbol].includes(quote));
  const [tab, setTab] = useState<"open" | "history">("open");
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const shown = list.filter(a => (tab === "open" ? isOpen(a) : !isOpen(a)));

  const cancel = async (a: Activity) => {
    setErr(null);
    const actions = walletActions();
    if (!actions) { requestWallet({ open: true }); return; }
    if (!a.intent) return;
    setCancelling(a.id);
    try {
      await actions.cancel({ srcChainKey: a.from.chainKey, intent: a.intent, kind: a.kind === "limit" ? "limit" : "market" });
      updateActivity(a.id, { status: "cancelled" });
    } catch (e) { setErr(e instanceof Error ? e.message : "Cancel failed."); } finally { setCancelling(null); }
  };

  return (
    <section className="x-card" aria-label="Your orders">
      <Tabs idBase="x-orders" label="Orders" value={tab} onChange={setTab} options={[{ value: "open", label: "Open orders", badge: list.filter(isOpen).length ? <span className="x-badge">{list.filter(isOpen).length}</span> : undefined }, { value: "history", label: "Order history" }]} />
      <div id="x-orders-panel" role="tabpanel" aria-labelledby={`x-orders-tab-${tab}`}>
        {err ? <p className="x-banner x-banner-warn" role="alert">{err}</p> : null}
        {shown.length ? (
          <div className="x-table-wrap">
            <table className="x-table x-table-compact">
              <thead><tr><th scope="col">Date</th><th scope="col">Side</th><th scope="col" className="x-right">Amount</th><th scope="col" className="x-right">Price</th><th scope="col">Status</th><th scope="col"><span className="x-sr-only">Actions</span></th></tr></thead>
              <tbody>
                {shown.map(a => {
                  const buy = a.to?.symbol === base;
                  return (
                    <tr key={a.id}>
                      <td className="x-num x-small">{new Date(a.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                      <td className={buy ? "x-up" : "x-down"}>{buy ? "Buy" : "Sell"} <span className="x-muted x-small">{a.kind === "limit" ? "limit" : "market"}</span></td>
                      <td className="x-right x-num">{fmtAmount(Number(buy ? a.to?.amount : a.from.amount))} {base}</td>
                      <td className="x-right x-num">{a.limitPrice ? fmtAmount(Number(a.limitPrice)) : "—"}</td>
                      <td>{statusLabel(a)}{a.expiresAt && isOpen(a) ? <span className="x-muted x-small"> · until {new Date(a.expiresAt * 1000).toLocaleDateString()}</span> : a.kind === "limit" && isOpen(a) ? <span className="x-muted x-small"> · no expiry</span> : null}</td>
                      <td className="x-right">
                        {isOpen(a) && a.intent ? <button type="button" className="x-btn x-btn-ghost x-btn-sm" onClick={() => cancel(a)} disabled={cancelling === a.id}>{cancelling === a.id ? "Cancelling…" : "Cancel"}</button>
                          : a.hubTxHash ? <a className="x-link x-small" href={HUB_TX_URL + a.hubTxHash} target="_blank" rel="noreferrer noopener" aria-label="View on the SODAX hub explorer"><ExternalLink size={14} aria-hidden="true" /></a> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title={tab === "open" ? "No open orders" : "No orders yet"}>Orders you place on this pair from this browser appear here.</EmptyState>}
      </div>
    </section>
  );
}

export default function Advanced({ pair: param }: { pair?: string }) {
  const pair = pairOf(param ?? `BTC-${QUOTE_SYMBOL}`);
  const [, navigate] = useLocation();
  const [range, setRange] = useState<ChartRange>("1D");
  const [hover, setHover] = useState<Point | null>(null);
  const { data: markets } = useMarkets();
  const chart = useChart(pair?.base, range);
  const row = useMemo(() => (pair ? marketMap(markets?.rows).get(pair.base) : undefined), [markets, pair]);
  const quoteRow = useMemo(() => (pair ? marketMap(markets?.rows).get(pair.quote) : undefined), [markets, pair]);

  if (!pair) {
    return <div className="x-page"><EmptyState title="Unknown market" action={<Link href={`/trade/BTC-${QUOTE_SYMBOL}`} className="x-btn x-btn-primary">Open BTC-USDC</Link>}>Pick a pair like ETH-USDC.</EmptyState></div>;
  }
  const { base, quote } = pair;
  // Reference prices are in USD; divide by the quote's USD price for a cross rate.
  const qp = quote === "USDC" || quote === "USDT" ? 1 : quoteRow?.price ?? null;
  const price = row?.price != null && qp ? row.price / qp : null;
  const points = chart.data?.status === "ok" ? chart.data.points.map(([t, v]) => [t, qp ? v / qp : v] as [number, number]) : [];

  return (
    <div className="x-page x-page-adv">
      <header className="x-pair-head">
        <div className="x-pair-id">
          <AssetIcon symbol={base} size={36} />
          <h1 className="x-h2">{base}<span className="x-muted"> / {quote}</span></h1>
          <label className="x-sr-only" htmlFor="x-pair-select">Change market</label>
          <select id="x-pair-select" className="x-input x-input-sm" value={`${base}-${quote}`} onChange={e => navigate(`/trade/${e.target.value}`)}>
            {TRADE_PAIRS.includes(`${base}-${quote}`) ? null : <option value={`${base}-${quote}`}>{base}-{quote}</option>}
            {TRADE_PAIRS.map(p => <option key={p} value={p}>{p.replace("-", " / ")}</option>)}
          </select>
        </div>
        <dl className="x-pair-stats">
          <div><dt className="x-muted x-small">Price</dt><dd className="x-num x-strong">{price != null ? `${fmtAmount(hover ? hover[1] : price)} ${quote}` : "—"}</dd></div>
          <div><dt className="x-muted x-small">24h change</dt><dd><Change value={row?.change24h} /></dd></div>
          <div><dt className="x-muted x-small">24h high</dt><dd className="x-num">{usd(row?.high24h)}</dd></div>
          <div><dt className="x-muted x-small">24h low</dt><dd className="x-num">{usd(row?.low24h)}</dd></div>
          <div><dt className="x-muted x-small">24h volume</dt><dd className="x-num">{usdCompact(row?.volume24h)}</dd></div>
        </dl>
      </header>
      <div className="x-adv-grid">
        <div className="x-adv-chart x-card">
          <AreaChart points={points} height={360} onHover={setHover} label={`${nameOf(base)} price in ${quote}`} formatTime={timeFormatter(range)} loading={chart.isLoading} />
          <div className="x-chart-foot">
            <Pills label="Chart range" value={range} options={CHART_RANGES} onChange={setRange} size="sm" />
            <Link href={`/asset/${base}`} className="x-link x-small">About {assetMeta(base)?.name ?? base}</Link>
          </div>
        </div>
        <div className="x-adv-side">
          <OrderPanel key={`${base}-${quote}`} base={base} quote={quote} price={price} />
          <BestRoute base={base} quote={quote} price={price} />
        </div>
        <div className="x-adv-orders"><Orders base={base} quote={quote} /></div>
      </div>
    </div>
  );
}
