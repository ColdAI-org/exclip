import { BRAND } from "../lib/brand";

const LEGAL = [
  { label: "Terms of use", href: BRAND.termsUrl },
  { label: "Privacy", href: BRAND.privacyUrl },
].filter((l): l is { label: string; href: string } => !!l.href);

/** ExClip's repository, which every copy credits in its footer (NOTICE). */
const EXCLIP_REPO ="https://github.com/ColdAI-org/exclip";

/** "Powered by ExClip", linked to the repository; under ExClip's own name, "ExClip is open source". No setting hides it:
 * NOTICE makes it ExClip's attribution notice. Fixed text colours, so no brand colour can make it unreadable. */
export function Credit({ name }: { name: string }) {
  return (
    <p className="x-credit">
      <a href={EXCLIP_REPO} target="_blank" rel="noopener">{name === "ExClip" ? "ExClip is open source" : "Powered by ExClip"}</a>
    </p>
  );
}

/** Who runs this deployment, its legal pages (brand.operator, termsUrl and privacyUrl in exclip.config.ts) and the credit. */
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
      <Credit name={BRAND.name} />
    </footer>
  );
}
