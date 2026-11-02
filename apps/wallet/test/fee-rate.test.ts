/** A fee rate in the wallet window's signing policy (docs/fees.md). In a build with a fee rate, a fee to a listed
 * receiver is signed only when it is exactly the rate of the amount paid, rounded down, as the server pins it; with a
 * tokenised stock on either side, only when it is exactly the fee on stock swaps, or there is no fee. A fee in basis
 * points keeps its cap. The receiver's name is set first, because config.ts reads it when it loads: everything that
 * imports config.ts is imported after it. */
import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { FEE_RATE_MAX } from "@exclip/config";
import { RATE_SCALE, splitFee } from "@exclip/config/fee-split";
import type { PolicyContext, Review } from "../src/sodax/policy.ts";
import { MAX_PARTNER_FEE_BPS } from "../src/sodax/chains.ts";
import { SODAX_STOCK_TOKENS } from "../src/sodax/stock-tokens.ts";
import type { SwapSpec } from "./sodax-fixtures.ts";

Object.assign(globalThis, { __EXCLIP_FEE_RECEIVER_NAME__: "Example Ltd" });
const { PolicyError, checkSignRequest } = await import("../src/sodax/policy.ts");
const { FEE_RECEIVER, ctx, swapRequest } = await import("./sodax-fixtures.ts");

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_SONIC = "0x29219dd400f2Bf60E5a23d13Be72B486D4038894";
/** 1,000 USDC from a spoke (Base, assetManager.transfer with the hub calls) and from Sonic (createIntent). */
const SPOKE: SwapSpec = { src: "0x2105.base", dst: "ethereum", input: USDC_BASE, output: USDC_ETH, amount: 1_000_000_000n, min: 980_000_000n, approvals: [1_000_000_000n] };
const SONIC: SwapSpec = { src: "sonic", dst: "0x2105.base", input: USDC_SONIC, output: USDC_BASE, amount: 1_000_000_000n, min: 980_000_000n, approvals: [1_000_000_000n] };

/** A build whose plain fee is `rate` per 100,000 of the amount paid, with `stockFeeBps` on swaps with a tokenised stock. */
const rated = (rate = 875, stockFeeBps = 0, over: Partial<PolicyContext> = {}) => ctx({ feeRate: { rate, stockFeeBps }, ...over });
/** 0.875 %, and no fee on stock swaps. */
const RATED = rated();
/** The fee 0.875 % of 1,000 USDC gives: 8.75 USDC. */
const FEE = 8_750_000n;

/** `spec` with a fee of `feeAmount` to `receiver` in the intent's fee data, as the server pins a fee rate's. */
const withFee = (spec: SwapSpec, feeAmount: bigint, receiver = FEE_RECEIVER): SwapSpec => ({ ...spec, feeAmount, feeReceiver: receiver });
const value = (review: Review, label: string) => review.lines.find((l) => l.label === label)?.value;

function refused(fn: () => unknown, detail: RegExp) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof PolicyError, String(e));
    assert.equal(e.code, "REFUSED");
    assert.match(e.detail, detail);
    return true;
  });
}

test("a fee of exactly the build's rate to a listed receiver passes, and the review names the receiver with the rate", () => {
  assert.equal(splitFee(SPOKE.amount, 875), FEE);
  for (const spec of [SPOKE, SONIC]) {
    const review = checkSignRequest(swapRequest(withFee(spec, FEE)), RATED);
    assert.equal(review.swap!.net, 991_250_000n, spec.src);
    assert.match(value(review, "Fees")!, /^8\.75 USDC · 0\.875% to Example Ltd · network up to /);
    assert.equal(value(review, "Fee receiver"), getAddress(FEE_RECEIVER));
  }
  // Rounded down: 0.875 % of 123.456789 USDC is 1.08024690375 USDC, so 1.080246 USDC, not a unit more.
  const odd = { ...SPOKE, amount: 123_456_789n, min: 120_000_000n, approvals: [123_456_789n] };
  assert.equal(splitFee(odd.amount, 875), 1_080_246n);
  assert.equal(checkSignRequest(swapRequest(withFee(odd, 1_080_246n)), RATED).swap!.net, 122_376_543n);
  refused(() => checkSignRequest(swapRequest(withFee(odd, 1_080_247n)), RATED), /fee is not exactly the fee rate/);
  // 114 units at 875 per 100,000 is 0.9975 of a unit: no fee, as the server pins none, and a unit is refused.
  const dust = { ...SPOKE, amount: 114n, min: 112n, approvals: [114n] };
  assert.equal(value(checkSignRequest(swapRequest(dust), RATED), "Fee receiver"), undefined);
  refused(() => checkSignRequest(swapRequest(withFee(dust, 1n)), RATED), /fee is not exactly the fee rate/);
});

test("a fee one unit more or less than the build's rate, or at any other rate, is refused", () => {
  const otherRates = [1, 100, 874, 876, 1_000].map((rate) => splitFee(SPOKE.amount, rate));
  for (const spec of [SPOKE, SONIC]) {
    for (const fee of [FEE - 1n, FEE + 1n, 0n, ...otherRates]) {
      refused(() => checkSignRequest(swapRequest(withFee(spec, fee)), RATED), /fee is not exactly the fee rate/);
    }
    // In basis points, as the SDK works out a percentage: 0.875 % is no whole number of them.
    for (const feeBps of [87n, 88n]) refused(() => checkSignRequest(swapRequest({ ...spec, feeBps }), RATED), /fee is not exactly the fee rate/);
  }
  // The rate that counts is the build's own: in a build at 0.1 %, 0.1 % passes.
  assert.equal(checkSignRequest(swapRequest(withFee(SPOKE, splitFee(SPOKE.amount, 100))), rated(100)).swap!.net, 999_000_000n);
});

test("a fee to a receiver the build doesn't list is refused, even at exactly the build's rate", () => {
  const unlisted = "0x4444444444444444444444444444444444444444";
  for (const fee of [FEE, 1n]) refused(() => checkSignRequest(swapRequest(withFee(SPOKE, fee, unlisted)), RATED), /fee receiver not allowlisted/);
  // As shipped, fee-receivers.json lists no receiver.
  refused(() => checkSignRequest(swapRequest(withFee(SPOKE, FEE)), rated(875, 0, { feeReceivers: [] })), /fee receiver not allowlisted/);
});

test("with a tokenised stock on either side, only exactly the fee on stock swaps is signed, or no fee, never the rate", () => {
  // The first tokenised stock stock-tokens.ts lists on Hedera, bought with and sold for USDC on Ethereum.
  const [STOCK] = SODAX_STOCK_TOKENS["hedera"]![0]!;
  const buy: SwapSpec = { src: "ethereum", dst: "hedera", input: USDC_ETH, output: STOCK, amount: 10_000_000n, min: 5_000_000n, approvals: [10_000_000n] };
  const sell: SwapSpec = { src: "hedera", dst: "ethereum", input: STOCK, output: USDC_ETH, amount: 5_000_000n, min: 9_000_000n, approvals: [5_000_000n] };
  const none = rated(875, 0, { stocks: true });
  const own = rated(875, 25, { stocks: true });
  for (const spec of [buy, sell]) {
    const rateFee = splitFee(spec.amount, 875);
    refused(() => checkSignRequest(swapRequest(withFee(spec, rateFee)), none), /fee on a swap with a tokenised stock/);
    refused(() => checkSignRequest(swapRequest(withFee(spec, rateFee)), own), /fee is not exactly the fee on stock swaps/);
    // The fee on stock swaps in basis points, as the server pins it, and on the review as a rate to the receiver.
    const review = checkSignRequest(swapRequest({ ...spec, feeBps: 25n }), own);
    assert.match(value(review, "Fees")!, / · 0\.25% to Example Ltd · network up to /, spec.src);
    assert.equal(value(review, "Fee receiver"), getAddress(FEE_RECEIVER));
    const stockFee = (spec.amount * 25n) / 10_000n;
    for (const fee of [stockFee - 1n, stockFee + 1n]) {
      refused(() => checkSignRequest(swapRequest(withFee(spec, fee)), own), /fee is not exactly the fee on stock swaps/);
    }
    // Without a fee on stock swaps, any fee is refused. No fee is signed in either build.
    refused(() => checkSignRequest(swapRequest({ ...spec, feeBps: 25n }), none), /fee on a swap with a tokenised stock/);
    for (const c of [none, own]) assert.equal(value(checkSignRequest(swapRequest(spec), c), "Fee receiver"), undefined, spec.src);
  }
});

test("a fee rate is held to the wallet's cap: 1 %, the most fees.rate allows", () => {
  // MAX_PARTNER_FEE_BPS (1 %) in parts per 100,000: FEE_RATE_MAX.
  assert.equal((MAX_PARTNER_FEE_BPS * BigInt(RATE_SCALE)) / 10_000n, BigInt(FEE_RATE_MAX));
  const most = checkSignRequest(swapRequest(withFee(SPOKE, 10_000_000n)), rated(FEE_RATE_MAX));
  assert.match(value(most, "Fees")!, /^10 USDC · 1% to Example Ltd · network up to /);
  // resolveConfig refuses a higher rate; a wallet given one still signs no fee above the cap.
  const over = FEE_RATE_MAX + 1;
  refused(() => checkSignRequest(swapRequest(withFee(SPOKE, splitFee(SPOKE.amount, over))), rated(over)), /partner fee above the cap/);
});

test("without a fee rate, a fee in basis points keeps its cap, and the review names its receiver", () => {
  const plain = (bps: bigint, c: PolicyContext) => checkSignRequest(swapRequest({ ...SPOKE, feeBps: bps }), c);
  for (const c of [ctx(), ctx({ feeRate: null })]) {
    assert.match(value(plain(100n, c), "Fees")!, /^Example Ltd fee 10 USDC · network up to /);
    assert.match(value(plain(30n, c), "Fees")!, /^Example Ltd fee 3 USDC · network up to /);
    refused(() => plain(101n, c), /partner fee above the cap/);
  }
  // A swap with no fee reads the same in either build.
  assert.deepEqual(checkSignRequest(swapRequest(SPOKE), RATED), checkSignRequest(swapRequest(SPOKE), ctx()));
});
