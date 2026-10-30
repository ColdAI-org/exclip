#!/usr/bin/env node
/**
 * Outlines "ExClip" in Inter Bold: the path inside brand/exclip-wordmark-*.svg and brand/exclip-lockup-*.svg.
 *
 *   pnpm run brand:outline
 *
 * Inter Bold from @fontsource/inter, -2.5% tracking, the font's kerning, 100 units to the em, baseline at y = 0, ink
 * starting at x = 0, two decimals. The SVGs are written by hand around this path, and tools/brand/render.mjs checks
 * that they still carry exactly this output.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const require = createRequire(import.meta.url);

/** Two decimals without trailing zeros: 12.50 → 12.5, -0 → 0. */
const num = (n) => {
  const s = (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

export function outlineWordmark(text = "ExClip", size = 100) {
  const bytes = readFileSync(require.resolve("@fontsource/inter/files/inter-latin-700-normal.woff"));
  const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const tracking = -0.025 * size;
  const glyphs = font.stringToGlyphs(text);
  const ink = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  let cursor = -(glyphs[0].getMetrics().xMin / font.unitsPerEm) * size;
  let d = "";
  for (let i = 0; i < glyphs.length; i++) {
    const path = glyphs[i].getPath(cursor, 0, size);
    const box = path.getBoundingBox();
    Object.assign(ink, {
      x1: Math.min(ink.x1, box.x1),
      y1: Math.min(ink.y1, box.y1),
      x2: Math.max(ink.x2, box.x2),
      y2: Math.max(ink.y2, box.y2),
    });
    let x = Number.NaN;
    let y = Number.NaN;
    for (const c of path.commands) {
      if (c.type === "Z") d += "Z";
      else if (c.type === "M") d += `M${num(c.x)} ${num(c.y)}`;
      else if (c.type === "L" && num(c.x) === num(x) && num(c.y) === num(y)) continue; // zero length once rounded
      else if (c.type === "L") d += `L${num(c.x)} ${num(c.y)}`;
      else if (c.type === "Q") d += `Q${num(c.x1)} ${num(c.y1)} ${num(c.x)} ${num(c.y)}`;
      else if (c.type === "C") d += `C${num(c.x1)} ${num(c.y1)} ${num(c.x2)} ${num(c.y2)} ${num(c.x)} ${num(c.y)}`;
      if (c.type !== "Z") ({ x, y } = c);
    }
    let advance = (glyphs[i].advanceWidth / font.unitsPerEm) * size;
    if (i < glyphs.length - 1) advance += (font.getKerningValue(glyphs[i], glyphs[i + 1]) / font.unitsPerEm) * size;
    cursor += advance + tracking;
  }
  // A minus sign already separates two numbers, so the space before it can go.
  return { d: d.replace(/ -/g, "-"), capHeight: (font.tables.os2.sCapHeight / font.unitsPerEm) * size, ink };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { d, capHeight, ink } = outlineWordmark();
  console.log(`cap height ${num(capHeight)}, ink x ${num(ink.x1)} to ${num(ink.x2)}, y ${num(ink.y1)} to ${num(ink.y2)}`);
  console.log(d);
}
