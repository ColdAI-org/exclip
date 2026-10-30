import { useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useExclipConfig } from "../lib/api";
import { BRAND } from "../lib/brand";
import { networkMeta } from "../lib/catalog";
import { devSignOnly, embeddedErrorText, embeddedOrigin, manageEmbedded, unbackedLimitUsd } from "../lib/embedded";
import { EmbeddedWalletError } from "../lib/embedded-client";
import { EMBEDDED_CHAINS, isEmbeddedChain } from "../lib/embedded-tx";
import { fromUnits, toUnits, usd } from "../lib/format";
import { useHoldings, type HoldingLeg } from "../lib/holdings";
import { openTrade, setTransfer, useUi } from "../lib/ui";
import { isConnected, requestWallet, useWallet, walletActions, type ChainFamily, type EmbeddedSession } from "../lib/wallet";
import { Sheet } from "./Sheet";

const FAMILY_LABEL: Record<ChainFamily, string> = {
  EVM: "Ethereum and EVM networks (Base, Arbitrum, BNB Chain, Hedera EVM…)",
  SOLANA: "Solana", SUI: "Sui", BITCOIN: "Bitcoin", ICON: "ICON", INJECTIVE: "Injective", STELLAR: "Stellar", NEAR: "NEAR", STACKS: "Stacks",
};

const EMBEDDED_NETWORKS = EMBEDDED_CHAINS.map(k => networkMeta(k).name).join(", ");

function CopyRow({ label, family, address }: { label: string; family: ChainFamily; address: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked: the address stays selectable */ }
  };
  return (
    <li className="x-row x-row-stack">
      <span className="x-small x-muted">{label}</span>
      <span className="x-addr-line">
        <code className="x-code x-num">{address}</code>
        <button type="button" className="x-icon-btn" onClick={copy} aria-label={copied ? "Copied" : `Copy ${family} address`}>
          {copied ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
        </button>
      </span>
    </li>
  );
}

/** Receive for the passkey wallet. The deposit address and its QR code are shown by the wallet window, never by this
 * page: a script running here could swap an address it renders. Until the wallet is backed up, deposits are capped:
 * the cap is stated here and in the window, and the window hides the address once this page reports holdings at the
 * limit. Nothing can stop an on-chain transfer to an address already shared, so the cap is a nudge, not a guarantee. */
function EmbeddedReceive({ session }: { session: EmbeddedSession }) {
  const { data: config } = useExclipConfig();
  const origin = embeddedOrigin(config);
  const limit = unbackedLimitUsd(config);
  const { total, loading } = useHoldings();
  const [busy, setBusy] = useState<null | "receive" | "save-phrase">(null);
  const [error, setError] = useState<string | null>(null);
  const run = (action: "receive" | "save-phrase") => {
    if (!origin) return;
    setError(null);
    const heldUsd = action === "receive" && !loading && Number.isFinite(total) ? Math.max(0, Math.floor(total)) : undefined;
    const p = manageEmbedded(origin, action, { heldUsd }); // opens the popup now
    setBusy(action);
    p.catch(e => {
      // Closing the receive window is how it ends; a timeout there means it stayed open, not that anything failed.
      if (action === "receive" && e instanceof EmbeddedWalletError && (e.code === "CANCELLED" || e.code === "TIMEOUT")) return;
      setError(embeddedErrorText(e));
    }).finally(() => setBusy(null));
  };
  const overLimit = !session.backedUp && !loading && total >= limit;
  return (
    <div className="x-stack">
      {!session.backedUp ? (
        <div className="x-banner x-banner-warn x-banner-action" role="region" aria-label="Deposit limit">
          <p>
            {loading ? "Checking your balance…" : overLimit
              ? `Your wallet already holds ${usd(total)}. Back up your wallet before depositing more: without a backup, losing this device's passkey means losing the funds.`
              : `Until you back up, keep this wallet under ${usd(limit, { decimals: 0 })} in total (now ${usd(total)}).`}
          </p>
          {origin ? <button type="button" className="x-btn x-btn-primary x-btn-sm" onClick={() => run("save-phrase")} disabled={!!busy}>{busy === "save-phrase" ? "Continue in the wallet window…" : "Back up now"}</button> : null}
        </div>
      ) : null}
      <p className="x-muted">Your address works on these networks only: {EMBEDDED_NETWORKS}. Don't send Bitcoin, Solana or other networks' assets to it.</p>
      <p className="x-muted">The wallet window shows the address and its QR code. Copy or scan it there, not from a screenshot or a message.</p>
      {error ? <p className="x-small" role="alert">{error}</p> : null}
      {origin ? (
        <button type="button" className="x-btn x-btn-primary x-btn-block" onClick={() => run("receive")} disabled={!!busy || loading}>
          {busy === "receive" ? "Continue in the wallet window…" : "Show my address"}
        </button>
      ) : <p className="x-muted">The wallet isn't available right now. Try again later.</p>}
    </div>
  );
}

/** Same-network send from the passkey wallet. The popup shows the full checksummed address, first-time and
 * look-alike warnings, and signs only what it decoded. */
function EmbeddedSend() {
  const { data: config } = useExclipConfig();
  const open = !!config?.tradingEnabled || devSignOnly();
  const { rows } = useHoldings();
  const legs = useMemo(() => rows.flatMap(r => r.legs).filter(l => isEmbeddedChain(l.chainKey)), [rows]);
  const [pick, setPick] = useState(0);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [state, setState] = useState<{ step: "edit" } | { step: "signing" } | { step: "sent"; hash: string; leg: HoldingLeg } | { step: "failed"; message: string }>({ step: "edit" });
  const leg = legs[pick] ?? null;
  const units = leg && amount ? toUnits(amount, leg.decimals) : null;
  const tooMuch = !!leg && units != null && units > BigInt(leg.units);
  const toValid = /^0x[0-9a-fA-F]{40}$/.test(to.trim());

  const send = () => {
    const actions = walletActions();
    if (!actions || !leg || !units || tooMuch || !toValid) return;
    const p = actions.embeddedSend({ chainKey: leg.chainKey, token: leg.address, amount: units, to: to.trim() }); // opens the popup now
    setState({ step: "signing" });
    p.then(hash => setState({ step: "sent", hash, leg }), e => setState({ step: "failed", message: e instanceof Error ? e.message : "The send didn't go through." }));
  };

  if (state.step === "sent") {
    const link = networkMeta(state.leg.chainKey).txUrl;
    return (
      <div className="x-stack">
        <p className="x-status-line" role="status"><Check size={18} aria-hidden="true" /> Sent {state.leg.tokenSymbol} on {networkMeta(state.leg.chainKey).name}.</p>
        {link ? <a className="x-btn x-btn-ghost x-btn-block" href={link + state.hash} target="_blank" rel="noopener noreferrer">View transaction <ExternalLink size={16} aria-hidden="true" /></a> : null}
        <button type="button" className="x-btn x-btn-primary x-btn-block" onClick={() => { setState({ step: "edit" }); setAmount(""); setTo(""); }}>Done</button>
      </div>
    );
  }
  if (!legs.length) return <p className="x-muted">Nothing to send yet. Assets on {EMBEDDED_NETWORKS} show up here.</p>;
  return (
    <form className="x-stack" onSubmit={e => { e.preventDefault(); send(); }}>
      <label className="x-field">
        <span className="x-small x-muted">Asset</span>
        <select className="x-input" value={pick} onChange={e => { setPick(Number(e.target.value)); setAmount(""); }}>
          {legs.map((l, i) => <option key={`${l.chainKey}:${l.address}`} value={i}>{l.tokenSymbol} on {networkMeta(l.chainKey).name} · {fromUnits(BigInt(l.units), l.decimals)}</option>)}
        </select>
      </label>
      <label className="x-field">
        <span className="x-small x-muted">Amount</span>
        <span className="x-input-group">
          <input className="x-input x-num" inputMode="decimal" autoComplete="off" value={amount} onChange={e => setAmount(e.target.value.replace(/[^\d.,]/g, ""))} aria-invalid={tooMuch || (!!amount && units == null)} />
          <button type="button" className="x-btn x-btn-ghost x-btn-sm" onClick={() => leg && setAmount(fromUnits(BigInt(leg.units), leg.decimals))}>Max</button>
        </span>
      </label>
      <label className="x-field">
        <span className="x-small x-muted">To (an address on {leg ? networkMeta(leg.chainKey).name : "the same network"})</span>
        <input className="x-input x-num" value={to} onChange={e => setTo(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} aria-invalid={!!to && !toValid} aria-describedby="x-send-help" />
      </label>
      <p id="x-send-help" className="x-fine">
        {tooMuch ? "That's more than you have." : to && !toValid ? "Paste the full address: 0x followed by 40 characters." : "Paste the address rather than typing it. The wallet window shows the full address before you approve; check every character. Sends can't be reversed."}
      </p>
      {state.step === "failed" ? <p className="x-banner x-banner-warn" role="alert">{state.message}</p> : null}
      <button type="submit" className="x-btn x-btn-primary x-btn-block" disabled={!open || state.step === "signing" || !units || tooMuch || !toValid}>
        {state.step === "signing" ? <><Loader2 className="x-spin" size={18} aria-hidden="true" /> Continue in the wallet window…</> : open ? "Review in wallet" : "Sending is paused"}
      </button>
    </form>
  );
}

/** Receive: your connected addresses. Send: same-network sends happen in the wallet; cross-network sends use a trade with a recipient. */
export function TransferSheet() {
  const { transfer } = useUi();
  const wallet = useWallet();
  const connected = isConnected(wallet);
  const entries = Object.entries(wallet.accounts).filter(([, a]) => !!a) as [ChainFamily, string][];

  return (
    <Sheet open={transfer !== null} onClose={() => setTransfer(null)} title={transfer === "send" ? "Send" : "Receive"}>
      {!connected ? (
        <div className="x-stack">
          <p className="x-muted">Connect a wallet to see your addresses and balances. {BRAND.name} never holds your funds.</p>
          <button type="button" className="x-btn x-btn-primary x-btn-block" onClick={() => { setTransfer(null); requestWallet({ open: true }); }}>Connect wallet</button>
        </div>
      ) : wallet.embedded ? (
        transfer === "receive" ? <EmbeddedReceive session={wallet.embedded} /> : <EmbeddedSend />
      ) : transfer === "receive" ? (
        <div className="x-stack">
          <p className="x-muted">Send assets to the address for the matching network. Sending on the wrong network can lose funds.</p>
          <ul className="x-list" aria-label="Your addresses">{entries.map(([f, a]) => <CopyRow key={f} label={FAMILY_LABEL[f]} family={f} address={a} />)}</ul>
        </div>
      ) : (
        <div className="x-stack">
          <p>To send to someone on the <strong>same network</strong>, use your wallet's own Send: it's one transaction, with no {BRAND.name} fee.</p>
          <p>To send to someone on <strong>another network</strong> (for example USDC from Base to a Solana address), {BRAND.name} routes it through SODAX and delivers it straight to their address.</p>
          <button type="button" className="x-btn x-btn-primary x-btn-block" onClick={() => openTrade("convert", "USDC", { send: true })}>Send across networks</button>
        </div>
      )}
    </Sheet>
  );
}
