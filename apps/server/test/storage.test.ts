/** Where state lives: the storage plan (production refuses memory unless allowed), and the Postgres, Redis and memory
 * stores against recording fakes and an injected clock, so their statements and transactions are checked without a
 * database. migrations.test.ts checks the same statements against the schema. */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, type Env, type ExclipConfigInput } from "@exclip/config";
import { openStorage, planStorage } from "../src/storage.ts";
import { createMemoryKv, createPostgresKv, createRedisKv, KV_SQL, type RedisLike } from "../src/kv.ts";
import { createPostgresWalletStore, WALLET_SQL } from "../src/services/walletBackup.ts";
import type { SqlPool, SqlResult } from "../src/db.ts";

const DB = { DATABASE_URL: "postgres://exclip:db-secret-pw@db.internal:5432/exclip" };
const REDIS = { REDIS_URL: "redis://:redis-secret-pw@cache.internal:6379" };

function plan(input: ExclipConfigInput = {}, env: Env = {}, dev = false) {
  const { config, secrets } = resolveConfig(input, env);
  return planStorage(config, secrets, dev);
}

// ---- the plan ----------------------------------------------------------------------------------------------

test("storage plan: KV in Redis, else Postgres, else memory; the wallet store in Postgres, else memory", () => {
  assert.deepEqual(plan({}, {}, true), { kv: "memory", wallet: "memory", refusal: null });
  assert.deepEqual(plan({}, DB), { kv: "postgres", wallet: "postgres", refusal: null });
  assert.deepEqual(plan({}, { ...DB, ...REDIS }), { kv: "redis", wallet: "postgres", refusal: null });
  // The config file's URLs count the same as the environment's.
  assert.deepEqual(plan({ server: { databaseUrl: DB.DATABASE_URL, redisUrl: REDIS.REDIS_URL } }), { kv: "redis", wallet: "postgres", refusal: null });
});

test("production refuses memory storage unless server.allowMemoryStore is set", () => {
  const bare = plan();
  assert.equal(bare.kv, "memory");
  assert.match(bare.refusal ?? "", /rate limits and passkey challenges and passkey wallet backups would be kept/);
  assert.match(bare.refusal ?? "", /DATABASE_URL/);
  assert.match(bare.refusal ?? "", /allowMemoryStore/);
  // Redis keeps the KV shared, but the wallet's backups would still be in this process.
  const redisOnly = plan({}, REDIS);
  assert.equal(redisOnly.kv, "redis");
  assert.match(redisOnly.refusal ?? "", /but passkey wallet backups would be kept/);
  assert.ok(!(redisOnly.refusal ?? "").includes("redis-secret-pw"), "no credential in the message");
  // With the wallet off, memory KV is still refused: rate limits must hold across processes.
  assert.match(plan({ features: { embeddedWallet: false } }).refusal ?? "", /but rate limits and passkey challenges would be kept/);
  assert.equal(plan({ features: { embeddedWallet: false } }, REDIS).refusal, null);
  // Opted in, or in development: allowed.
  assert.equal(plan({ server: { allowMemoryStore: true } }).refusal, null);
  assert.equal(plan({}, {}, true).refusal, null);
});

test("openStorage: memory stores when planned, without loading a driver", async () => {
  const { secrets } = resolveConfig({});
  const storage = await openStorage({ kv: "memory", wallet: "memory", refusal: null }, secrets);
  await storage.kv.set("k", "v", 60);
  assert.equal(await storage.kv.get("k"), "v");
  assert.equal(await storage.walletStore.getCredential("A".repeat(43)), null);
  await storage.close();
});

// ---- Postgres, against a recording fake ----------------------------------------------------------------------

const rows = (...r: Array<Record<string, unknown>>): SqlResult => ({ rows: r, rowCount: r.length });
const NAMES = new Map<string, string>([...Object.entries(WALLET_SQL), ...Object.entries(KV_SQL)].map(([name, sql]) => [sql, name]));

type Logged = { on: "pool" | "client"; sql: string; values: unknown[] };

/** A pg Pool stand-in: logs each statement by its WALLET_SQL / KV_SQL name and answers through `answer`. */
function fakePool(answer: (name: string, values: unknown[]) => SqlResult | Error = () => rows()) {
  const log: Logged[] = [];
  const released: boolean[] = [];
  const run = (on: Logged["on"]) => async (text: string, values: unknown[] = []) => {
    const name = NAMES.get(text) ?? text;
    log.push({ on, sql: name, values });
    const result = answer(name, values);
    if (result instanceof Error) throw result;
    return result;
  };
  const pool: SqlPool = {
    query: run("pool"),
    async connect() {
      return { query: run("client"), release: (destroy?: boolean) => { released.push(destroy === true); } };
    },
  };
  return { pool, log, released, names: () => log.map((entry) => entry.sql) };
}

const CRED = { credentialId: "c".repeat(43), publicKey: new Uint8Array([1, 2, 3]), rpId: "wallet.example.com", signCount: 0, transports: ["internal"] };
const AT = new Date("2026-10-16T12:00:00Z");

test("Postgres wallet store: a new credential and its backup v1 in one transaction; a known id is 'exists'", async () => {
  const fresh = fakePool((name) => (name === "insertCredential" ? rows({ credential_id: CRED.credentialId }) : rows()));
  assert.equal(await createPostgresWalletStore(fresh.pool).createCredential(CRED, new Uint8Array([9]), AT), "created");
  assert.deepEqual(fresh.names(), ["BEGIN", "insertCredential", "insertBackup", "COMMIT"]);
  assert.ok(fresh.log.every((entry) => entry.on === "client"), "all on the transaction's connection");
  assert.deepEqual(fresh.log[1]!.values, [CRED.credentialId, Buffer.from([1, 2, 3]), CRED.rpId, 0, ["internal"], AT]);
  assert.deepEqual(fresh.log[2]!.values, [CRED.credentialId, 1, Buffer.from([9]), AT]);
  assert.deepEqual(fresh.released, [false]);

  const known = fakePool((name) => (name === "insertBackup" ? new Error("must not run") : rows()));
  assert.equal(await createPostgresWalletStore(known.pool).createCredential(CRED, new Uint8Array([9]), AT), "exists");
  assert.deepEqual(known.names(), ["BEGIN", "insertCredential", "COMMIT"]);
  assert.match(WALLET_SQL.insertCredential, /ON CONFLICT \(credential_id\) DO NOTHING/);
});

test("Postgres wallet store: an append locks the credential row, counts, and inserts the next version; at the cap it is 'full'", async () => {
  const ok = fakePool((name) => (name === "backupStats" ? rows({ n: 2, top: 3 }) : name === "insertBackup" ? rows({ version: 4 }) : rows()));
  assert.equal(await createPostgresWalletStore(ok.pool).appendBackup(CRED.credentialId, new Uint8Array([7]), AT, 50), 4);
  assert.deepEqual(ok.names(), ["BEGIN", "lockCredential", "backupStats", "insertBackup", "COMMIT"]);
  assert.deepEqual(ok.log[3]!.values, [CRED.credentialId, 4, Buffer.from([7]), AT], "the version after the highest, not the count");
  assert.match(WALLET_SQL.lockCredential, /FOR UPDATE$/);

  const full = fakePool((name) => (name === "backupStats" ? rows({ n: 50, top: 50 }) : rows()));
  assert.equal(await createPostgresWalletStore(full.pool).appendBackup(CRED.credentialId, new Uint8Array([7]), AT, 50), "full");
  assert.deepEqual(full.names(), ["BEGIN", "lockCredential", "backupStats", "COMMIT"], "nothing inserted, nothing deleted");
});

test("Postgres wallet store: a failed statement rolls back; a connection whose ROLLBACK fails is destroyed", async () => {
  const failing = fakePool((name) => (name === "insertBackup" ? new Error("duplicate key") : rows({ n: 0, top: 0 })));
  await assert.rejects(createPostgresWalletStore(failing.pool).appendBackup(CRED.credentialId, new Uint8Array([7]), AT, 50), /duplicate key/);
  assert.deepEqual(failing.names(), ["BEGIN", "lockCredential", "backupStats", "insertBackup", "ROLLBACK"]);
  assert.deepEqual(failing.released, [false]);

  const broken = fakePool((name) => (name === "insertBackup" || name === "ROLLBACK" ? new Error(`${name} failed`) : rows({ n: 0, top: 0 })));
  await assert.rejects(createPostgresWalletStore(broken.pool).appendBackup(CRED.credentialId, new Uint8Array([7]), AT, 50), /insertBackup failed/);
  assert.deepEqual(broken.released, [true]);
});

test("Postgres wallet store: rows map back to credentials (a bigint sign count arrives as a string) and backups", async () => {
  const created = new Date("2026-10-01T00:00:00Z");
  const p = fakePool((name) => {
    if (name === "getCredential") {
      return rows({
        credential_id: CRED.credentialId, public_key: Buffer.from([1, 2, 3]), rp_id: CRED.rpId, sign_count: "7",
        transports: ["internal", "hybrid"], created_at: created, last_used_at: null, retired_at: null,
      });
    }
    if (name === "recentBackups") return rows({ version: 2, blob: Buffer.from([5]), created_at: created }, { version: 1, blob: Buffer.from([4]), created_at: created });
    return rows();
  });
  const store = createPostgresWalletStore(p.pool);
  assert.deepEqual(await store.getCredential(CRED.credentialId), {
    credentialId: CRED.credentialId, publicKey: new Uint8Array([1, 2, 3]), rpId: CRED.rpId, signCount: 7,
    transports: ["internal", "hybrid"], createdAt: created, lastUsedAt: null, retiredAt: null,
  });
  const backups = await store.recentBackups(CRED.credentialId, 50);
  assert.deepEqual(backups.map((b) => [b.version, [...b.blob]]), [[2, [5]], [1, [4]]]);
  assert.deepEqual(p.log.at(-1), { on: "pool", sql: "recentBackups", values: [CRED.credentialId, 50] });
  assert.equal(await createPostgresWalletStore(fakePool().pool).getCredential("x".repeat(43)), null);
});

test("Postgres wallet store: the sign count is compare-and-set; retire marks, purge deletes", async () => {
  const p = fakePool((name, values) => {
    if (name === "recordUse") return values[1] === 0 ? rows({ credential_id: CRED.credentialId }) : rows();
    if (name === "purgeRetired") return rows({ credential_id: "a" }, { credential_id: "b" });
    return rows();
  });
  const store = createPostgresWalletStore(p.pool);
  assert.equal(await store.recordUse(CRED.credentialId, 0, 5, AT), true);
  assert.deepEqual(p.log[0], { on: "pool", sql: "recordUse", values: [CRED.credentialId, 0, 5, AT] });
  assert.equal(await store.recordUse(CRED.credentialId, 3, 5, AT), false, "another request moved it first");
  await store.retireCredential(CRED.credentialId, AT);
  assert.deepEqual(p.log.at(-1), { on: "pool", sql: "retire", values: [CRED.credentialId, AT] });
  assert.equal(await store.purgeRetired(AT), 2);
});

test("Postgres KV: statements, expiry judged by the database clock, and the sliding window", async () => {
  const p = fakePool((name) => {
    if (name === "get") return rows({ value: "v" });
    if (name === "setNx") return rows({ key: "k" });
    if (name === "incr") return rows({ value: "3" });
    if (name === "windowCount") return rows({ n: 2 });
    return rows();
  });
  const kv = createPostgresKv(p.pool);
  assert.equal(await kv.get("k"), "v");
  assert.equal(await kv.setNx("k", "v", 10), true);
  assert.equal(await kv.incr("n", 60), 3);
  const { count, member } = await kv.slidingWindowAdd("w", 100_000, 60_000, 65);
  assert.equal(count, 2);
  assert.deepEqual(p.log.slice(-3).map((entry) => [entry.sql, entry.values]), [
    ["windowPrune", ["w", 40_000]],
    ["windowAdd", ["w", member, 100_000, 65]],
    ["windowCount", ["w", 40_000]],
  ]);
  await kv.slidingWindowRemove("w", member);
  assert.deepEqual(p.log.at(-1)!.values, ["w", member]);
  for (const sql of [KV_SQL.get, KV_SQL.setNx, KV_SQL.incr]) assert.match(sql, /now\(\)/);
  // A live key isn't taken over (no row back), and a missing one reads as null.
  assert.equal(await createPostgresKv(fakePool().pool).setNx("k", "v", 10), false);
  assert.equal(await createPostgresKv(fakePool().pool).get("k"), null);
});

test("Postgres KV: every 500th write also deletes expired rows, in the background", async () => {
  const p = fakePool();
  const kv = createPostgresKv(p.pool);
  for (let i = 0; i < 499; i++) await kv.set(`k${i}`, "v", 60);
  assert.ok(!p.names().includes("sweepValues"));
  await kv.set("k499", "v", 60);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(p.names().includes("sweepValues") && p.names().includes("sweepWindows"));
});

// ---- Redis and memory --------------------------------------------------------------------------------------

test("Redis KV: SET EX and SET NX, INCR with a TTL on the first only, the window as one MULTI on a sorted set", async () => {
  const calls: unknown[][] = [];
  let setReply: string | null = "OK";
  let incrReply = 1;
  const client: RedisLike = {
    async get(key) { calls.push(["get", key]); return null; },
    async set(key, value, ...args) { calls.push(["set", key, value, ...args]); return setReply; },
    async del(key) { calls.push(["del", key]); return 1; },
    async incr(key) { calls.push(["incr", key]); return incrReply; },
    async expire(key, seconds) { calls.push(["expire", key, seconds]); return 1; },
    async zrem(key, member) { calls.push(["zrem", key, member]); return 1; },
    multi() {
      const queued: unknown[][] = [];
      return {
        zremrangebyscore(key, min, max) { queued.push(["zremrangebyscore", key, min, max]); },
        zadd(key, score, member) { queued.push(["zadd", key, score, member]); },
        zcard(key) { queued.push(["zcard", key]); },
        expire(key, seconds) { queued.push(["expire", key, seconds]); },
        async exec() {
          calls.push(["multi", ...queued]);
          return [[null, 0], [null, 1], [null, 4], [null, 1]];
        },
      };
    },
    async quit() { calls.push(["quit"]); return "OK"; },
  };
  const kv = createRedisKv(client);
  await kv.set("a", "1", 30);
  assert.equal(await kv.setNx("b", "1", 30), true);
  setReply = null;
  assert.equal(await kv.setNx("b", "1", 30), false);
  assert.equal(await kv.incr("c", 60), 1);
  incrReply = 2;
  assert.equal(await kv.incr("c", 60), 2);
  const { count, member } = await kv.slidingWindowAdd("w", 100_000, 60_000, 65);
  assert.equal(count, 4);
  await kv.slidingWindowRemove("w", member);
  await kv.close?.();
  assert.deepEqual(calls, [
    ["set", "a", "1", "EX", 30],
    ["set", "b", "1", "EX", 30, "NX"],
    ["set", "b", "1", "EX", 30, "NX"],
    ["incr", "c"], ["expire", "c", 60],
    ["incr", "c"],
    ["multi", ["zremrangebyscore", "w", 0, 40_000], ["zadd", "w", 100_000, member], ["zcard", "w"], ["expire", "w", 65]],
    ["zrem", "w", member],
    ["quit"],
  ]);
});

test("memory KV: keys expire on the injected clock; INCR keeps its first expiry; the window slides", async () => {
  const clock = { t: 1_000_000 };
  const kv = createMemoryKv(() => clock.t);
  await kv.set("a", "1", 2);
  assert.equal(await kv.get("a"), "1");
  clock.t += 2_000;
  assert.equal(await kv.get("a"), null);

  assert.equal(await kv.setNx("b", "1", 2), true);
  assert.equal(await kv.setNx("b", "2", 2), false);
  clock.t += 2_000;
  assert.equal(await kv.setNx("b", "3", 2), true, "an expired key can be taken again");
  await kv.del("b");
  assert.equal(await kv.get("b"), null);

  assert.equal(await kv.incr("n", 10), 1);
  clock.t += 5_000;
  assert.equal(await kv.incr("n", 10), 2);
  clock.t += 5_000;
  assert.equal(await kv.incr("n", 10), 1, "expired 10 s after the first INCR, not the last");

  const add = (at: number) => kv.slidingWindowAdd("w", at, 60_000, 65);
  const t0 = clock.t;
  assert.equal((await add(t0)).count, 1);
  const second = await add(t0 + 1);
  assert.equal(second.count, 2);
  await kv.slidingWindowRemove("w", second.member);
  assert.equal((await add(t0 + 2)).count, 2);
  assert.equal((await add(t0 + 60_001)).count, 2, "members older than the window are dropped");
});
