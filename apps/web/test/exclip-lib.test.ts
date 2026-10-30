import test from "node:test";
import assert from "node:assert/strict";
import type { SodaxToken } from "../src/lib/api.ts";
import { canonicalSymbol, pairOf } from "../src/lib/catalog.ts";
import { amount, fromUnits, pct, smartDecimals, toUnits, usd } from "../src/lib/format.ts";
import { pickChain } from "../src/lib/tokens.ts";
import type { WalletState } from "../src/lib/wallet.ts";

test("prices: grouping, more decimals for small values, never scientific notation", () => {
  assert.equal(usd(64321.5), "$64,321.50");
  assert.equal(usd(1.5), "$1.50");
  assert.equal(usd(0.000045678), "$0.00004568");
  assert.equal(usd(1e-9), "$0.000000001");
  assert.equal(usd(-12.3), "−$12.30");
  assert.equal(usd(12.3, { sign: true }), "+$12.30");
  assert.equal(usd(null), "—");
  for (const v of [1e-9, 4.5e-7, 1e21 / 1e6, 123456789.123]) assert.doesNotMatch(usd(v) + amount(v), /e[+-]?\d/i);
  assert.equal(smartDecimals(0.0123), 5);
  assert.equal(smartDecimals(0.000045678), 8);
  assert.equal(smartDecimals(5000), 2);
});

test("changes carry an explicit sign; amounts trim trailing zeros", () => {
  assert.equal(pct(2.144), "+2.14%");
  assert.equal(pct(-0.8), "−0.80%");
  assert.equal(pct(0), "0.00%");
  assert.equal(amount(1234.5), "1,234.5");
  assert.equal(amount(0.00001234), "0.00001234");
});

test("base units round-trip exactly, without floating point", () => {
  assert.equal(fromUnits(123450000n, 8), "1.2345");
  assert.equal(fromUnits(1n, 18), "0.000000000000000001");
  assert.equal(fromUnits(-5000000n, 6), "-5");
  assert.equal(toUnits("1.2345", 8), 123450000n);
  assert.equal(toUnits("1,234.5", 6), 1234500000n);
  assert.equal(toUnits("1234,5", 6), 1234500000n);
  assert.equal(toUnits("1,234", 6), 1234000000n); // a thousands separator, not a decimal comma
  assert.equal(toUnits("0.1234567", 6), null); // more decimals than the token has
  assert.equal(toUnits("1e5", 6), null);
  assert.equal(toUnits("", 6), null);
  assert.equal(toUnits(".", 6), null);
});

test("token symbols and pairs map onto the catalog", () => {
  assert.equal(canonicalSymbol("WETH"), "ETH");
  assert.equal(canonicalSymbol("cbbtc"), "BTC");
  assert.equal(canonicalSymbol("NOPE"), null);
  assert.deepEqual(pairOf("eth-usdc"), { base: "ETH", quote: "USDC" });
  assert.equal(pairOf("ETH-ETH"), null);
  assert.equal(pairOf("ETH/USDC"), null);
  assert.equal(pairOf(undefined), null);
});

const wallet = (balances: WalletState["balances"] = {}): WalletState =>
  ({ status: "ready", requested: true, sheetOpen: false, accounts: {}, balances, error: null, embedded: null });

test("the network for a trade: asked for, else largest holding, else a well-supported default", () => {
  const list: SodaxToken[] = [
    { symbol: "USDC", name: "USD Coin", decimals: 6, address: "0xA", chainKey: "ethereum" },
    { symbol: "USDC", name: "USD Coin", decimals: 6, address: "0xB", chainKey: "0x2105.base" },
    { symbol: "USDC", name: "USD Coin", decimals: 6, address: "0xC", chainKey: "0xa4b1.arbitrum" },
  ];
  assert.equal(pickChain(list, wallet(), "ethereum"), "ethereum");
  assert.equal(pickChain(list, wallet(), "solana"), "0x2105.base");
  assert.equal(pickChain(list, wallet({ "0xa4b1.arbitrum": { "0xc": "5000000" }, ethereum: { "0xa": "1000000" } })), "0xa4b1.arbitrum");
  assert.equal(pickChain([], wallet()), null);
});
