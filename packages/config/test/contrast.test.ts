import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRAST_BACKGROUNDS, MIN_CONTRAST, brandContrast, contrastRatio } from "../src/contrast.ts";
import { DEFAULT_BRAND } from "../src/index.ts";
import { findRepoRoot } from "../src/node.ts";

test("contrast: ExClip's own colours reach the ratios docs/branding.md gives them", () => {
  const checks = brandContrast(DEFAULT_BRAND);
  assert.deepEqual(
    checks.map((c) => [c.color, c.background, c.ratio.toFixed(2), c.ok]),
    [
      ["accent", "#07080A", "8.38", true],
      ["accent", "#03141C", "7.84", true],
      ["accentHover", "#07080A", "10.37", true],
      ["accentHover", "#03141C", "9.70", true],
      ["accentInk", "#FFFFFF", "4.87", true],
      ["accentInk", "#F6F7F9", "4.54", true],
    ],
  );
});

test("contrast: a pairing below 4.5:1 fails, whichever way round the colours are", () => {
  // ExClip's ink is too dark for the dark theme, and its accent too light for the light one.
  const swapped = brandContrast({ accent: DEFAULT_BRAND.accentInk, accentHover: DEFAULT_BRAND.accentHover, accentInk: DEFAULT_BRAND.accent });
  assert.deepEqual(
    swapped.filter((c) => !c.ok).map((c) => `${c.color} against ${c.against}`),
    ["accent against the dark canvas", "accent against the button label", "accentInk against white", "accentInk against the light canvas"],
  );
  assert.equal(contrastRatio("#000000", "#FFFFFF").toFixed(2), "21.00");
  assert.equal(contrastRatio("#FFFFFF", "#000000").toFixed(2), "21.00");
  assert.equal(contrastRatio("#777777", "#777777"), 1);
  assert.equal(MIN_CONTRAST, 4.5);
});

test("contrast: the backgrounds are the ones the app's stylesheet uses", () => {
  const css = readFileSync(join(findRepoRoot(), "apps/web/src/styles/exclip.css"), "utf8").toLowerCase();
  const declared: [string, string][] = [
    ["--x-canvas", CONTRAST_BACKGROUNDS.darkCanvas],
    ["--x-on-accent", CONTRAST_BACKGROUNDS.buttonLabel],
    ["--x-surface", CONTRAST_BACKGROUNDS.white],
    ["--x-canvas", CONTRAST_BACKGROUNDS.lightCanvas],
  ];
  for (const [name, hex] of declared) {
    assert.ok(css.includes(`${name}: ${hex.toLowerCase()};`), `exclip.css sets ${name}: ${hex}`);
  }
});
