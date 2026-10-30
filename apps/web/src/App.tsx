/**
 * ExClip: a non-custodial cross-chain exchange on SODAX. Every URL renders this one component, which picks the screen
 * from the path, so moving between screens keeps the shell, the wallet connection and the open sheets. All live data
 * loads in the browser after the first render.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Shell } from "./components/Shell";
import { EmptyState } from "./components/primitives";
import { BRAND, setDocumentMeta } from "./lib/brand";
import { assetMeta, pairOf, QUOTE_SYMBOL } from "./lib/catalog";
import Home from "./pages/Home";
import AssetPage from "./pages/AssetPage";
import Advanced from "./pages/Advanced";
import Portfolio from "./pages/Portfolio";

type Screen = { key: string; title: string; description: string; render: () => ReactNode };

/** One path segment as text. A malformed escape stays as typed, so it matches no screen instead of throwing. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function screenFor(path: string): Screen {
  const name = BRAND.name;
  const seg = path.split("/").slice(1).map(decode);
  const [section, param] = seg;
  if (!section) return { key: "home", title: `${name}: trade crypto across every chain`, description: "Buy, sell and convert crypto across 20+ networks from your own wallet. Non-custodial, settled by SODAX.", render: () => <Home /> };
  if (section === "asset" && param && seg.length === 2) {
    const meta = assetMeta(param);
    const sym = param.toUpperCase();
    return {
      key: `asset:${sym}`,
      title: meta ? `${meta.name} (${sym}) price and trading · ${name}` : `Asset not found · ${name}`,
      description: meta ? `Live ${meta.name} price, chart and market stats. Buy or sell ${sym} on any supported network from your own wallet.` : `This asset isn't listed on ${name}.`,
      render: () => <AssetPage symbol={sym} />,
    };
  }
  if (section === "trade" && seg.length <= 2) {
    const pair = pairOf(param ?? `BTC-${QUOTE_SYMBOL}`);
    const label = pair ? `${pair.base}/${pair.quote}` : "Advanced trade";
    return { key: `trade:${param ?? ""}`, title: `${label} advanced trade · ${name}`, description: "Market and limit orders as SODAX intents, with live best-route pricing and your open orders.", render: () => <Advanced pair={param} /> };
  }
  if (section === "portfolio" && seg.length === 1) return { key: "portfolio", title: `Portfolio · ${name}`, description: "Your holdings across every network, allocation and activity, with CSV export.", render: () => <Portfolio /> };
  return {
    key: "404",
    title: `Page not found · ${name}`,
    description: `This ${name} page doesn't exist.`,
    render: () => <div className="x-page"><EmptyState title="Page not found" action={<Link href="/" className="x-btn x-btn-primary">{name} home</Link>}>That page doesn't exist.</EmptyState></div>,
  };
}

// A new screen starts at the top, as a page load would. Back and Forward keep the offset the browser restores: the
// flag marks a history step until the frame after it, by which time the screen it leads to has rendered.
let poppedHistory = false;
window.addEventListener("popstate", () => {
  poppedHistory = true;
  requestAnimationFrame(() => { poppedHistory = false; });
});

export default function App() {
  const [location] = useLocation();
  const path = location.replace(/\/+$/, "") || "/";
  const screen = screenFor(path);
  const { key, title, description } = screen;
  const shown = useRef(key);

  useLayoutEffect(() => {
    if (shown.current === key) return;
    shown.current = key;
    if (!poppedHistory) window.scrollTo(0, 0);
  }, [key]);
  useEffect(() => setDocumentMeta(title, description), [title, description]);

  return (
    <Shell>
      <div key={key} className="x-screen">{screen.render()}</div>
    </Shell>
  );
}
