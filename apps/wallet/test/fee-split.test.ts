/** A fee split in the wallet window's signing policy (docs/fee-split.md). A fee to a splitter is signed only when the
 * wallet works the splitter out itself from a split the build lists, and the fee is exactly the split's rates of the
 * amount paid, rounded down, on a swap with no tokenised stock on either side. A plain fee keeps its rules. The splits
 * are the local dry run's (contracts/fee-split/test/vectors/splitters.json, written by the real factories), and the
 * operator's name is set first, because config.ts reads it when it loads: everything that imports config.ts is
 * imported after it. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { OPERATOR_RATE_MAX, RATE_SCALE, create2Address, splitFee, splitSalt, splitterInitCodeHash } from "@exclip/config/fee-split";
import type { FeeSplitTerms } from "../src/config.ts";
import type { PolicyContext, Review } from "../src/sodax/policy.ts";
import { MAX_PARTNER_FEE_BPS } from "../src/sodax/chains.ts";
import { SODAX_STOCK_TOKENS } from "../src/sodax/stock-tokens.ts";
import type { SwapSpec } from "./sodax-fixtures.ts";

Object.assign(globalThis, { __EXCLIP_OPERATOR__: "Example Ltd" });
const { PolicyError, checkSignRequest } = await import("../src/sodax/policy.ts");
const { FEE_RECEIVER, ctx, swapRequest } = await import("./sodax-fixtures.ts");

type Vectors = {
  factories: { address: string; platform: string; platformRate: number; maxTotalRate: number }[];
  splitters: { factory: string; operator: string; operatorRate: number; splitter: string }[];
};
const VECTORS = JSON.parse(readFileSync(new URL("../../../contracts/fee-split/test/vectors/splitters.json", import.meta.url), "utf8")) as Vectors;

/** The dry run's factories: platform 0x1111…1111 at 875 with a cap of 1,875; another one with the same values; and one
 * whose platform takes 0. */
const DRY_RUN = "0x5b73C5498c1E3b4dbA84de0F1833c4a029d90519";
const OTHER_FACTORY = "0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496";
const NO_PLATFORM_FEE = "0x34A1D3fff3958843C43aD80F30b94c510645C316";
const PLATFORM = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x2222222222222222222222222222222222222222";

/** A split under one of the dry run's factories as build-guards.ts feeSplitTerms bakes it in, and the splitter the
 * real factory gave for it. */
function dryRunSplit(factory: string, operator: string, operatorRate: number): { terms: FeeSplitTerms; splitter: string } {
  const f = VECTORS.factories.find((x) => x.address === factory)!;
  const v = VECTORS.splitters.find((x) => x.factory === factory && x.operator === operator && x.operatorRate === operatorRate)!;
  const terms = { factory, platform: f.platform, platformName: "Example Platform", platformRate: f.platformRate, maxTotalRate: f.maxTotalRate, operator, operatorRate };
  return { terms, splitter: v.splitter };
}

/** The README's vector: the operator 0x2222…2222 at 100 under the dry run's factory. 0.875 % + 0.1 % = 0.975 %. */
const SPLIT = dryRunSplit(DRY_RUN, OPERATOR, 100);
const LISTED = ctx({ feeSplits: [SPLIT.terms] });

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_SONIC = "0x29219dd400f2Bf60E5a23d13Be72B486D4038894";
/** 1,000 USDC from a spoke (Base, assetManager.transfer with the hub calls) and from Sonic (createIntent). */
const SPOKE: SwapSpec = { src: "0x2105.base", dst: "ethereum", input: USDC_BASE, output: USDC_ETH, amount: 1_000_000_000n, min: 980_000_000n, approvals: [1_000_000_000n] };
const SONIC: SwapSpec = { src: "sonic", dst: "0x2105.base", input: USDC_SONIC, output: USDC_BASE, amount: 1_000_000_000n, min: 980_000_000n, approvals: [1_000_000_000n] };
/** The fee 0.975 % of 1,000 USDC gives: 9.75 USDC. */
const FEE = 9_750_000n;

/** `spec` with a fee of `feeAmount` to `receiver`, in the intent's fee data. */
const withFee = (spec: SwapSpec, feeAmount: bigint, receiver = SPLIT.splitter): SwapSpec => ({ ...spec, feeAmount, feeReceiver: receiver });
const value = (review: Review, label: string) => review.lines.find((l) => l.label === label)?.value;

function refused(fn: () => unknown, detail: RegExp) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof PolicyError, String(e));
    assert.equal(e.code, "REFUSED");
    assert.match(e.detail, detail);
    return true;
  });
}

test("the dry run's vector: the wallet's splitter for the README's split is the one the real factory gave", () => {
  assert.equal(SPLIT.splitter, "0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe", "contracts/fee-split/README.md");
  assert.equal(splitFee(SPOKE.amount, 875 + 100), FEE);
});

test("a fee of exactly the split's rates to the splitter the wallet works out passes, and the review says who gets what", () => {
  for (const spec of [SPOKE, SONIC]) {
    const review = checkSignRequest(swapRequest(withFee(spec, FEE)), LISTED);
    assert.equal(review.swap!.net, 990_250_000n, spec.src);
    assert.match(value(review, "Fees")!, /^9\.75 USDC · 0\.875% to Example Platform · 0\.1% to Example Ltd · network up to /);
    assert.equal(value(review, "Fee receiver"), "0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe · fee splitter");
  }
  // Rounded down: 0.975 % of 123.456789 USDC is 1.20370369275 USDC, so 1.203703 USDC, not a unit more.
  const odd = { ...SPOKE, amount: 123_456_789n, min: 120_000_000n, approvals: [123_456_789n] };
  assert.equal(splitFee(odd.amount, 975), 1_203_703n);
  assert.equal(checkSignRequest(swapRequest(withFee(odd, 1_203_703n)), LISTED).swap!.net, 122_253_086n);
  refused(() => checkSignRequest(swapRequest(withFee(odd, 1_203_704n)), LISTED), /fee is not exactly the split's rates/);
});

test("a fee one unit more or less than the split's rates, or at any other rate, is refused", () => {
  const otherRates = [0, 100, 875, 1_000, 1_875].map((rate) => splitFee(SPOKE.amount, rate));
  for (const spec of [SPOKE, SONIC]) {
    for (const fee of [FEE - 1n, FEE + 1n, ...otherRates]) {
      refused(() => checkSignRequest(swapRequest(withFee(spec, fee)), LISTED), /fee is not exactly the split's rates/);
    }
  }
});

test("a fee to any splitter the build doesn't list is refused: another factory's, another operator's or rate's, or none at all", () => {
  const unlisted = [
    // The same operator and rate, under a factory the allow-list doesn't list.
    dryRunSplit(OTHER_FACTORY, OPERATOR, 100).splitter,
    // The listed factory, with another operator or another rate.
    dryRunSplit(DRY_RUN, "0x3333333333333333333333333333333333333333", 100).splitter,
    dryRunSplit(DRY_RUN, OPERATOR, 1_000).splitter,
    // The parties themselves, and the factory.
    OPERATOR, PLATFORM, DRY_RUN,
    // Where CREATE2 puts a split the factory refuses (the operator is its platform): no splitter can ever be there.
    create2Address(DRY_RUN, splitSalt(PLATFORM, 100), splitterInitCodeHash(DRY_RUN)),
  ];
  for (const receiver of unlisted) {
    for (const fee of [FEE, 1n]) refused(() => checkSignRequest(swapRequest(withFee(SPOKE, fee, receiver)), LISTED), /fee receiver not allowlisted/);
  }
  // Listing the refused split doesn't help: the wallet works out no splitter for it.
  const refusedSplit = { ...SPLIT.terms, operator: PLATFORM };
  refused(() => checkSignRequest(swapRequest(withFee(SPOKE, FEE, unlisted.at(-1)!)), ctx({ feeSplits: [refusedSplit] })), /fee receiver not allowlisted/);
  // As shipped, no split is listed.
  refused(() => checkSignRequest(swapRequest(withFee(SPOKE, FEE)), ctx()), /fee receiver not allowlisted/);
});

test("the operator's rate is held to the wallet's cap, while the split's total may reach the factory's", () => {
  // MAX_PARTNER_FEE_BPS (1 %) in parts per 100,000: OPERATOR_RATE_MAX.
  assert.equal((MAX_PARTNER_FEE_BPS * BigInt(RATE_SCALE)) / 10_000n, BigInt(OPERATOR_RATE_MAX));
  // 1 % for the operator on top of the platform's 0.875 %: 1.875 %, the factory's cap and above a plain fee's 1 %.
  const most = dryRunSplit(DRY_RUN, OPERATOR, 1_000);
  const review = checkSignRequest(swapRequest(withFee(SPOKE, 18_750_000n, most.splitter)), ctx({ feeSplits: [most.terms] }));
  assert.match(value(review, "Fees")!, /^18\.75 USDC · 0\.875% to Example Platform · 1% to Example Ltd · /);
  // A factory whose platform takes 0 leaves an operator up to 1.875 %: the factory would create that splitter, the
  // wallet refuses it (and the build stops on it, fee-receivers.json's operatorRate rule).
  const greedy = dryRunSplit(NO_PLATFORM_FEE, "0x4444444444444444444444444444444444444444", 1_875);
  refused(() => checkSignRequest(swapRequest(withFee(SPOKE, 18_750_000n, greedy.splitter)), ctx({ feeSplits: [greedy.terms] })), /operator's rate above the cap/);
});

test("a party at 0 is left out of the review", () => {
  const platformOnly = dryRunSplit(DRY_RUN, OPERATOR, 0);
  const review = checkSignRequest(swapRequest(withFee(SPOKE, 8_750_000n, platformOnly.splitter)), ctx({ feeSplits: [platformOnly.terms] }));
  assert.match(value(review, "Fees")!, /^8\.75 USDC · 0\.875% to Example Platform · network up to /);
  const operatorOnly = dryRunSplit(NO_PLATFORM_FEE, OPERATOR, 1);
  const tiny = checkSignRequest(swapRequest(withFee(SPOKE, 10_000n, operatorOnly.splitter)), ctx({ feeSplits: [operatorOnly.terms] }));
  assert.match(value(tiny, "Fees")!, /^0\.01 USDC · 0\.001% to Example Ltd · network up to /);
});

test("a split on a swap with a tokenised stock on either side is refused; the operator's own plain fee there is not", () => {
  // The first tokenised stock stock-tokens.ts lists on Hedera, bought with and sold for USDC on Ethereum.
  const [STOCK] = SODAX_STOCK_TOKENS["hedera"]![0]!;
  const buy: SwapSpec = { src: "ethereum", dst: "hedera", input: USDC_ETH, output: STOCK, amount: 10_000_000n, min: 5_000_000n, approvals: [10_000_000n] };
  const sell: SwapSpec = { src: "hedera", dst: "ethereum", input: STOCK, output: USDC_ETH, amount: 5_000_000n, min: 9_000_000n, approvals: [5_000_000n] };
  const stocks = ctx({ stocks: true, feeSplits: [SPLIT.terms] });
  for (const spec of [buy, sell]) {
    refused(() => checkSignRequest(swapRequest(withFee(spec, splitFee(spec.amount, 975))), stocks), /fee split on a swap with a tokenised stock/);
    // The operator's own fee, to its listed receiver, as before the split; or no fee.
    const own = checkSignRequest(swapRequest({ ...spec, feeBps: 25n }), stocks);
    assert.match(value(own, "Fees")!, /^Example Ltd fee /, spec.src);
    assert.equal(value(own, "Fee receiver"), getAddress(FEE_RECEIVER));
    assert.equal(value(checkSignRequest(swapRequest(spec), stocks), "Fee receiver"), undefined);
  }
});

test("a plain fee keeps its rules and its review with splits listed; a splitter is held to its split even if receivers list it", () => {
  const plain = (bps: bigint, c: PolicyContext) => checkSignRequest(swapRequest({ ...SPOKE, feeBps: bps }), c);
  assert.match(value(plain(100n, LISTED), "Fees")!, /^Example Ltd fee 10 USDC · network up to /);
  refused(() => plain(101n, LISTED), /partner fee above the cap/);
  for (const bps of [1n, 30n, 100n]) assert.deepEqual(plain(bps, LISTED), plain(bps, ctx()));
  assert.deepEqual(checkSignRequest(swapRequest(SPOKE), LISTED), checkSignRequest(swapRequest(SPOKE), ctx()));
  // Under the plain cap, but not the split's rates: refused, though the address is a plain receiver too.
  const both = ctx({ feeReceivers: [FEE_RECEIVER, SPLIT.splitter.toLowerCase()], feeSplits: [SPLIT.terms] });
  refused(() => checkSignRequest(swapRequest(withFee(SPOKE, FEE - 1n)), both), /fee is not exactly the split's rates/);
});
