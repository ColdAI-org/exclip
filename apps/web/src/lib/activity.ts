/**
 * ExClip activity kept in this browser: swaps and limit orders started here. It is what Open orders, Order history,
 * Portfolio activity and the CSV export read. Nothing of it is sent to the server. Intents are stored with bigints as
 * strings so an unfilled order can still be cancelled after a reload.
 */
import { useSyncExternalStore } from "react";
import type { SerializedIntent } from "./wallet";

export type ActivityStatus = "pending" | "open" | "solving" | "settled" | "failed" | "cancelled" | "expired";

export type Activity = {
  id: string;
  kind: "swap" | "limit";
  createdAt: number;
  updatedAt: number;
  status: ActivityStatus;
  from: { symbol: string; chainKey: string; amount: string };
  to?: { symbol: string; chainKey: string; amount: string; minAmount?: string };
  /** Limit price in quote per base, as typed. */
  limitPrice?: string;
  /** Seconds since epoch, or null for no expiry. */
  expiresAt?: number | null;
  srcTxHash?: string;
  hubTxHash?: string;
  fillTxHash?: string;
  intent?: SerializedIntent;
  error?: string;
};

const KEY = "exclip.activity.v1";
const MAX = 500;
let items: Activity[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const EMPTY: Activity[] = [];

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) items = parsed.filter(a => a && typeof a.id === "string");
  } catch { items = []; }
}

function save() {
  try { window.localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX))); } catch { /* storage full or blocked */ }
  listeners.forEach(l => l());
}

export function addActivity(a: Omit<Activity, "createdAt" | "updatedAt">): Activity {
  load();
  const now = Date.now();
  const entry = { ...a, createdAt: now, updatedAt: now };
  items = [entry, ...items.filter(x => x.id !== a.id)];
  save();
  return entry;
}

export function updateActivity(id: string, patch: Partial<Activity>) {
  load();
  items = items.map(a => (a.id === id ? { ...a, ...patch, updatedAt: Date.now() } : a));
  save();
}

/** Marks limit orders whose deadline has passed as expired. */
export function sweepExpired(nowSeconds = Math.floor(Date.now() / 1000)) {
  load();
  let changed = false;
  items = items.map(a => {
    if (a.status === "open" && a.expiresAt && a.expiresAt < nowSeconds) { changed = true; return { ...a, status: "expired" as const, updatedAt: Date.now() }; }
    return a;
  });
  if (changed) save();
}

function subscribe(l: () => void) {
  load();
  listeners.add(l);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { loaded = false; load(); listeners.forEach(x => x()); } };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(l); window.removeEventListener("storage", onStorage); };
}

/** All activity, newest first. Empty on the very first render, read from storage once a component subscribes. */
export function useActivity(): Activity[] {
  return useSyncExternalStore(subscribe, () => (loaded ? items : EMPTY));
}

export const isOpen = (a: Activity) => a.status === "open" || a.status === "pending" || a.status === "solving";

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Quote everything; neutralise spreadsheet formulas (=, +, -, @) in free text.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function activityCsv(list: Activity[]): string {
  const header = ["date_utc", "type", "status", "from_amount", "from_asset", "from_network", "to_amount", "to_asset", "to_network", "limit_price", "source_tx", "hub_tx", "fill_tx"];
  const rows = list.map(a => [
    new Date(a.createdAt).toISOString(), a.kind, a.status,
    a.from.amount, a.from.symbol, a.from.chainKey,
    a.to?.amount ?? "", a.to?.symbol ?? "", a.to?.chainKey ?? "",
    a.limitPrice ?? "", a.srcTxHash ?? "", a.hubTxHash ?? "", a.fillTxHash ?? "",
  ]);
  return [header, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
