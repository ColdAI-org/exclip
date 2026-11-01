/** Builds SODAX swap payloads the way @sodax/sdk 2.2.0 does (EvmSpokeService.deposit, EvmSolverService
 * .constructCreateIntentData, SonicSpokeService.createSwapIntent, SwapService.approve), so the policy is tested against
 * the real shapes. Test addresses only. */
import { encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, parseAbiParameters, type Hex } from "viem";
import type { SignRequest, SwapPlan, UnsignedTx } from "../src/protocol.ts";
import { EVM_CHAINS, INTENTS_CONTRACT, NATIVE_TOKEN } from "../src/sodax/chains.ts";
import { findToken, type Intent, type PolicyContext } from "../src/sodax/policy.ts";
import { base58Decode } from "../src/base58.ts";

const INTENT = "(uint256 intentId,address creator,address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,uint256 deadline,bool allowPartialFill,uint256 srcChain,uint256 dstChain,bytes srcAddress,bytes dstAddress,address solver,bytes data)";
export const INTENTS_ABI = parseAbi([`function createIntent(${INTENT} intent)`]);
export const ASSET_MANAGER_ABI = parseAbi(["function transfer(address token, bytes to, uint256 amount, bytes data) payable"]);
export const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function transfer(address to, uint256 amount) returns (bool)"]);
const CALLS = parseAbiParameters("(address,uint256,bytes)[]");

export const NOW = 1_800_000_000n;
export const OWN = {
  evm: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
  solana: "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV",
  sui: "0x1c4d3a5b6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80910",
};
export const HUB = "0x2222222222222222222222222222222222222222";
export const FEE_RECEIVER = "0x3333333333333333333333333333333333333333";

export const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  accounts: OWN, hubWallet: HUB, feeReceivers: [FEE_RECEIVER], knownRecipients: [], nowSec: NOW, walletOrigin: "https://wallet.test", ...over,
});

// 1 gwei: within every network's cap (the ETH rollups allow 10 gwei).
const fee = { type: "eip1559" as const, maxFeePerGas: "1000000000", maxPriorityFeePerGas: "100000000" };
export const tx = (to: string, data: Hex, value = 0n, nonce = 7): UnsignedTx => ({ to, data, value: value.toString(), nonce: String(nonce), gas: "300000", fee });

export type SwapSpec = {
  src: string; dst: string; input: string; output: string; amount: bigint; min: bigint;
  feeBps?: bigint; feeReceiver?: string; dstAddress?: string; approvals?: bigint[];
  /** The signing wallet's addresses (default OWN); a wallet test passes its own so the swap can be signed. */
  own?: { evm: string; solana: string; sui: string };
};
const own = (s: SwapSpec) => s.own ?? OWN;
const ownDst = (s: SwapSpec) => s.dstAddress ?? (s.dst === "solana" ? own(s).solana : s.dst === "sui" ? own(s).sui : own(s).evm);

function dstBytes(dst: string, address: string): Hex {
  if (dst === "solana") return `0x${Buffer.from(base58Decode(address)).toString("hex")}`;
  return address.toLowerCase() as Hex;
}

// Tokenised stocks included: the fixtures build what SODAX would, and whether the wallet takes it is the policy's call.
export function buildIntent(s: SwapSpec): Intent {
  const src = EVM_CHAINS[s.src]!;
  const input = findToken(s.src, s.input, true)!, output = findToken(s.dst, s.output, true)!;
  const feeAmount = s.feeBps ? (s.amount * s.feeBps) / 10_000n : 0n;
  const data: Hex = s.feeBps
    ? encodePacked(["uint8", "bytes"], [1, encodeAbiParameters(parseAbiParameters("uint256 fee, address receiver"), [feeAmount, (s.feeReceiver ?? FEE_RECEIVER) as Hex])])
    : "0x";
  const dstRelay = s.dst === "solana" ? 1n : s.dst === "sui" ? 21n : EVM_CHAINS[s.dst]!.relayId;
  const dstAddress = ownDst(s);
  return {
    intentId: 123456789n,
    creator: HUB,
    inputToken: s.src === "sonic" ? input.address : input.hubAsset,
    outputToken: s.dst === "sonic" ? output.address : output.hubAsset,
    inputAmount: s.amount - feeAmount,
    minOutputAmount: s.min,
    deadline: NOW + 300n,
    allowPartialFill: false,
    srcChain: src.relayId,
    dstChain: dstRelay,
    srcAddress: own(s).evm.toLowerCase() as Hex,
    dstAddress: dstBytes(s.dst, dstAddress),
    solver: NATIVE_TOKEN,
    data,
  };
}

export function plan(s: SwapSpec, intent = buildIntent(s)): SwapPlan {
  return {
    kind: "swap", dstChainKey: s.dst, inputToken: s.input, outputToken: s.output, inputAmount: s.amount.toString(),
    minOutputAmount: s.min.toString(), deadline: intent.deadline.toString(),
    dstAddress: ownDst(s),
  };
}

export const createIntentData = (intent: Intent) => encodeFunctionData({ abi: INTENTS_ABI, functionName: "createIntent", args: [intent as never] });

/** The swap transaction SODAX builds for `s` (spoke: assetManager.transfer with hub calls; Sonic: createIntent). */
export function swapTx(s: SwapSpec, intent = buildIntent(s), nonce = 7): UnsignedTx {
  const src = EVM_CHAINS[s.src]!;
  const input = findToken(s.src, s.input, true)!;
  const native = input.address === NATIVE_TOKEN;
  if (s.src === "sonic") return tx(INTENTS_CONTRACT, createIntentData(intent), native ? s.amount : 0n, nonce);
  const hubCalls = encodeAbiParameters(CALLS, [[
    [input.hubAsset as Hex, 0n, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [INTENTS_CONTRACT, s.amount] })],
    [INTENTS_CONTRACT, 0n, createIntentData(intent)],
  ]]);
  const data = encodeFunctionData({ abi: ASSET_MANAGER_ABI, functionName: "transfer", args: [input.address as Hex, HUB as Hex, s.amount, hubCalls] });
  return tx(src.assetManager!, data, native ? s.amount * src.nativeValueScale : 0n, nonce);
}

export function approveTx(s: SwapSpec, amount: bigint, nonce = 7, spender?: string): UnsignedTx {
  const src = EVM_CHAINS[s.src]!;
  const who = (spender ?? (s.src === "sonic" ? INTENTS_CONTRACT : src.assetManager!)) as Hex;
  return tx(s.input, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [who, amount] }), 0n, nonce);
}

/** A complete sign request for `s`: approvals (if any) then the swap, consecutive nonces. */
export function swapRequest(s: SwapSpec, intent = buildIntent(s)): SignRequest {
  const approvals = (s.approvals ?? []).map((a, i) => approveTx(s, a, 7 + i));
  return {
    v: 1, kind: "exclip-wallet", id: "req_0123456789abcdef", type: "sign", chainKey: s.src, from: own(s).evm,
    plan: plan(s, intent), txs: [...approvals, swapTx(s, intent, 7 + approvals.length)],
  };
}
