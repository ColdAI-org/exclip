import { test } from "node:test";
import assert from "node:assert/strict";
import { ClipVault, MemoryStorage, type Clock } from "@clip-wallet/vault";
import { encodeFunctionData, getAddress, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { STOCK_BADGE, stocksDisclaimer } from "@exclip/config/stocks";
import {
  ACCOUNTS_KEY, AUTO_LOCK_MS, EmbeddedWallet, NOT_BACKED_UP_WARNING, PASSWORD_BOX_KEY, PENDING_KEY, PRICE_UNCHECKED_WARNING, STATUS_MAC_BOX_KEY, STATUS_RESET_MESSAGE, UNBACKED_LIMIT_USD, isBackedUp, type WalletDeps,
} from "../src/wallet.ts";
import { toB64u } from "../src/bytes.ts";
import { OPERATOR_NAME } from "../src/config.ts";
import type { SwapFacts } from "../src/sodax/price.ts";
import { argon2id } from "../src/password.ts";
import { WebAuthnError, UNSUPPORTED_MESSAGE } from "../src/webauthn.ts";
import { PolicyError } from "../src/sodax/policy.ts";
import { SODAX_STOCK_TOKENS } from "../src/sodax/stock-tokens.ts";
import { STATUS_KEY, readStatus } from "../src/storage.ts";
import type { SignRequest } from "../src/protocol.ts";
import { FakeApi, FakeAuthenticator, FakeSonic, type AuthenticatorOptions } from "./fakes.ts";
import { ERC20_ABI, FEE_RECEIVER, HUB, OWN, swapRequest } from "./sodax-fixtures.ts";

/** Fixed time, no timers (the vault's auto-lock is checked on access instead). */
const NOW_MS = 1_800_000_000_000;
const clock: Clock = { now: () => NOW_MS };
/** Cheap Argon2id cost for tests (same pure-JS implementation the wallet ships). */
const testArgon2 = { params: { memoryKiB: 64, iterations: 1, parallelism: 1 }, fn: argon2id };

function device(auth: FakeAuthenticator, api: FakeApi, storage = new MemoryStorage(), extra: Partial<WalletDeps> = {}) {
  const wallet = new EmbeddedWallet({ storage, api, webauthn: auth.env(), feeReceivers: [], clock, argon2: testArgon2, hubWallet: new FakeSonic().lookup, ...extra });
  return { wallet, storage };
}

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FRIEND = "0x00000000000000000000000000000000000f1e4d";
function sendRequest(from: string): SignRequest {
  return {
    v: 1, kind: "exclip-wallet", id: "req_0123456789abcdef", type: "sign", chainKey: "0x2105.base", from,
    plan: { kind: "transfer", token: USDC_BASE, amount: "2500000", to: FRIEND },
    txs: [{
      to: USDC_BASE, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [FRIEND as Hex, 2_500_000n] }),
      value: "0", nonce: "3", gas: "65000", fee: { type: "eip1559", maxFeePerGas: "2000000000", maxPriorityFeePerGas: "1000000" },
    }],
  };
}

test("create → server backup → sign in on a new device → same addresses → sign; locked after every step", async () => {
  const phoneA = new FakeAuthenticator({ capability: true });
  const api = new FakeApi();
  const a = device(phoneA, api);

  const created = await a.wallet.create();
  assert.match(created.accounts.evm, /^0x[0-9a-fA-F]{40}$/);
  assert.ok(created.accounts.solana && created.accounts.sui && created.accounts.stellar);
  assert.equal(created.serverBackup, true);
  assert.equal(created.passkeySynced, true);
  assert.equal(phoneA.calls.length, 1, "one passkey prompt to create");
  assert.equal(await a.wallet.vaultStatus(), "locked");
  assert.equal(created.backedUp, false, "not backed up until the user confirms sync or saves the phrase");

  // What reached the server: a registration with EMPTY extension results (never the PRF output) and ciphertext.
  const [reg] = api.registered as { clientExtensionResults: object; response: object }[];
  assert.deepEqual(reg!.clientExtensionResults, {});
  assert.equal(JSON.stringify(api.registered).includes("leaked"), false, "toJSON() is never used");
  const create = phoneA.calls[0]!.options as CredentialCreationOptions;
  assert.equal(create.publicKey!.authenticatorSelection!.residentKey, "required");
  assert.equal(create.publicKey!.authenticatorSelection!.userVerification, "required");
  assert.equal(create.publicKey!.attestation, "none");
  assert.deepEqual(create.publicKey!.pubKeyCredParams.map((p) => p.alg), [-7, -8]);
  assert.equal(create.publicKey!.rp.id, "wallet.test");
  assert.equal(new Uint8Array(create.publicKey!.user.id as ArrayBuffer).length, 32);
  assert.equal(create.publicKey!.user.name, "ExClip wallet", "the brand name (ExClip when the build sets none)");

  // Nothing secret in local storage: the vault record is ciphertext, the status record public facts.
  const all = [...(a.storage as unknown as { map: Map<string, string> }).map?.values?.() ?? []].join("");
  assert.equal(/[a-z]+( [a-z]+){11}/.test(all), false, "no phrase in storage");

  // New device: the synced passkey, empty storage, one prompt.
  const phoneB = new FakeAuthenticator({ capability: true }).sync(phoneA);
  const b = device(phoneB, api);
  const restored = await b.wallet.signIn();
  assert.deepEqual(restored.accounts, created.accounts);
  assert.deepEqual(api.purposes, ["register", "fetch"], "each server challenge asked for its own operation");
  assert.equal(phoneB.calls.length, 1, "one passkey prompt to sign in on a new device");
  assert.equal(await b.wallet.vaultStatus(), "locked");

  // Sign on the new device.
  const prepared = await b.wallet.prepareSign(sendRequest(restored.accounts.evm));
  assert.match(prepared.review.warnings.join(" "), /haven't sent/);
  assert.equal(await b.wallet.vaultStatus(), "locked", "reviewing needs no key");
  const result = await b.wallet.sign(prepared);
  assert.equal(await b.wallet.vaultStatus(), "locked", "locked again after signing");
  assert.equal(phoneB.calls.length, 2, "one fresh prompt per signature");
  const getOpts = phoneB.calls[1]!.options as CredentialRequestOptions;
  assert.equal(getOpts.publicKey!.userVerification, "required");
  assert.equal(getOpts.publicKey!.allowCredentials!.length, 1, "only this wallet's passkeys");

  const parsed = parseTransaction(result.signed[0]!);
  assert.equal(parsed.chainId, 8453);
  assert.equal(parsed.to?.toLowerCase(), USDC_BASE.toLowerCase());
  assert.equal(parsed.nonce, 3);
  const signer = await recoverTransactionAddress({ serializedTransaction: result.signed[0]! as never });
  assert.equal(signer.toLowerCase(), created.accounts.evm.toLowerCase());
  assert.match(result.hashes[0]!, /^0x[0-9a-f]{64}$/);

  // The recipient is remembered (for the next first-time / look-alike check), nothing else.
  assert.deepEqual((await readStatus(b.storage)).recipients, [FRIEND]);
  const second = await b.wallet.prepareSign(sendRequest(restored.accounts.evm));
  assert.deepEqual(second.review.warnings, [NOT_BACKED_UP_WARNING], "only the backup warning is left");
  await b.wallet.revealPhrase();
  await b.wallet.markPhraseSaved();
  assert.deepEqual((await b.wallet.prepareSign(sendRequest(restored.accounts.evm))).review.warnings, []);
});

test("receive: the popup's own address, hidden only when not backed up at or above its limit", async () => {
  const auth = new FakeAuthenticator();
  const api = new FakeApi();
  const d = device(auth, api);
  await assert.rejects(d.wallet.receive(), { name: "WalletError", code: "NO_WALLET" });
  const created = await d.wallet.create();
  const prompts = auth.calls.length;

  const view = await d.wallet.receive();
  assert.equal(view.address, getAddress(created.accounts.evm), "checksummed");
  assert.equal(view.backedUp, false);
  assert.equal(view.limitUsd, UNBACKED_LIMIT_USD);
  assert.equal(view.hideAddress, false, "no hint: shown, with the warning");
  assert.equal((await d.wallet.receive(UNBACKED_LIMIT_USD - 1)).hideAddress, false);
  assert.equal((await d.wallet.receive(UNBACKED_LIMIT_USD)).hideAddress, true);
  assert.equal((await d.wallet.receive(10_000)).hideAddress, true);
  assert.equal(auth.calls.length, prompts, "showing the saved address needs no passkey");
  assert.equal(UNBACKED_LIMIT_USD, 100, "100 when the build sets no limit");
  assert.match(NOT_BACKED_UP_WARNING, /\$100/);

  // The on-demand check re-derives the keys with one passkey prompt and locks again.
  assert.deepEqual(await d.wallet.verifyAddresses(), created.accounts);
  assert.equal(auth.calls.length, prompts + 1);
  assert.equal(await d.wallet.vaultStatus(), "locked");

  // Backed up: the hint no longer hides anything.
  await d.wallet.revealPhrase();
  await d.wallet.markPhraseSaved();
  const after = await d.wallet.receive(10_000);
  assert.deepEqual([after.backedUp, after.hideAddress], [true, false]);

  // A saved address that no longer matches the keys fails the on-demand check.
  const saved = JSON.parse((await d.storage.get(ACCOUNTS_KEY))!);
  await d.storage.set(ACCOUNTS_KEY, JSON.stringify({ ...saved, evm: FRIEND }));
  await assert.rejects(d.wallet.verifyAddresses(), { name: "WalletError" });
  assert.equal(await d.wallet.vaultStatus(), "locked");
});

test("Safari-style PRF (result only on get): two prompts at create, then everything works", async () => {
  const auth = new FakeAuthenticator({ prfOnlyOnGet: true });
  const api = new FakeApi();
  const d = device(auth, api);
  const created = await d.wallet.create();
  assert.equal(auth.calls.map((c) => c.kind).join(","), "create,get");
  const result = await d.wallet.sign(await d.wallet.prepareSign(sendRequest(created.accounts.evm)));
  assert.equal(result.signed.length, 1);
});

for (const [name, opts, prompts] of [
  ["no PRF on the authenticator", { noPrf: true }, 1],
  ["the browser reports no PRF", { capability: false }, 0],
] as [string, AuthenticatorOptions, number][]) {
  test(`PRF unsupported (${name}): refused with the browser message, nothing stored`, async () => {
    const auth = new FakeAuthenticator(opts);
    const api = new FakeApi();
    const d = device(auth, api);
    await assert.rejects(d.wallet.create(), (e: unknown) => e instanceof WebAuthnError && e.code === "UNSUPPORTED_BROWSER" && e.message === UNSUPPORTED_MESSAGE);
    assert.equal(auth.calls.length, prompts);
    assert.equal(await d.wallet.hasWallet(), false);
    assert.equal(api.backups.size, 0);
    if (prompts) assert.equal(auth.signalled.length, 1, "the useless passkey is reported to the browser");
  });
}

test("a second create on the same browser is refused; sign-in there unlocks locally and fetches nothing", async () => {
  const auth = new FakeAuthenticator();
  const api = new FakeApi();
  const d = device(auth, api);
  const created = await d.wallet.create();
  await assert.rejects(d.wallet.create(), { name: "WalletError", code: "WALLET_EXISTS", message: /already has a wallet/ });
  let fetched = 0;
  api.fetchBackup = async () => { fetched++; throw new Error("unexpected"); };
  const again = await d.wallet.signIn();
  assert.deepEqual(again.accounts, created.accounts);
  assert.equal(fetched, 0);
  assert.equal(await d.wallet.vaultStatus(), "locked");
});

test("backup upload fails: the wallet still works and stays 'not backed up'; saving the phrase fixes that", async () => {
  const auth = new FakeAuthenticator();
  const api = new FakeApi();
  api.failRegister = true;
  const d = device(auth, api);
  const created = await d.wallet.create();
  assert.equal(created.serverBackup, false);
  assert.equal(await d.wallet.confirmSynced(), false, "a synced passkey without a server backup isn't a backup");

  const phrase = await d.wallet.revealPhrase();
  assert.equal(phrase.split(" ").length, 12);
  assert.equal(await d.wallet.vaultStatus(), "locked");
  assert.equal((await d.wallet.markPhraseSaved()).backedUp, true);

  // The phrase restores the same EVM account in any BIP-39 wallet (here: a plain ClipVault).
  const other = new ClipVault({ storage: new MemoryStorage(), clock, argon2: testArgon2.params, argon2id: testArgon2.fn });
  await other.importPhrase(phrase, "test-password-123");
  assert.equal((await other.deriveAccount("evm", 0)).address.toLowerCase(), created.accounts.evm.toLowerCase());
  await other.lock();
});

test("synced passkey + server backup + the user's confirmation counts as backed up", async () => {
  const d = device(new FakeAuthenticator(), new FakeApi());
  await d.wallet.create();
  assert.equal(await d.wallet.confirmSynced(), true);
});

test("add another passkey: its own server backup; that passkey alone restores the wallet on a new device", async () => {
  const phone = new FakeAuthenticator();
  const key = new FakeAuthenticator();
  const api = new FakeApi();
  const d = device(phone, api);
  const created = await d.wallet.create();

  // The second passkey lives on another authenticator (e.g. a security key): unlock with the phone, create on the key.
  const both = new FakeAuthenticator();
  both.creds.push(...phone.creds);
  const env = both.env();
  env.credentials.create = async (o) => {
    const c = await key.env().credentials.create(o);
    both.creds.push(...key.creds.filter((k) => !both.creds.includes(k)));
    return c;
  };
  const d2 = new EmbeddedWallet({ storage: d.storage, api, webauthn: env, feeReceivers: [], clock, argon2: testArgon2, hubWallet: new FakeSonic().lookup });
  const r = await d2.addPasskey();
  assert.equal(r.passkeys, 2);
  assert.equal(r.backedUp, true, "two passkeys, each with a server backup");
  assert.equal(api.backups.size, 2);
  assert.equal(await d2.vaultStatus(), "locked");
  const excluded = key.calls[0]!.options as CredentialCreationOptions;
  assert.equal(excluded.publicKey!.excludeCredentials!.length, 1, "can't re-add the same authenticator");

  const fresh = new FakeAuthenticator().sync(key);
  const restored = await device(fresh, api).wallet.signIn();
  assert.deepEqual(restored.accounts, created.accounts);
});

test("add a passkey: the creation prompt runs with the vault locked, so a slow user can't hit the auto-lock", async () => {
  const phone = new FakeAuthenticator();
  const api = new FakeApi();
  let now = NOW_MS;
  const slowClock: Clock = { now: () => now };
  const d = device(phone, api, new MemoryStorage(), { clock: slowClock });
  const created = await d.wallet.create();
  const key = new FakeAuthenticator();
  const both = new FakeAuthenticator();
  both.creds.push(...phone.creds);
  const env = both.env();
  const seen: string[] = [];
  env.credentials.create = async (o) => {
    seen.push(await d2.vaultStatus());
    now += 10 * AUTO_LOCK_MS; // the user takes ten minutes over the second prompt
    return key.env().credentials.create(o);
  };
  const d2 = new EmbeddedWallet({ storage: d.storage, api, webauthn: env, feeReceivers: [], clock: slowClock, argon2: testArgon2, hubWallet: new FakeSonic().lookup });
  const r = await d2.addPasskey();
  assert.deepEqual(seen, ["locked"], "the seed is out of memory while the browser waits");
  assert.equal(r.passkeys, 2);
  assert.equal(api.backups.size, 2);
  assert.equal(await d2.vaultStatus(), "locked");
  // The new passkey restores the wallet on its own.
  const restored = await device(new FakeAuthenticator().sync(key), api, new MemoryStorage(), { clock: slowClock }).wallet.signIn();
  assert.deepEqual(restored.accounts, created.accounts);
});

test("a wrong passkey's backup is refused and the new device stays empty", async () => {
  const api = new FakeApi();
  const alice = new FakeAuthenticator();
  await device(alice, api).wallet.create();
  const mallory = new FakeAuthenticator();
  await device(mallory, api).wallet.create();
  // Mallory's server copy is swapped for Alice's blob: decryption under Mallory's PRF must fail.
  const aliceBlob = [...api.backups.values()][0]!;
  const malloryId = [...api.backups.keys()][1]!;
  api.backups.set(malloryId, aliceBlob);
  const d = device(new FakeAuthenticator().sync(mallory), api);
  await assert.rejects(d.wallet.signIn());
  assert.equal(await d.wallet.hasWallet(), false);
});

/** Shape-valid but unreadable: the ClipVault header and random bytes. */
const junkBackup = () => toB64u(new Uint8Array([0x43, 0x4c, 0x50, 0x42, 0x01, ...crypto.getRandomValues(new Uint8Array(120))]));

test("restore tries the server's versions newest first and uses the first that opens", async () => {
  const api = new FakeApi();
  const phone = new FakeAuthenticator();
  const created = await device(phone, api).wallet.create();
  const [id] = [...api.backups.keys()];
  const good = api.backups.get(id!)![0]!;
  // Two bad appends after the good version 1.
  api.backups.set(id!, [good, junkBackup(), junkBackup()]);
  const b = device(new FakeAuthenticator().sync(phone), api);
  assert.deepEqual((await b.wallet.signIn()).accounts, created.accounts);
  assert.equal(await b.wallet.vaultStatus(), "locked");

  // None opens: refused with the vault's own error, and the device stays empty.
  api.backups.set(id!, [junkBackup(), junkBackup()]);
  const c = device(new FakeAuthenticator().sync(phone), api);
  await assert.rejects(c.wallet.signIn(), { code: "vault/backup-mismatch" });
  assert.equal(await c.wallet.hasWallet(), false);
});

test("a backup goes up only once it reads back; a failed upload is retried from manage", async () => {
  const api = new FakeApi();
  const phone = new FakeAuthenticator();
  const d = device(phone, api);

  // The vault returns a backup that doesn't decrypt: nothing is uploaded, the wallet still works.
  const original = ClipVault.prototype.createPasskeyBackup;
  ClipVault.prototype.createPasskeyBackup = async function (password, prf) {
    const blob = await original.call(this, password, prf);
    blob[blob.length - 1]! ^= 1;
    return blob;
  };
  let created;
  try {
    created = await d.wallet.create();
  } finally {
    ClipVault.prototype.createPasskeyBackup = original;
  }
  assert.equal(created.serverBackup, false);
  assert.deepEqual(api.registered, [], "an unreadable backup never left the page");
  assert.equal(await d.wallet.serverBackupPending(), true);
  const pending = JSON.parse((await d.storage.get(PENDING_KEY))!) as { id: string }[];
  assert.equal(pending.length, 1);
  assert.equal(JSON.stringify(pending).includes("prf"), false, "only the public registration is kept");

  // Retry while the service is down: refused, still pending, locked.
  api.failRegister = true;
  await assert.rejects(d.wallet.retryServerBackup());
  assert.equal(await d.wallet.serverBackupPending(), true);
  assert.equal(await d.wallet.vaultStatus(), "locked");

  // Retry: one prompt, limited to the pending passkey, on a server "register" challenge; a late registration.
  api.failRegister = false;
  const prompts = phone.calls.length;
  const r = await d.wallet.retryServerBackup();
  assert.equal(phone.calls.length, prompts + 1);
  const get = phone.calls.at(-1)!.options as CredentialRequestOptions;
  assert.equal(get.publicKey!.allowCredentials!.length, 1);
  assert.deepEqual(api.late, [pending[0]!.id]);
  assert.equal(api.purposes.at(-1), "register");
  assert.equal(await d.wallet.serverBackupPending(), false);
  assert.deepEqual((await readStatus(d.storage)).backedUpCredentials, [pending[0]!.id]);
  assert.equal(r.passkeys, 1);
  assert.equal(await d.wallet.vaultStatus(), "locked");
  // And it restores on a new device.
  assert.deepEqual((await device(new FakeAuthenticator().sync(phone), api).wallet.signIn()).accounts, created.accounts);

  // Already on the server (the first upload landed, its answer didn't): counts as done.
  const e = device(new FakeAuthenticator(), new FakeApi());
  await e.wallet.create();
  const [reg] = (e.wallet as unknown as { deps: { api: FakeApi } }).deps.api.registered;
  await e.storage.set(PENDING_KEY, JSON.stringify([reg]));
  assert.equal(await e.wallet.serverBackupPending(), true);
  await e.wallet.retryServerBackup();
  assert.equal(await e.wallet.serverBackupPending(), false);

  // A pending entry that isn't one of this wallet's passkeys (edited storage) prompts for nothing.
  const f = device(new FakeAuthenticator(), new FakeApi());
  await f.wallet.create();
  await f.storage.set(PENDING_KEY, JSON.stringify([{ ...(reg as object), id: "A".repeat(43), rawId: "A".repeat(43) }]));
  await assert.rejects(f.wallet.retryServerBackup(), { name: "WalletError", message: /isn't part of this wallet/ });
});

test("saved addresses that don't match the keys stop signing, and the vault is locked afterwards", async () => {
  const d = device(new FakeAuthenticator(), new FakeApi());
  const created = await d.wallet.create();
  const prepared = await d.wallet.prepareSign(sendRequest(created.accounts.evm));
  await d.storage.set("exclip-wallet/accounts/v1", JSON.stringify({ ...created.accounts, evm: "0x000000000000000000000000000000000000dEaD" }));
  await assert.rejects(d.wallet.sign(prepared), { name: "WalletError", message: /don't match/ });
  assert.equal(await d.wallet.vaultStatus(), "locked");
  assert.ok(await d.storage.get(PASSWORD_BOX_KEY), "the sealed password box exists");
  assert.ok(await d.storage.get(STATUS_KEY));
});

test("every saved address is checked against the keys at unlock", async () => {
  const d = device(new FakeAuthenticator(), new FakeApi());
  const created = await d.wallet.create();
  const good = JSON.stringify(created.accounts);
  // Case-only changes to hex addresses are the same address.
  await d.storage.set(ACCOUNTS_KEY, JSON.stringify({ ...created.accounts, evm: created.accounts.evm.toLowerCase(), sui: created.accounts.sui.toUpperCase().replace("0X", "0x") }));
  assert.deepEqual(await d.wallet.verifyAddresses(), created.accounts);
  const other = { evm: "0x000000000000000000000000000000000000dEaD", solana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", sui: "0x" + "ab".repeat(32), stellar: "G" + "B".repeat(55) };
  for (const key of ["evm", "solana", "sui", "stellar"] as const) {
    await d.storage.set(ACCOUNTS_KEY, JSON.stringify({ ...created.accounts, [key]: other[key] }));
    await assert.rejects(d.wallet.verifyAddresses(), { name: "WalletError", code: "WRONG_ACCOUNT" }, key);
    assert.equal(await d.wallet.vaultStatus(), "locked");
  }
  await d.storage.set(ACCOUNTS_KEY, good);
});

test("sign re-checks the request with the keys' own addresses and signs only the reviewed transactions", async () => {
  const d = device(new FakeAuthenticator(), new FakeApi());
  const created = await d.wallet.create();
  // A request changed in memory after the review (here: the nonce) is refused inside the unlocked step.
  const prepared = await d.wallet.prepareSign(sendRequest(created.accounts.evm));
  const tampered = { ...prepared, request: { ...prepared.request, txs: [{ ...prepared.request.txs[0]!, nonce: "4" }] } };
  await assert.rejects(d.wallet.sign(tampered), (e: unknown) => e instanceof PolicyError && e.detail === "re-check differs");
  assert.equal(await d.wallet.vaultStatus(), "locked");
  // A request the policy no longer accepts (here: from another account) is refused by the re-check itself.
  const foreign = { ...prepared, request: { ...prepared.request, from: "0x000000000000000000000000000000000000dEaD" } };
  await assert.rejects(d.wallet.sign(foreign), (e: unknown) => e instanceof PolicyError && e.code === "WRONG_ACCOUNT");
  // The untouched one signs.
  const signed = await d.wallet.sign(prepared);
  assert.equal(signed.signed.length, 1);
});

test("the SODAX hub wallet: the popup's own lookup, pinned only once a payload that agreed with it was signed, shown in the review", async () => {
  const api = new FakeApi();
  const sonic = new FakeSonic();
  const d = device(new FakeAuthenticator(), api, new MemoryStorage(), { hubWallet: sonic.lookup });
  const { accounts } = await d.wallet.create();
  const spec = { src: "0x2105.base", dst: "ethereum", input: USDC_BASE, output: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", amount: 1_000_000n, min: 990_000n, approvals: [1_000_000n], own: accounts };
  const swap = swapRequest(spec); // deposits to HUB
  const registered = api.registered.length;

  // The popup's lookup and ExClip's payload disagree: refused and NOT pinned.
  await assert.rejects(d.wallet.prepareSign(swap), PolicyError);
  assert.deepEqual((await readStatus(d.storage)).hubWallets, {});

  sonic.hub = HUB;
  const ok = await d.wallet.prepareSign(swap);
  assert.equal(ok.review.kind, "swap");
  assert.deepEqual(ok.hubPin, { chainKey: "0x2105.base", address: HUB.toLowerCase() });
  // The user sees the account the deposit and the intent go through.
  assert.deepEqual(ok.review.lines.find((l) => l.label === "Your SODAX account on Sonic"), { label: "Your SODAX account on Sonic", value: getAddress(HUB), mono: true });
  // The lookup was asked for this network and this wallet's address, and nothing went to the wallet API.
  assert.deepEqual(sonic.asked.at(-1), ["0x2105.base", accounts.evm]);
  assert.equal(api.registered.length, registered);
  // A review the user walks away from pins nothing; signing it does.
  assert.deepEqual((await readStatus(d.storage)).hubWallets, {});
  await d.wallet.sign(ok);
  assert.equal((await readStatus(d.storage)).hubWallets["0x2105.base"], HUB.toLowerCase());

  sonic.hub = "0x6666666666666666666666666666666666666666";
  await assert.rejects(d.wallet.prepareSign(swap), (e: unknown) => e instanceof PolicyError && e.detail === "hub wallet changed");
  // Offline: the pinned value is used (nothing new to pin). Never pinned and offline: no swap.
  sonic.offline = true;
  const offline = await d.wallet.prepareSign(swap);
  assert.equal(offline.review.kind, "swap");
  assert.equal(offline.hubPin, undefined);
  const fresh = device(new FakeAuthenticator(), api, new MemoryStorage(), { hubWallet: sonic.lookup });
  await fresh.storage.set(ACCOUNTS_KEY, JSON.stringify({ ...OWN, stellar: "G" + "A".repeat(55) }));
  await assert.rejects(fresh.wallet.prepareSign(swap), { name: "WalletError", code: "SERVICE" });
});

test("as shipped (no fee receivers): a fee-free swap is quoted on its whole input, reviewed, and signed exactly as built; a fee is refused", async () => {
  const WETH_SONIC = "0x50c42dEAcD8Fc9773493ED674b675bE577f2634b";
  const asked: SwapFacts[] = [];
  const sonic = new FakeSonic();
  sonic.hub = HUB;
  // As shipped: an empty fee allowlist (device()'s default), the popup's own SODAX quote, the hub lookup.
  const d = device(new FakeAuthenticator(), new FakeApi(), new MemoryStorage(), {
    hubWallet: sonic.lookup, quote: async (f) => { asked.push(f); return 400n * 10n ** 15n; },
  });
  const { accounts } = await d.wallet.create();
  // 1,000 USDC (Base) → WETH (Sonic) with no fee data: what the SODAX SDK builds when the app sets no partner fee.
  const spec = { src: "0x2105.base", dst: "sonic", input: USDC_BASE, output: WETH_SONIC, amount: 1_000_000_000n, min: 396n * 10n ** 15n, approvals: [1_000_000_000n], own: accounts };
  const request = swapRequest(spec);
  const prepared = await d.wallet.prepareSign(request);
  assert.equal(prepared.priceAlarm, undefined);
  assert.equal(asked.at(-1)!.net, 1_000_000_000n, "nothing comes off the input, so the popup quotes all of it");
  assert.equal(prepared.review.swap!.net, prepared.review.swap!.gross);
  assert.doesNotMatch(prepared.review.lines.map((l) => `${l.label}: ${l.value}`).join("\n"), new RegExp(`${OPERATOR_NAME} fee|Fee receiver`));

  const { signed, hashes } = await d.wallet.sign(prepared);
  assert.equal(signed.length, 2, "the exact approval, then the deposit");
  assert.equal(hashes.length, 2);
  for (const [i, raw] of signed.entries()) {
    assert.equal(parseTransaction(raw).data?.toLowerCase(), request.txs[i]!.data.toLowerCase(), "signed as built");
    const signer = await recoverTransactionAddress({ serializedTransaction: raw as never });
    assert.equal(signer.toLowerCase(), accounts.evm.toLowerCase());
  }
  // Any fee needs a receiver on the allowlist and the repository ships none: even 0.3% is refused at the review.
  await assert.rejects(d.wallet.prepareSign(swapRequest({ ...spec, feeBps: 30n })), (e: unknown) => e instanceof PolicyError && /receiver/.test(e.detail));
});

test("tokenised stocks: refused unless the build switched them on; then reviewed with the badge and the disclaimer, and signed exactly as built", async () => {
  const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const [STOCK] = SODAX_STOCK_TOKENS["hedera"]![0]!;
  const auth = new FakeAuthenticator();
  const api = new FakeApi();
  const sonic = new FakeSonic();
  sonic.hub = HUB;
  const off = device(auth, api, new MemoryStorage(), { hubWallet: sonic.lookup });
  const { accounts } = await off.wallet.create();
  // 10 USDC (Ethereum) for at least 0.05 of a tokenised stock (Hedera).
  const request = swapRequest({ src: "ethereum", dst: "hedera", input: USDC_ETH, output: STOCK, amount: 10_000_000n, min: 5_000_000n, approvals: [10_000_000n], own: accounts });
  await assert.rejects(off.wallet.prepareSign(request), (e: unknown) => e instanceof PolicyError && e.detail === "token not listed");

  // The same passkey and storage, in a build with stocks on.
  const on = device(auth, api, off.storage, { hubWallet: sonic.lookup, stocks: true }).wallet;
  const prepared = await on.prepareSign(request);
  assert.equal(prepared.review.lines.find((l) => l.label === "You receive (at least)")!.badge, STOCK_BADGE);
  assert.equal(prepared.review.disclaimer, stocksDisclaimer(OPERATOR_NAME));
  assert.ok(prepared.review.warnings.includes(PRICE_UNCHECKED_WARNING), "no quote here, and no band for a stock");
  const { signed } = await on.sign(prepared);
  assert.equal(signed.length, 2, "the exact approval, then the deposit");
  for (const [i, raw] of signed.entries()) assert.equal(parseTransaction(raw).data?.toLowerCase(), request.txs[i]!.data.toLowerCase(), "signed as built");
});

test("status record MAC: an edit made outside the wallet is reset at the next unlock, and that signature is refused", async () => {
  const d = device(new FakeAuthenticator(), new FakeApi());
  const { accounts } = await d.wallet.create();
  assert.match((await d.storage.get(STATUS_KEY))!, /"mac":"[A-Za-z0-9_-]{43}"/, "written with its MAC");
  assert.ok(await d.storage.get(STATUS_MAC_BOX_KEY), "the MAC key is sealed under the seed");
  await d.wallet.sign(await d.wallet.prepareSign(sendRequest(accounts.evm))); // FRIEND is now a known recipient

  // Someone with write access to the origin's storage marks the phrase saved, so the review drops its backup warning.
  const forged = { ...JSON.parse((await d.storage.get(STATUS_KEY))!), phraseSaved: true };
  await d.storage.set(STATUS_KEY, JSON.stringify(forged));
  const prepared = await d.wallet.prepareSign(sendRequest(accounts.evm));
  assert.deepEqual(prepared.review.warnings, [], "the review before unlocking reads the record as stored");
  // The unlock to sign finds the forgery: nothing signed, the record back to the safe defaults, locked.
  await assert.rejects(d.wallet.sign(prepared), (e: unknown) => e instanceof PolicyError && e.message === STATUS_RESET_MESSAGE);
  assert.equal(await d.wallet.vaultStatus(), "locked");
  const reset = await readStatus(d.storage);
  assert.equal(reset.phraseSaved, false);
  assert.deepEqual(reset.recipients, [], "the genuine facts go too: nothing in a failed record is trusted");
  // The next review is built on the clean record (first-time recipient, not backed up), and signs.
  const again = await d.wallet.prepareSign(sendRequest(accounts.evm));
  assert.match(again.review.warnings.join(" "), /haven't sent/);
  assert.ok(again.review.warnings.includes(NOT_BACKED_UP_WARNING));
  assert.equal((await d.wallet.sign(again)).signed.length, 1);

  // Other ways around it, each caught at the next unlock: a record with no MAC, a MAC from another key, the key box
  // removed (a new key no longer verifies the record), the key box replaced.
  const other = device(new FakeAuthenticator(), new FakeApi());
  await other.wallet.create();
  const forgeries: [string, () => Promise<void>][] = [
    ["no MAC", async () => { const { mac: _, ...bare } = JSON.parse((await d.storage.get(STATUS_KEY))!); await d.storage.set(STATUS_KEY, JSON.stringify(bare)); }],
    ["another wallet's record", async () => d.storage.set(STATUS_KEY, (await other.storage.get(STATUS_KEY))!)],
    ["key box removed", async () => d.storage.remove(STATUS_MAC_BOX_KEY)],
    ["another wallet's key box", async () => d.storage.set(STATUS_MAC_BOX_KEY, (await other.storage.get(STATUS_MAC_BOX_KEY))!)],
    ["key box not JSON", async () => d.storage.set(STATUS_MAC_BOX_KEY, "{")],
  ];
  for (const [name, forge] of forgeries) {
    await d.wallet.revealPhrase();
    await d.wallet.markPhraseSaved();
    assert.equal((await readStatus(d.storage)).phraseSaved, true, name);
    await forge();
    await d.wallet.verifyAddresses();
    assert.equal((await readStatus(d.storage)).phraseSaved, false, name);
  }
  // An untouched record survives unlocks.
  await d.wallet.revealPhrase();
  await d.wallet.markPhraseSaved();
  await d.wallet.verifyAddresses();
  assert.equal((await readStatus(d.storage)).phraseSaved, true);
});

test("status record MAC: no write before an unlock in this page", async () => {
  const d = device(new FakeAuthenticator(), new FakeApi());
  await d.wallet.create();
  // A new page on the same storage: the key is sealed, so it can't sign a record until its own unlock.
  const page = device(new FakeAuthenticator(), new FakeApi(), d.storage).wallet;
  await assert.rejects(page.confirmSynced(), { name: "WalletError", message: "Unlock the wallet with your passkey first." });
  assert.equal((await readStatus(d.storage)).syncConfirmed, false);
});

test("price check: the popup's own quote raises a red alarm; no quote falls back to the band table", async () => {
  const WETH_SONIC = "0x50c42dEAcD8Fc9773493ED674b675bE577f2634b";
  const SODA_SONIC = "0x7c7d53EEcda37a87ce0D5bf8E0b24512A48dC963";
  const USDC_SONIC = "0x29219dd400f2Bf60E5a23d13Be72B486D4038894";
  const asked: SwapFacts[] = [];
  let answer: bigint | null | Error = null;
  const api = new FakeApi();
  const sonic = new FakeSonic();
  sonic.hub = HUB;
  const { wallet, storage } = device(new FakeAuthenticator(), api, new MemoryStorage(), {
    feeReceivers: [FEE_RECEIVER],
    hubWallet: sonic.lookup,
    quote: async (f) => { asked.push(f); if (answer instanceof Error) throw answer; return answer; },
  });
  await storage.set(ACCOUNTS_KEY, JSON.stringify({ ...OWN, stellar: "G" + "A".repeat(55) }));
  // 1,000 USDC (Base) → WETH (Sonic), a 1% fee.
  const spec = (min: bigint) => ({ src: "0x2105.base", dst: "sonic", input: USDC_BASE, output: WETH_SONIC, amount: 1_000_000_000n, min, approvals: [1_000_000_000n], feeBps: 100n });
  const fair = 396n * 10n ** 15n; // 0.396 WETH

  // A fair minimum against the quote: no alarm, and the popup quoted the net amount of the decoded trade.
  answer = 400n * 10n ** 15n;
  const ok = await wallet.prepareSign(swapRequest(spec(fair)));
  assert.equal(ok.priceAlarm, undefined);
  assert.deepEqual(ok.review.warnings, [NOT_BACKED_UP_WARNING]);
  assert.equal(asked.at(-1)!.net, 990_000_000n);
  assert.equal(asked.at(-1)!.output.symbol, "WETH");

  // 20% under the popup's own quote: the alarm, also first among the review's warnings.
  const low = await wallet.prepareSign(swapRequest(spec(320n * 10n ** 15n)));
  assert.match(low.priceAlarm!, /This price looks wrong\. You'd receive at least 0\.32 WETH, but SODAX quotes about 0\.4 WETH right now: 20% less/);
  assert.equal(low.review.warnings[0], low.priceAlarm);

  // No quote (offline, blocked, error): the band table still catches a minimum that is off by orders of magnitude…
  for (const a of [null, new Error("Failed to fetch")]) {
    answer = a;
    const dust = await wallet.prepareSign(swapRequest(spec(1n)));
    assert.match(dust.priceAlarm!, /This price looks wrong\. 0\.000000000000000001 WETH is far less than 1000 USDC is worth/);
    assert.equal((await wallet.prepareSign(swapRequest(spec(fair)))).priceAlarm, undefined);
  }
  // …and says so plainly when it has no band for a token.
  const soda = await wallet.prepareSign(swapRequest({ ...spec(1n), output: SODA_SONIC }));
  assert.equal(soda.priceAlarm, undefined);
  assert.ok(soda.review.warnings.includes(PRICE_UNCHECKED_WARNING));

  // Stable pairs are the policy's (97% floor): no quote is fetched for them. Sends never ask either.
  const before = asked.length;
  answer = 1n;
  const stable = await wallet.prepareSign(swapRequest({ ...spec(985_000_000n), output: USDC_SONIC }));
  assert.equal(stable.priceAlarm, undefined);
  await wallet.prepareSign(sendRequest(OWN.evm));
  assert.equal(asked.length, before);
});

test("isBackedUp rules", () => {
  const s = { v: 1 as const, phraseSaved: false, recipients: [], hubWallets: {}, passwordCredential: null, backedUpCredentials: [] as string[], syncConfirmed: false };
  assert.equal(isBackedUp(s, 1), false);
  assert.equal(isBackedUp({ ...s, phraseSaved: true }, 1), true);
  assert.equal(isBackedUp({ ...s, syncConfirmed: true }, 1), false);
  assert.equal(isBackedUp({ ...s, syncConfirmed: true, backedUpCredentials: ["a".repeat(22)] }, 1), true);
  assert.equal(isBackedUp({ ...s, backedUpCredentials: ["a".repeat(22), "b".repeat(22)] }, 2), true);
});
