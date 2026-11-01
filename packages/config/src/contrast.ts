/** The contrast rule for brand.colors (docs/branding.md#the-contrast-rule). The config checks only that a colour is
 * #RRGGBB; this measures whether text in it stays readable, by WCAG 2.2's formula. `pnpm run contrast` prints it for
 * exclip.config.ts. */
import type { Brand } from "./index.ts";

/** WCAG 2.2's level for normal text. ExClip's colours carry small text, so every pairing must reach it. */
export const MIN_CONTRAST = 4.5;

/** What each brand colour sits on, or carries, in apps/web/src/styles/exclip.css. */
export const CONTRAST_BACKGROUNDS = {
  darkCanvas: "#07080A",
  buttonLabel: "#03141C",
  white: "#FFFFFF",
  lightCanvas: "#F6F7F9",
} as const;

type Background = keyof typeof CONTRAST_BACKGROUNDS;
export type BrandColor = "accent" | "accentHover" | "accentInk";
export type ContrastCheck = { color: BrandColor; hex: string; against: string; background: string; ratio: number; ok: boolean };

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};

/** The WCAG 2.2 contrast ratio of two #RRGGBB colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The six pairings the rule names, in the order docs/branding.md lists them. */
const PAIRS: readonly (readonly [BrandColor, string, Background])[] = [
  ["accent", "the dark canvas", "darkCanvas"],
  ["accent", "the button label", "buttonLabel"],
  ["accentHover", "the dark canvas", "darkCanvas"],
  ["accentHover", "the button label", "buttonLabel"],
  ["accentInk", "white", "white"],
  ["accentInk", "the light canvas", "lightCanvas"],
];

export function brandContrast(brand: Pick<Brand, BrandColor>): ContrastCheck[] {
  return PAIRS.map(([color, against, key]) => {
    const background = CONTRAST_BACKGROUNDS[key];
    const ratio = contrastRatio(brand[color], background);
    return { color, hex: brand[color], against, background, ratio, ok: ratio >= MIN_CONTRAST };
  });
}
