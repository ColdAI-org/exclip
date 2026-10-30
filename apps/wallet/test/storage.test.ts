import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage, type VaultStorage } from "@clip-wallet/vault";
import { IdbStorage, STATUS_KEY, STATUS_LOCK, attestStatus, defaultLocks, readStatus, statusMac, updateStatus, writeStatus, type LockManagerLike, type WalletStatusRecord } from "../src/storage.ts";
import { fakeIndexedDb } from "./fakes.ts";

test("IdbStorage: set, get, overwrite, remove; one database connection", async () => {
  const idb = fakeIndexedDb();
  const s = new IdbStorage(idb);
  assert.equal(await s.get("k"), undefined);
  await s.set("k", "one");
  assert.equal(await s.get("k"), "one");
  await s.set("k", "two");
  assert.equal(await s.get("k"), "two");
  await s.remove("k");
  assert.equal(await s.get("k"), undefined);
  assert.equal(idb.opens, 1);
  // Survives a "reload": a new IdbStorage on the same database sees the data.
  await s.set("vault", "ciphertext");
  assert.equal(await new IdbStorage(idb).get("vault"), "ciphertext");
  await assert.rejects(s.set("k", 1 as unknown as string), TypeError);
});

test("status record: defaults, merge, and anything malformed is dropped", async () => {
  const s = new MemoryStorage();
  const fresh = await readStatus(s);
  assert.deepEqual(fresh, { v: 1, phraseSaved: false, recipients: [], hubWallets: {}, passwordCredential: null, backedUpCredentials: [], syncConfirmed: false });

  await writeStatus(s, { phraseSaved: true });
  await writeStatus(s, { recipients: Array.from({ length: 25 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`) });
  const merged = await readStatus(s);
  assert.equal(merged.phraseSaved, true);
  assert.equal(merged.recipients.length, 20);

  await s.set(STATUS_KEY, JSON.stringify({
    phraseSaved: "yes",
    syncConfirmed: 1,
    recipients: ["0xABCDEF0000000000000000000000000000000000", "nope", 5, "0x" + "a".repeat(40)],
    hubWallets: { "0x2105.base": "0x" + "b".repeat(40), "BAD KEY": "0x" + "c".repeat(40), sonic: "0x123" },
    passwordCredential: "short",
    backedUpCredentials: ["A".repeat(22), "has space in it here", 3],
    extra: "ignored",
  }));
  assert.deepEqual(await readStatus(s), {
    v: 1, phraseSaved: false, syncConfirmed: false,
    recipients: ["0x" + "a".repeat(40)],
    hubWallets: { "0x2105.base": "0x" + "b".repeat(40) },
    passwordCredential: null,
    backedUpCredentials: ["A".repeat(22)],
  });

  await s.set(STATUS_KEY, "{not json");
  assert.equal((await readStatus(s)).phraseSaved, false);
});

/** Storage whose reads and writes each take a turn of the event loop, like IndexedDB, so writers interleave. */
class SlowStorage implements VaultStorage {
  private readonly inner = new MemoryStorage();
  private readonly turn = () => new Promise((r) => setTimeout(r, 0));
  async get(key: string) {
    await this.turn();
    return this.inner.get(key);
  }
  async set(key: string, value: string) {
    await this.turn();
    await this.inner.set(key, value);
  }
  async remove(key: string) {
    await this.inner.remove(key);
  }
}
const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;

test("status updates are one writer at a time (navigator.locks), so two popups can't lose each other's", async () => {
  // Without a lock, read-modify-write by ten popups at once keeps only some of their updates.
  const racy = new SlowStorage();
  const none: LockManagerLike = { request: (_name, cb) => cb() };
  await Promise.all(Array.from({ length: 10 }, (_, i) => updateStatus(racy, (s) => ({ recipients: [addr(i), ...s.recipients] }), none)));
  assert.ok((await readStatus(racy)).recipients.length < 10, "the race is real");

  // Under the lock every update lands, mixed fields too.
  const names: string[] = [];
  const recording: LockManagerLike = { request: (name, cb) => (names.push(name), defaultLocks().request(name, cb)) };
  const s = new SlowStorage();
  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => updateStatus(s, (c) => ({ recipients: [addr(i), ...c.recipients] }), recording)),
    updateStatus(s, (c) => ({ hubWallets: { ...c.hubWallets, sonic: addr(99) } }), recording),
    updateStatus(s, (c) => ({ hubWallets: { ...c.hubWallets, ethereum: addr(98) } }), recording),
    writeStatus(s, { phraseSaved: true }, recording),
  ]);
  const after = await readStatus(s);
  assert.equal(after.recipients.length, 10);
  assert.deepEqual(new Set(after.recipients), new Set(Array.from({ length: 10 }, (_, i) => addr(i))));
  assert.deepEqual(after.hubWallets, { sonic: addr(99), ethereum: addr(98) });
  assert.equal(after.phraseSaved, true);
  assert.deepEqual(new Set(names), new Set([STATUS_LOCK]));

  // A writer that throws releases the lock for the next one.
  await assert.rejects(updateStatus(s, () => { throw new Error("boom"); }));
  assert.equal((await writeStatus(s, { syncConfirmed: true })).syncConfirmed, true);
});

test("the status MAC covers every field, and a keyed write never builds on a record that fails it", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const base: WalletStatusRecord = { v: 1, phraseSaved: false, recipients: [addr(1)], hubWallets: { sonic: addr(2), "0x2105.base": addr(3) }, passwordCredential: "A".repeat(22), backedUpCredentials: ["B".repeat(22)], syncConfirmed: false };
  const mac = statusMac(key, base);
  assert.match(mac, /^[A-Za-z0-9_-]{43}$/);
  // Hub pins in any order are the same record; any changed field, or another key, is not.
  assert.equal(statusMac(key, { ...base, hubWallets: { "0x2105.base": addr(3), sonic: addr(2) } }), mac);
  const changed: Partial<WalletStatusRecord>[] = [
    { phraseSaved: true }, { syncConfirmed: true }, { recipients: [] }, { recipients: [addr(1), addr(4)] },
    { hubWallets: { sonic: addr(2) } }, { hubWallets: { sonic: addr(3), "0x2105.base": addr(2) } },
    { passwordCredential: null }, { backedUpCredentials: [] },
  ];
  for (const c of changed) assert.notEqual(statusMac(key, { ...base, ...c }), mac, JSON.stringify(c));
  assert.notEqual(statusMac(crypto.getRandomValues(new Uint8Array(32)), base), mac);

  // A keyed write stores the MAC; an edit behind its back is not carried into the next keyed write.
  const s = new MemoryStorage();
  await writeStatus(s, { recipients: [addr(1)] }, undefined, key);
  const stored = JSON.parse((await s.get(STATUS_KEY))!);
  assert.equal(stored.mac, statusMac(key, await readStatus(s)));
  await s.set(STATUS_KEY, JSON.stringify({ ...stored, phraseSaved: true }));
  const next = await writeStatus(s, { syncConfirmed: true }, undefined, key);
  assert.deepEqual(next, { v: 1, phraseSaved: false, recipients: [], hubWallets: {}, passwordCredential: null, backedUpCredentials: [], syncConfirmed: true });
});

test("attestStatus checks the record under the status lock; one that fails is reset and reported", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const names: string[] = [];
  const recording: LockManagerLike = { request: (name, cb) => (names.push(name), defaultLocks().request(name, cb)) };
  const s = new MemoryStorage();
  // No record yet: nothing to reset.
  assert.deepEqual(await attestStatus(s, async () => key, recording), { key, reset: false });
  assert.equal(await s.get(STATUS_KEY), undefined);
  // A genuine record verifies and is left as it is.
  await writeStatus(s, { phraseSaved: true, recipients: [addr(1)] }, undefined, key);
  const genuine = await s.get(STATUS_KEY);
  assert.equal((await attestStatus(s, async () => key, recording)).reset, false);
  assert.equal(await s.get(STATUS_KEY), genuine);
  // Edited, unkeyed (written without the key, by an older build or by someone else), not JSON, or under another
  // key: reset.
  const forgeries = [
    JSON.stringify({ ...JSON.parse(genuine!), recipients: [addr(9)] }),
    JSON.stringify({ v: 1, phraseSaved: true }),
    "{not json",
  ];
  for (const raw of forgeries) {
    await s.set(STATUS_KEY, raw);
    assert.equal((await attestStatus(s, async () => key, recording)).reset, true, raw);
    assert.deepEqual(await readStatus(s), { v: 1, phraseSaved: false, recipients: [], hubWallets: {}, passwordCredential: null, backedUpCredentials: [], syncConfirmed: false });
    assert.equal((await attestStatus(s, async () => key, recording)).reset, false, "the reset record carries a valid MAC");
  }
  await s.set(STATUS_KEY, genuine!);
  assert.equal((await attestStatus(s, async () => crypto.getRandomValues(new Uint8Array(32)), recording)).reset, true);
  assert.deepEqual(new Set(names), new Set([STATUS_LOCK]));
});
