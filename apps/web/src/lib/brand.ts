/**
 * The deployment's brand, baked into the bundle at build time from exclip.config.ts (vite.config.ts puts
 * webBuildConfig's output in `__EXCLIP__`). Switches that can change without a rebuild (trading, the passkey wallet,
 * the fee) come from the server's /api/exclip/config instead.
 */
export const BRAND = __EXCLIP__.brand;

/** Puts the brand colours on the root element as custom properties; exclip.css reads them and derives the rest. */
export function applyBrandColors(root: HTMLElement) {
  root.style.setProperty("--brand-accent", BRAND.accent);
  root.style.setProperty("--brand-accent-hover", BRAND.accentHover);
  root.style.setProperty("--brand-accent-ink", BRAND.accentInk);
}

/** Sets the tab title and the meta description for the current screen. */
export function setDocumentMeta(title: string, description: string) {
  document.title = title;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "description";
    document.head.appendChild(meta);
  }
  meta.content = description;
}
