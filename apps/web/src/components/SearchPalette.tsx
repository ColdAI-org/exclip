import { useEffect, useId, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Search } from "lucide-react";
import { ASSETS } from "../lib/catalog";
import { marketMap, useMarkets } from "../lib/api";
import { usd } from "../lib/format";
import { isModifierShortcut } from "../lib/keyboard";
import { setSearchOpen, useUi } from "../lib/ui";
import { Sheet } from "./Sheet";
import { AssetIcon, Change } from "./primitives";

type Hit = { symbol: string; name: string; href: string };

/** ⌘K / Ctrl+K search over the assets. A combobox with a listbox of results. */
export function SearchPalette() {
  const { searchOpen } = useUi();
  const [, navigate] = useLocation();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const { data: markets } = useMarkets({ enabled: searchOpen });
  const prices = useMemo(() => marketMap(markets?.rows), [markets]);
  const listId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isModifierShortcut(e, "k")) { e.preventDefault(); setSearchOpen(true); }
      else if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || (e.target instanceof HTMLElement && e.target.isContentEditable))) { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { if (!searchOpen) { setQ(""); setCursor(0); } }, [searchOpen]);

  const hits = useMemo<Hit[]>(() => {
    const all: Hit[] = ASSETS.map(a => ({ symbol: a.symbol, name: a.name, href: `/asset/${a.symbol}` }));
    const needle = q.trim().toLowerCase();
    if (!needle) return all.slice(0, 8);
    const score = (h: Hit) => {
      const s = h.symbol.toLowerCase(), n = h.name.toLowerCase();
      if (s === needle) return 0;
      if (s.startsWith(needle)) return 1;
      if (n.startsWith(needle)) return 2;
      if (n.includes(needle) || s.includes(needle)) return 3;
      return 9;
    };
    return all.map(h => [h, score(h)] as const).filter(([, s]) => s < 9).sort((a, b) => a[1] - b[1]).slice(0, 12).map(([h]) => h);
  }, [q]);

  const current = hits[cursor];
  const go = (h: Hit) => { setSearchOpen(false); navigate(h.href); };

  return (
    <Sheet open={searchOpen} onClose={() => setSearchOpen(false)} title="Search assets">
      <div className="x-search">
        <label className="x-search-field">
          <Search size={18} aria-hidden="true" />
          <span className="x-sr-only">Search by name or ticker</span>
          <input
            data-autofocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={current ? `${listId}-${current.symbol}` : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="Bitcoin, ETH, HBAR…"
            value={q}
            onChange={e => { setQ(e.target.value); setCursor(0); }}
            onKeyDown={e => {
              if (e.key === "ArrowDown") { e.preventDefault(); setCursor(c => Math.min(hits.length - 1, c + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); }
              else if (e.key === "Enter" && current) { e.preventDefault(); go(current); }
            }}
          />
          <kbd className="x-kbd" aria-hidden="true">Esc</kbd>
        </label>
        <ul id={listId} role="listbox" aria-label="Assets" className="x-list x-search-list">
          {hits.map((h, i) => {
            const m = prices.get(h.symbol);
            return (
              <li
                key={h.symbol}
                id={`${listId}-${h.symbol}`}
                role="option"
                aria-selected={i === cursor}
                className={`x-row x-row-btn${i === cursor ? " is-active" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(h)}
              >
                <AssetIcon symbol={h.symbol} size={32} />
                <span className="x-row-main">
                  <span className="x-row-title">{h.name}</span>
                  <span className="x-row-sub">{h.symbol}</span>
                </span>
                {m ? <span className="x-row-end"><span className="x-num">{usd(m.price)}</span><Change value={m.change24h} /></span> : null}
              </li>
            );
          })}
          {!hits.length ? <li className="x-muted x-pad" role="presentation">No assets match “{q}”.</li> : null}
        </ul>
      </div>
    </Sheet>
  );
}
