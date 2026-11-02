import test from "node:test";
import assert from "node:assert/strict";
import type { PublicFeeSplit } from "../src/lib/api.ts";
import { swapFee, type FeeConfig } from "../src/lib/fees.ts";
import { feeRate } from "../src/lib/format.ts";

// Placeholders: the splitter is the one contracts/fee-split/README.md works out for 0x2222…2222 at 100 per 100,000.
const SPLITTER = "0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe";
const OPERATOR = "0x2222222222222222222222222222222222222222";
const OWN = "0x1111111111111111111111111111111111111111";

const SPLIT: PublicFeeSplit = {
  receiver: SPLITTER,
  totalRate: 975,
  platform: { name: "Example Platform", rate: 875 },
  operator: { name: "Example Operator Ltd", rate: 100 },
  stockFee: null,
};
const withSplit = (over: Partial<PublicFeeSplit> = {}): FeeConfig => ({ partnerFeeBps: 0, feeReceiver: null, feeSplit: { ...SPLIT, ...over } });
const plain = (partnerFeeBps: number, feeReceiver: string | null): FeeConfig => ({ partnerFeeBps, feeReceiver, feeSplit: null });

const NONE = { intent: undefined, total: 0n, lines: [] };
const USDC_1000 = 1_000_000_000n;

test("no fee: no config yet, no amount, or a server that charges none", () => {
  for (const config of [null, undefined, plain(0, null), plain(30, null), plain(0, OWN), { partnerFeeBps: 0, feeReceiver: null }]) {
    assert.deepEqual(swapFee(config, USDC_1000, false), NONE, JSON.stringify(config));
  }
  for (const amount of [null, 0n, -1n]) assert.deepEqual(swapFee(withSplit(), amount, false), NONE, String(amount));
});

test("a plain fee: basis points to the receiver on every swap, stocks included, as before", () => {
  const expected = { intent: { address: OWN, percentage: 10 }, total: 1_000_000n, lines: [{ party: null, rate: 100, amount: 1_000_000n }] };
  assert.deepEqual(swapFee(plain(10, OWN), USDC_1000, false), expected);
  assert.deepEqual(swapFee(plain(10, OWN), USDC_1000, true), expected);
  // Rounded down, as the SDK rounds a percentage.
  assert.equal(swapFee(plain(10, OWN), 999n, false).total, 0n);
});

test("a split: one amount to the splitter, the platform's and the operator's rates of the amount sold, rounded down", () => {
  // The worked example in docs/fee-split.md: 1,000 USDC sold, 0.875 % to the platform and 0.1 % to the operator.
  assert.deepEqual(swapFee(withSplit(), USDC_1000, false), {
    intent: { address: SPLITTER, amount: 9_750_000n },
    total: 9_750_000n,
    lines: [
      { party: "Example Platform", rate: 875, amount: 8_750_000n },
      { party: "Example Operator Ltd", rate: 100, amount: 1_000_000n },
    ],
  });
  // The amount the server pins for the same sale (apps/server/test/exclip.test.ts), so the two never disagree.
  assert.deepEqual(swapFee(withSplit(), 1_234_567n, false).intent, { address: SPLITTER, amount: 12_037n });
  // The amount alone, as the server pins it: no percentage goes with it.
  assert.equal("percentage" in (swapFee(withSplit(), USDC_1000, false).intent ?? {}), false);
});

test("a split that rounds down to nothing sends no fee, and a party at 0 gets no line", () => {
  // 102 units at 975 per 100,000 is 0.9945 of a unit: no fee data in the intent, as the server pins none.
  const dust = swapFee(withSplit(), 102n, false);
  assert.equal(dust.intent, undefined);
  assert.equal(dust.total, 0n);
  assert.deepEqual(dust.lines.map(l => l.amount), [0n, 0n]);
  assert.deepEqual(swapFee(withSplit(), 103n, false).intent, { address: SPLITTER, amount: 1n });

  const platformOnly = swapFee(withSplit({ totalRate: 875, operator: { name: "Example Operator Ltd", rate: 0 } }), USDC_1000, false);
  assert.deepEqual(platformOnly.lines, [{ party: "Example Platform", rate: 875, amount: 8_750_000n }]);
  const operatorOnly = swapFee(withSplit({ totalRate: 100, platform: { name: "Example Platform", rate: 0 } }), USDC_1000, false);
  assert.deepEqual(operatorOnly.lines, [{ party: "Example Operator Ltd", rate: 100, amount: 1_000_000n }]);
});

test("a split with a stock on either side: never the splitter, only the operator's own fee, or none", () => {
  // The owner's choice of 2 November 2026 (docs/fee-split.md).
  assert.deepEqual(swapFee(withSplit(), USDC_1000, true), NONE);
  assert.deepEqual(swapFee(withSplit({ stockFee: { receiver: OPERATOR, bps: 25 } }), USDC_1000, true), {
    intent: { address: OPERATOR, percentage: 25 },
    total: 2_500_000n,
    lines: [{ party: "Example Operator Ltd", rate: 250, amount: 2_500_000n }],
  });
  // The stock fee is for stock swaps only: a crypto swap still pays the split.
  assert.equal(swapFee(withSplit({ stockFee: { receiver: OPERATOR, bps: 25 } }), USDC_1000, false).intent?.address, SPLITTER);
});

test("a split wins over plain fee fields, which the server never publishes with one", () => {
  const both: FeeConfig = { partnerFeeBps: 10, feeReceiver: OWN, feeSplit: SPLIT };
  assert.deepEqual(swapFee(both, USDC_1000, false).intent, { address: SPLITTER, amount: 9_750_000n });
  assert.deepEqual(swapFee(both, USDC_1000, true), NONE);
});

test("fee rates read as percentages with two or three decimals", () => {
  const cases: [number, string][] = [[1, "0.001%"], [100, "0.10%"], [250, "0.25%"], [875, "0.875%"], [1_000, "1.00%"], [1_875, "1.875%"]];
  for (const [rate, text] of cases) assert.equal(feeRate(rate), text, String(rate));
});
