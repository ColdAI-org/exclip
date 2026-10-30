/** The vault password nobody sees (docs/embedded-wallet.md).
 *
 * ClipVault encrypts under a password (Argon2id → KEK) and also accepts passkey unlock. The embedded wallet has no
 * user password: it derives one from the passkey's PRF output and the credential id, uses it only where the vault API
 * requires a password (create, enroll another passkey, backup create/restore, reveal phrase), and never shows,
 * stores or sends it.
 *
 *   vaultPassword = base64url(HKDF-SHA256(ikm = PRF(credential, WALLET_PRF_INPUT), salt = credentialId,
 *                                         info = "exclip/embedded-wallet/vault-password/v1", 32 bytes))
 *
 * It is a uniform 256-bit secret, so the Argon2id cost on top of it adds no security; VAULT_ARGON2 keeps it small,
 * and argon2id() is a pure-JS implementation because the wallet's CSP doesn't allow WebAssembly. */
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toB64u, utf8, wipe } from "./bytes.ts";

export const VAULT_PASSWORD_INFO = "exclip/embedded-wallet/vault-password/v1";

/** PRF input (eval.first) for everything the embedded wallet derives: unlock wrap key, backup key, vault password.
 * Each use is domain-separated by its own HKDF info and salt (vault PASSKEY_WRAP_INFO, BACKUP_INFO, the line above). */
export const WALLET_PRF_INPUT: Uint8Array = sha256(utf8("exclip/embedded-wallet/prf-input/v1"));

export function deriveVaultPassword(prfOutput: Uint8Array, credentialId: Uint8Array): string {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.length < 32) throw new Error("PRF output must be at least 32 bytes");
  if (!(credentialId instanceof Uint8Array) || credentialId.length < 16) throw new Error("credential id too short");
  const key = hkdf(sha256, prfOutput, credentialId, utf8(VAULT_PASSWORD_INFO), 32);
  try {
    return toB64u(key);
  } finally {
    wipe(key);
  }
}

/** Argon2id cost for vaults the embedded wallet writes. The input is a 256-bit random secret (above), so this only
 * has to stay within the vault's accepted range; 8 MiB/t=1 runs in well under a second in pure JS on a phone. */
export const VAULT_ARGON2 = { memoryKiB: 8 * 1024, iterations: 1, parallelism: 1 } as const;

/** The vault's Argon2idFn, in pure JS (@noble/hashes). Same RFC 9106 output as the vault's default hash-wasm. */
export async function argon2id(i: { password: string; salt: Uint8Array; memoryKiB: number; iterations: number; parallelism: number; hashLength: number }): Promise<Uint8Array> {
  return argon2idAsync(utf8(i.password), i.salt, { m: i.memoryKiB, t: i.iterations, p: i.parallelism, dkLen: i.hashLength });
}
