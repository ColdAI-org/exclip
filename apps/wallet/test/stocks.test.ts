/** Tokenised stocks in the wallet window (docs/tokenised-stocks.md). Off, the token table and every check are as they
 * were. On (a build with stocks.enabled), a stock is a listed token, and its review shows the stock badge and the
 * disclaimer. The operator's name is set first, because config.ts reads it when it loads: everything that imports
 * config.ts is imported after it. */
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, getAddress, maxUint256, type Hex } from "viem";
import { STOCK_BADGE, stocksDisclaimer } from "@exclip/config/stocks";
import type { Session } from "../src/channel.ts";
import type { SignRequest } from "../src/protocol.ts";
import type { Ui } from "../src/screens.ts";
import type { Review } from "../src/sodax/policy.ts";
import type { EmbeddedWallet, PreparedSign } from "../src/wallet.ts";
import { EVM_CHAINS, NON_EVM_DESTINATIONS } from "../src/sodax/chains.ts";
import { PRICE_BANDS } from "../src/sodax/price.ts";
import { SODAX_STOCK_TOKENS } from "../src/sodax/stock-tokens.ts";
import { SODAX_TOKENS } from "../src/sodax/tokens.ts";
import { FakeElement, fakeDocument } from "./fake-dom.ts";
import type { SwapSpec } from "./sodax-fixtures.ts";

Object.assign(globalThis, {
  __EXCLIP_OPERATOR__: "Example Ltd",
  document: fakeDocument,
  location: new URL("https://wallet.example.net/"),
});
const { PolicyError, checkSignRequest, findToken } = await import("../src/sodax/policy.ts");
const { ERC20_ABI, OWN, ctx, swapRequest, tx } = await import("./sodax-fixtures.ts");
const { STOCKS } = await import("../src/config.ts");
const { sign } = await import("../src/screens.ts");

const DISCLAIMER = stocksDisclaimer("Example Ltd");
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_HEDERA = SODAX_TOKENS["hedera"]!.find(([, symbol]) => symbol === "USDC")![0];
const FRIEND = getAddress("0xabcdef0123456789abcdef0123456789abcdef01");
// The first tokenised stock stock-tokens.ts lists on Hedera.
const [STOCK, SYMBOL] = SODAX_STOCK_TOKENS["hedera"]![0]!;

/** 10 USDC on Ethereum for at least 0.05 of the stock on Hedera, and 0.05 of it back for at least 9 USDC. */
const buy: SwapSpec = { src: "ethereum", dst: "hedera", input: USDC_ETH, output: STOCK, amount: 10_000_000n, min: 5_000_000n, approvals: [10_000_000n] };
const sell: SwapSpec = { src: "hedera", dst: "ethereum", input: STOCK, output: USDC_ETH, amount: 5_000_000n, min: 9_000_000n, approvals: [5_000_000n] };
const coins: SwapSpec = { src: "0x2105.base", dst: "ethereum", input: USDC_BASE, output: USDC_ETH, amount: 1_000_000n, min: 990_000n, approvals: [1_000_000n] };

/** A transfer of `amount` of `token` on Hedera to `to`. */
const send = (token: string, amount: bigint, to: string): SignRequest => ({
  v: 1, kind: "exclip-wallet", id: "req_0123456789abcdef", type: "sign", chainKey: "hedera", from: OWN.evm,
  plan: { kind: "transfer", token, amount: amount.toString(), to },
  txs: [tx(token, encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to as Hex, amount] }))],
});

const line = (review: Review, label: string) => review.lines.find((l) => l.label === label)!;

function refused(fn: () => unknown, detail: RegExp) {
  assert.throws(fn, (e: unknown) => e instanceof PolicyError && e.code === "REFUSED" && detail.test(e.detail));
}

test("stocks off: a tokenised stock isn't a listed token, to swap or to send, and every coin is as it was", () => {
  assert.equal(STOCKS, false, "a build that doesn't define it has stocks off");
  for (const [chainKey, rows] of Object.entries(SODAX_TOKENS)) {
    for (const [address] of rows) {
      const coin = findToken(chainKey, address);
      assert.ok(coin && !("stock" in coin), `${chainKey} ${address}`);
      assert.deepEqual(findToken(chainKey, address, true), coin, "switching stocks on changes no coin");
    }
  }
  for (const [chainKey, rows] of Object.entries(SODAX_STOCK_TOKENS)) {
    for (const [address] of rows) assert.equal(findToken(chainKey, address), null, `${chainKey} ${address}`);
  }
  for (const spec of [buy, sell]) refused(() => checkSignRequest(swapRequest(spec), ctx()), /token not listed/);
  refused(() => checkSignRequest(send(STOCK, 5_000_000n, FRIEND), ctx()), /token not listed/);
});

test("stocks on: a swap with a stock leg is checked like any other, and its review shows the badge and the disclaimer", () => {
  const on = ctx({ stocks: true });
  const bought = checkSignRequest(swapRequest(buy), on);
  assert.equal(bought.swap!.output.stock, true);
  assert.equal(line(bought, "You pay").badge, undefined);
  assert.match(line(bought, "You receive (at least)").value, new RegExp(`^0\\.05 ${SYMBOL} on `));
  assert.equal(line(bought, "You receive (at least)").badge, STOCK_BADGE);
  assert.equal(bought.disclaimer, DISCLAIMER);

  const sold = checkSignRequest(swapRequest(sell), on);
  assert.equal(line(sold, "You pay").value, `0.05 ${SYMBOL}`);
  assert.equal(line(sold, "You pay").badge, STOCK_BADGE);
  assert.equal(line(sold, "You receive (at least)").badge, undefined);
  assert.equal(sold.disclaimer, DISCLAIMER);

  // The same checks as for a coin.
  refused(() => checkSignRequest(swapRequest({ ...sell, approvals: [maxUint256] }), on), /exactly the trade amount/);
  refused(() => checkSignRequest(swapRequest({ ...buy, dstAddress: FRIEND }), on), /destination is not this wallet/);
  // A swap between coins is reviewed exactly as with stocks off: no badge, no disclaimer.
  assert.deepEqual(checkSignRequest(swapRequest(coins), on), checkSignRequest(swapRequest(coins), ctx()));
});

test("stocks on: a stock is sent like any listed token, with the badge and the disclaimer, and its contract is no recipient", () => {
  const on = ctx({ stocks: true });
  const sent = checkSignRequest(send(STOCK, 5_000_000n, FRIEND), on);
  assert.equal(line(sent, "You send").value, `0.05 ${SYMBOL}`);
  assert.equal(line(sent, "You send").badge, STOCK_BADGE);
  assert.equal(sent.disclaimer, DISCLAIMER);
  // Funds sent to a token's own contract are lost: a stock's too, once the wallet lists it.
  assert.throws(() => checkSignRequest(send(USDC_HEDERA, 1_000_000n, STOCK), on), /token or SODAX contract/);
  const coin = checkSignRequest(send(USDC_HEDERA, 1_000_000n, FRIEND), on);
  assert.ok(coin.lines.every((l) => l.badge === undefined));
  assert.equal(coin.disclaimer, undefined);
});

test("stock-tokens.ts holds stocks only: no coin's address, symbol or price band", () => {
  const coinSymbols = new Set([...Object.values(SODAX_TOKENS).flat().map(([, symbol]) => symbol), ...Object.keys(PRICE_BANDS)].map((s) => s.toUpperCase()));
  assert.ok(Object.keys(SODAX_STOCK_TOKENS).length > 0);
  for (const [chainKey, rows] of Object.entries(SODAX_STOCK_TOKENS)) {
    assert.ok(chainKey in EVM_CHAINS || chainKey in NON_EVM_DESTINATIONS, `${chainKey}: a network the wallet uses`);
    for (const [address, symbol] of rows) {
      assert.ok(!(SODAX_TOKENS[chainKey] ?? []).some(([a]) => a.toLowerCase() === address.toLowerCase()), `${chainKey} ${symbol}: a coin's address`);
      assert.ok(!coinSymbols.has(symbol.toUpperCase()), `${symbol}: a coin's symbol`);
    }
  }
});

test("the review screen shows the badge after the stock's amount, and the disclaimer under the review", async () => {
  const render = async (review: Review) => {
    const root = new FakeElement("main");
    const wallet = { prepareSign: async (request: SignRequest) => ({ review, request }) as PreparedSign };
    const session = { request: {}, origin: "https://swap.example.org", reply() {}, fail() {}, answered: false } as unknown as Session;
    const ui: Ui = { root: root as unknown as HTMLElement, session, wallet: wallet as unknown as EmbeddedWallet, close() {}, random: (n) => new Uint8Array(n) };
    await sign(ui, {} as SignRequest);
    return root.outerHTML;
  };
  const bought = checkSignRequest(swapRequest(buy), ctx({ stocks: true }));
  const html = await render(bought);
  assert.ok(html.includes(`<dd>${line(bought, "You receive (at least)").value} <span class="badge">${STOCK_BADGE}</span></dd>`), html);
  const list = html.indexOf('<dl class="review">');
  const disclaimer = html.indexOf(`<p class="disclaimer">${DISCLAIMER}</p>`);
  assert.ok(list >= 0 && list < disclaimer && disclaimer < html.indexOf("Checked and signed by the wallet"), "under the review, above the note and the buttons");

  const plain = await render(checkSignRequest(swapRequest(coins), ctx({ stocks: true })));
  assert.doesNotMatch(plain, /class="badge"|class="disclaimer"/);
});
