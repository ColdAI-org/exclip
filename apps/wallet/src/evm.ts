/** EVM transaction signing for policy-checked transactions (sodax/policy.ts CheckedTx).
 *
 * The chain id comes from the checked tx (EVM_CHAINS), so a signature is only valid on the network the review named.
 * Every signature is verified by recovering the signer before it leaves: a wrong key or a malformed signature stops
 * here instead of reaching the network. */
import { keccak256, recoverAddress, serializeTransaction, type Hex, type TransactionSerializable } from "viem";
import { hashSignablePayload } from "@clip-wallet/vault";
import type { CheckedTx } from "./sodax/policy.ts";
import { toHex } from "./bytes.ts";

export const EVM_ACCOUNT_ID = "evm:0";

export function serializable(tx: CheckedTx): TransactionSerializable {
  const base = { chainId: tx.chainId, to: tx.to, data: tx.data, value: tx.value, nonce: tx.nonce, gas: tx.gas };
  return tx.fee.type === "eip1559"
    ? { ...base, type: "eip1559", maxFeePerGas: tx.fee.maxFeePerGas, maxPriorityFeePerGas: tx.fee.maxPriorityFeePerGas }
    : { ...base, type: "legacy", gasPrice: tx.fee.gasPrice };
}

/** keccak256 of the unsigned serialization: what the key signs (EIP-1559 typed, or EIP-155 legacy with chain id). */
export function signingDigest(tx: CheckedTx): Uint8Array {
  return keccak256(serializeTransaction(serializable(tx)), "bytes");
}

/** The vault approval hash for that digest (vault approvals.ts). */
export function approvalHash(digest: Uint8Array): Uint8Array {
  return hashSignablePayload({ accountId: EVM_ACCOUNT_ID, scheme: "ecdsa-secp256k1", bytes: digest });
}

export type EcdsaSignature = { bytes: Uint8Array; recovery?: number };

/** The signed raw transaction and its hash, after checking the signature recovers to `expectedSigner`. */
export async function assemble(tx: CheckedTx, digest: Uint8Array, sig: EcdsaSignature, expectedSigner: string): Promise<{ raw: Hex; hash: Hex }> {
  if (sig.bytes.length !== 64 || (sig.recovery !== 0 && sig.recovery !== 1)) throw new Error("unexpected signature");
  const r = toHex(sig.bytes.subarray(0, 32));
  const s = toHex(sig.bytes.subarray(32, 64));
  const yParity = sig.recovery;
  const signer = await recoverAddress({ hash: toHex(digest), signature: { r, s, yParity } });
  if (signer.toLowerCase() !== expectedSigner.toLowerCase()) throw new Error("signature does not match the wallet");
  const raw = serializeTransaction(serializable(tx), { r, s, yParity, v: 27n + BigInt(yParity) });
  return { raw, hash: keccak256(raw) };
}
