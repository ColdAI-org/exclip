import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { usd } from "../lib/format";

export type Point = [number, number];

const W = 1000;

/**
 * A smooth price area chart. The line is neutral; the fill is green or red for the period's direction (the accent is
 * never a data colour). Hover, touch or the arrow keys move a crosshair and report the point to `onHover`, so the page
 * headline can show the value under the cursor. It scales with its box through the viewBox, so the markup is the same
 * whatever the screen width.
 */
export function AreaChart({ points, height = 240, onHover, label, formatTime, loading = false }: {
  points: Point[];
  height?: number;
  onHover?: (p: Point | null) => void;
  label: string;
  formatTime?: (t: number) => string;
  loading?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    let min = Infinity, max = -Infinity;
    for (const [, v] of points) { if (v < min) min = v; if (v > max) max = v; }
    const pad = (max - min) * 0.08 || Math.abs(max) * 0.01 || 1;
    const lo = min - pad, hi = max + pad;
    const first = points[0]!, last = points[points.length - 1]!;
    const t0 = first[0], t1 = last[0];
    const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W;
    const y = (v: number) => height - ((v - lo) / (hi - lo)) * height;
    const xy = points.map(([t, v]) => [x(t), y(v)] as const);
    // Monotone-ish smoothing with short cubic segments.
    let d = `M${xy[0]![0].toFixed(1)} ${xy[0]![1].toFixed(1)}`;
    for (let i = 1; i < xy.length; i++) {
      const [x0, y0] = xy[i - 1]!, [x1, y1] = xy[i]!;
      const cx = (x0 + x1) / 2;
      d += `C${cx.toFixed(1)} ${y0.toFixed(1)} ${cx.toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    }
    const area = `${d}L${W} ${height}L0 ${height}Z`;
    const up = last[1] >= first[1];
    return { d, area, xy, up, min, max };
  }, [points, height]);

  const move = (clientX: number) => {
    const el = box.current;
    if (!el || !geo) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const target = frac * W;
    // Binary search on x.
    let lo = 0, hi = geo.xy.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (geo.xy[mid]![0] < target) lo = mid; else hi = mid; }
    const i = Math.abs(geo.xy[lo]![0] - target) <= Math.abs(geo.xy[hi]![0] - target) ? lo : hi;
    setActive(i);
    onHover?.(points[i] ?? null);
  };
  const leave = () => { setActive(null); onHover?.(null); };
  const onKey = (e: KeyboardEvent) => {
    if (!geo) return;
    const last = points.length - 1;
    let i: number;
    if (e.key === "ArrowLeft") i = Math.max(0, (active ?? last) - Math.max(1, Math.round(points.length / 60)));
    else if (e.key === "ArrowRight") i = Math.min(last, (active ?? 0) + Math.max(1, Math.round(points.length / 60)));
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = last;
    else if (e.key === "Escape") { leave(); return; }
    else return;
    e.preventDefault();
    setActive(i);
    onHover?.(points[i] ?? null);
  };

  const a = active != null && geo ? geo.xy[active] ?? null : null;
  const fmt = formatTime ?? ((t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  const summary = geo
    ? `${label}. Low ${usd(geo.min)}, high ${usd(geo.max)}, ${geo.up ? "up" : "down"} over the period.`
    : `${label}. No data.`;

  return (
    <div
      ref={box}
      className={`x-chart${loading ? " is-loading" : ""}`}
      style={{ height }}
      role="img"
      aria-label={summary}
      tabIndex={geo ? 0 : -1}
      onPointerMove={(e: PointerEvent) => move(e.clientX)}
      onPointerDown={(e: PointerEvent) => move(e.clientX)}
      onPointerLeave={leave}
      onBlur={leave}
      onKeyDown={onKey}
    >
      {geo ? (
        <>
          <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden="true" focusable="false">
            <defs>
              <linearGradient id={`xa-${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className={geo.up ? "x-fill-up" : "x-fill-down"} stopOpacity=".28" />
                <stop offset="1" className={geo.up ? "x-fill-up" : "x-fill-down"} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={geo.area} fill={`url(#xa-${id})`} />
            <path d={geo.d} className="x-chart-line" fill="none" vectorEffect="non-scaling-stroke" />
            {a ? <line x1={a[0]} x2={a[0]} y1={0} y2={height} className="x-chart-cross" vectorEffect="non-scaling-stroke" /> : null}
          </svg>
          {a ? (
            <>
              <span className="x-chart-dot" style={{ left: `${(a[0] / W) * 100}%`, top: a[1] }} aria-hidden="true" />
              <span className="x-chart-time x-num" style={{ left: `clamp(48px, ${(a[0] / W) * 100}%, calc(100% - 48px))` }} aria-hidden="true">{fmt(points[active!]![0])}</span>
            </>
          ) : null}
        </>
      ) : (
        <div className="x-chart-empty">{loading ? <span className="x-skel x-chart-skel" aria-hidden="true" /> : <span className="x-muted">Chart unavailable right now.</span>}</div>
      )}
    </div>
  );
}
