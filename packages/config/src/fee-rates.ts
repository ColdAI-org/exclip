/** Fee rates and their arithmetic, for a fee split (docs/fee-split.md) and a plain fee given as a rate (docs/fees.md),
 * apart from the address maths in ./fee-split.ts: the app bundles this module, so it imports nothing. ./fee-split.ts
 * re-exports all of it.
 *
 * Erasable TypeScript only and no Node imports. */

/** Rates are in parts per 100,000 of the amount sold: 875 is 0.875 %, 1,000 is 1 % (FeeSplitterFactory.RATE_SCALE). */
export const RATE_SCALE = 100_000;

/** The most an operator may take in a split, on top of the platform's rate: 1,000 per 100,000, the same 1 % as a plain
 * fee (PARTNER_FEE_MAX_BPS). */
export const OPERATOR_RATE_MAX = 1_000;

/** A rate as a percentage without trailing zeros: 875 is "0.875", 1,000 is "1". */
export function formatRate(rate: number): string {
  const whole = Math.floor(rate / 1_000);
  const fraction = String(rate % 1_000).padStart(3, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** The fee at `rate` per 100,000 on `amountSold`: amountSold × rate ÷ 100,000, rounded down. A split's fee is this at
 * its total rate, and a plain fee given as a rate (fees.rate) this at that rate. The server pins it, the app puts it in
 * the intent, and the wallet window signs such a fee only when it is exactly this. */
export function splitFee(amountSold: bigint, rate: number): bigint {
  return (amountSold * BigInt(rate)) / BigInt(RATE_SCALE);
}

/** What the splitter owes each party out of `fee`: fee × its rate ÷ the sum of both rates, rounded down
 * (FeeSplitter.releasable). Rounding leaves at most one smallest unit that neither can take. */
export function splitShares(fee: bigint, platformRate: number, operatorRate: number): { platform: bigint; operator: bigint } {
  const total = BigInt(platformRate + operatorRate);
  if (total === 0n) return { platform: 0n, operator: 0n };
  return { platform: (fee * BigInt(platformRate)) / total, operator: (fee * BigInt(operatorRate)) / total };
}
