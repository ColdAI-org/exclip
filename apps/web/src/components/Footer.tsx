import { BRAND } from "../lib/brand";

const LEGAL = [
  { label: "Terms of use", href: BRAND.termsUrl },
  { label: "Privacy", href: BRAND.privacyUrl },
].filter((l): l is { label: string; href: string } => !!l.href);

/** Who runs this deployment, and its legal pages (brand.operator, termsUrl and privacyUrl in exclip.config.ts). */
export function Footer() {
  return (
    <footer className="x-footer">
      <p className="x-fine">
        {BRAND.operator ? `${BRAND.name} is run by ${BRAND.operator}. ` : ""}Non-custodial: you sign every trade, and swaps settle through SODAX.
      </p>
      {LEGAL.length ? (
        <nav aria-label="Legal">
          <ul className="x-footer-links">
            {LEGAL.map(l => <li key={l.label}><a className="x-link x-small" href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a></li>)}
          </ul>
        </nav>
      ) : null}
    </footer>
  );
}
