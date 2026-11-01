/** The footer's credit (NOTICE): "Powered by ExClip" under another brand, "ExClip is open source" under ExClip's own
 * name, both linked to the repository. src/lib/brand.ts reads __EXCLIP__ when it loads, so the build's value is set
 * first and the footer imported after it. */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveConfig, webBuildConfig, type ExclipConfigInput } from "@exclip/config";

const build = (input: ExclipConfigInput) => webBuildConfig(resolveConfig(input).config, false);
Object.assign(globalThis, { __EXCLIP__: build({ brand: { name: "Acme Swap", operator: "Acme Ltd" } }) });
const { Credit, Footer } = await import("../src/components/Footer.tsx");

const credit = (text: string) =>
  `<p class="x-credit"><a href="https://github.com/ColdAI-org/exclip" target="_blank" rel="noopener">${text}</a></p>`;

test("under another brand name, the footer credits ExClip after the operator's line", () => {
  assert.equal(
    renderToStaticMarkup(createElement(Footer)),
    `<footer class="x-footer"><p class="x-fine">Acme Swap is run by Acme Ltd. Non-custodial: you sign every trade, and swaps settle through SODAX.</p>${credit("Powered by ExClip")}</footer>`,
  );
});

test("under ExClip's own name, the credit says that ExClip is open source", () => {
  const { name } = build({}).brand;
  assert.equal(name, "ExClip");
  assert.equal(renderToStaticMarkup(createElement(Credit, { name })), credit("ExClip is open source"));
});
