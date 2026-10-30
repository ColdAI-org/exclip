/**
 * The wallet runtime: everything that needs @sodax/wallet-sdk-react and @sodax/dapp-kit. This module is only ever
 * reached through a dynamic import from <WalletHost> (after Connect or Preview), so neither SDK is in the first-load
 * bundle. It registers its actions in ./wallet and mirrors accounts and balances into the same store.
 *
 * The SDK talks to SODAX through this server's proxy (/api/exclip/sodax): the API key is added server-side.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  SodaxWalletProvider,
  getXChainType,
  sortConnectors,
  useWalletModal,
  useWalletProvider,
  useXAccounts,
  useXConnectors,
  useXDisconnect,
  useXService,
  type IXConnector,
  type SodaxWalletConfig,
} from "@sodax/wallet-sdk-react";
import { SodaxProvider, useSodaxContext, useXBalances, type SodaxOptions, type SpokeChainKey } from "@sodax/dapp-kit";
import { relayTxAndWaitPacket } from "@sodax/sdk";
import { ArrowLeft, Check, ExternalLink, KeyRound, Loader2, Wallet as WalletIcon, X } from "lucide-react";
import { sodaxOptions, useExclipConfig, useSodaxTokens, type SodaxToken } from "./api";
import { BRAND } from "./brand";
import { networkMeta } from "./catalog";
import { SELF_CUSTODY, connectEmbedded, devSignOnly, embeddedErrorText, embeddedOrigin, manageEmbedded, signOutEmbedded } from "./embedded";
import { WalletPopup } from "./embedded-client";
import {
  BROWSER_WALLET_MESSAGE, EmbeddedTradeError, HUB_CHAIN, embeddedSend, embeddedSwap, embeddedSwapProblem, isEmbeddedChain,
  type EvmRpc, type SodaxSwaps,
} from "./embedded-tx";
import {
  closeWalletSheet,
  getWalletState,
  registerWalletActions,
  rememberConnection,
  setWalletState,
  useWallet,
  type ChainFamily,
  type SerializedIntent,
  type WalletActions,
} from "./wallet";
import { Sheet } from "../components/Sheet";

const FAMILIES: { family: ChainFamily; label: string; detail: string }[] = [
  { family: "EVM", label: "EVM networks", detail: "Hedera, Ethereum, Base, Arbitrum, BNB Chain, Sonic and more" },
  { family: "SOLANA", label: "Solana", detail: "Phantom, Solflare, Backpack" },
  { family: "SUI", label: "Sui", detail: "Sui Wallet, Slush" },
  { family: "BITCOIN", label: "Bitcoin", detail: "Unisat, Xverse, OKX" },
  { family: "STELLAR", label: "Stellar", detail: "Freighter, xBull, Lobstr" },
  { family: "NEAR", label: "NEAR", detail: "Meteor, HOT, MyNearWallet" },
  { family: "INJECTIVE", label: "Injective", detail: "Keplr, Leap" },
  { family: "STACKS", label: "Stacks", detail: "Leather, Xverse" },
  { family: "ICON", label: "ICON", detail: "Hana" },
];

const WALLET_CONFIG: SodaxWalletConfig = { EVM: {}, SOLANA: {}, SUI: {}, BITCOIN: {}, STELLAR: {}, NEAR: {}, INJECTIVE: {}, STACKS: {}, ICON: {} };

/** Clip Wallet first: it announces itself over EIP-6963 / Wallet Standard as "Clip" (connector ids vary by family). */
export function clipFirst<T extends IXConnector>(connectors: readonly T[]): T[] {
  const preferred = connectors.filter(c => /\bclip\b/i.test(c.name) || /clip/i.test(c.id)).map(c => c.id);
  return sortConnectors(connectors, { preferred });
}

const serialize = (intent: object): SerializedIntent =>
  Object.fromEntries(Object.entries(intent).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : (v as string | boolean)]));

const revive = (intent: SerializedIntent) =>
  Object.fromEntries(Object.entries(intent).map(([k, v]) => [k, typeof v === "string" && /^\d+$/.test(v) && !/^0x/.test(v) ? BigInt(v) : v]));

function errorText(e: unknown): string {
  const err = e as { code?: string; message?: string; error?: { code?: string; message?: string } };
  const code = err?.code ?? err?.error?.code ?? "";
  if (/reject|denied|cancel/i.test(`${code} ${err?.message ?? ""}`)) return "You declined the request in your wallet.";
  if (code === "NO_PATH_FOUND" || /NO_PATH/i.test(err?.message ?? "")) return "No route between these assets right now.";
  if (code === "TX_SUBMIT_FAILED" || code === "RELAY_TIMEOUT") return "Your transaction is on chain but the relay is slow. Don't resend: we'll keep tracking it.";
  return "The wallet or network returned an error. Nothing was sent.";
}

/** Throws the SDK's Result error, or returns its value. */
function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (r.ok) return r.value;
  throw r.error;
}

function useProviders() {
  // Fixed order of hook calls: one per family, every render.
  const evm = useWalletProvider({ xChainType: "EVM" });
  const solana = useWalletProvider({ xChainType: "SOLANA" });
  const sui = useWalletProvider({ xChainType: "SUI" });
  const bitcoin = useWalletProvider({ xChainType: "BITCOIN" });
  const stellar = useWalletProvider({ xChainType: "STELLAR" });
  const near = useWalletProvider({ xChainType: "NEAR" });
  const injective = useWalletProvider({ xChainType: "INJECTIVE" });
  const stacks = useWalletProvider({ xChainType: "STACKS" });
  const icon = useWalletProvider({ xChainType: "ICON" });
  return { EVM: evm, SOLANA: solana, SUI: sui, BITCOIN: bitcoin, STELLAR: stellar, NEAR: near, INJECTIVE: injective, STACKS: stacks, ICON: icon } as Record<ChainFamily, unknown>;
}

function familyOf(chainKey: string): ChainFamily | null {
  try { return (getXChainType(chainKey as SpokeChainKey) as ChainFamily | undefined) ?? null; } catch { return null; }
}

type Sodax = ReturnType<typeof useSodaxContext>["sodax"];

/** The SDK in raw mode (it builds transactions, never signs) for the embedded wallet's trade flow. */
function sodaxSwaps(sodax: Sodax): SodaxSwaps {
  const swaps = sodax.swaps as unknown as {
    isAllowanceValid(p: unknown): ReturnType<SodaxSwaps["isAllowanceValid"]>;
    buildApproveTxs(p: unknown): ReturnType<SodaxSwaps["buildApproveTxs"]>;
    createIntent(p: unknown): ReturnType<SodaxSwaps["createIntent"]>;
    postExecution(p: { intent_tx_hash: `0x${string}` }): ReturnType<SodaxSwaps["postExecution"]>;
    relayerApiEndpoint: string;
  };
  return {
    isAllowanceValid: params => swaps.isAllowanceValid({ params, raw: true }),
    buildApproveTxs: params => swaps.buildApproveTxs({ params, raw: true }),
    createIntent: (params, skipSimulation) => swaps.createIntent({ params, raw: true, skipSimulation }),
    async relay(chainKey, srcTxHash, relayData) {
      const r = await relayTxAndWaitPacket({
        srcTxHash, data: relayData as never, chainKey: chainKey as SpokeChainKey,
        relayerApiEndpoint: swaps.relayerApiEndpoint as never, timeout: 180_000,
      });
      return r.ok ? { ok: true, value: r.value.dst_tx_hash } : { ok: false, error: r.error };
    },
    postExecution: hubTxHash => swaps.postExecution({ intent_tx_hash: hubTxHash as `0x${string}` }),
    rpc: chainKey => (chainKey === HUB_CHAIN ? sodax.spoke.sonic.publicClient : sodax.spoke.evm.getPublicClient(chainKey as never)) as unknown as EvmRpc,
  };
}

/** Publishes accounts and actions into the first-load store. */
function Bridge() {
  const { sodax } = useSodaxContext();
  const { data: config } = useExclipConfig();
  const { embedded } = useWallet();
  const accounts = useXAccounts();
  const providers = useProviders();
  const disconnect = useXDisconnect();
  const live = useRef({ providers, accounts, origin: embeddedOrigin(config), trading: !!config?.tradingEnabled });
  live.current = { providers, accounts, origin: embeddedOrigin(config), trading: !!config?.tradingEnabled };

  useEffect(() => {
    // While the passkey wallet is in use, its session owns `accounts` (wallet.ts setEmbeddedSession).
    if (embedded) return;
    const out: Partial<Record<ChainFamily, string>> = {};
    for (const [family, account] of Object.entries(accounts)) if (account?.address) out[family as ChainFamily] = account.address;
    setWalletState({ accounts: out });
    rememberConnection(Object.keys(out).length > 0);
  }, [accounts, embedded]);

  useEffect(() => {
    const need = (chainKey: string) => {
      const family = familyOf(chainKey);
      const provider = family ? live.current.providers[family] : undefined;
      const address = family ? live.current.accounts[family]?.address : undefined;
      if (!family || !provider || !address) throw Object.assign(new Error("Connect a wallet for this network first."), { code: "NOT_CONNECTED" });
      return { provider, address, family };
    };

    /** Opens the passkey wallet popup. Must run before the caller's first await (see embedded.ts). */
    const openEmbedded = (): { popup: WalletPopup; evm: string; signOnly: boolean } => {
      const session = getWalletState().embedded;
      const origin = live.current.origin;
      if (!session || !origin) throw new EmbeddedTradeError("Sign in with your passkey wallet first.");
      const signOnly = devSignOnly();
      if (!live.current.trading && !signOnly) throw new EmbeddedTradeError("Trading is paused on this server.");
      return { popup: WalletPopup.open(origin), evm: session.evm, signOnly };
    };
    const embeddedFailure = (e: unknown) => Object.assign(new Error(embeddedErrorText(e)), { cause: e });
    const notWithEmbedded = (what: string) =>
      new Error(`${what} isn't available in the passkey wallet yet. Use a browser wallet, or move your wallet to Clip Wallet (Back up → Move to Clip Wallet).`);

    const actions: WalletActions = {
      familyOf,
      async swap(input, onProgress) {
        const session = getWalletState().embedded;
        if (session) {
          try {
            const problem = embeddedSwapProblem(input, session.evm);
            if (problem) throw new EmbeddedTradeError(problem);
            const { popup, evm, signOnly } = openEmbedded(); // before the first await
            return await embeddedSwap(sodaxSwaps(sodax), popup, input, evm, onProgress, { signOnly });
          } catch (e) {
            const err = embeddedFailure(e);
            onProgress({ step: "failed", message: err.message });
            throw err;
          }
        }
        const src = need(input.srcChainKey);
        const dstFamily = familyOf(input.dstChainKey);
        const dstAddress = input.dstAddress ?? (dstFamily ? live.current.accounts[dstFamily]?.address : undefined);
        if (!dstAddress) throw Object.assign(new Error(`Connect a ${networkMeta(input.dstChainKey).name} wallet, or enter a receiving address.`), { code: "NO_DESTINATION" });
        const params = {
          inputToken: input.inputToken,
          outputToken: input.outputToken,
          inputAmount: input.inputAmount,
          minOutputAmount: input.minOutputAmount,
          // A limit order without expiry leaves the deadline out (it is optional for createLimitOrder).
          ...(input.kind === "limit" && input.deadline === 0n ? {} : { deadline: input.deadline }),
          allowPartialFill: input.kind === "limit",
          srcChainKey: input.srcChainKey as SpokeChainKey,
          dstChainKey: input.dstChainKey as SpokeChainKey,
          srcAddress: src.address,
          dstAddress,
          data: "0x" as const,
        };
        const action = { params, walletProvider: src.provider } as never;
        try {
          const allowed = unwrap(await sodax.swaps.isAllowanceValid(action));
          if (!allowed) { onProgress({ step: "approve" }); unwrap(await sodax.swaps.approve(action)); }
          onProgress({ step: "sign" });
          const res = unwrap(input.kind === "limit" ? await sodax.swaps.createLimitOrder(action) : await sodax.swaps.swap(action));
          const srcTxHash = res.intentDeliveryInfo.srcTxHash;
          const hubTxHash = res.intentDeliveryInfo.dstTxHash;
          onProgress({ step: "submitted", srcTxHash, srcChainKey: input.srcChainKey });
          onProgress({ step: "solving", srcTxHash, hubTxHash });
          return { srcTxHash, hubTxHash, intent: serialize(res.intent) };
        } catch (e) {
          const message = errorText(e);
          onProgress({ step: "failed", message });
          throw Object.assign(new Error(message), { cause: e });
        }
      },
      async cancel({ srcChainKey, intent, kind }) {
        if (getWalletState().embedded) throw notWithEmbedded("Cancelling an order");
        const src = need(srcChainKey);
        const action = { params: { srcChainKey, intent: revive(intent) }, walletProvider: src.provider } as never;
        try {
          const r = unwrap(kind === "limit" ? await sodax.swaps.cancelLimitOrder(action) : await sodax.swaps.cancelIntent(action));
          return r.srcChainTxHash;
        } catch (e) { throw new Error(errorText(e), { cause: e }); }
      },
      async status(hubTxHash) {
        const r = await sodax.swaps.getStatus({ intent_tx_hash: hubTxHash as `0x${string}` });
        if (!r.ok) return null;
        return { code: Number(r.value.status), fillTxHash: r.value.fill_tx_hash };
      },
      async disconnect(family) {
        await disconnect({ xChainType: family } as never);
      },
      async embeddedSend(input) {
        try {
          if (!isEmbeddedChain(input.chainKey)) throw new EmbeddedTradeError(BROWSER_WALLET_MESSAGE);
          const rpc = sodaxSwaps(sodax).rpc(input.chainKey);
          const { popup, evm, signOnly } = openEmbedded(); // before the first await
          return await embeddedSend(rpc, popup, input, evm, { signOnly });
        } catch (e) {
          throw embeddedFailure(e);
        }
      },
    };
    registerWalletActions(actions);
    setWalletState({ status: "ready" });
    return () => registerWalletActions(null);
  }, [sodax, disconnect]);

  return null;
}

/** Reads balances for one connected chain (one query per chain key, every 30 s while mounted). */
function BalanceProbe({ chainKey, family, address, tokens }: { chainKey: string; family: ChainFamily; address: string; tokens: SodaxToken[] }) {
  const xService = useXService({ xChainType: family });
  const { data } = useXBalances({ params: { xService, xChainId: chainKey as SpokeChainKey, xTokens: tokens as never, address } as never });
  useEffect(() => {
    if (!data) return;
    const row: Record<string, string> = {};
    for (const [addr, v] of Object.entries(data)) if (typeof v === "bigint") row[addr.toLowerCase()] = v.toString();
    setWalletState(s => ({ balances: { ...s.balances, [chainKey]: row } }));
  }, [data, chainKey]);
  return null;
}

function Balances() {
  const { accounts } = useWallet();
  const { data: tokens } = useSodaxTokens();
  if (!tokens) return null;
  const probes = [];
  for (const [chainKey, list] of Object.entries(tokens)) {
    const family = familyOf(chainKey);
    const address = family ? accounts[family] : undefined;
    if (!family || !address || !Array.isArray(list) || !list.length) continue;
    probes.push(<BalanceProbe key={`${chainKey}:${address}`} chainKey={chainKey} family={family} address={address} tokens={list} />);
  }
  return <>{probes}</>;
}

function ConnectorRow({ c, onPick, busy }: { c: IXConnector; onPick: (c: IXConnector) => void; busy: boolean }) {
  const isClip = /\bclip\b/i.test(c.name);
  return (
    <li>
      <button type="button" className="x-row x-row-btn" onClick={() => onPick(c)} disabled={busy} aria-describedby={isClip ? "x-clip-note" : undefined}>
        <span className="x-wallet-ico" aria-hidden="true">
          {c.icon ? <img src={c.icon} alt="" width={28} height={28} /> : <WalletIcon size={18} />}
        </span>
        <span className="x-row-main">
          <span className="x-row-title">{c.name}</span>
          <span className="x-row-sub">{isClip ? "Recommended · one wallet for every network" : c.isInstalled ? "Detected" : "Not installed"}</span>
        </span>
        {!c.isInstalled && c.installUrl ? <ExternalLink size={16} aria-hidden="true" /> : null}
      </button>
    </li>
  );
}

function WalletList({ family, onPick, busy }: { family: ChainFamily; onPick: (c: IXConnector) => void; busy: boolean }) {
  const connectors = useXConnectors({ xChainType: family });
  const sorted = useMemo(() => clipFirst(connectors), [connectors]);
  if (!sorted.length) return <p className="x-muted x-pad">No wallets found for this network family. Install one, then reload.</p>;
  return <ul className="x-list" role="list">{sorted.map(c => <ConnectorRow key={c.id} c={c} onPick={onPick} busy={busy} />)}</ul>;
}

/** Passkey wallet options at the top of the connect sheet. Each button opens the popup synchronously in its click. */
function EmbeddedPanel({ origin }: { origin: string }) {
  const { embedded } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (start: () => Promise<void>, closeAfter: boolean) => {
    setError(null);
    let p: Promise<void>;
    try { p = start(); } catch (e) { setError(embeddedErrorText(e)); return; }
    setBusy(true);
    p.then(() => { if (closeAfter) closeWalletSheet(); }, e => setError(embeddedErrorText(e))).finally(() => setBusy(false));
  };
  const status = busy ? <p className="x-status-line" role="status"><Loader2 className="x-spin" size={18} aria-hidden="true" /> Continue in the wallet window…</p> : null;
  const alert = error ? <p className="x-banner x-banner-warn" role="alert">{error}</p> : null;

  if (embedded) {
    return (
      <div className="x-stack x-pad-b">
        <div className="x-row x-row-stack">
          <span className="x-row-title"><KeyRound size={16} aria-hidden="true" /> Passkey wallet</span>
          <code className="x-code x-num">{embedded.evm}</code>
          <span className="x-row-sub">{embedded.backedUp ? "Backed up" : "Not backed up yet: save your recovery phrase so you can't lose access."}</span>
        </div>
        {status}{alert}
        <button type="button" className="x-btn x-btn-primary x-btn-block" disabled={busy} onClick={() => run(() => manageEmbedded(origin, "save-phrase"), false)}>{embedded.backedUp ? "Show recovery phrase" : "Save recovery phrase"}</button>
        <button type="button" className="x-btn x-btn-ghost x-btn-block" disabled={busy} onClick={() => run(() => manageEmbedded(origin, "add-passkey"), false)}>Add another passkey</button>
        <button type="button" className="x-btn x-btn-ghost x-btn-block" disabled={busy} onClick={() => run(() => manageEmbedded(origin, "move-to-clip"), false)}>Move to Clip Wallet</button>
        <button type="button" className="x-btn x-btn-ghost x-btn-block" disabled={busy} onClick={() => { signOutEmbedded(); closeWalletSheet(); }}>Sign out</button>
        <p className="x-fine">{SELF_CUSTODY} Sign out forgets the address in this tab; the wallet stays on this device.</p>
      </div>
    );
  }
  return (
    <div className="x-stack x-pad-b">
      <button type="button" className="x-btn x-btn-primary x-btn-block x-btn-lg" disabled={busy} onClick={() => run(() => connectEmbedded(origin, "create"), true)}>
        <KeyRound size={18} aria-hidden="true" /> Create wallet with a passkey
      </button>
      <button type="button" className="x-btn x-btn-ghost x-btn-block" disabled={busy} onClick={() => run(() => connectEmbedded(origin, "signin"), true)}>Sign in with passkey</button>
      {status}{alert}
      <p className="x-fine">{SELF_CUSTODY} Works on EVM networks (Ethereum, Base, Arbitrum, BNB Chain, Hedera, Sonic and more).</p>
    </div>
  );
}

function ConnectSheet() {
  const { sheetOpen, accounts, embedded } = useWallet();
  const { data: config } = useExclipConfig();
  const origin = embeddedOrigin(config);
  const modal = useWalletModal({ onConnected: () => { /* state mirrors through Bridge */ } });
  const [family, setFamily] = useState<ChainFamily | null>(null);
  const state = modal.state;

  // Runs when the sheet opens or closes; `modal` is a new object every render.
  useEffect(() => { if (!sheetOpen) { setFamily(null); modal.close(); } }, [sheetOpen]);
  useEffect(() => {
    if (state.kind !== "success") return undefined;
    const t = setTimeout(() => closeWalletSheet(), 700);
    return () => clearTimeout(t);
  }, [state.kind]);

  const pickFamily = (f: ChainFamily) => { setFamily(f); modal.open(); modal.selectChain(f); };
  const pick = (c: IXConnector) => {
    if (!c.isInstalled && c.installUrl) { window.open(c.installUrl, "_blank", "noopener,noreferrer"); return; }
    if (embedded) signOutEmbedded(); // one wallet at a time
    void modal.selectWallet(c as never);
  };
  const browserAccounts: Partial<Record<ChainFamily, string>> = embedded ? {} : accounts;
  const back = () => { if (state.kind === "walletSelect" || state.kind === "closed") setFamily(null); modal.back(); };
  const busy = state.kind === "connecting";

  return (
    <Sheet open={sheetOpen} onClose={closeWalletSheet} title={family ? FAMILIES.find(f => f.family === family)?.label ?? "Connect" : "Connect a wallet"}>
      {family ? (
        <div>
          <button type="button" className="x-link-btn" onClick={back}><ArrowLeft size={16} aria-hidden="true" /> All networks</button>
          {state.kind === "connecting" ? (
            <p className="x-status-line" role="status"><Loader2 className="x-spin" size={18} aria-hidden="true" /> Approve the connection in {state.connector.name}…</p>
          ) : state.kind === "error" ? (
            <div className="x-alert" role="alert">
              <p>{errorText(state.error)}</p>
              <button type="button" className="x-btn x-btn-ghost" onClick={() => void modal.retry()}>Try again</button>
            </div>
          ) : state.kind === "success" ? (
            <p className="x-status-line" role="status"><Check size={18} aria-hidden="true" /> Connected</p>
          ) : (
            <WalletList family={family} onPick={pick} busy={busy} />
          )}
        </div>
      ) : (
        <div>
          <p className="x-muted x-pad-b">{BRAND.name} never holds your funds. You sign every trade in your own wallet.</p>
          {origin ? <EmbeddedPanel origin={origin} /> : embedded ? (
            <button type="button" className="x-btn x-btn-ghost x-btn-block x-pad-b" onClick={() => { signOutEmbedded(); closeWalletSheet(); }}>Sign out of the passkey wallet</button>
          ) : null}
          {origin || embedded ? <h3 className="x-h3 x-pad-b">Use a browser wallet</h3> : null}
          <ul className="x-list" role="list">
            {FAMILIES.map(f => (
              <li key={f.family}>
                <button type="button" className="x-row x-row-btn" onClick={() => pickFamily(f.family)}>
                  <span className="x-row-main">
                    <span className="x-row-title">{f.label}</span>
                    <span className="x-row-sub">{browserAccounts[f.family] ? `Connected · ${browserAccounts[f.family]!.slice(0, 6)}…${browserAccounts[f.family]!.slice(-4)}` : f.detail}</span>
                  </span>
                  {browserAccounts[f.family] ? <Check size={18} aria-label="Connected" /> : null}
                </button>
              </li>
            ))}
          </ul>
          <p id="x-clip-note" className="x-fine x-clip-note">Clip Wallet is listed first when it's installed.</p>
        </div>
      )}
      <button type="button" className="x-sr-only" onClick={closeWalletSheet}><X aria-hidden="true" /> Close</button>
    </Sheet>
  );
}

export default function WalletRuntime() {
  const { data: config } = useExclipConfig();
  // Only the two fee fields matter: a config refetch must not rebuild the SDK.
  const options = useMemo(() => sodaxOptions(config, window.location.origin) as SodaxOptions, [config?.feeReceiver, config?.partnerFeeBps]);

  return (
    <SodaxProvider config={options}>
      <SodaxWalletProvider config={WALLET_CONFIG}>
        <Bridge />
        <Balances />
        <ConnectSheet />
      </SodaxWalletProvider>
    </SodaxProvider>
  );
}
