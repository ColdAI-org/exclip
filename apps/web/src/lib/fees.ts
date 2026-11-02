/**
 * The partner fee on one swap, as this server's /config sets it (docs/fees.md, docs/fee-split.md). One function gives
 * both the fee the intent carries and the lines the review shows, so what the user reviews is what they sign:
 * - a plain fee in basis points: partnerFeeBps of the amount sold, to feeReceiver, on every swap;
 * - a plain fee as a rate: feeRate's rate per 100,000 of the amount sold and rounded down, as one amount to feeReceiver.
 *   A swap with a tokenised stock on either side pays its fee on stock swaps (feeRate.stockFeeBps) instead, or nothing;
 * - a fee split: the platform's rate plus the operator's, per 100,000 of the amount sold and rounded down, as one amount
 *   to the splitter, which pays each party its share later. A swap with a tokenised stock on either side never pays the
 *   splitter: it pays the operator's own plain fee (stockFee), or nothing.
 * The server pins the same fee on SODAX's routes, and the passkey wallet checks it again. The SDK has no fee of its own
 * (sodaxOptions in ./api.ts), so a swap with no fee here carries none.
 */
import { splitFee, splitShares } from "@exclip/config/fee-rates";
import type { ExclipPublicConfig } from "./api";

/** A fee as the SDK's createIntent takes it (extras.partnerFee): an amount for a fee rate or a split, basis points for
 * a plain fee in basis points and a fee on stock swaps. */
export type IntentFee = { address: `0x${string}`; amount: bigint } | { address: `0x${string}`; percentage: number };

/** One line of the review: who the fee is for, its rate per 100,000 of the amount sold, and its amount in the token
 * sold. A plain fee's `party` is feeReceiverName, or null when /config gives none, and the review then names this site. */
export type FeeLine = { party: string | null; rate: number; amount: bigint };

export type SwapFee = {
  /** For createIntent's extras.partnerFee, or undefined for no fee. */
  intent: IntentFee | undefined;
  /** What comes off the amount sold before the swap. */
  total: bigint;
  /** The review's fee lines, one for each party with a rate above 0. None when the swap pays no fee. */
  lines: FeeLine[];
};

export type FeeConfig = Pick<ExclipPublicConfig, "partnerFeeBps" | "feeReceiver" | "feeRate" | "feeReceiverName" | "feeSplit">;

const NO_FEE: SwapFee = { intent: undefined, total: 0n, lines: [] };

/** The fee on selling `amountSold` (the token's smallest units) with this config; `stockLeg` when either side is a
 * tokenised stock (SODAX flags its token isRwa). */
export function swapFee(config: FeeConfig | null | undefined, amountSold: bigint | null, stockLeg: boolean): SwapFee {
  if (!config || amountSold == null || amountSold <= 0n) return NO_FEE;
  const split = config.feeSplit;
  if (!split) return config.feeReceiver ? receiverFee(config, config.feeReceiver, amountSold, stockLeg) : NO_FEE;
  if (stockLeg) return split.stockFee ? plainFee(split.stockFee.receiver, split.stockFee.bps, amountSold, split.operator.name) : NO_FEE;

  const total = splitFee(amountSold, split.totalRate);
  const shares = splitShares(total, split.platform.rate, split.operator.rate);
  const lines = [
    { party: split.platform.name, rate: split.platform.rate, amount: shares.platform },
    { party: split.operator.name, rate: split.operator.rate, amount: shares.operator },
  ].filter(line => line.rate > 0);
  // A fee that rounds down to 0 isn't sent: the SDK would still write fee data for it, and the server doesn't pin one.
  return { intent: total > 0n ? { address: split.receiver as `0x${string}`, amount: total } : undefined, total, lines };
}

/** A plain fee to `receiver`: partnerFeeBps on every swap, or else feeRate's amount, and on a stock swap its fee on
 * stock swaps or none. */
function receiverFee(config: FeeConfig, receiver: string, amountSold: bigint, stockLeg: boolean): SwapFee {
  const party = config.feeReceiverName ?? null;
  const rate = config.feeRate;
  if (!rate) return config.partnerFeeBps > 0 ? plainFee(receiver, config.partnerFeeBps, amountSold, party) : NO_FEE;
  if (stockLeg) return rate.stockFeeBps > 0 ? plainFee(receiver, rate.stockFeeBps, amountSold, party) : NO_FEE;
  const total = splitFee(amountSold, rate.rate);
  // As with a split, a fee that rounds down to 0 isn't sent.
  const intent = total > 0n ? { address: receiver as `0x${string}`, amount: total } : undefined;
  return { intent, total, lines: [{ party, rate: rate.rate, amount: total }] };
}

function plainFee(receiver: string, bps: number, amountSold: bigint, party: string | null): SwapFee {
  const total = (amountSold * BigInt(bps)) / 10_000n;
  return { intent: { address: receiver as `0x${string}`, percentage: bps }, total, lines: [{ party, rate: bps * 10, amount: total }] };
}
