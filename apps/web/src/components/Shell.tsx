import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeftRight, Briefcase, CandlestickChart, Home, Moon, Search, Sun } from "lucide-react";
import { useExclipConfig } from "../lib/api";
import { BRAND } from "../lib/brand";
import { setLocale, shortAddress } from "../lib/format";
import { loadTheme, openTrade, setSearchOpen, setTheme, useUi } from "../lib/ui";
import { primaryAddress, requestWallet, setEmbeddedSession, setWalletState, shouldReconnect, storedEmbeddedSession, useWallet } from "../lib/wallet";
import { embeddedErrorText, embeddedOrigin, manageEmbedded } from "../lib/embedded";
import { sweepExpired } from "../lib/activity";
import { useIntentWatcher } from "../lib/watcher";
import { Footer } from "./Footer";
import { Logo, Wordmark } from "./Mark";
import { SearchPalette } from "./SearchPalette";
import { TradeSheet } from "./TradeSheet";
import { TransferSheet } from "./TransferSheet";
import { Sheet } from "./Sheet";

const NAV = [
  { href: "/", label: "Home", icon: Home, match: (p: string) => p === "/" || p.startsWith("/asset/") },
  { href: "/trade", label: "Trade", icon: CandlestickChart, match: (p: string) => p === "/trade" || p.startsWith("/trade/") },
  { href: "/portfolio", label: "Portfolio", icon: Briefcase, match: (p: string) => p === "/portfolio" },
] as const;

// The wallet SDKs (and everything they pull in) load only through this import, after Connect or Preview, so they stay
// out of the first-load bundle. The polyfills must run before the SDK modules evaluate, hence the two steps.
const WalletRuntime = lazy(() => import("../lib/wallet-polyfills").then(() => import("../lib/wallet-runtime")));

class LoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch() { setWalletState({ status: "failed", requested: false, error: "The wallet module didn't load. Check your connection and try again." }); }
  override render() { return this.state.failed ? null : this.props.children; }
}

function WalletLoading() {
  const { sheetOpen } = useWallet();
  return (
    <Sheet open={sheetOpen} onClose={() => setWalletState({ sheetOpen: false })} title="Connect a wallet">
      <div className="x-list" aria-busy="true">
        <p className="x-status-line" role="status">Loading wallets…</p>
        {[0, 1, 2, 3].map(i => <div key={i} className="x-row"><span className="x-skel" style={{ width: "60%", height: 16 }} /></div>)}
      </div>
    </Sheet>
  );
}

/** Mounts the lazy wallet runtime once requested; restores a previous session after the first render. */
function WalletHost() {
  const { requested } = useWallet();
  useEffect(() => {
    const embedded = storedEmbeddedSession();
    if (embedded) { setEmbeddedSession(embedded); requestWallet(); } else if (shouldReconnect()) requestWallet();
  }, []);
  if (!requested) return null;
  return (
    <LoadBoundary>
      <Suspense fallback={<WalletLoading />}>
        <WalletRuntime />
      </Suspense>
    </LoadBoundary>
  );
}

export function ConnectButton({ className = "" }: { className?: string }) {
  const wallet = useWallet();
  const address = primaryAddress(wallet);
  if (address) {
    return (
      <button type="button" className={`x-btn x-btn-ghost x-addr ${className}`} onClick={() => requestWallet({ open: true })} aria-label={`Wallet ${shortAddress(address)}. Manage connections`}>
        <span className="x-dot-live" aria-hidden="true" />
        <span className="x-num">{shortAddress(address)}</span>
      </button>
    );
  }
  return (
    <button type="button" className={`x-btn x-btn-primary ${className}`} onClick={() => requestWallet({ open: true })} aria-busy={wallet.status === "loading" && wallet.sheetOpen}>
      Connect wallet
    </button>
  );
}

/** Shown while the passkey wallet has neither a saved phrase nor a second passkey. Opens the popup in the click. */
function BackupBanner({ origin }: { origin: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backUp = () => {
    setError(null);
    const p = manageEmbedded(origin, "save-phrase");
    setBusy(true);
    p.catch(e => setError(embeddedErrorText(e))).finally(() => setBusy(false));
  };
  return (
    <div className="x-banner x-banner-warn x-banner-action" role="region" aria-label="Back up your wallet">
      <p>
        <strong>Back up your wallet.</strong> If this device's passkey is lost, a saved recovery phrase is the only way back to your funds.
        {error ? <span role="alert"> {error}</span> : null}
      </p>
      <button type="button" className="x-btn x-btn-primary x-btn-sm" onClick={backUp} disabled={busy}>{busy ? "Continue in the wallet window…" : "Back up now"}</button>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const path = location.replace(/\/$/, "") || "/";
  const { theme } = useUi();
  const wallet = useWallet();
  const { data: config } = useExclipConfig();
  const walletOrigin = embeddedOrigin(config);
  useIntentWatcher();

  useEffect(() => {
    loadTheme();
    setLocale(navigator.language);
    sweepExpired();
  }, []);

  return (
    <div className="exclip x-app" data-theme={theme}>
      <a href="#x-main" className="x-skip">Skip to content</a>
      <aside className="x-rail" aria-label={BRAND.name}>
        <Link href="/" className="x-brand" aria-label={`${BRAND.name} home`}>
          <Logo size={32} />
          <Wordmark />
        </Link>
        <nav aria-label="Main">
          <ul className="x-rail-nav">
            {NAV.map(n => {
              const on = n.match(path);
              return (
                <li key={n.href}>
                  <Link href={n.href} className={`x-rail-link${on ? " is-on" : ""}`} aria-current={on ? "page" : undefined}>
                    <n.icon size={20} aria-hidden="true" />
                    <span>{n.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="x-rail-foot">
          <button type="button" className="x-btn x-btn-primary x-btn-block" onClick={() => openTrade("buy")}>
            <ArrowLeftRight size={18} aria-hidden="true" /> Trade
          </button>
          <p className="x-fine">Non-custodial: you sign every trade.</p>
        </div>
      </aside>

      <div className="x-main-col">
        <header className="x-top">
          <Link href="/" className="x-brand x-brand-top" aria-label={`${BRAND.name} home`}><Logo size={28} /><Wordmark /></Link>
          <button type="button" className="x-searchbtn" onClick={() => setSearchOpen(true)} aria-keyshortcuts="Meta+K Control+K">
            <Search size={18} aria-hidden="true" />
            <span className="x-searchbtn-label">Search assets</span>
            <kbd className="x-kbd" aria-hidden="true">⌘K</kbd>
          </button>
          <div className="x-top-end">
            <button
              type="button"
              className="x-icon-btn"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            >
              {theme === "dark" ? <Sun size={20} aria-hidden="true" /> : <Moon size={20} aria-hidden="true" />}
            </button>
            <ConnectButton />
          </div>
        </header>
        {wallet.error ? <p className="x-banner x-banner-warn" role="alert">{wallet.error}</p> : null}
        {wallet.embedded && !wallet.embedded.backedUp && walletOrigin ? <BackupBanner origin={walletOrigin} /> : null}
        {/* features.trading off: markets stay readable; every trade button already says the same. */}
        {config && !config.tradingEnabled ? <p className="x-banner" role="status">Trading is paused on this server. Prices, charts and quotes are live.</p> : null}
        <main id="x-main" className="x-main" tabIndex={-1}>
          {children}
        </main>
        <Footer />
      </div>

      <nav className="x-tabbar" aria-label="Main">
        {NAV.map(n => {
          const on = n.match(path);
          return (
            <Link key={n.href} href={n.href} className={`x-tabbar-link${on ? " is-on" : ""}`} aria-current={on ? "page" : undefined}>
              <n.icon size={22} aria-hidden="true" />
              <span>{n.label}</span>
            </Link>
          );
        })}
      </nav>

      <SearchPalette />
      <TradeSheet />
      <TransferSheet />
      <WalletHost />
    </div>
  );
}
