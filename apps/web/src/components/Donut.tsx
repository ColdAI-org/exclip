import { usd } from "../lib/format";

export type Slice = { label: string; value: number; hue: number };

/** Allocation donut. The legend next to it carries every value; the ring itself is decorative. */
export function Donut({ slices, size = 168, total }: { slices: Slice[]; size?: number; total: number }) {
  const r = 15.9155; // circumference 100
  let offset = 25; // start at 12 o'clock
  const sum = slices.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div className="x-donut" style={{ width: size, height: size }}>
      <svg viewBox="0 0 42 42" width={size} height={size} aria-hidden="true" focusable="false">
        <circle cx="21" cy="21" r={r} fill="none" className="x-donut-track" strokeWidth="5" />
        {slices.map(s => {
          const len = (s.value / sum) * 100;
          const el = (
            <circle
              key={s.label}
              cx="21" cy="21" r={r} fill="none" strokeWidth="5"
              stroke={`hsl(${s.hue} 70% 55%)`}
              strokeDasharray={`${Math.max(0, len - 0.6)} ${100 - Math.max(0, len - 0.6)}`}
              strokeDashoffset={offset}
            />
          );
          offset -= len;
          return el;
        })}
      </svg>
      <div className="x-donut-center">
        <span className="x-muted x-small">Total</span>
        <span className="x-num x-strong">{usd(total, { decimals: total >= 1000 ? 0 : 2 })}</span>
      </div>
    </div>
  );
}
