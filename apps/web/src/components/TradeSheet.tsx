import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, ArrowLeft, Check, ChevronDown, ExternalLink, Loader2, Search, X } from "lucide-react";
import { STOCK_BADGE } from "@exclip/config/stocks";
import {
  ApiError, fetchQuote, marketMap, useExclipConfig, useMarkets, useSodaxTokens,
  type SodaxToken,
} from "../lib/api";
import { BRAND } from "../lib/brand";
import { assetMeta, HUB_TX_URL, nameOf, networkMeta, QUOTE_SYMBOL } from "../lib/catalog";
import { amount as fmtAmount, duration, fromUnits, pct, plain, toUnits, usd } from "../lib/format";
import { closeTrade, useUi, type TradeTab } from "../lib/ui";
import { isConnected, requestWallet, useWallet, walletActions, type SwapProgress, type WalletState } from "../lib/wallet";
import { addActivity, updateActivity, useActivity } from "../lib/activity";
import { balanceOf, pickChain } from "../lib/tokens";
import { devSignOnly } from "../lib/embedded";
import { embeddedSwapProblem } from "../lib/embedded-tx";
import { stockListings, tradableAssets, useStockEligibility, useStockPass, type StockListing } from "../lib/stocks";
import { Sheet } from "./Sheet";
import { AssetIcon, NetworkBadge, Tabs } from "./primitives";
import { ELIGIBILITY_TITLE, EligibilityForm, StockAccess, StockBadge, StockDisclaimer } from "./Stocks";

type Side = { symbol: string; chainKey: string | null };
type Step = "edit" | "pick-from" | "pick-to" | "eligibility" | "review" | "progress";

const NO_STOCKS: ReadonlyMap<string, StockListing> = new Map();

const SLIPPAGES = [0.1, 0.5, 1] as const;
const HUB_SECONDS = 20;

function defaults(tab: TradeTab, symbol: string | null): { from: Side; to: Side } {
  const s = symbol && symbol !== QUOTE_SYMBOL ? symbol : tab === "convert" ? "ETH" : "BTC";
  if (tab === "buy") return { from: { symbol: QUOTE_SYMBOL, chainKey: null }, to: { symbol: s, chainKey: null } };
  if (tab === "sell") return { from: { symbol: s, chainKey: null }, to: { symbol: QUOTE_SYMBOL, chainKey: null } };
  return { from: { symbol: s, chainKey: null }, to: { symbol: s === "ETH" ? "BTC" : "ETH", chainKey: null } };
}

function txLink(chainKey: string, hash: string | undefined) {
  const base = networkMeta(chainKey).txUrl;
  return base && hash ? base + hash : null;
}

export function TradeSheet() {
  const { trade } = useUi();
  return (
    <Sheet open={trade.open} onClose={closeTrade} title="Trade" labelledBy="x-trade-title">
      {trade.open ? <TradeFlow key={`${trade.tab}:${trade.symbol ?? ""}:${trade.send}`} initialTab={trade.tab} symbol={trade.symbol} send={trade.send} /> : null}
    </Sheet>
  );
}

function TradeFlow({ initialTab, symbol, send }: { initialTab: TradeTab; symbol: string | null; send: boolean }) {
  const wallet = useWallet();
  const { data: config } = useExclipConfig();
  const { data: tokens, error: tokensError, isLoading: tokensLoading } = useSodaxTokens();
  const { data: markets } = useMarkets();

  const prices = useMemo(() => marketMap(markets?.rows), [markets]);
  // Tokenised stocks (SODAX's isRwa tokens) come in only when this server offers them, under SODAX's own symbols.
  const stocksOn = !!config?.stocksEnabled;
  const stocks = useMemo(() => (stocksOn ? stockListings(tokens) : NO_STOCKS), [tokens, stocksOn]);
  const bySymbol = useMemo(() => tradableAssets(tokens, stocks), [tokens, stocks]);

  const [tab, setTab] = useState<TradeTab>(initialTab);
  const [sides, setSides] = useState(() => defaults(initialTab, symbol));
  const [step, setStep] = useState<Step>("edit");
  const [modeChoice, setMode] = useState<"usd" | "token">("usd");
  const [input, setInput] = useState("");
  const [slippage, setSlippage] = useState<number>(0.5);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [progress, setProgress] = useState<SwapProgress | null>(null);
  const [recipient, setRecipient] = useState("");
  const recipientValid = !recipient || /^[A-Za-z0-9._:-]{20,128}$/.test(recipient.trim());

  const changeTab = (t: TradeTab) => {
    setTab(t);
    const cur = sides.to.symbol !== QUOTE_SYMBOL ? sides.to.symbol : sides.from.symbol;
    setSides(defaults(t, cur));
    setInput("");
  };

  // Resolve each side to a concrete SODAX token (asset + network).
  const fromList = bySymbol.get(sides.from.symbol) ?? [];
  const toList = bySymbol.get(sides.to.symbol) ?? [];
  const fromChain = pickChain(fromList, wallet, sides.from.chainKey);
  const toChain = pickChain(toList, wallet, sides.to.chainKey ?? fromChain);
  const fromToken = fromList.find(t => t.chainKey === fromChain) ?? null;
  const toToken = toList.find(t => t.chainKey === toChain) ?? null;
  const fromPrice = prices.get(sides.from.symbol)?.price ?? null;
  const toPrice = prices.get(sides.to.symbol)?.price ?? null;
  const fromBalance = fromToken ? balanceOf(wallet, fromToken) : 0n;
  const connected = isConnected(wallet);

  // A trade with a stock in it waits for the server's yes (services/stocks.ts on the server): no quote and no preview
  // until this visitor may trade stocks. A stock has no US dollar price here, so an amount of one is typed in the stock.
  const fromStock = stocks.get(sides.from.symbol) ?? null;
  const toStock = stocks.get(sides.to.symbol) ?? null;
  const stockLeg = !!fromStock || !!toStock;
  const eligibility = useStockEligibility(stockLeg);
  const pass = useStockPass();
  const stockBlocked = stockLeg && eligibility.data?.eligible !== true;
  const mode = fromStock ? "token" : modeChoice;

  // What the visitor typed, as base units of the token they pay with.
  const units = useMemo(() => {
    if (!fromToken || !input) return null;
    if (mode === "token") return toUnits(input, fromToken.decimals);
    const dollars = Number(input.replace(/,/g, ""));
    if (!fromPrice || !Number.isFinite(dollars) || dollars <= 0) return null;
    return toUnits(plain(dollars / fromPrice, Math.min(fromToken.decimals, 8)), fromToken.decimals);
  }, [input, mode, fromToken, fromPrice]);

  const feeBps = config?.partnerFeeBps ?? 0;
  const feeUnits = units ? (units * BigInt(feeBps)) / 10_000n : 0n;
  const netUnits = units ? units - feeUnits : null;

  // Debounce typing before asking for a quote. The quote starts from the amount sold, as the intent does: the server
  // pins the fee on the quote and SODAX takes it off that amount, as the SDK's own getQuote does (docs/fee-split.md).
  const [debounced, setDebounced] = useState<bigint | null>(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(units), 350); return () => clearTimeout(t); }, [units]);

  const quoteEnabled = !!fromToken && !!toToken && !!debounced && debounced > 0n && !(fromToken.address === toToken.address && fromChain === toChain) && !stockBlocked;
  const quote = useQuery({
    queryKey: ["exclip", "quote", fromToken?.address, fromChain, toToken?.address, toChain, debounced?.toString(), stockLeg ? pass?.attestation ?? null : null],
    queryFn: ({ signal }) => fetchQuote({
      tokenSrc: fromToken!.address, tokenSrcChainKey: fromChain!, tokenDst: toToken!.address, tokenDstChainKey: toChain!,
      amount: debounced!.toString(), quoteType: "exact_input",
    }, signal),
    enabled: quoteEnabled && (step === "edit" || step === "review"),
    staleTime: 15_000,
    refetchInterval: step === "review" ? 20_000 : false,
    retry: (n, e) => n < 1 && !(e instanceof ApiError && e.status < 500),
  });
  const outUnits = quote.data?.quotedAmount && /^\d+$/.test(quote.data.quotedAmount) ? BigInt(quote.data.quotedAmount) : null;
  const outAmount = outUnits != null && toToken ? Number(fromUnits(outUnits, toToken.decimals)) : null;
  const inAmount = units != null && fromToken ? Number(fromUnits(units, fromToken.decimals)) : null;
  const minOut = outUnits != null ? (outUnits * BigInt(Math.round((100 - slippage) * 100))) / 10_000n : null;

  const insufficient = connected && units != null && fromToken != null && units > fromBalance;
  const tooPrecise = !!input && mode === "token" && units == null;

  const setFraction = (f: number) => {
    if (!fromToken || fromBalance === 0n) return;
    const u = f === 1 ? fromBalance : (fromBalance * BigInt(Math.round(f * 100))) / 100n;
    const tokenStr = fromUnits(u, fromToken.decimals);
    if (mode === "token") setInput(tokenStr);
    else if (fromPrice) setInput(plain(Number(tokenStr) * fromPrice, 2));
  };

  const flip = () => {
    setSides(s => ({ from: s.to, to: s.from }));
    setTab(t => (t === "buy" ? "sell" : t === "sell" ? "buy" : "convert"));
    setInput("");
  };

  const preview = () => {
    requestWallet(); // start loading the wallet SDK now, so Confirm is instant
    setStep("review");
  };

  const confirm = async () => {
    const actions = walletActions();
    if (!actions || !fromToken || !toToken || !units || !minOut) return;
    const id = `swap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setActivityId(id);
    setProgress({ step: "sign" });
    setStep("progress");
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 60);
    try {
      const out = await actions.swap({
        srcChainKey: fromToken.chainKey, dstChainKey: toToken.chainKey,
        inputToken: fromToken.address, outputToken: toToken.address,
        inputAmount: units, minOutputAmount: minOut, deadline, kind: "market",
        dstAddress: recipient.trim() || undefined,
      }, p => {
        setProgress(p);
        if (p.step === "submitted") {
          addActivity({
            id, kind: "swap", status: "pending",
            from: { symbol: sides.from.symbol, chainKey: fromToken.chainKey, amount: fromUnits(units, fromToken.decimals) },
            to: { symbol: sides.to.symbol, chainKey: toToken.chainKey, amount: outUnits ? fromUnits(outUnits, toToken.decimals) : "", minAmount: fromUnits(minOut, toToken.decimals) },
            srcTxHash: p.srcTxHash,
          });
        }
      });
      updateActivity(id, { status: "solving", srcTxHash: out.srcTxHash, hubTxHash: out.hubTxHash, intent: out.intent });
    } catch (e) {
      const message = e instanceof Error ? e.message : "The trade didn't go through.";
      setProgress({ step: "failed", message });
      updateActivity(id, { status: "failed", error: message });
    }
  };

  const pickerOpen = step === "pick-from" || step === "pick-to";
  if (pickerOpen) {
    const which = step === "pick-from" ? "from" : "to";
    return (
      <AssetPicker
        title={which === "from" ? "Pay with" : "Receive"}
        bySymbol={bySymbol}
        stocks={stocks}
        wallet={wallet}
        prices={prices}
        exclude={which === "from" ? sides.to.symbol : sides.from.symbol}
        onBack={() => setStep("edit")}
        onPick={side => {
          // A stock's amount is typed in the stock, so dollars typed for a coin don't carry over to one, or back.
          if (which === "from" && modeChoice === "usd" && stocks.has(side.symbol) !== !!fromStock) setInput("");
          setSides(s => ({ ...s, [which]: side }));
          setStep("edit");
        }}
      />
    );
  }

  if (step === "progress") {
    return <Progress id={activityId} progress={progress} fromChain={fromToken?.chainKey ?? ""} toChain={toToken?.chainKey ?? ""} summary={`${fmtAmount(inAmount)} ${sides.from.symbol} → ${fmtAmount(outAmount)} ${sides.to.symbol}`} />;
  }

  if (step === "eligibility") {
    return (
      <div className="x-trade">
        <div className="x-sheet-subhead">
          <button type="button" className="x-icon-btn" onClick={() => setStep("edit")} aria-label="Back to the trade"><ArrowLeft size={20} aria-hidden="true" /></button>
          <h2 id="x-trade-title" className="x-h3">{ELIGIBILITY_TITLE}</h2>
        </div>
        <EligibilityForm termsVersion={config?.stocksTermsVersion ?? null} onDone={() => setStep("edit")} />
      </div>
    );
  }

  const route = fromChain && toChain ? `${networkMeta(fromChain).short} → ${networkMeta(toChain).short}` : "—";
  const est = fromChain && toChain ? networkMeta(fromChain).confirmSeconds + HUB_SECONDS + networkMeta(toChain).confirmSeconds : null;
  const feeUsd = fromPrice && fromToken ? Number(fromUnits(feeUnits, fromToken.decimals)) * fromPrice : null;
  const rate = inAmount && outAmount && netUnits && fromToken ? outAmount / Number(fromUnits(netUnits, fromToken.decimals)) : null;
  const quoteErr = quote.error instanceof Error ? quote.error.message : null;

  if (step === "review") {
    const actions = walletActions();
    const srcFamily = actions?.familyOf(fromChain ?? "") ?? null;
    const signer = srcFamily ? wallet.accounts[srcFamily] : undefined;
    // The passkey wallet: market swaps between its EVM networks, into itself only. Dev builds can sign without
    // broadcasting while trading is off, so the whole flow can be reviewed up to "signed".
    const embedded = wallet.embedded;
    const embeddedProblem = embedded && fromToken && toToken && minOut != null && units
      ? embeddedSwapProblem({
        srcChainKey: fromToken.chainKey, dstChainKey: toToken.chainKey, inputToken: fromToken.address, outputToken: toToken.address,
        inputAmount: units, minOutputAmount: minOut, deadline: 1n, kind: "market", dstAddress: recipient.trim() || undefined,
      }, embedded.evm)
      : null;
    const signOnly = !!embedded && devSignOnly();
    let cta: ReactNode;
    if (stockBlocked) cta = <StockAccess eligibility={eligibility} onConfirm={() => setStep("eligibility")} />;
    else if (embeddedProblem) cta = <><p className="x-banner x-banner-warn" role="alert">{embeddedProblem}</p><button type="button" className="x-btn x-btn-primary x-btn-block x-btn-lg" disabled>Confirm with passkey</button></>;
    else if (signOnly && actions) cta = <button type="button" className="x-btn x-btn-primary x-btn-block x-btn-lg" onClick={confirm} disabled={!outUnits || insufficient || !recipientValid}>Sign with passkey (dev: not broadcast)</button>;
    else if (!config?.tradingEnabled) cta = <button type="button" className="x-btn x-btn-primary x-btn-block x-btn-lg" disabled>Trading is paused</button>;
    else if (!connected || (actions && !signer)) cta = <button type="button" className="x-btn x-btn-primary x-btn-block x-btn-lg" onClick={() => requestWallet({ open: true })}>Connect {networkMeta(fromChain ?? "").short} wallet</button>;
    else if (!actions) cta = <button type="button" className="x-btn x-btn-primary x-btn-block x-btn-lg" disabled><Loader2 className="x-spin" size={18} aria-hidden="true" /> Loading wallet…</button>;
    else cta = <button type="button" className="x-btn x-btn-primary x-btn-block x-btn-lg" onClick={confirm} disabled={!outUnits || insufficient || !recipientValid}>{embedded ? "Confirm with passkey" : "Confirm in wallet"}</button>;

    return (
      <div className="x-trade">
        <div className="x-sheet-subhead">
          <button type="button" className="x-icon-btn" onClick={() => setStep("edit")} aria-label="Back to amount"><ArrowLeft size={20} aria-hidden="true" /></button>
          <h2 id="x-trade-title" className="x-h3">Review {tab === "convert" ? "conversion" : tab === "buy" ? "purchase" : "sale"}</h2>
        </div>
        <div className="x-review-hero">
          <div className="x-review-leg"><AssetIcon symbol={sides.from.symbol} size={40} network={fromChain ?? undefined} /><div><div className="x-muted x-small">You pay</div><div className="x-strong x-num x-lg">{fmtAmount(inAmount)} {sides.from.symbol}</div>{fromStock ? <StockBadge /> : <div className="x-muted x-small x-num">{usd(inAmount != null && fromPrice ? inAmount * fromPrice : null)}</div>}</div></div>
          <div className="x-review-leg"><AssetIcon symbol={sides.to.symbol} size={40} network={toChain ?? undefined} /><div><div className="x-muted x-small">You receive (est.)</div><div className="x-strong x-num x-lg">{quote.isFetching && !outAmount ? "…" : `${fmtAmount(outAmount)} ${sides.to.symbol}`}</div>{toStock ? <StockBadge /> : <div className="x-muted x-small x-num">{usd(outAmount != null && toPrice ? outAmount * toPrice : null)}</div>}</div></div>
        </div>
        <dl className="x-dl">
          <Row k="Rate" v={rate ? `1 ${sides.from.symbol} = ${fmtAmount(rate)} ${sides.to.symbol}` : "—"} />
          <Row k="Route" v={<span className="x-route"><NetworkBadge chainKey={fromChain ?? ""} /> {route} <NetworkBadge chainKey={toChain ?? ""} /></span>} />
          <Row k="Network fee" v="Paid in gas on the source network; your wallet shows it before you sign" />
          {feeBps > 0
            ? <Row k={`${BRAND.name} fee (${pct(feeBps / 100, { sign: false })})`} v={`${fmtAmount(fromToken ? Number(fromUnits(feeUnits, fromToken.decimals)) : null)} ${sides.from.symbol} · ${usd(feeUsd)}`} />
            : <Row k={`${BRAND.name} fee`} v="None" />}
          <Row k="SODAX fee" v="Included in the rate" />
          <Row k={`Minimum received (${slippage}% slippage)`} v={minOut != null && toToken ? `${fmtAmount(Number(fromUnits(minOut, toToken.decimals)))} ${sides.to.symbol}` : "—"} />
          <Row k="Estimated time" v={est ? `About ${duration(est)}` : "—"} />
        </dl>
        <div className="x-field-row">
          <span className="x-muted x-small" id="x-slip">Slippage tolerance</span>
          <div className="x-pills x-pills-sm" role="radiogroup" aria-labelledby="x-slip">
            {SLIPPAGES.map(s => <button key={s} type="button" role="radio" aria-checked={slippage === s} className={`x-pill${slippage === s ? " is-on" : ""}`} onClick={() => setSlippage(s)}>{s}%</button>)}
          </div>
        </div>
        <details className="x-details" open={send || undefined}>
          <summary>Send to a different address</summary>
          <label className="x-field">
            <span className="x-small x-muted">Recipient on {networkMeta(toChain ?? "").name}</span>
            <input className="x-input x-num" value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="Leave empty to receive in your own wallet" autoComplete="off" spellCheck={false} aria-invalid={!recipientValid} aria-describedby="x-recipient-help" />
          </label>
          <p id="x-recipient-help" className="x-fine">{!recipientValid ? `That doesn't look like a ${networkMeta(toChain ?? "").short} address.` : embedded ? "Your passkey wallet only swaps into itself. To pay someone, swap first, then use Send." : "Double-check it: transfers to a wrong address can't be reversed."}</p>
        </details>
        {quoteErr ? <p className="x-banner x-banner-warn" role="alert">{quoteErr}</p> : null}
        {insufficient ? <p className="x-banner x-banner-warn" role="alert">Not enough {sides.from.symbol} on {networkMeta(fromChain ?? "").short}.</p> : null}
        <p className="x-fine">Your trade is an intent: solvers compete to fill it on the SODAX hub, and you receive at least the minimum or the trade doesn't happen. {BRAND.name} never holds your funds.</p>
        {stockLeg ? <StockDisclaimer /> : null}
        {cta}
      </div>
    );
  }

  // Edit step.
  const display = input || "0";
  const sizeClass = display.length > 12 ? " is-xs" : display.length > 8 ? " is-sm" : "";
  const secondary = mode === "usd"
    ? (inAmount != null ? `≈ ${fmtAmount(inAmount)} ${sides.from.symbol}` : `${sides.from.symbol} amount`)
    : (inAmount != null && fromPrice ? `≈ ${usd(inAmount * fromPrice)}` : "US dollar value");
  const canPreview = !!units && units > 0n && !!outUnits && !insufficient && !quote.isFetching;

  return (
    <div className="x-trade">
      <h2 id="x-trade-title" className="x-sr-only">Trade</h2>
      <Tabs idBase="x-trade" label="Trade type" value={tab} onChange={changeTab} options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }, { value: "convert", label: "Convert" }]} />
      <div id="x-trade-panel" role="tabpanel" aria-labelledby={`x-trade-tab-${tab}`} className="x-trade-panel">
        <div className="x-amount">
          <label className="x-sr-only" htmlFor="x-amount-input">Amount in {mode === "usd" ? "US dollars" : sides.from.symbol}</label>
          <div className={`x-amount-line${sizeClass}`}>
            {mode === "usd" ? <span className="x-amount-cur" aria-hidden="true">$</span> : null}
            <input
              id="x-amount-input"
              data-autofocus
              className="x-amount-input x-num"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={input}
              onChange={e => { const v = e.target.value.replace(/[^\d.,]/g, ""); setInput(v); }}
              size={Math.max(1, display.length)}
            />
            {mode === "token" ? <span className="x-amount-unit" aria-hidden="true">{sides.from.symbol}</span> : null}
          </div>
          {fromStock ? null : (
            <button type="button" className="x-toggle" onClick={() => { setMode(m => (m === "usd" ? "token" : "usd")); setInput(""); }} aria-label={`Switch to entering ${mode === "usd" ? sides.from.symbol : "US dollars"}`}>
              <ArrowDownUp size={14} aria-hidden="true" /> <span className="x-num">{secondary}</span>
            </button>
          )}
          <div className="x-chips" role="group" aria-label="Use part of your balance">
            {[0.25, 0.5, 1].map(f => (
              <button key={f} type="button" className="x-chip" onClick={() => setFraction(f)} disabled={!connected || fromBalance === 0n}>{f === 1 ? "Max" : `${f * 100}%`}</button>
            ))}
          </div>
        </div>

        <div className="x-legs">
          <LegButton label="Pay with" side={sides.from} stock={fromStock} chainKey={fromChain} token={fromToken} wallet={wallet} onClick={() => setStep("pick-from")} />
          <button type="button" className="x-flip" onClick={flip} aria-label="Swap pay and receive"><ArrowDownUp size={16} aria-hidden="true" /></button>
          <LegButton label="Receive" side={sides.to} stock={toStock} chainKey={toChain} token={toToken} wallet={wallet} onClick={() => setStep("pick-to")} />
        </div>

        <div className="x-quote-line" aria-live="polite">
          {tokensLoading ? <span className="x-muted">Loading markets…</span>
            : tokensError ? <span className="x-warn-text">{tokensError instanceof Error ? tokensError.message : "Markets are unavailable."}</span>
            : !fromToken || !toToken ? <span className="x-warn-text">That pair isn't available yet.</span>
            : tooPrecise ? <span className="x-warn-text">{sides.from.symbol} has at most {fromToken.decimals} decimals.</span>
            : insufficient ? <span className="x-warn-text">Not enough {sides.from.symbol} on {networkMeta(fromToken.chainKey).short}.</span>
            : stockBlocked ? <span className="x-muted">Quotes for tokenised stocks appear once you can trade them.</span>
            : quote.isFetching ? <span className="x-muted"><Loader2 className="x-spin" size={14} aria-hidden="true" /> Finding the best route…</span>
            : quoteErr ? <span className="x-warn-text">{quoteErr}</span>
            : outAmount != null ? <span>You receive about <strong className="x-num">{fmtAmount(outAmount)} {sides.to.symbol}</strong>{toStock ? null : <> <span className="x-muted x-num">({usd(toPrice ? outAmount * toPrice : null)})</span></>}</span>
            : <span className="x-muted">Enter an amount to see a quote.</span>}
        </div>

        {stockBlocked ? <StockAccess eligibility={eligibility} onConfirm={() => setStep("eligibility")} /> : null}

        <button type="button" className="x-btn x-btn-primary x-btn-block x-btn-lg" disabled={!canPreview} onClick={preview}>Preview {tab}</button>
        {!connected ? <p className="x-fine x-center">You can preview without a wallet. You'll connect one to confirm.</p> : null}
      </div>
    </div>
  );
}

/** An asset's name: SODAX's for a tokenised stock, the catalog's otherwise. */
function nameIn(stocks: ReadonlyMap<string, StockListing>, symbol: string): string {
  return stocks.get(symbol)?.name ?? nameOf(symbol);
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return <div className="x-dl-row"><dt>{k}</dt><dd className="x-num">{v}</dd></div>;
}

function LegButton({ label, side, stock, chainKey, token, wallet, onClick }: { label: string; side: Side; stock: StockListing | null; chainKey: string | null; token: SodaxToken | null; wallet: WalletState; onClick: () => void }) {
  const bal = token ? balanceOf(wallet, token) : 0n;
  const name = stock?.name ?? nameOf(side.symbol);
  return (
    <button type="button" className="x-leg" onClick={onClick} aria-label={`${label}: ${name}${stock ? ` (${STOCK_BADGE.toLowerCase()})` : ""}${chainKey ? ` on ${networkMeta(chainKey).name}` : ""}. Change`}>
      <span className="x-leg-label x-muted x-small">{label}</span>
      <AssetIcon symbol={side.symbol} size={36} network={chainKey ?? undefined} />
      <span className="x-row-main">
        {stock ? <span className="x-stock-title"><span className="x-row-title">{name}</span><StockBadge /></span> : <span className="x-row-title">{name}</span>}
        <span className="x-row-sub">{chainKey ? `on ${networkMeta(chainKey).short}` : "No network"}{token && isConnected(wallet) ? ` · ${fmtAmount(Number(fromUnits(bal, token.decimals)))} ${side.symbol}` : ""}</span>
      </span>
      <ChevronDown size={18} aria-hidden="true" />
    </button>
  );
}

function AssetPicker({ title, bySymbol, stocks, wallet, prices, exclude, onBack, onPick }: {
  title: string;
  bySymbol: Map<string, SodaxToken[]>;
  stocks: ReadonlyMap<string, StockListing>;
  wallet: WalletState;
  prices: Map<string, { price: number }>;
  exclude: string;
  onBack: () => void;
  onPick: (side: Side) => void;
}) {
  const [q, setQ] = useState("");
  const [asset, setAsset] = useState<string | null>(null);
  const connected = isConnected(wallet);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...bySymbol.entries()]
      .map(([symbol, list]) => {
        const held = list.reduce((s, t) => s + Number(fromUnits(balanceOf(wallet, t), t.decimals)), 0);
        return { symbol, list, held, usd: held * (prices.get(symbol)?.price ?? 0) };
      })
      .filter(r => !needle || r.symbol.toLowerCase().includes(needle) || nameIn(stocks, r.symbol).toLowerCase().includes(needle) || r.list.some(t => networkMeta(t.chainKey).name.toLowerCase().includes(needle)))
      .sort((a, b) => b.usd - a.usd || (assetMeta(a.symbol) ? 0 : 1) - (assetMeta(b.symbol) ? 0 : 1) || a.symbol.localeCompare(b.symbol));
  }, [bySymbol, stocks, wallet, prices, q]);

  if (asset) {
    const list = bySymbol.get(asset) ?? [];
    return (
      <div className="x-trade">
        <div className="x-sheet-subhead">
          <button type="button" className="x-icon-btn" onClick={() => setAsset(null)} aria-label="Back to assets"><ArrowLeft size={20} aria-hidden="true" /></button>
          <h2 id="x-trade-title" className="x-h3">{nameIn(stocks, asset)}: choose a network</h2>
        </div>
        <ul className="x-list" aria-label="Networks">
          {list.map(t => {
            const b = Number(fromUnits(balanceOf(wallet, t), t.decimals));
            const n = networkMeta(t.chainKey);
            return (
              <li key={`${t.chainKey}:${t.address}`}>
                <button type="button" className="x-row x-row-btn" onClick={() => onPick({ symbol: asset, chainKey: t.chainKey })}>
                  <NetworkBadge chainKey={t.chainKey} size={32} />
                  <span className="x-row-main"><span className="x-row-title">{n.name}</span><span className="x-row-sub">{t.symbol}</span></span>
                  {connected ? <span className="x-row-end x-num">{fmtAmount(b)}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className="x-trade">
      <div className="x-sheet-subhead">
        <button type="button" className="x-icon-btn" onClick={onBack} aria-label="Back"><ArrowLeft size={20} aria-hidden="true" /></button>
        <h2 id="x-trade-title" className="x-h3">{title}</h2>
      </div>
      <label className="x-search-field">
        <Search size={18} aria-hidden="true" />
        <span className="x-sr-only">Search assets or networks</span>
        <input data-autofocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search assets or networks" autoComplete="off" spellCheck={false} />
        {q ? <button type="button" className="x-icon-btn x-icon-btn-sm" onClick={() => setQ("")} aria-label="Clear search"><X size={16} aria-hidden="true" /></button> : null}
      </label>
      <ul className="x-list x-picker-list" aria-label="Assets">
        {rows.map(r => (
          <li key={r.symbol}>
            <button
              type="button"
              className="x-row x-row-btn"
              disabled={r.symbol === exclude}
              onClick={() => (r.list.length === 1 ? onPick({ symbol: r.symbol, chainKey: r.list[0]!.chainKey }) : setAsset(r.symbol))}
            >
              <AssetIcon symbol={r.symbol} size={36} />
              <span className="x-row-main">
                {stocks.has(r.symbol)
                  ? <span className="x-stock-title"><span className="x-row-title">{nameIn(stocks, r.symbol)}</span><StockBadge /></span>
                  : <span className="x-row-title">{nameOf(r.symbol)}</span>}
                <span className="x-row-sub x-net-strip">
                  {r.symbol} ·
                  {r.list.slice(0, 5).map(t => <NetworkBadge key={t.chainKey} chainKey={t.chainKey} size={14} />)}
                  {r.list.length > 5 ? <span className="x-small">+{r.list.length - 5}</span> : null}
                </span>
              </span>
              {connected && r.held > 0 ? (
                <span className="x-row-end"><span className="x-num">{fmtAmount(r.held)}</span><span className="x-muted x-small x-num">{usd(r.usd)}</span></span>
              ) : null}
            </button>
          </li>
        ))}
        {!rows.length ? <li className="x-muted x-pad">Nothing matches “{q}”.</li> : null}
      </ul>
    </div>
  );
}

const STEPS = [
  { key: "sign", label: "Sign in your wallet" },
  { key: "submitted", label: "Submitted" },
  { key: "solving", label: "Solving" },
  { key: "settled", label: "Settled" },
] as const;

function Progress({ id, progress, fromChain, toChain, summary }: { id: string | null; progress: SwapProgress | null; fromChain: string; toChain: string; summary: string }) {
  const activity = useActivity().find(a => a.id === id);
  // The activity log (updated by the intent watcher) is the source of truth once the intent is on the hub.
  const settled = activity?.status === "settled";
  const failed = progress?.step === "failed" || activity?.status === "failed";
  const at = settled ? 3 : progress?.step === "solving" || activity?.status === "solving" ? 2 : progress?.step === "submitted" ? 1 : 0;
  const srcHash = activity?.srcTxHash ?? (progress && "srcTxHash" in progress ? progress.srcTxHash : undefined);
  const hubHash = activity?.hubTxHash ?? (progress && "hubTxHash" in progress ? progress.hubTxHash : undefined);
  const srcUrl = txLink(fromChain, srcHash);
  const fillUrl = txLink(toChain, activity?.fillTxHash);
  const message = failed ? (progress?.step === "failed" ? progress.message : activity?.error) : null;

  return (
    <div className="x-trade">
      <h2 id="x-trade-title" className="x-h3 x-center">{failed ? "Trade didn't complete" : settled ? "Trade settled" : progress?.step === "approve" ? "Approve token" : "Trade in progress"}</h2>
      <p className="x-muted x-center x-num">{summary}</p>
      <ol className="x-steps" aria-label="Progress">
        {STEPS.map((s, i) => {
          const state = failed && i === at ? "failed" : i < at || (settled && i === at) ? "done" : i === at ? "active" : "todo";
          return (
            <li key={s.key} className={`x-step is-${state}`} aria-current={state === "active" ? "step" : undefined}>
              <span className="x-step-dot" aria-hidden="true">{state === "done" ? <Check size={14} /> : state === "active" ? <Loader2 size={14} className="x-spin" /> : state === "failed" ? <X size={14} /> : null}</span>
              <span>{i === 0 && progress?.step === "approve" ? "Approve spending in your wallet" : s.label}<span className="x-sr-only">: {state}</span></span>
            </li>
          );
        })}
      </ol>
      {message ? <p className="x-banner x-banner-warn" role="alert">{message}</p> : null}
      <div className="x-links" role="status" aria-live="polite">
        {srcUrl ? <a href={srcUrl} target="_blank" rel="noreferrer noopener">Source transaction on {networkMeta(fromChain).short} <ExternalLink size={14} aria-hidden="true" /></a> : srcHash ? <span className="x-muted x-small">Source tx {srcHash.slice(0, 10)}…</span> : null}
        {hubHash ? <a href={HUB_TX_URL + hubHash} target="_blank" rel="noreferrer noopener">Intent on the SODAX hub <ExternalLink size={14} aria-hidden="true" /></a> : null}
        {fillUrl ? <a href={fillUrl} target="_blank" rel="noreferrer noopener">Delivery on {networkMeta(toChain).short} <ExternalLink size={14} aria-hidden="true" /></a> : null}
      </div>
      <button type="button" className="x-btn x-btn-ghost x-btn-block" onClick={closeTrade}>{settled || failed ? "Done" : "Close. We'll keep tracking it"}</button>
    </div>
  );
}
