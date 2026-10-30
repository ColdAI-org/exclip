import { memo, type CSSProperties, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { assetMeta, networkMeta } from "../lib/catalog";
import { direction, pct } from "../lib/format";

/** An asset's icon: a generated monogram (no third-party logos), tinted per asset. */
export function AssetIcon({ symbol, size = 36, network }: { symbol: string; size?: number; network?: string }) {
  const meta = assetMeta(symbol);
  const hue = meta?.hue ?? 0;
  const sat = meta ? (meta.kind === "stable" ? 70 : 65) : 0;
  const label = symbol.length > 4 ? symbol.slice(0, 3) : symbol;
  const style = {
    width: size,
    height: size,
    "--x-ico-h": hue,
    "--x-ico-s": `${sat}%`,
    fontSize: Math.max(9, Math.round(size * (label.length > 3 ? 0.27 : 0.32))),
  } as CSSProperties;
  return (
    <span className="x-asset-ico" style={style} aria-hidden="true">
      {label}
      {network ? <NetworkBadge chainKey={network} size={Math.round(size * 0.42)} className="x-asset-ico-net" /> : null}
    </span>
  );
}

/** A network's badge: its initials on a tinted disc, like the asset icons (no third-party logos). */
export function NetworkBadge({ chainKey, size = 16, className = "" }: { chainKey: string; size?: number; className?: string }) {
  const n = networkMeta(chainKey);
  return (
    <span className={`x-net-ico x-net-mono ${className}`} style={{ width: size, height: size, "--x-ico-h": n.hue, fontSize: Math.max(7, Math.round(size * (n.monogram.length > 1 ? 0.4 : 0.5))) } as CSSProperties} aria-hidden="true">
      {n.monogram}
    </span>
  );
}

/** A coloured change with an arrow and a sign, so direction never depends on colour alone. */
export function Change({ value, className = "", suffix }: { value: number | null | undefined; className?: string; suffix?: ReactNode }) {
  const dir = direction(value);
  const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  const word = dir === "up" ? "up" : dir === "down" ? "down" : "unchanged";
  return (
    <span className={`x-change x-${dir} x-num ${className}`}>
      <Icon size={14} aria-hidden="true" strokeWidth={2.5} />
      <span className="x-sr-only">{word} </span>
      {pct(value)}
      {suffix}
    </span>
  );
}

export function Skeleton({ w = "100%", h = 14, r = 6, className = "", style }: { w?: number | string; h?: number | string; r?: number; className?: string; style?: CSSProperties }) {
  return <span className={`x-skel ${className}`} style={{ width: w, height: h, borderRadius: r, ...style }} aria-hidden="true" />;
}

/** Tiny inline price line. Colour follows the period's direction; it's decorative (the % next to it carries the data). */
export const Sparkline = memo(function Sparkline({ points, width = 96, height = 32, dir }: { points: number[]; width?: number; height?: number; dir?: "up" | "down" | "flat" }) {
  if (points.length < 2) return <span className="x-spark-empty" style={{ width, height }} aria-hidden="true" />;
  let min = Infinity, max = -Infinity;
  for (const p of points) { if (p < min) min = p; if (p > max) max = p; }
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const d = points.map((p, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)} ${(height - 2 - ((p - min) / span) * (height - 4)).toFixed(1)}`).join("");
  const trend = dir ?? (points[points.length - 1]! >= points[0]! ? "up" : "down");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={`x-spark x-${trend}`} aria-hidden="true" focusable="false">
      <path d={d} fill="none" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
});

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="x-empty">
      {icon ? <div className="x-empty-ico" aria-hidden="true">{icon}</div> : null}
      <p className="x-empty-title">{title}</p>
      {children ? <div className="x-empty-body">{children}</div> : null}
      {action ? <div className="x-empty-action">{action}</div> : null}
    </div>
  );
}

export function Pills<T extends string>({ value, options, onChange, label, size = "md" }: {
  value: T;
  options: readonly T[] | { value: T; label: string }[];
  onChange: (v: NoInfer<T>) => void;
  label: string;
  size?: "sm" | "md";
}) {
  const opts = (options as readonly (T | { value: T; label: string })[]).map(o => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <div className={`x-pills x-pills-${size}`} role="radiogroup" aria-label={label}>
      {opts.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`x-pill${value === o.value ? " is-on" : ""}`}
          onClick={() => onChange(o.value)}
          onKeyDown={e => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const i = opts.findIndex(x => x.value === value);
            const next = opts[(i + (e.key === "ArrowRight" ? 1 : opts.length - 1)) % opts.length]!;
            onChange(next.value);
            (e.currentTarget.parentElement?.querySelectorAll("button")[opts.indexOf(next)] as HTMLButtonElement | undefined)?.focus();
          }}
          tabIndex={value === o.value ? 0 : -1}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange, label, idBase }: {
  value: T;
  options: { value: T; label: string; badge?: ReactNode }[];
  onChange: (v: NoInfer<T>) => void;
  label: string;
  idBase: string;
}) {
  return (
    <div className="x-tabs" role="tablist" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          id={`${idBase}-tab-${o.value}`}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          aria-controls={`${idBase}-panel`}
          tabIndex={value === o.value ? 0 : -1}
          className={`x-tab${value === o.value ? " is-on" : ""}`}
          onClick={() => onChange(o.value)}
          onKeyDown={e => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const next = options[(i + (e.key === "ArrowRight" ? 1 : options.length - 1)) % options.length]!;
            onChange(next.value);
            document.getElementById(`${idBase}-tab-${next.value}`)?.focus();
          }}
        >
          {o.label}{o.badge}
        </button>
      ))}
    </div>
  );
}
