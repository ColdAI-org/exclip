/**
 * ExClip number formatting. Every number on screen goes through here: locale grouping, smart decimals (more for
 * small prices, fewer for large values) and never scientific notation. The locale starts as en-US, so tests and the
 * first render agree; `setLocale` switches it to the visitor's after mount.
 */

let locale = "en-US";
const cache = new Map<string, Intl.NumberFormat>();

export function setLocale(next: string | undefined) {
  if (!next || next === locale) return;
  try { new Intl.NumberFormat(next); locale = next; cache.clear(); } catch { /* keep en-US */ }
}

function nf(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = locale + JSON.stringify(options);
  let f = cache.get(key);
  if (!f) { f = new Intl.NumberFormat(locale, { notation: "standard", ...options }); cache.set(key, f); }
  return f;
}

/** Fraction digits that keep about four significant figures for small numbers, two for ordinary ones. */
export function smartDecimals(value: number, { min = 2, max = 10 }: { min?: number; max?: number } = {}): number {
  const a = Math.abs(value);
  if (!Number.isFinite(a) || a === 0) return min;
  if (a >= 1000) return Math.min(min, 2);
  if (a >= 1) return Math.max(min, 2);
  // 0.0123 -> 5, 0.000045678 -> 8
  const lead = Math.floor(-Math.log10(a)); // zeros after the point
  return Math.min(max, Math.max(min, lead + 4));
}

const DASH = "—";

/** $1,234.56 · $0.0004567 · never 4.5e-7. */
export function usd(value: number | null | undefined, opts: { decimals?: number; sign?: boolean } = {}): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const d = opts.decimals ?? smartDecimals(value);
  const s = nf({ style: "currency", currency: "USD", minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d }).format(Math.abs(value));
  if (opts.sign) return (value > 0 ? "+" : value < 0 ? "−" : "") + s;
  return value < 0 ? "−" + s : s;
}

/** $1.2B / $345.6M / $12.3K for market caps and volumes. */
export function usdCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return nf({ style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: value >= 1e3 ? 2 : 0 }).format(value);
}

/** Plain compact number (supplies). */
export function compact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return nf({ notation: "compact", maximumFractionDigits: 2 }).format(value);
}

/** Token amount: 1,234.5678 · 0.00001234 · trailing zeros trimmed. */
export function amount(value: number | null | undefined, maxDecimals?: number): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const d = maxDecimals ?? (Math.abs(value) >= 1 ? 6 : smartDecimals(value, { min: 2, max: 12 }));
  return nf({ minimumFractionDigits: 0, maximumFractionDigits: d }).format(value);
}

/** +2.14% / −0.80% (true minus sign); the arrow is drawn by <Change>. */
export function pct(value: number | null | undefined, { sign = true, decimals = 2 }: { sign?: boolean; decimals?: number } = {}): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const s = nf({ minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Math.abs(value)) + "%";
  if (!sign) return value < 0 ? "−" + s : s;
  return (value > 0 ? "+" : value < 0 ? "−" : "") + s;
}

/** A fee's rate, given per 100,000 of the amount sold, as a percentage: 875 is 0.875%, 100 is 0.10%. */
export function feeRate(perHundredThousand: number): string {
  return nf({ minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(perHundredThousand / 1_000) + "%";
}

export function direction(value: number | null | undefined): "up" | "down" | "flat" {
  if (value == null || !Number.isFinite(value) || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

/**
 * Exact decimal string for a bigint base-unit amount (no floating point, no exponent).
 * fromUnits(123450000n, 8) === "1.2345".
 */
export function fromUnits(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/**
 * Parses what the user typed into base units, exactly. Accepts "1,234.5" or "1234,5" (a lone comma with up to the
 * token's decimals after it counts as the decimal point). Returns null for anything that isn't a plain decimal.
 */
export function toUnits(input: string, decimals: number): bigint | null {
  let s = input.trim().replace(/[\s_]/g, "");
  if (!s) return null;
  if (/^\d+,\d+$/.test(s) && !s.includes(".") && s.split(",")[1]!.length !== 3) s = s.replace(",", ".");
  s = s.replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === ".") return null;
  const [w = "", f = ""] = s.split(".");
  if (f.length > decimals) return null;
  return BigInt((w || "0") + f.padEnd(decimals, "0"));
}

/** A plain decimal string for a JS number, without exponent (for inputs). */
export function plain(value: number, maxDecimals = 8): string {
  if (!Number.isFinite(value)) return "";
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: maxDecimals });
}

export function shortAddress(address: string | undefined | null): string {
  if (!address) return "";
  return address.length <= 13 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** "3 min" / "45 s" for estimated settlement times. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  return `${Math.round(seconds / 60)} min`;
}
