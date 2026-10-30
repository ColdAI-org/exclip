import { BRAND } from "../lib/brand";

/**
 * The brand's logo: a file (brand.logo in exclip.config.ts; by default /logo.svg, two crossing routes in a rounded
 * square), drawn as an image so a deployment can swap it without touching code. It is decorative: the link around it
 * carries the name.
 */
export function Logo({ size = 32 }: { size?: number }) {
  return <img src={BRAND.logo} alt="" width={size} height={size} className="x-mark" />;
}

export function Wordmark() {
  return <span className="x-wordmark">{BRAND.name}</span>;
}
