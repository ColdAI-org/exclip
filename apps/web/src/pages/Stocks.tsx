/**
 * Tokenised stocks: the tokens SODAX flags isRwa, on a server that switches them on (stocks.enabled,
 * docs/tokenised-stocks.md). With them off, App renders the 404 here and nothing links to this screen. Symbols and
 * names are SODAX's own. There are no company logos, and no prices: the markets feed covers crypto only.
 */
import { useMemo, useState } from "react";
import { useExclipConfig, useSodaxTokens } from "../lib/api";
import { networkMeta } from "../lib/catalog";
import { stockListings, useStockEligibility } from "../lib/stocks";
import { openTrade } from "../lib/ui";
import { AssetIcon, EmptyState, NetworkBadge, Skeleton } from "../components/primitives";
import { EligibilitySheet, StockAccess, StockBadge, StockDisclaimer } from "../components/Stocks";

export default function Stocks() {
  const { data: config } = useExclipConfig();
  const { data: tokens, error, isLoading } = useSodaxTokens();
  const eligibility = useStockEligibility(true);
  const listings = useMemo(() => [...stockListings(tokens).values()], [tokens]);
  const [confirming, setConfirming] = useState(false);
  // Refused outright (a country the server can't place, or one it excludes): no trade can start. Anything else opens
  // the trade sheet, which asks for the confirmation itself when it's missing.
  const verdict = eligibility.data;
  const refused = !!verdict && !verdict.eligible && verdict.code !== "SELF_CERT_REQUIRED";

  return (
    <div className="x-page">
      <header className="x-page-head">
        <h1 className="x-h1">Tokenised stocks</h1>
        <p className="x-muted">Tokens that track company shares, swapped through SODAX from your own wallet.</p>
      </header>

      <StockDisclaimer />

      <section className="x-card" aria-labelledby="x-stocks-access-title">
        <h2 id="x-stocks-access-title" className="x-h2">Your access</h2>
        <StockAccess eligibility={eligibility} onConfirm={() => setConfirming(true)} />
      </section>

      <section className="x-card" aria-labelledby="x-stocks-list-title">
        <h2 id="x-stocks-list-title" className="x-h2">Listed on SODAX</h2>
        {isLoading ? (
          <div aria-busy="true">{[0, 1, 2].map(i => <div key={i} className="x-row"><Skeleton w={36} h={36} r={18} /><Skeleton w="50%" /></div>)}</div>
        ) : error ? (
          <p className="x-banner x-banner-warn" role="alert">{error.message}</p>
        ) : !listings.length ? (
          <EmptyState title="No tokenised stocks right now">SODAX doesn't list any at the moment.</EmptyState>
        ) : (
          <ul className="x-list" aria-label="Tokenised stocks">
            {listings.map(s => (
              <li key={s.symbol} className="x-row">
                <AssetIcon symbol={s.symbol} size={36} />
                <span className="x-row-main">
                  <span className="x-stock-title"><span className="x-row-title">{s.name}</span><StockBadge /></span>
                  <span className="x-row-sub x-net-strip">
                    {s.symbol} ·
                    {s.tokens.map(t => <NetworkBadge key={`${t.chainKey}:${t.address}`} chainKey={t.chainKey} size={14} />)}
                    <span className="x-sr-only">on {s.tokens.map(t => networkMeta(t.chainKey).name).join(", ")}</span>
                  </span>
                </span>
                <button type="button" className="x-btn x-btn-ghost x-btn-sm" onClick={() => openTrade("buy", s.symbol)} disabled={refused} aria-label={`Trade ${s.name} (${s.symbol})`}>
                  Trade
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <EligibilitySheet open={confirming} termsVersion={config?.stocksTermsVersion ?? null} onClose={() => setConfirming(false)} onDone={() => setConfirming(false)} />
    </div>
  );
}
