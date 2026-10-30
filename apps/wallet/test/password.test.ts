import { test } from "node:test";
import assert from "node:assert/strict";
import { hashWasmArgon2id } from "@clip-wallet/vault";
import { VAULT_PASSWORD_INFO, WALLET_PRF_INPUT, argon2id, deriveVaultPassword } from "../src/password.ts";
import { random } from "./fakes.ts";

const prf = new Uint8Array(32).fill(7);
const cred = new Uint8Array(16).fill(9);

test("the vault password is deterministic, 256 bits, base64url", () => {
  const a = deriveVaultPassword(prf, cred);
  assert.equal(a, deriveVaultPassword(prf.slice(), cred.slice()));
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
});

test("domain separation: another PRF output, credential id or input gives another password", () => {
  const base = deriveVaultPassword(prf, cred);
  const otherPrf = prf.slice();
  otherPrf[31] = 8;
  const otherCred = cred.slice();
  otherCred[0] = 8;
  assert.notEqual(deriveVaultPassword(otherPrf, cred), base);
  assert.notEqual(deriveVaultPassword(prf, otherCred), base);
  // The password isn't the PRF output (or any encoding of it), so the vault's own PRF-derived keys stay unrelated.
  assert.notEqual(base, Buffer.from(prf).toString("base64url"));
  assert.equal(VAULT_PASSWORD_INFO, "exclip/embedded-wallet/vault-password/v1");
  assert.equal(WALLET_PRF_INPUT.length, 32);
});

test("short inputs are refused", () => {
  assert.throws(() => deriveVaultPassword(new Uint8Array(31), cred), /at least 32 bytes/);
  assert.throws(() => deriveVaultPassword(prf, new Uint8Array(15)), /too short/);
  assert.throws(() => deriveVaultPassword("x" as unknown as Uint8Array, cred));
});

test("the pure-JS Argon2id matches the vault's default (hash-wasm) bit for bit", async () => {
  const input = { password: "correct horse", salt: random(16), memoryKiB: 64, iterations: 2, parallelism: 1, hashLength: 32 };
  assert.deepEqual(await argon2id(input), await hashWasmArgon2id(input));
});
