/** The credit in the wallet window's footer (NOTICE): "Powered by ExClip" under another brand, "ExClip is open source"
 * under ExClip's own name, both linked to the repository. Runs the review screen on just enough DOM for dom.ts. The
 * build's brand name is set first, because config.ts reads it when it loads, and screens.ts is imported after it. */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, walletBuildConfig } from "@exclip/config";
import type { Session } from "../src/channel.ts";
import type { SignRequest } from "../src/protocol.ts";
import type { Ui } from "../src/screens.ts";
import type { EmbeddedWallet, PreparedSign } from "../src/wallet.ts";

class FakeText {
  constructor(readonly text: string) {}
  get outerHTML(): string { return this.text; }
}

/** Keeps its attributes and children and prints them back. Finds nothing, so show() focuses nothing. */
class FakeElement {
  readonly attrs: string[] = [];
  childNodes: (FakeElement | FakeText)[] = [];
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void { this.attrs.push(` ${name}="${value}"`); }
  addEventListener(): void {}
  append(...nodes: (FakeElement | FakeText)[]): void { this.childNodes.push(...nodes); }
  replaceChildren(): void { this.childNodes = []; }
  querySelector(): null { return null; }
  querySelectorAll(): FakeElement[] { return []; }
  get outerHTML(): string { return `<${this.tag}${this.attrs.join("")}>${this.childNodes.map((n) => n.outerHTML).join("")}</${this.tag}>`; }
}

Object.assign(globalThis, {
  __EXCLIP_BRAND_NAME__: "Acme Swap",
  document: { createElement: (tag: string) => new FakeElement(tag), createTextNode: (text: string) => new FakeText(text) },
  location: new URL("https://wallet.example.net/"),
});
const { credit, sign } = await import("../src/screens.ts");

const link = (text: string) =>
  `<p class="credit"><a href="https://github.com/ColdAI-org/exclip" target="_blank" rel="noopener">${text}</a></p>`;

test("under another brand name, the review's footer credits ExClip", async () => {
  const root = new FakeElement("main");
  const review = { title: "Swap 250 USDC for ETH", chain: { name: "Base" }, warnings: [], lines: [], txs: [] };
  const wallet = { prepareSign: async (request: SignRequest) => ({ review, request }) as unknown as PreparedSign };
  const session = { request: {}, origin: "https://swap.example.org", reply() {}, fail() {}, answered: false } as unknown as Session;
  const ui: Ui = { root: root as unknown as HTMLElement, session, wallet: wallet as unknown as EmbeddedWallet, close() {}, random: (n) => new Uint8Array(n) };

  await sign(ui, {} as SignRequest);

  const footer = root.childNodes.at(-1);
  assert.equal(
    footer?.outerHTML,
    `<footer class="foot"><p>Wallet: wallet.example.net · Requested by swap.example.org</p>${link("Powered by ExClip")}</footer>`,
  );
});

test("under ExClip's own name, the credit says that ExClip is open source", () => {
  const { brandName } = walletBuildConfig(resolveConfig({}).config, false);
  assert.equal(brandName, "ExClip");
  assert.equal(credit(brandName).outerHTML, link("ExClip is open source"));
});
