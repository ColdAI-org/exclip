#!/usr/bin/env node
/**
 * Checks the hand-written ExClip SVGs in brand/ and renders everything made from them.
 *
 *   pnpm run brand
 *
 * Writes brand/preview.png (the review sheet), apps/web/public/logo.svg (the small mark: the app's favicon and in-app
 * mark) and the PNG icons in apps/web/public/icons/ (web app manifest and iOS home screen), then prints the WCAG 2.2
 * contrast ratios that brand/README.md quotes. Outputs are committed, so a normal build never runs this. Re-run it
 * after editing anything in brand/.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { outlineWordmark } from "./outline.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const fail = (message) => {
  throw new Error(`brand: ${message}`);
};

/** Every colour the SVGs may use, plus the small-text variants and the app's hover accent. */
const PALETTE = {
  Cyan: "#00B4F0",
  Blue: "#2563EB",
  Night: "#0B0D12",
  Tile: "#1A1E28",
  "Small tile": "#12151D",
  White: "#FFFFFF",
  "Cyan ink": "#0077B6",
  "Blue light": "#3B82F6",
  "Cyan hover": "#38C8FF",
};
/** The two app canvases, and the dark label the app puts on accent buttons (apps/web/src/styles/exclip.css). */
const CANVAS = { "Light canvas": "#F6F7F9", "Dark canvas": "#07080A" };
const ON_ACCENT = "#03141C";

const FILES = [
  "exclip-mark.svg",
  "exclip-mark-small.svg",
  "exclip-glyph-color.svg",
  "exclip-glyph-white.svg",
  "exclip-glyph-ink.svg",
  "exclip-wordmark-ink.svg",
  "exclip-wordmark-white.svg",
  "exclip-lockup-ink.svg",
  "exclip-lockup-white.svg",
];
const svg = Object.fromEntries(FILES.map((name) => [name, read(`brand/${name}`)]));

// Every file: a viewBox, a title, paths only, brand colours only.
for (const [name, text] of Object.entries(svg)) {
  if (!/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" [^>]*viewBox="[^"]+"/.test(text)) fail(`${name} needs a viewBox`);
  if (!text.includes("<title>ExClip</title>")) fail(`${name} needs <title>ExClip</title>`);
  if (/<text\b|<image\b|font-family/.test(text)) fail(`${name} must be outlined paths, with no text or images`);
  for (const hex of text.match(/#[0-9A-Fa-f]{6}\b/g) ?? []) {
    if (!Object.values(PALETTE).includes(hex)) fail(`${name} uses ${hex}, which is not a brand colour`);
  }
}

// The glyphs and lockups copy the mark's routes by hand; catch a copy that drifted.
const ROUTES = ['d="M18 18L27 27M37 37L46 46"', 'cx="18" cy="18" r="4"', 'cx="46" cy="46" r="4"', 'd="M18 46L46 18"'];
for (const name of FILES.filter((f) => !/small|wordmark/.test(f))) {
  for (const part of ROUTES) if (!svg[name].includes(part)) fail(`${name} has drifted from the mark: no ${part}`);
}
const wordmark = (name) => /<path [^>]*d="(M48\.78[^"]+)"/.exec(svg[name])?.[1];
const outline = outlineWordmark().d;
for (const name of FILES.filter((f) => /wordmark|lockup/.test(f))) {
  if (wordmark(name) !== outline) fail(`${name}: the wordmark is not the Inter Bold outline (pnpm run brand:outline)`);
}

const png = (text, width) => new Resvg(text, { fitTo: { mode: "width", value: width } }).render().asPng();
const uri = (text) => `data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}`;
const once = (text, from, to) => {
  const parts = text.split(from);
  if (parts.length !== 2) fail(`expected exactly one ${from}`);
  return parts.join(to);
};

// iOS and Android crop home-screen icons to their own shape, so those get a square tile with no hairline. The X
// reaches 37% of the icon size from the centre, inside the 40% safe zone of a maskable icon.
const fullBleed = once(
  once(svg["exclip-mark.svg"], ' rx="16"', ""),
  '\n  <rect x=".5" y=".5" width="63" height="63" rx="15.5" fill="none" stroke="#FFFFFF" stroke-opacity=".08"/>',
  "",
);
const ICONS = join(ROOT, "apps/web/public/icons");
mkdirSync(ICONS, { recursive: true });
const icons = {
  "exclip-180.png": png(fullBleed, 180),
  "exclip-192.png": png(svg["exclip-mark.svg"], 192),
  "exclip-512.png": png(svg["exclip-mark.svg"], 512),
  "exclip-maskable-512.png": png(fullBleed, 512),
};
for (const [name, data] of Object.entries(icons)) writeFileSync(join(ICONS, name), data);
copyFileSync(join(ROOT, "brand/exclip-mark-small.svg"), join(ROOT, "apps/web/public/logo.svg"));

// Review sheet, no text: the same set on the light canvas and on the dark one.
const W = 1200;
const HALF = 384;
function half(top, { bg, edge, lockup, word, glyphs }) {
  const image = (text, x, y, w, h) => `<image href="${uri(text)}" x="${x}" y="${top + y}" width="${w}" height="${h}"/>`;
  const marks = [
    ["exclip-mark.svg", 48, 128],
    ["exclip-mark.svg", 216, 64],
    ["exclip-mark.svg", 312, 48],
    ["exclip-mark-small.svg", 392, 32],
    ["exclip-mark-small.svg", 456, 16],
  ].map(([name, x, size]) => image(svg[name], x, 176 - size, size, size));
  const glyphRow = glyphs.map((name, i) => image(svg[name], 1056 - (glyphs.length - 1 - i) * 120, 64, 96, 96));
  const swatches = Object.values(PALETTE).map(
    (hex, i) =>
      `<rect x="${344 + i * 92}" y="${top + 248}" width="72" height="72" rx="14" fill="${hex}" stroke="${edge}"/>`,
  );
  return [
    `<rect y="${top}" width="${W}" height="${HALF}" fill="${bg}"/>`,
    ...marks,
    image(svg[lockup], 536, 64, 304, 96),
    ...glyphRow,
    image(svg[word], 48, 248, 208.08, 72),
    ...swatches,
  ].join("\n  ");
}
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${HALF * 2}" viewBox="0 0 ${W} ${HALF * 2}">
  ${half(0, {
    bg: CANVAS["Light canvas"],
    edge: "rgba(11,13,18,.14)",
    lockup: "exclip-lockup-ink.svg",
    word: "exclip-wordmark-ink.svg",
    glyphs: ["exclip-glyph-ink.svg"],
  })}
  ${half(HALF, {
    bg: CANVAS["Dark canvas"],
    edge: "rgba(255,255,255,.14)",
    lockup: "exclip-lockup-white.svg",
    word: "exclip-wordmark-white.svg",
    glyphs: ["exclip-glyph-color.svg", "exclip-glyph-white.svg"],
  })}
</svg>`;
writeFileSync(join(ROOT, "brand/preview.png"), png(sheet, W * 2));

// WCAG 2.2 relative luminance and contrast ratio.
const channel = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const backgrounds = { White: PALETTE.White, ...CANVAS, Night: PALETTE.Night, Tile: PALETTE.Tile };
const rows = Object.entries(PALETTE).map(
  ([name, hex]) =>
    `| ${name} \`${hex}\` | ${Object.values(backgrounds)
      .map((bg) => (bg === hex ? "—" : `${contrast(hex, bg).toFixed(2)}:1`))
      .join(" | ")} |`,
);
console.log(
  [
    `| Colour | ${Object.entries(backgrounds).map(([name, hex]) => `${name} \`${hex}\``).join(" | ")} |`,
    `| --- |${" ---: |".repeat(Object.keys(backgrounds).length)}`,
    ...rows,
    "",
    `Button label ${ON_ACCENT} on Cyan and on Cyan hover: ${contrast(ON_ACCENT, PALETTE.Cyan).toFixed(2)}:1, ${contrast(ON_ACCENT, PALETTE["Cyan hover"]).toFixed(2)}:1`,
    `Cyan against Blue (where the routes meet in the small mark): ${contrast(PALETTE.Cyan, PALETTE.Blue).toFixed(2)}:1`,
    `Small tile against Dark canvas: ${contrast(PALETTE["Small tile"], CANVAS["Dark canvas"]).toFixed(2)}:1`,
    `Blue and Cyan against Small tile: ${contrast(PALETTE.Blue, PALETTE["Small tile"]).toFixed(2)}:1, ${contrast(PALETTE.Cyan, PALETTE["Small tile"]).toFixed(2)}:1`,
    "",
    `brand: checked ${FILES.length} SVGs; wrote brand/preview.png, apps/web/public/logo.svg and ${Object.keys(icons).length} icons in apps/web/public/icons/`,
  ].join("\n"),
);
