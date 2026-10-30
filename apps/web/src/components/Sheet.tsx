import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useUi } from "../lib/ui";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog that is a centred card on desktop and a bottom sheet on phones (CSS). Traps focus, closes on
 * Escape and on the backdrop, restores focus to what opened it, and locks page scroll while open.
 */
export function Sheet({ open, onClose, title, children, wide = false, labelledBy }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const restore = useRef<HTMLElement | null>(null);
  const { theme } = useUi();

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement | null;
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = "hidden";
    const t = window.setTimeout(() => {
      const el = ref.current;
      const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el)?.focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      root.style.overflow = prev;
      restore.current?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab" || !ref.current) return;
    const nodes = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(n => n.offsetParent !== null || n === document.activeElement);
    if (!nodes.length) return;
    const first = nodes[0]!, last = nodes[nodes.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return createPortal(
    <div className="exclip x-portal" data-theme={theme}>
      <div className="x-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        tabIndex={-1}
        className={`x-sheet${wide ? " x-sheet-wide" : ""}`}
        onKeyDown={onKeyDown}
      >
        <div className="x-sheet-grip" aria-hidden="true" />
        <header className="x-sheet-head">
          <h2 id={titleId} className="x-sheet-title">{title}</h2>
          <button type="button" className="x-icon-btn" onClick={onClose} aria-label="Close"><X size={20} aria-hidden="true" /></button>
        </header>
        <div className="x-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
