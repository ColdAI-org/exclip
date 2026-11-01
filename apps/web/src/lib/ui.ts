/** ExClip UI state shared across the shell and pages: theme, the trade sheet and the search palette. */
import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
export type TradeTab = "buy" | "sell" | "convert";

export type UiState = {
  theme: Theme;
  /** `send`: deliver to another address (the review step opens with the recipient field). */
  trade: { open: boolean; tab: TradeTab; symbol: string | null; send: boolean };
  searchOpen: boolean;
  /** Receive / Send help sheet. */
  transfer: "send" | "receive" | null;
};

const INITIAL: UiState = { theme: "dark", trade: { open: false, tab: "buy", symbol: null, send: false }, searchOpen: false, transfer: null };
let state = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<UiState>) { state = { ...state, ...patch }; listeners.forEach(l => l()); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

// The server snapshot lets a page that mounts a sheet render outside a browser (the tests do).
export function useUi(): UiState { return useSyncExternalStore(subscribe, () => state, () => state); }

const THEME_KEY = "exclip.theme";

/** Dark by default; a saved light preference applies once the shell mounts. */
export function loadTheme() {
  try { const t = window.localStorage.getItem(THEME_KEY); if (t === "light" || t === "dark") set({ theme: t }); } catch { /* blocked */ }
}
export function setTheme(theme: Theme) {
  set({ theme });
  try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* blocked */ }
}

export function openTrade(tab: TradeTab = "buy", symbol: string | null = null, opts: { send?: boolean } = {}) {
  set({ trade: { open: true, tab, symbol, send: !!opts.send }, transfer: null });
}
export function closeTrade() { set({ trade: { ...state.trade, open: false } }); }
export function setSearchOpen(open: boolean) { set({ searchOpen: open }); }
export function setTransfer(transfer: UiState["transfer"]) { set({ transfer }); }
