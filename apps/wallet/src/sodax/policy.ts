/** The signing policy (docs/embedded-wallet.md). Pure: no I/O, no clock, no globals.
 *
 * ExClip sends a plan (what the user asked for) and unsigned transactions. Nothing ExClip says is trusted: this
 * module decodes every transaction itself, re-encodes it to prove there are no extra bytes, and accepts it only if
 *  - it is one of the shapes SODAX swaps produce on an allowlisted network (approve → asset manager / intents
 *    contract, assetManager.transfer with the [approve, createIntent] hub calls, or Sonic createIntent), or a plain
 *    transfer of a listed token to the address the user typed;
 *  - every field matches the plan: token, gross amount, minimum received, deadline, destination network, and the
 *    destination is the wallet's OWN address there (the embedded wallet never swaps to someone else);
 *  - approvals are exact (the trade amount, or a 0 reset first), never unlimited, and the spender is the SODAX
 *    contract that this trade uses;
 *  - a swap between USD stablecoins pays out at least 97% of what goes in (price.ts; other pairs are checked against
 *    the popup's own quote in wallet.ts);
 *  - the partner fee goes to a build-time allowlisted receiver and is at most MAX_PARTNER_FEE_BPS, or goes to the
 *    splitter of a build-time allowlisted fee split, which this module works out itself, and is exactly the split's
 *    rates of the amount paid, on a swap with no tokenised stock on either side (fee-receivers.json, docs/fee-split.md);
 *  - nonces are consecutive and the gas/fee numbers are sane, with the fee capped per network. The chain id comes
 *    from EVM_CHAINS, never the request.
 * Anything else is refused. The review screen is built only from what this module decoded, and shows the nonce and a
 * warning when the fee could be more than FEE_WARNING_BPS of the amount. A listed token is one in tokens.ts or, in a
 * build that switches tokenised stocks on (PolicyContext.stocks), one in stock-tokens.ts; the review marks a stock with
 * the stock badge and carries the stocks disclaimer (docs/tokenised-stocks.md). */
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, parseAbi, parseAbiParameters, type Hex } from "viem";
import { RATE_SCALE, formatRate, predictSplitter, splitFee } from "@exclip/config/fee-split";
import { STOCK_BADGE, stocksDisclaimer } from "@exclip/config/stocks";
import type { SignRequest, SwapPlan, TransferPlan, UnsignedTx } from "../protocol.ts";
import { base58Decode } from "../base58.ts";
import { fromHex, toHex } from "../bytes.ts";
import { OPERATOR_NAME, type FeeSplitTerms } from "../config.ts";
import { INTENTS_CONTRACT, MAX_PARTNER_FEE_BPS, NATIVE_TOKEN, SONIC_KEY, SONIC_WALLET_ROUTER, destination, evmChain, type EvmChain } from "./chains.ts";
import { SODAX_TOKENS } from "./tokens.ts";
import { SODAX_STOCK_TOKENS } from "./stock-tokens.ts";
import { PRICE_BANDS, stableMinimumTooLow, type SwapFacts } from "./price.ts";

export const BROWSER_WALLET_MESSAGE = "Use a browser wallet for this network";
export const MISMATCH_MESSAGE = "This request doesn't match the trade you asked for. Nothing was signed.";
export const STABLE_FLOOR_MESSAGE = "This swap between US-dollar stablecoins could pay out less than 97% of what you put in. Nothing was signed. Get a new quote or lower the slippage.";

export class PolicyError extends Error {
  constructor(readonly code: "REFUSED" | "UNSUPPORTED_NETWORK" | "WRONG_ACCOUNT", message: string, readonly detail = "") {
    super(message);
    this.name = "PolicyError";
  }
}
const refuse = (detail: string): never => {
  throw new PolicyError("REFUSED", MISMATCH_MESSAGE, detail);
};
const check = (ok: boolean, detail: string): void => {
  if (!ok) refuse(detail);
};

const INTENT = "(uint256 intentId,address creator,address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,uint256 deadline,bool allowPartialFill,uint256 srcChain,uint256 dstChain,bytes srcAddress,bytes dstAddress,address solver,bytes data)";
const INTENTS_ABI = parseAbi([`function createIntent(${INTENT} intent)`]);
const ASSET_MANAGER_ABI = parseAbi(["function transfer(address token, bytes to, uint256 amount, bytes data) payable"]);
const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function transfer(address to, uint256 amount) returns (bool)"]);
const CALLS = parseAbiParameters("(address,uint256,bytes)[]");
const FEE_DATA = parseAbiParameters("uint256 fee, address receiver");

/** Gas limit and fee sanity bounds. A request outside them is refused rather than shown. The fee cap is per network
 * (EvmChain.maxFeePerGas); MAX_FEE_PER_GAS is the ceiling no network's cap may exceed. */
export const MAX_GAS = 5_000_000n;
export const MIN_GAS = 21_000n;
export const MAX_FEE_PER_GAS = 10_000n * 10n ** 9n; // 10,000 gwei
/** A network fee above this share of the amount moved gets a warning in the review. */
export const FEE_WARNING_BPS = 500n;
/** Longest deadline a swap may carry (ExClip sets minutes; a far deadline is a stale-price risk). */
export const MAX_DEADLINE_SEC = 24n * 3600n;

export type Intent = {
  intentId: bigint; creator: string; inputToken: string; outputToken: string; inputAmount: bigint; minOutputAmount: bigint;
  deadline: bigint; allowPartialFill: boolean; srcChain: bigint; dstChain: bigint; srcAddress: Hex; dstAddress: Hex; solver: string; data: Hex;
};

export type PolicyContext = {
  /** The wallet's own addresses (from the unlocked vault). */
  accounts: { evm: string; solana: string; sui: string };
  /** The SODAX hub wallet for (source chain, accounts.evm); on Sonic, the user router. Required for swaps. */
  hubWallet: string | null;
  /** Partner-fee receivers an intent may name (lower-case). */
  feeReceivers: readonly string[];
  /** Fee splits whose splitter an intent may name (config.ts FEE_SPLITS). The splitters are worked out here. */
  feeSplits: readonly FeeSplitTerms[];
  /** EVM recipients sent to before (lower-case). */
  knownRecipients: readonly string[];
  nowSec: bigint;
  walletOrigin: string;
  /** The build switched tokenised stocks on (config.ts STOCKS): the tokens in stock-tokens.ts are listed too. */
  stocks?: boolean;
};

/** A transaction that passed the policy, with every number as a bigint. */
export type CheckedTx = {
  chainId: number; to: `0x${string}`; data: Hex; value: bigint; nonce: number; gas: bigint;
  fee: { type: "eip1559"; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { type: "legacy"; gasPrice: bigint };
  /** What this transaction does, in words, for the review. */
  label: string;
};

/** `badge`: a label shown after the value (STOCK_BADGE, on a tokenised stock's line). */
export type ReviewLine = { label: string; value: string; mono?: boolean; badge?: string };
export type Review = {
  kind: "swap" | "transfer";
  title: string;
  chain: EvmChain;
  lines: ReviewLine[];
  warnings: string[];
  txs: CheckedTx[];
  /** With a tokenised stock in it: the stocks disclaimer, shown under the review. */
  disclaimer?: string;
  /** Transfers only: the recipient (lower-case), recorded after signing for later first-time/look-alike checks. */
  recipient?: string;
  /** Swaps only: the decoded amounts, for the price check against the popup's own reference (price.ts). */
  swap?: SwapFacts;
};

/* ------------------------------------------------------------------ helpers */

const lower = (a: string) => a.toLowerCase();
const sameAddress = (a: string, b: string) => lower(a) === lower(b);
const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

/** `stock`: a tokenised stock (stock-tokens.ts). */
export type Token = { address: string; symbol: string; decimals: number; hubAsset: string; stock?: true };

function lookUp(table: typeof SODAX_TOKENS, chainKey: string, address: string): Token | null {
  const list = Object.hasOwn(table, chainKey) ? table[chainKey]! : [];
  const evm = isEvmAddress(address);
  for (const [a, symbol, decimals, hubAsset] of list) {
    if (evm ? sameAddress(a, address) : a === address) return { address: a, symbol, decimals, hubAsset };
  }
  return null;
}

/** The listed token at `address` on `chainKey`. With `stocks`, the tokenised stocks count too, marked `stock`. */
export function findToken(chainKey: string, address: string, stocks = false): Token | null {
  const coin = lookUp(SODAX_TOKENS, chainKey, address);
  if (coin || !stocks) return coin;
  const stock = lookUp(SODAX_STOCK_TOKENS, chainKey, address);
  return stock && { ...stock, stock: true };
}

/** A tokenised stock by the wallet's own table (stock-tokens.ts), whether or not this build lists stocks. */
const isStock = (chainKey: string, address: string) => lookUp(SODAX_STOCK_TOKENS, chainKey, address) !== null;

/** Every listed token contract on `chainKey`, the tokenised stocks included with `stocks`. */
const tokenContracts = (chainKey: string, stocks: boolean): string[] =>
  [...(SODAX_TOKENS[chainKey] ?? []), ...(stocks ? SODAX_STOCK_TOKENS[chainKey] ?? [] : [])].map(([a]) => a);

const amount = (raw: bigint, t: { decimals: number; symbol: string }) => `${formatUnits(raw, t.decimals)} ${t.symbol}`;
/** A tokenised stock's line carries the stock badge. */
const badge = (t: Token): Pick<ReviewLine, "badge"> => (t.stock ? { badge: STOCK_BADGE } : {});
/** A review with a tokenised stock in it carries the stocks disclaimer, naming who runs this deployment. */
const disclaimer = (...tokens: Token[]): Pick<Review, "disclaimer"> => (tokens.some((t) => t.stock) ? { disclaimer: stocksDisclaimer(OPERATOR_NAME) } : {});
const uint = (s: string) => BigInt(s); // protocol.ts already checked the decimal format

/** decodeFunctionData, then proof that re-encoding gives the same bytes (no trailing data, canonical encoding). */
function decodeExact<const A extends readonly unknown[]>(abi: A, data: string, name: string): readonly unknown[] {
  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: abi as never, data: data as Hex }) as never;
  } catch {
    return refuse(`${name}: undecodable`);
  }
  check(decoded.functionName === name, `expected ${name}, got ${decoded.functionName}`);
  const again = (encodeFunctionData as (p: { abi: unknown; functionName: string; args: readonly unknown[] }) => Hex)({ abi, functionName: name, args: decoded.args ?? [] });
  check(lower(again) === lower(data), `${name}: non-canonical encoding`);
  return decoded.args ?? [];
}

function toChecked(tx: UnsignedTx, chain: EvmChain, label: string): CheckedTx {
  const gas = uint(tx.gas);
  check(gas >= MIN_GAS && gas <= MAX_GAS, "gas out of range");
  const nonce = uint(tx.nonce);
  check(nonce < 2n ** 53n, "nonce out of range");
  const cap = chain.maxFeePerGas < MAX_FEE_PER_GAS ? chain.maxFeePerGas : MAX_FEE_PER_GAS;
  let fee: CheckedTx["fee"];
  if (tx.fee.type === "eip1559") {
    const maxFeePerGas = uint(tx.fee.maxFeePerGas), maxPriorityFeePerGas = uint(tx.fee.maxPriorityFeePerGas);
    check(maxFeePerGas > 0n && maxFeePerGas <= cap && maxPriorityFeePerGas <= maxFeePerGas, "fee out of range");
    fee = { type: "eip1559", maxFeePerGas, maxPriorityFeePerGas };
  } else {
    const gasPrice = uint(tx.fee.gasPrice);
    check(gasPrice > 0n && gasPrice <= cap, "fee out of range");
    fee = { type: "legacy", gasPrice };
  }
  return { chainId: chain.chainId, to: getAddress(lower(tx.to)), data: lower(tx.data) as Hex, value: uint(tx.value), nonce: Number(nonce), gas, fee, label };
}

/** Upper bound on the network fee for all transactions, in the native coin (EVM value units = 18 decimals, except
 * Hedera whose gas price is in weibars: shown in HBAR via the value scale). */
function maxNetworkFee(txs: CheckedTx[], chain: EvmChain): bigint {
  let wei = 0n;
  for (const t of txs) wei += t.gas * (t.fee.type === "eip1559" ? t.fee.maxFeePerGas : t.fee.gasPrice);
  return chain.nativeValueScale > 1n ? wei / chain.nativeValueScale : wei;
}
function networkFee(txs: CheckedTx[], chain: EvmChain): string {
  return `up to ${formatUnits(maxNetworkFee(txs, chain), chain.native.decimals)} ${chain.native.symbol}`;
}

/** Amount in units of 10^-36 token, so tokens with different decimals compare exactly (as in price.ts). */
const wad = (raw: bigint, decimals: number): bigint => raw * 10n ** BigInt(36 - decimals);

/** A warning when the most the network fee can be is above FEE_WARNING_BPS of the amount moved.
 *  - The native coin moves: the same unit, compared exactly, and the warning gives the share.
 *  - A token moves: compared in USD with the build-time bands (price.ts), the fee at its coin's lowest price and the
 *    amount at its highest. That reading only warns when the fee is certainly above the share, so it never cries wolf;
 *    a coin or token without a band (most coins except ETH) gets no warning, and the fee line is the only signal. */
function feeWarning(txs: CheckedTx[], chain: EvmChain, token: Token, amt: bigint, verb: string): string | null {
  const fee = maxNetworkFee(txs, chain);
  if (amt <= 0n) return null;
  if (sameAddress(token.address, NATIVE_TOKEN)) {
    if (fee * 10_000n <= amt * FEE_WARNING_BPS) return null;
    const pct = (fee * 100n + amt / 2n) / amt;
    return `The network fee could be up to ${pct.toLocaleString("en-US")}% of what you ${verb}. Check the fee before you approve.`;
  }
  const coinBand = Object.hasOwn(PRICE_BANDS, chain.native.symbol) ? PRICE_BANDS[chain.native.symbol]! : null;
  const tokenBand = Object.hasOwn(PRICE_BANDS, token.symbol) ? PRICE_BANDS[token.symbol]! : null;
  if (!coinBand || !tokenBand) return null;
  if (wad(fee, chain.native.decimals) * coinBand[0] * 10_000n <= wad(amt, token.decimals) * tokenBand[1] * FEE_WARNING_BPS) return null;
  return `The network fee could be more than ${FEE_WARNING_BPS / 100n}% of what you ${verb}. Check the fee before you approve.`;
}

/** The nonce, so a transaction held back for later (a nonce ahead of the account's next one) is visible. */
function nonceLine(txs: CheckedTx[]): ReviewLine {
  const first = txs[0]!.nonce, last = txs[txs.length - 1]!.nonce;
  return { label: txs.length > 1 ? "Transaction numbers (nonces)" : "Transaction number (nonce)", value: first === last ? `${first}` : `${first} to ${last}` };
}

/** The bytes SODAX puts in intent.dstAddress for the wallet's own address on that network. */
function ownDestinationBytes(family: "evm" | "solana" | "sui", ctx: PolicyContext): Uint8Array {
  if (family === "evm") return fromHex(ctx.accounts.evm);
  if (family === "solana") {
    const b = base58Decode(ctx.accounts.solana);
    check(b.length === 32, "solana address");
    return b;
  }
  const b = fromHex(ctx.accounts.sui);
  check(b.length === 32, "sui address");
  return b;
}

/** The splitter a listed split's factory creates for its operator and rate, worked out here as the factory does
 * (@exclip/config/fee-split predictSplitter), or null for a split the factory would refuse: the build stops on one,
 * and nothing is signed for it. */
function splitterOf(split: FeeSplitTerms): string | null {
  const { factory, platform, platformRate, maxTotalRate, operator, operatorRate } = split;
  try {
    return predictSplitter({ address: factory, platform, platformRate, maxTotalRate }, operator, operatorRate);
  } catch {
    return null;
  }
}

/** "0x" or the single FEE envelope 0x01 ‖ abi.encode(uint256 fee, address receiver). Anything else (ARRAY, DELIVERY
 * hooks, unknown types) is refused: it could route the output somewhere the review doesn't show. The receiver is the
 * splitter of a listed fee split (`split`), or a listed plain receiver. A splitter is looked for first, so its fee is
 * held to the split's rates whatever else lists it. */
function partnerFee(data: Hex, ctx: PolicyContext): { fee: bigint; receiver: string | null; split: FeeSplitTerms | null } {
  if (data === "0x") return { fee: 0n, receiver: null, split: null };
  check(data.length === 4 + 128 && data.startsWith("0x01"), "intent data is not a plain fee");
  const [fee, receiver] = decodeAbiParameters(FEE_DATA, `0x${data.slice(4)}`);
  check(lower(encodeAbiParameters(FEE_DATA, [fee, receiver])) === lower(`0x${data.slice(4)}`), "fee data: non-canonical");
  const split = ctx.feeSplits.find((s) => splitterOf(s)?.toLowerCase() === lower(receiver)) ?? null;
  check(split !== null || ctx.feeReceivers.includes(lower(receiver)), "fee receiver not allowlisted");
  return { fee, receiver, split };
}

/** The partner fee's part of the review's Fees line. A split's says who gets which rate: the platform by its name in
 * the allow-list, the operator by this build's (config.ts OPERATOR_NAME). A party at 0 is left out. */
function partnerFeeParts(fee: bigint, input: Token, split: FeeSplitTerms | null): string[] {
  if (!split) return fee > 0n ? [`${OPERATOR_NAME} fee ${amount(fee, input)}`] : [];
  const shares: [number, string][] = [[split.platformRate, split.platformName], [split.operatorRate, OPERATOR_NAME]];
  return [amount(fee, input), ...shares.filter(([rate]) => rate > 0).map(([rate, name]) => `${formatRate(rate)}% to ${name}`)];
}

/* ------------------------------------------------------------------ swaps */

function checkIntent(intent: Intent, plan: SwapPlan, chain: EvmChain, ctx: PolicyContext, input: Token, output: Token, dst: NonNullable<ReturnType<typeof destination>>) {
  const hub = ctx.hubWallet;
  check(!!hub && isEvmAddress(hub), "hub wallet unknown");
  check(sameAddress(intent.creator, hub!), "intent creator is not this wallet's hub account");
  const isSonic = chain.key === SONIC_KEY;
  check(sameAddress(intent.inputToken, isSonic ? input.address : input.hubAsset), "intent input token");
  check(sameAddress(intent.outputToken, plan.dstChainKey === SONIC_KEY ? output.address : output.hubAsset), "intent output token");
  const { fee, receiver, split } = partnerFee(intent.data, ctx);
  const gross = uint(plan.inputAmount);
  check(gross > 0n && intent.inputAmount + fee === gross, "intent amount");
  if (split) {
    // A fee split (docs/fee-split.md): never on a swap with a tokenised stock on either side, the operator's rate
    // within the wallet's cap, and exactly the split's rates of the amount paid, rounded down, so the rates on the
    // review are the rates charged. The total may reach the factory's listed cap.
    check(!isStock(chain.key, input.address) && !isStock(plan.dstChainKey, output.address), "fee split on a swap with a tokenised stock");
    check(BigInt(split.operatorRate) * 10_000n <= MAX_PARTNER_FEE_BPS * BigInt(RATE_SCALE), "operator's rate above the cap");
    check(fee === splitFee(gross, split.platformRate + split.operatorRate), "fee is not exactly the split's rates");
  } else {
    check(fee * 10_000n <= gross * MAX_PARTNER_FEE_BPS, "partner fee above the cap");
  }
  check(intent.minOutputAmount === uint(plan.minOutputAmount) && intent.minOutputAmount > 0n, "minimum received");
  check(intent.deadline === uint(plan.deadline), "deadline");
  check(intent.deadline > ctx.nowSec && intent.deadline <= ctx.nowSec + MAX_DEADLINE_SEC, "deadline out of range");
  check(intent.allowPartialFill === false, "partial fills");
  check(intent.srcChain === chain.relayId && intent.dstChain === dst.relayId, "intent networks");
  check(lower(intent.srcAddress) === lower(ctx.accounts.evm), "intent source address");
  check(lower(intent.dstAddress) === lower(toHex(ownDestinationBytes(dst.family, ctx))), "intent destination is not this wallet");
  check(sameAddress(intent.solver, NATIVE_TOKEN), "intent names a solver");
  return { fee, receiver, split };
}

function checkSwap(req: SignRequest, plan: SwapPlan, chain: EvmChain, ctx: PolicyContext): Review {
  const dst = destination(plan.dstChainKey);
  if (!dst) throw new PolicyError("UNSUPPORTED_NETWORK", BROWSER_WALLET_MESSAGE, `destination ${plan.dstChainKey}`);
  const input = findToken(chain.key, plan.inputToken, ctx.stocks === true);
  const output = findToken(plan.dstChainKey, plan.outputToken, ctx.stocks === true);
  check(!!input && !!output, "token not listed");
  const ownDst = dst.family === "evm" ? ctx.accounts.evm : ctx.accounts[dst.family];
  check(dst.family === "evm" ? sameAddress(plan.dstAddress, ownDst) : plan.dstAddress === ownDst, "destination is not this wallet");

  const gross = uint(plan.inputAmount);
  const native = sameAddress(input!.address, NATIVE_TOKEN);
  const isSonic = chain.key === SONIC_KEY;
  const spender = isSonic ? INTENTS_CONTRACT : chain.assetManager!;
  const swapTx = req.txs[req.txs.length - 1]!;
  const approvals = req.txs.slice(0, -1);
  const checked: CheckedTx[] = [];

  // Approvals: none for a native coin; otherwise [exact] or [0 reset, exact], to the token, for this trade's spender.
  check(native ? approvals.length === 0 : approvals.length <= 2, "approvals");
  approvals.forEach((tx, i) => {
    check(sameAddress(tx.to, input!.address) && uint(tx.value) === 0n, "approval target");
    const [who, amt] = decodeExact(ERC20_ABI, tx.data, "approve") as [string, bigint];
    check(sameAddress(who, spender), "approval spender");
    const reset = approvals.length === 2 && i === 0;
    check(reset ? amt === 0n : amt === gross, "approval must be exactly the trade amount");
    checked.push(toChecked(tx, chain, reset ? `Reset ${input!.symbol} allowance to 0` : `Allow SODAX to take exactly ${amount(gross, input!)}`));
  });

  let intent: Intent;
  if (isSonic) {
    check(sameAddress(swapTx.to, INTENTS_CONTRACT), "swap target");
    check(uint(swapTx.value) === (native ? gross : 0n), "swap value");
    [intent] = decodeExact(INTENTS_ABI, swapTx.data, "createIntent") as [Intent];
  } else {
    check(sameAddress(swapTx.to, chain.assetManager!), "swap target");
    check(uint(swapTx.value) === (native ? gross * chain.nativeValueScale : 0n), "swap value");
    const [token, to, amt, hubData] = decodeExact(ASSET_MANAGER_ABI, swapTx.data, "transfer") as [string, Hex, bigint, Hex];
    check(sameAddress(token, input!.address) && amt === gross, "deposit token or amount");
    check(!!ctx.hubWallet && lower(to) === lower(ctx.hubWallet), "deposit is not to this wallet's hub account");
    let calls: readonly (readonly [string, bigint, Hex])[];
    try {
      calls = (decodeAbiParameters(CALLS, hubData) as unknown as [readonly (readonly [string, bigint, Hex])[]])[0];
    } catch {
      return refuse("hub calls undecodable");
    }
    check(lower(encodeAbiParameters(CALLS, [calls as never])) === lower(hubData), "hub calls: non-canonical");
    check(calls.length === 2, "hub calls");
    const [approveCall, createCall] = calls as [readonly [string, bigint, Hex], readonly [string, bigint, Hex]];
    check(sameAddress(approveCall[0], input!.hubAsset) && approveCall[1] === 0n, "hub approve target");
    const [hubSpender, hubAmount] = decodeExact(ERC20_ABI, approveCall[2], "approve") as [string, bigint];
    check(sameAddress(hubSpender, INTENTS_CONTRACT) && hubAmount === gross, "hub approve");
    check(sameAddress(createCall[0], INTENTS_CONTRACT) && createCall[1] === 0n, "hub createIntent target");
    [intent] = decodeExact(INTENTS_ABI, createCall[2], "createIntent") as [Intent];
  }
  const { fee, receiver, split } = checkIntent(intent, plan, chain, ctx, input!, output!, dst);
  const swap: SwapFacts = { input: input!, output: output!, gross, net: intent.inputAmount, minOut: intent.minOutputAmount };
  if (stableMinimumTooLow(swap)) throw new PolicyError("REFUSED", STABLE_FLOOR_MESSAGE, "stable minimum below the floor");
  checked.push(toChecked(swapTx, chain, `Swap ${amount(gross, input!)} for at least ${amount(intent.minOutputAmount, output!)}`));

  const lines: ReviewLine[] = [
    { label: "Network", value: chain.name },
    { label: "You pay", value: amount(gross, input!), ...badge(input!) },
    { label: "You receive (at least)", value: `${amount(intent.minOutputAmount, output!)} on ${dst.name}`, ...badge(output!) },
    { label: "Receiving address (yours)", value: dst.family === "evm" ? getAddress(lower(ownDst)) : ownDst, mono: true },
    // The account the deposit and the intent go through, as the popup looked it up on Sonic.
    { label: "Your SODAX account on Sonic", value: getAddress(lower(ctx.hubWallet!)), mono: true },
  ];
  if (approvals.length) lines.push({ label: "Spender (exact amount)", value: `${getAddress(lower(spender))} · SODAX`, mono: true });
  lines.push({ label: "Fees", value: [...partnerFeeParts(fee, input!, split), `network ${networkFee(checked, chain)}`].join(" · ") });
  if (receiver) lines.push({ label: "Fee receiver", value: split ? `${getAddress(receiver)} · fee splitter` : getAddress(receiver), mono: true });
  lines.push(nonceLine(checked));
  lines.push({ label: "Signing from", value: ctx.walletOrigin });
  const warning = feeWarning(checked, chain, input!, gross, "pay");
  return { kind: "swap", title: "Review swap", chain, lines, warnings: warning ? [warning] : [], txs: checked, swap, ...disclaimer(input!, output!) };
}

/* ------------------------------------------------------------------ transfers */

/** Same first 4 and last 4 hex characters as a known recipient but a different address: the shape of an
 * address-poisoning attack (a look-alike planted in the history). */
export function lookAlike(to: string, known: readonly string[]): string | null {
  const t = lower(to);
  return known.find((k) => k !== t && k.slice(2, 6) === t.slice(2, 6) && k.slice(-4) === t.slice(-4)) ?? null;
}

function checkTransfer(req: SignRequest, plan: TransferPlan, chain: EvmChain, ctx: PolicyContext): Review {
  check(req.txs.length === 1, "one transaction");
  const token = findToken(chain.key, plan.token, ctx.stocks === true);
  check(!!token, "token not listed");
  const tx = req.txs[0]!;
  const amt = uint(plan.amount);
  check(amt > 0n, "amount");
  // Mixed case is an EIP-55 checksum: if it doesn't hold, the address was mistyped.
  if (plan.to !== lower(plan.to) && plan.to.slice(2) !== plan.to.slice(2).toUpperCase() && getAddress(lower(plan.to)) !== plan.to) {
    throw new PolicyError("REFUSED", "That address fails its checksum, so it probably has a typo. Check it and try again.", "checksum");
  }
  const to = lower(plan.to);
  // Never "send" into a contract that would swallow the funds: the zero address, token contracts, SODAX contracts.
  const swallowing = [NATIVE_TOKEN, INTENTS_CONTRACT, SONIC_WALLET_ROUTER, chain.assetManager ?? NATIVE_TOKEN, ...tokenContracts(chain.key, ctx.stocks === true)];
  if (swallowing.some((a) => sameAddress(a, to))) throw new PolicyError("REFUSED", "That address is a token or SODAX contract. Funds sent there are lost.", "contract recipient");
  if (sameAddress(token!.address, NATIVE_TOKEN)) {
    // plan.amount is in the coin's listed units (HBAR: tinybars); tx.value is in EVM value units (Hedera: weibars).
    check(sameAddress(tx.to, to) && uint(tx.value) === amt * chain.nativeValueScale && tx.data === "0x", "native transfer");
  } else {
    check(sameAddress(tx.to, token!.address) && uint(tx.value) === 0n, "token transfer target");
    const [rcpt, value] = decodeExact(ERC20_ABI, tx.data, "transfer") as [string, bigint];
    check(sameAddress(rcpt, to) && value === amt, "token transfer recipient or amount");
  }
  const checked = [toChecked(tx, chain, `Send ${amount(amt, token!)}`)];
  const warnings: string[] = [];
  if (sameAddress(to, ctx.accounts.evm)) warnings.push("This is your own address.");
  else if (!ctx.knownRecipients.includes(to)) warnings.push("You haven't sent to this address before. Check every character.");
  const like = lookAlike(to, ctx.knownRecipients);
  if (like) warnings.push(`This address starts and ends like ${getAddress(like)}, which you've used before, but it is a different address. It may be a scam look-alike.`);
  const feeTooHigh = feeWarning(checked, chain, token!, amt, "send");
  if (feeTooHigh) warnings.push(feeTooHigh);
  return {
    kind: "transfer",
    title: "Review send",
    chain,
    lines: [
      { label: "Network", value: chain.name },
      { label: "You send", value: amount(amt, token!), ...badge(token!) },
      { label: "To (full address)", value: getAddress(to), mono: true },
      { label: "Network fee", value: networkFee(checked, chain) },
      nonceLine(checked),
      { label: "Signing from", value: ctx.walletOrigin },
    ],
    warnings,
    txs: checked,
    recipient: to,
    ...disclaimer(token!),
  };
}

/* ------------------------------------------------------------------ entry point */

/** True when checking `req` needs the hub wallet (fetch and pin it first). */
export const needsHubWallet = (req: SignRequest) => req.plan.kind === "swap";

/** Checks a sign request. Returns the review, or throws PolicyError. */
export function checkSignRequest(req: SignRequest, ctx: PolicyContext): Review {
  const chain = evmChain(req.chainKey);
  if (!chain) throw new PolicyError("UNSUPPORTED_NETWORK", BROWSER_WALLET_MESSAGE, `source ${req.chainKey}`);
  if (!sameAddress(req.from, ctx.accounts.evm)) throw new PolicyError("WRONG_ACCOUNT", "That request is for a different wallet.");
  const first = uint(req.txs[0]!.nonce);
  req.txs.forEach((tx, i) => check(uint(tx.nonce) === first + BigInt(i), "nonces must be consecutive"));
  check(req.txs.every((tx) => tx.fee.type === req.txs[0]!.fee.type), "mixed fee types");
  return req.plan.kind === "swap" ? checkSwap(req, req.plan, chain, ctx) : checkTransfer(req, req.plan, chain, ctx);
}
