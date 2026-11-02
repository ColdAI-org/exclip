/**
 * ExClip's half of an embedded-wallet trade (docs/embedded-wallet.md). Pure: the SODAX SDK and the RPC client come in
 * as small interfaces, so all of it runs in unit tests.
 *
 *  1. Ask SODAX for the unsigned transactions (exact approvals if needed, then the intent), fill nonce, fees and gas.
 *  2. Send them with the plan (what the user asked for, never what SODAX returned) to the popup, which decodes and
 *     checks every byte against the plan, shows its own review, and signs after a fresh passkey ceremony.
 *  3. Broadcast in order, each only after the one before it succeeded on chain; relay to the hub; tell the solver.
 *
 * v1 scope: market swaps from and to the EVM networks below, and same-network sends. Anything else gets
 * BROWSER_WALLET_MESSAGE before the popup opens.
 */
import { MAX_TXS, type Hex, type SignRequest, type SignResult, type SwapPlan, type TransferPlan, type UnsignedTx } from "./wallet-protocol";
import { stockRefusalText } from "./stock-gate";
import type { IntentFee } from "./fees";
import type { SerializedIntent, SwapInput, SwapOutcome, SwapProgress } from "./wallet";

/** The networks the popup signs on (apps/wallet/src/sodax/chains.ts EVM_CHAINS; a test keeps them equal). */
export const EMBEDDED_CHAINS = [
  "sonic", "ethereum", "0x2105.base", "0xa4b1.arbitrum", "0xa.optimism", "0x89.polygon", "0x38.bsc", "0xa86a.avax",
  "hyper", "lightlink", "0x2019.kaia", "redbelly", "hedera", "robinhood",
] as const;
export const HUB_CHAIN = "sonic";
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
/** EVM value units per listed native unit (Hedera: weibars per tinybar). Same as chains.ts nativeValueScale. */
const NATIVE_VALUE_SCALE: Record<string, bigint> = { hedera: 10n ** 10n };

export const BROWSER_WALLET_MESSAGE = "Use a browser wallet for this network";

/** The popup's outer sanity bounds: a request outside them is refused there, so stop here first. (The popup also caps
 * the fee per network, at or below this; chains.ts maxFeePerGas.) */
export const MAX_GAS = 5_000_000n;
export const MAX_FEE_PER_GAS = 10_000n * 10n ** 9n;
/** Gas for a transaction that can't be estimated yet because it depends on an earlier one in the same batch (an
 * approve after an allowance reset; the swap after its approval). Unused gas is refunded, except on Hedera, which
 * keeps up to 20% of the unused limit: these are small next to the trade. */
export const APPROVE_GAS = 100_000n;
export const SWAP_GAS_AFTER_APPROVAL = 800_000n;
/** Head room on estimates: state can move between estimate and inclusion. */
const ESTIMATE_PCT = 125n;

export const isEmbeddedChain = (chainKey: string) => (EMBEDDED_CHAINS as readonly string[]).includes(chainKey);
const lower = (s: string) => s.toLowerCase();

export class EmbeddedTradeError extends Error {
  /** `sent`: something reached the chain, so the user must not simply retry. */
  constructor(message: string, readonly sent = false, readonly txHashes: string[] = []) {
    super(message);
    this.name = "EmbeddedTradeError";
  }
}

/* ------------------------------------------------------------------ RPC */

/** The viem PublicClient methods used here (the SDK's clients satisfy it). */
export type EvmRpc = {
  getTransactionCount(a: { address: Hex; blockTag: "pending" }): Promise<number>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint }>;
  getGasPrice(): Promise<bigint>;
  estimateGas(a: { account: Hex; to: Hex; data: Hex; value: bigint }): Promise<bigint>;
  sendRawTransaction(a: { serializedTransaction: Hex }): Promise<Hex>;
  waitForTransactionReceipt(a: { hash: Hex; timeout?: number }): Promise<{ status: "success" | "reverted" }>;
};

export type RawTx = { to: string; data: string; value: bigint; kind: "approve" | "swap" | "transfer" };

/** Nonces from the pending count, one fee for all, gas estimated for the first transaction and fixed for the rest. */
export async function fillTxs(rpc: EvmRpc, from: string, raws: RawTx[]): Promise<UnsignedTx[]> {
  if (!raws.length || raws.length > MAX_TXS) throw new EmbeddedTradeError("This trade needs more steps than the wallet signs at once.");
  const [nonce, fee] = await Promise.all([rpc.getTransactionCount({ address: from as Hex, blockTag: "pending" }), networkFee(rpc)]);
  const first = raws[0]!;
  const estimated = await rpc.estimateGas({ account: from as Hex, to: first.to as Hex, data: first.data as Hex, value: first.value })
    .catch(() => { throw new EmbeddedTradeError("The network rejected this in a dry run (check your balance, including gas). Nothing was sent."); });
  return raws.map((tx, i) => {
    const gas = i === 0 ? (estimated * ESTIMATE_PCT) / 100n : tx.kind === "approve" ? APPROVE_GAS : SWAP_GAS_AFTER_APPROVAL;
    if (gas > MAX_GAS) throw new EmbeddedTradeError("This trade needs more gas than the wallet allows. Nothing was sent.");
    return { to: tx.to, data: tx.data, value: tx.value.toString(), nonce: String(nonce + i), gas: gas.toString(), fee };
  });
}

async function networkFee(rpc: EvmRpc): Promise<UnsignedTx["fee"]> {
  const tooHigh = () => new EmbeddedTradeError("Network fees are unusually high right now. Try again later. Nothing was sent.");
  const est = await rpc.estimateFeesPerGas().catch(() => null);
  if (est?.maxFeePerGas != null && est.maxPriorityFeePerGas != null) {
    if (est.maxFeePerGas > MAX_FEE_PER_GAS) throw tooHigh();
    const tip = est.maxPriorityFeePerGas > est.maxFeePerGas ? est.maxFeePerGas : est.maxPriorityFeePerGas;
    return { type: "eip1559", maxFeePerGas: est.maxFeePerGas.toString(), maxPriorityFeePerGas: tip.toString() };
  }
  const gasPrice = est?.gasPrice ?? (await rpc.getGasPrice());
  if (gasPrice <= 0n || gasPrice > MAX_FEE_PER_GAS) throw tooHigh();
  return { type: "legacy", gasPrice: gasPrice.toString() };
}

/** Sends the signed transactions in order. Each must come back with the hash the popup computed, and must succeed on
 * chain before the next one goes out (an approval has to land before the swap that spends it). */
export async function broadcast(rpc: EvmRpc, signed: SignResult, onSent?: (hash: Hex, index: number) => void): Promise<Hex[]> {
  const sent: Hex[] = [];
  for (let i = 0; i < signed.signed.length; i++) {
    const expected = signed.hashes[i]!;
    let hash: Hex;
    try {
      hash = await rpc.sendRawTransaction({ serializedTransaction: signed.signed[i]! });
    } catch {
      throw new EmbeddedTradeError(
        sent.length ? "The network refused the next step. Your earlier step is on chain; check your activity before trying again." : "The network refused the transaction. Nothing was sent.",
        sent.length > 0, sent,
      );
    }
    if (lower(hash) !== lower(expected)) throw new EmbeddedTradeError("The network answered with an unexpected transaction id. Don't resend: check your activity first.", true, [...sent, expected]);
    sent.push(hash);
    onSent?.(hash, i);
    const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 180_000 }).catch(() => null);
    if (!receipt) throw new EmbeddedTradeError("Your transaction is taking long to confirm. Don't resend: we'll keep tracking it.", true, sent);
    if (receipt.status !== "success") throw new EmbeddedTradeError("The transaction failed on chain. Only the network fee was spent.", true, sent);
  }
  return sent;
}

/* ------------------------------------------------------------------ plans */

/** Why the embedded wallet can't do this swap (shown before the popup opens), or null. */
export function embeddedSwapProblem(input: SwapInput, ownEvm: string): string | null {
  if (!isEmbeddedChain(input.srcChainKey) || !isEmbeddedChain(input.dstChainKey)) return BROWSER_WALLET_MESSAGE;
  if (input.kind !== "market") return "Limit orders need a browser wallet for now. Market swaps work with your passkey wallet.";
  if (input.deadline <= 0n) return "This trade has no deadline.";
  if (input.dstAddress && lower(input.dstAddress) !== lower(ownEvm)) {
    return "Your passkey wallet only swaps into itself. To send to someone else, swap first, then use Send.";
  }
  return null;
}

/** What the user asked for. The popup holds SODAX's transactions to this, so it is built from the user's input. */
export function swapPlan(input: SwapInput, ownEvm: string): SwapPlan {
  return {
    kind: "swap",
    dstChainKey: input.dstChainKey,
    inputToken: input.inputToken,
    outputToken: input.outputToken,
    inputAmount: input.inputAmount.toString(),
    minOutputAmount: input.minOutputAmount.toString(),
    deadline: input.deadline.toString(),
    dstAddress: ownEvm,
  };
}

const word = (hex: string) => hex.padStart(64, "0");

/** ERC-20 transfer(to, amount) calldata. */
export function erc20TransferData(to: string, amount: bigint): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new EmbeddedTradeError("That isn't an EVM address.");
  if (amount <= 0n || amount >= 2n ** 256n) throw new EmbeddedTradeError("Enter an amount.");
  return `0xa9059cbb${word(lower(to.slice(2)))}${word(amount.toString(16))}`;
}

export type SendInput = { chainKey: string; token: string; amount: bigint; to: string };

/** The one transaction for a same-network send. `to` is passed through as typed: the popup checks its checksum. */
export function sendTx(input: SendInput): { plan: TransferPlan; raw: RawTx } {
  if (!isEmbeddedChain(input.chainKey)) throw new EmbeddedTradeError(BROWSER_WALLET_MESSAGE);
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.to)) throw new EmbeddedTradeError("Enter a full EVM address (0x followed by 40 characters).");
  if (input.amount <= 0n) throw new EmbeddedTradeError("Enter an amount.");
  const plan: TransferPlan = { kind: "transfer", token: input.token, amount: input.amount.toString(), to: input.to };
  const native = lower(input.token) === NATIVE_TOKEN;
  const raw: RawTx = native
    ? { to: input.to, data: "0x", value: input.amount * (NATIVE_VALUE_SCALE[input.chainKey] ?? 1n), kind: "transfer" }
    : { to: input.token, data: erc20TransferData(input.to, input.amount), value: 0n, kind: "transfer" };
  return { plan, raw };
}

/* ------------------------------------------------------------------ flows */

type Result<T> = { ok: true; value: T } | { ok: false; error: unknown };
type SdkRawTx = { to: string; data: string; value: bigint };

/** The SODAX calls a swap needs, adapted from the SDK in wallet-runtime.tsx (raw mode: nothing is signed there). */
export type SodaxSwaps = {
  isAllowanceValid(params: Record<string, unknown>): Promise<Result<boolean>>;
  buildApproveTxs(params: Record<string, unknown>): Promise<Result<{ resetTx?: SdkRawTx; approveTx: SdkRawTx }>>;
  /** `partnerFee` is the swap's fee from lib/fees.ts (the SDK's extras.partnerFee), or undefined for none. */
  createIntent(params: Record<string, unknown>, skipSimulation: boolean, partnerFee: IntentFee | undefined): Promise<Result<{ tx: SdkRawTx; intent: object; relayData: unknown }>>;
  /** Relays a spoke transaction to the hub; returns the hub transaction hash. */
  relay(srcChainKey: string, srcTxHash: Hex, relayData: unknown): Promise<Result<string>>;
  postExecution(hubTxHash: string): Promise<Result<unknown>>;
  rpc(chainKey: string): EvmRpc;
};

/** The popup, reduced to what a trade needs (embedded-client.ts WalletPopup). */
export type Signer = { sign(body: Omit<SignRequest, "v" | "kind" | "id" | "type">): Promise<SignResult>; close(reason?: string): void };

export const SIGN_ONLY_MESSAGE = "Dev mode: signed but not broadcast. Nothing was sent.";

const serialize = (intent: object): SerializedIntent =>
  Object.fromEntries(Object.entries(intent).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : (v as string | boolean)]));

function unwrap<T>(r: Result<T>, message: string): T {
  if (r.ok) return r.value;
  // A tokenised-stock refusal (HTTP 451 from this server's proxy) says why, in place of the generic message.
  throw new EmbeddedTradeError(stockRefusalText(r.error) ?? message);
}

const asRaw = (tx: SdkRawTx, kind: RawTx["kind"]): RawTx => {
  if (typeof tx?.to !== "string" || typeof tx.data !== "string" || typeof tx.value !== "bigint") throw new EmbeddedTradeError("SODAX returned an unexpected transaction. Nothing was sent.");
  return { to: tx.to, data: tx.data, value: tx.value, kind };
};

/**
 * A market swap through the embedded wallet. `signer` is the popup, opened by the caller in the click handler; the intent
 * carries `opts.partnerFee`, which the popup checks against its own rules. Throws EmbeddedTradeError; `sent` on it means
 * something reached the chain.
 */
export async function embeddedSwap(
  sodax: SodaxSwaps, signer: Signer, input: SwapInput, ownEvm: string,
  onProgress: (p: SwapProgress) => void, opts: { signOnly?: boolean; partnerFee?: IntentFee } = {},
): Promise<SwapOutcome> {
  const problem = embeddedSwapProblem(input, ownEvm);
  if (problem) throw new EmbeddedTradeError(problem);
  const params = {
    srcChainKey: input.srcChainKey, dstChainKey: input.dstChainKey, inputToken: input.inputToken, outputToken: input.outputToken,
    inputAmount: input.inputAmount, minOutputAmount: input.minOutputAmount, deadline: input.deadline,
    allowPartialFill: false, srcAddress: ownEvm, dstAddress: ownEvm, data: "0x",
  };

  let request: Omit<SignRequest, "v" | "kind" | "id" | "type">;
  let created: { tx: SdkRawTx; intent: object; relayData: unknown };
  try {
    const allowed = unwrap(await sodax.isAllowanceValid(params), "Couldn't check your token allowance. Nothing was sent.");
    const raws: RawTx[] = [];
    if (!allowed) {
      const a = unwrap(await sodax.buildApproveTxs(params), "Couldn't prepare the approval. Nothing was sent.");
      if (a.resetTx) raws.push(asRaw(a.resetTx, "approve"));
      raws.push(asRaw(a.approveTx, "approve"));
    }
    // Simulation can't pass before the approval exists; the popup checks the payload either way.
    created = unwrap(await sodax.createIntent(params, raws.length > 0, opts.partnerFee), "SODAX couldn't build this trade. Nothing was sent.");
    raws.push(asRaw(created.tx, "swap"));
    const txs = await fillTxs(sodax.rpc(input.srcChainKey), ownEvm, raws);
    request = { chainKey: input.srcChainKey, from: ownEvm, plan: swapPlan(input, ownEvm), txs };
  } catch (e) {
    signer.close("The trade couldn't be prepared.");
    throw e instanceof EmbeddedTradeError ? e : new EmbeddedTradeError("Couldn't prepare the trade. Nothing was sent.");
  }

  onProgress({ step: "sign" });
  const signed = await signer.sign(request); // the popup closes itself after answering
  if (opts.signOnly) throw new EmbeddedTradeError(SIGN_ONLY_MESSAGE);

  const rpc = sodax.rpc(input.srcChainKey);
  const last = signed.hashes.length - 1;
  if (last > 0) onProgress({ step: "approve" });
  const hashes = await broadcast(rpc, signed, (hash, i) => {
    if (i === last) onProgress({ step: "submitted", srcTxHash: hash, srcChainKey: input.srcChainKey });
  });
  const srcTxHash = hashes[last]!;

  let hubTxHash: string = srcTxHash;
  if (input.srcChainKey !== HUB_CHAIN) {
    const relayed = await sodax.relay(input.srcChainKey, srcTxHash, created.relayData);
    if (!relayed.ok) throw new EmbeddedTradeError("Your trade is on chain but the relay is slow. Don't resend: we'll keep tracking it.", true, hashes);
    hubTxHash = relayed.value;
  }
  // The intent is on the hub either way; if this notice fails, solvers still find it, just later.
  await sodax.postExecution(hubTxHash).catch(() => null);
  onProgress({ step: "solving", srcTxHash, hubTxHash });
  return { srcTxHash, hubTxHash, intent: serialize(created.intent) };
}

/** A same-network send through the embedded wallet. Returns the transaction hash. */
export async function embeddedSend(rpc: EvmRpc, signer: Signer, input: SendInput, ownEvm: string, opts: { signOnly?: boolean } = {}): Promise<Hex> {
  let request: Omit<SignRequest, "v" | "kind" | "id" | "type">;
  try {
    const { plan, raw } = sendTx(input);
    request = { chainKey: input.chainKey, from: ownEvm, plan, txs: await fillTxs(rpc, ownEvm, [raw]) };
  } catch (e) {
    signer.close("The send couldn't be prepared.");
    throw e instanceof EmbeddedTradeError ? e : new EmbeddedTradeError("Couldn't prepare the send. Nothing was sent.");
  }
  const signed = await signer.sign(request);
  if (opts.signOnly) throw new EmbeddedTradeError(SIGN_ONLY_MESSAGE);
  const [hash] = await broadcast(rpc, signed);
  return hash!;
}
