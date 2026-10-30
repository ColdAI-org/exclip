/** Hardening: each test asserts the safe behaviour against a concrete attack on stored state or a secret left behind in
 * memory (docs/embedded-wallet.md). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClipVault, MemoryStorage, type Clock } from "@clip-wallet/vault";
import { ACCOUNTS_KEY, EmbeddedWallet } from "../src/wallet.ts";
import { argon2id } from "../src/password.ts";
import { FakeApi, FakeAuthenticator, FakeSonic } from "./fakes.ts";
import { HUB, buildIntent, swapRequest, type SwapSpec } from "./sodax-fixtures.ts";

const clock: Clock = { now: () => 1_800_000_000_000 };
const testArgon2 = { params: { memoryKiB: 64, iterations: 1, parallelism: 1 }, fn: argon2id };
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL_NATIVE = "11111111111111111111111111111111";
const ATTACKER_SOL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

test("a tampered saved Solana address can't receive a swap the keys never owned", async () => {
  const api = new FakeApi();
  const sonic = new FakeSonic();
  sonic.hub = HUB;
  const storage = new MemoryStorage();
  const wallet = new EmbeddedWallet({ storage, api, webauthn: new FakeAuthenticator().env(), feeReceivers: [], clock, argon2: testArgon2, hubWallet: sonic.lookup });
  const created = await wallet.create();

  // Someone with write access to the profile's IndexedDB swaps the saved Solana address (no key, no passkey).
  await storage.set(ACCOUNTS_KEY, JSON.stringify({ ...created.accounts, solana: ATTACKER_SOL }));

  // A Base → Solana swap whose output goes to that address: the policy calls it "yours".
  const spec: SwapSpec = { src: "0x2105.base", dst: "solana", input: USDC_BASE, output: SOL_NATIVE, amount: 1_000_000n, min: 1n, approvals: [1_000_000n], dstAddress: ATTACKER_SOL };
  const intent = { ...buildIntent(spec), srcAddress: created.accounts.evm.toLowerCase() as `0x${string}` };
  const request = { ...swapRequest(spec, intent), from: created.accounts.evm };
  const prepared = await wallet.prepareSign(request);
  assert.match(prepared.review.lines.map((l) => `${l.label}: ${l.value}`).join("\n"), new RegExp(`\\(yours\\): ${ATTACKER_SOL}`));

  // After unlock the derived Solana address differs from the saved one: signing must stop.
  await assert.rejects(wallet.sign(prepared), { name: "WalletError", message: /don't match/ });
});

test("every PRF output the backup functions saw is zero once the flow ends (create, restore, add passkey)", async () => {
  const seen: { at: string; bytes: Uint8Array; nonZero: boolean }[] = [];
  const proto = ClipVault.prototype;
  const { createPasskeyBackup, restorePasskeyBackup } = proto;
  proto.createPasskeyBackup = function (password, prf) {
    seen.push({ at: "create", bytes: prf, nonZero: prf.some((b) => b !== 0) });
    return createPasskeyBackup.call(this, password, prf);
  };
  proto.restorePasskeyBackup = function (blob, prf, password) {
    seen.push({ at: "restore", bytes: prf, nonZero: prf.some((b) => b !== 0) });
    return restorePasskeyBackup.call(this, blob, prf, password);
  };
  try {
    const api = new FakeApi();
    const phone = new FakeAuthenticator();
    const storage = new MemoryStorage();
    const deps = { api, feeReceivers: [], clock, argon2: testArgon2, hubWallet: new FakeSonic().lookup };
    await new EmbeddedWallet({ ...deps, storage, webauthn: phone.env() }).create();
    await new EmbeddedWallet({ ...deps, storage: new MemoryStorage(), webauthn: new FakeAuthenticator().sync(phone).env() }).signIn();

    // A second passkey on another authenticator (as in wallet.test.ts).
    const key = new FakeAuthenticator();
    const both = new FakeAuthenticator();
    both.creds.push(...phone.creds);
    const env = both.env();
    env.credentials.create = async (o) => {
      const c = await key.env().credentials.create(o);
      both.creds.push(...key.creds.filter((k) => !both.creds.includes(k)));
      return c;
    };
    await new EmbeddedWallet({ ...deps, storage, webauthn: env }).addPasskey();

    assert.deepEqual(seen.map((s) => s.at), ["create", "restore", "create"]);
    for (const s of seen) {
      assert.ok(s.nonZero, `${s.at}: a real PRF output went in`);
      assert.ok(s.bytes.every((b) => b === 0), `${s.at}: wiped afterwards`);
    }
  } finally {
    proto.createPasskeyBackup = createPasskeyBackup;
    proto.restorePasskeyBackup = restorePasskeyBackup;
  }
});
