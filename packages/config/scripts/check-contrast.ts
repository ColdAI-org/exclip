/** Checks brand.colors in exclip.config.ts (or the file EXCLIP_CONFIG names) against the contrast rule
 * (docs/branding.md#the-contrast-rule): `pnpm run contrast`. Exits with 1 when a pairing falls short. */
import { relative } from "node:path";
import { brandContrast, MIN_CONTRAST } from "../src/contrast.ts";
import { ConfigError } from "../src/index.ts";
import { findRepoRoot, loadExclipConfig } from "../src/node.ts";

const root = findRepoRoot();
let loaded;
try {
  loaded = await loadExclipConfig(process.env, root);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(e.message);
  process.exit(1);
}

const checks = brandContrast(loaded.config.brand);
const source = loaded.file ? relative(root, loaded.file) : "the defaults (there is no exclip.config.ts)";
console.log(`brand.colors from ${source}, each against what it meets (WCAG 2.2, at least ${MIN_CONTRAST}:1):\n`);
for (const c of checks) {
  const ratio = `${c.ratio.toFixed(2)}:1`.padStart(7);
  console.log(`  ${c.color.padEnd(11)}  ${c.hex}  against ${`${c.against} ${c.background}`.padEnd(25)}  ${ratio}  ${c.ok ? "ok" : "TOO LOW"}`);
}
const low = checks.filter((c) => !c.ok).length;
if (low) {
  console.error(`\n${low} of ${checks.length} below ${MIN_CONTRAST}:1. accent and accentHover need to be lighter, accentInk darker.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${checks.length} reach ${MIN_CONTRAST}:1. Leave some room above it: links and focus rings also sit on cards and sheets.`);
}
