import { Fragment, useState } from "react";
import { Link } from "wouter";
import { ChevronDown, Download, ExternalLink } from "lucide-react";
import { BRAND } from "../lib/brand";
import { assetMeta, HUB_TX_URL, nameOf, networkMeta } from "../lib/catalog";
import { amount as fmtAmount, pct, usd } from "../lib/format";
import { activityCsv, downloadText, useActivity, type Activity } from "../lib/activity";
import { useHoldings } from "../lib/holdings";
import { openTrade } from "../lib/ui";
import { isConnected, requestWallet, useWallet } from "../lib/wallet";
import { Donut } from "../components/Donut";
import { AssetIcon, Change, EmptyState, NetworkBadge, Skeleton } from "../components/primitives";

const KIND: Record<Activity["kind"], string> = { swap: "Trade", limit: "Limit order" };
const STATUS: Record<Activity["status"], string> = { pending: "Submitting", open: "Open", solving: "Solving", settled: "Complete", failed: "Failed", cancelled: "Cancelled", expired: "Expired" };
/** The export's file name starts with the brand, reduced to something every file system accepts. */
const CSV_PREFIX = BRAND.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "exclip";

function ActivityList() {
  const list = useActivity();
  if (!list.length) return <EmptyState title="No activity yet">Trades and orders you make in this browser show up here.</EmptyState>;
  return (
    <ul className="x-list">
      {list.slice(0, 50).map(a => {
        const src = networkMeta(a.from.chainKey).txUrl;
        const link = a.hubTxHash ? HUB_TX_URL + a.hubTxHash : src && a.srcTxHash ? src + a.srcTxHash : null;
        return (
          <li key={a.id} className="x-row">
            <AssetIcon symbol={a.to?.symbol ?? a.from.symbol} size={32} />
            <span className="x-row-main">
              <span className="x-row-title">{KIND[a.kind]}: {a.from.symbol}{a.to ? ` → ${a.to.symbol}` : ""}</span>
              <span className="x-row-sub">{new Date(a.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · {STATUS[a.status]}</span>
            </span>
            <span className="x-row-end">
              <span className="x-num">−{fmtAmount(Number(a.from.amount))} {a.from.symbol}</span>
              {a.to?.amount ? <span className="x-num x-small x-muted">+{fmtAmount(Number(a.to.amount))} {a.to.symbol}</span> : null}
            </span>
            {link ? <a className="x-icon-btn" href={link} target="_blank" rel="noreferrer noopener" aria-label="View on explorer"><ExternalLink size={16} aria-hidden="true" /></a> : null}
          </li>
        );
      })}
    </ul>
  );
}

export default function Portfolio() {
  const wallet = useWallet();
  const h = useHoldings();
  const activity = useActivity();
  const [open, setOpen] = useState<string | null>(null);
  const connected = isConnected(wallet);

  const priced = h.rows.filter(r => r.usd != null && r.usd > 0);
  const top = priced.slice(0, 6);
  const other = priced.slice(6).reduce((s, r) => s + (r.usd ?? 0), 0);
  const slices = [...top.map(r => ({ label: r.symbol, value: r.usd!, hue: assetMeta(r.symbol)?.hue ?? 200 })), ...(other > 0 ? [{ label: "Other", value: other, hue: 0 }] : [])];

  return (
    <div className="x-page">
      <header className="x-page-head x-page-head-row">
        <div>
          <h1 className="x-h1">Portfolio</h1>
          <p className="x-muted">Everything in your connected wallets that {BRAND.name} can trade, across every network.</p>
        </div>
        <button type="button" className="x-btn x-btn-ghost" onClick={() => downloadText(`${CSV_PREFIX}-activity-${new Date().toISOString().slice(0, 10)}.csv`, activityCsv(activity))} disabled={!activity.length}>
          <Download size={16} aria-hidden="true" /> Export CSV
        </button>
      </header>

      {!connected ? (
        <section className="x-card">
          <EmptyState title="Connect a wallet to see your portfolio" action={<button type="button" className="x-btn x-btn-primary" onClick={() => requestWallet({ open: true })}>Connect wallet</button>}>
            {BRAND.name} reads balances straight from the networks. Nothing is stored on the server.
          </EmptyState>
        </section>
      ) : (
        <div className="x-portfolio-grid">
          <section className="x-card x-alloc" aria-labelledby="x-alloc-title">
            <h2 id="x-alloc-title" className="x-h2">Allocation</h2>
            {h.loading ? <Skeleton w={168} h={168} r={84} /> : slices.length ? (
              <div className="x-alloc-body">
                <Donut slices={slices} total={h.total} />
                <ul className="x-legend">
                  {slices.map(s => (
                    <li key={s.label}>
                      <span className="x-legend-dot" style={{ background: `hsl(${s.hue} 70% 55%)` }} aria-hidden="true" />
                      <span>{s.label}</span>
                      <span className="x-num x-muted">{pct((s.value / (h.total || 1)) * 100, { sign: false, decimals: 1 })}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : <p className="x-muted">No priced assets yet.</p>}
            <dl className="x-stats">
              <div><dt className="x-muted x-small">Total value</dt><dd className="x-num x-strong">{usd(h.total, { decimals: 2 })}</dd></div>
              <div><dt className="x-muted x-small">24h change</dt><dd className="x-num">{h.change24hUsd != null ? <>{usd(h.change24hUsd, { sign: true, decimals: 2 })} <Change value={h.change24hPct} /></> : "—"}</dd></div>
            </dl>
          </section>

          <section className="x-card x-holdings" aria-labelledby="x-holdings-title">
            <h2 id="x-holdings-title" className="x-h2">Holdings</h2>
            {h.loading ? <div aria-busy="true">{[0, 1, 2, 3].map(i => <div key={i} className="x-row"><Skeleton w={36} h={36} r={18} /><Skeleton w="50%" /></div>)}</div>
              : h.rows.length ? (
                <table className="x-table">
                  <caption className="x-sr-only">Holdings by asset. Expand a row for its networks.</caption>
                  <thead><tr><th scope="col">Asset</th><th scope="col" className="x-right">Balance</th><th scope="col" className="x-right x-hide-sm">Price</th><th scope="col" className="x-right">Value</th><th scope="col"><span className="x-sr-only">Networks</span></th></tr></thead>
                  <tbody>
                    {h.rows.map(r => {
                      const expanded = open === r.symbol;
                      return (
                        <Fragment key={r.symbol}>
                          <tr>
                            <th scope="row"><Link href={`/asset/${r.symbol}`} className="x-asset-cell"><AssetIcon symbol={r.symbol} size={32} /><span className="x-row-main"><span className="x-row-title">{nameOf(r.symbol)}</span><span className="x-row-sub">{r.symbol}</span></span></Link></th>
                            <td className="x-right x-num">{fmtAmount(r.amount)}</td>
                            <td className="x-right x-hide-sm"><span className="x-num">{usd(r.price)}</span><br /><Change value={r.change24h} /></td>
                            <td className="x-right x-num x-strong">{usd(r.usd)}</td>
                            <td className="x-right">
                              <button type="button" className="x-icon-btn" aria-expanded={expanded} aria-controls={`x-legs-${r.symbol}`} onClick={() => setOpen(expanded ? null : r.symbol)} aria-label={`${expanded ? "Hide" : "Show"} ${r.symbol} by network (${r.legs.length})`}>
                                <ChevronDown size={18} className={expanded ? "x-rot" : ""} aria-hidden="true" />
                              </button>
                            </td>
                          </tr>
                          <tr id={`x-legs-${r.symbol}`} hidden={!expanded} className="x-legs-row">
                            <td colSpan={5}>
                              <ul className="x-list x-legs-list">
                                {r.legs.map(l => (
                                  <li key={`${l.chainKey}:${l.address}`} className="x-row x-row-tight">
                                    <NetworkBadge chainKey={l.chainKey} size={20} />
                                    <span className="x-row-main"><span className="x-row-title">{networkMeta(l.chainKey).name}</span><span className="x-row-sub">{l.tokenSymbol}</span></span>
                                    <span className="x-row-end"><span className="x-num">{fmtAmount(l.amount)}</span><span className="x-num x-small x-muted">{usd(l.usd)}</span></span>
                                  </li>
                                ))}
                              </ul>
                              <div className="x-row-actions">
                                <button type="button" className="x-btn x-btn-ghost x-btn-sm" onClick={() => openTrade("sell", r.symbol)}>Sell</button>
                                <button type="button" className="x-btn x-btn-ghost x-btn-sm" onClick={() => openTrade("convert", r.symbol)}>Convert</button>
                              </div>
                            </td>
                          </tr>
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              ) : <EmptyState title="No supported assets found" action={<button type="button" className="x-btn x-btn-primary" onClick={() => openTrade("buy")}>Buy crypto</button>}>We look for every asset SODAX can trade on the networks you've connected.</EmptyState>}
          </section>
        </div>
      )}

      <section className="x-card" aria-labelledby="x-activity-title">
        <h2 id="x-activity-title" className="x-h2">Activity</h2>
        <ActivityList />
      </section>
    </div>
  );
}
