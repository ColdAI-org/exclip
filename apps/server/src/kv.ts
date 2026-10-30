/** A small key-value store for what server processes must share: per-IP rate-limit windows, single-use passkey
 * challenges and the daily new-passkey counter. Redis when one is configured, else Postgres (migrations/0002_kv.sql),
 * else memory (this process only; production refuses that unless server.allowMemoryStore is set, see storage.ts).
 * Every key expires.
 *
 * Sliding-window rate limits use a sorted set in Redis and a member table in Postgres. Counters use INCR with a TTL,
 * single-use markers SET NX with a TTL. */
import { randomUUID } from "node:crypto";
import type { SqlPool } from "./db.ts";

export interface KvStore {
  /** GET key. Null when absent or expired. */
  get(key: string): Promise<string | null>;
  /** SET key value EX ttlSec. */
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** SET key value NX EX ttlSec. True when this call created the key, false when it already existed. */
  setNx(key: string, value: string, ttlSec: number): Promise<boolean>;
  /** DEL key. */
  del(key: string): Promise<void>;
  /** INCR key. A key this creates expires after ttlSec; an existing key keeps its expiry. */
  incr(key: string, ttlSec: number): Promise<number>;
  /** Sliding-window helper. Adds a member at `nowMs`, evicts members older than the window and returns the resulting
   * count, with the generated member so the caller can `slidingWindowRemove` it (the rate limiter rolls back denied
   * attempts so they don't inflate the window). */
  slidingWindowAdd(key: string, nowMs: number, windowMs: number, ttlSec: number): Promise<{ count: number; member: string }>;
  /** Drops one member that slidingWindowAdd added. */
  slidingWindowRemove(key: string, member: string): Promise<void>;
  /** Closes the store's own connection, if it has one. */
  close?(): Promise<void>;
}

// ─── memory ───────────────────────────────────────────────────────────

/** One process only: for development, tests, and a single-process deployment that opted in (server.allowMemoryStore). */
export function createMemoryKv(now: () => number = Date.now): KvStore {
  const values = new Map<string, { value: string; expires: number }>();
  const windows = new Map<string, { expires: number; members: Array<{ score: number; member: string }> }>();
  let writes = 0;
  const live = (key: string) => {
    const entry = values.get(key);
    if (entry && entry.expires <= now()) {
      values.delete(key);
      return undefined;
    }
    return entry;
  };
  // Expired keys are dropped when read, and all of them every 1,000 writes, so keys nobody reads again don't pile up.
  const sweep = () => {
    if (++writes % 1_000 !== 0) return;
    const t = now();
    for (const [key, entry] of values) if (entry.expires <= t) values.delete(key);
    for (const [key, window] of windows) if (window.expires <= t) windows.delete(key);
  };
  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ttlSec) {
      sweep();
      values.set(key, { value, expires: now() + ttlSec * 1000 });
    },
    async setNx(key, value, ttlSec) {
      sweep();
      if (live(key)) return false;
      values.set(key, { value, expires: now() + ttlSec * 1000 });
      return true;
    },
    async del(key) {
      values.delete(key);
    },
    async incr(key, ttlSec) {
      sweep();
      const entry = live(key);
      const next = entry ? Number(entry.value) + 1 : 1;
      values.set(key, { value: String(next), expires: entry ? entry.expires : now() + ttlSec * 1000 });
      return next;
    },
    async slidingWindowAdd(key, nowMs, windowMs, ttlSec) {
      sweep();
      const current = windows.get(key);
      const members = current && current.expires > now() ? current.members.filter((m) => m.score > nowMs - windowMs) : [];
      const member = `${nowMs}-${randomUUID()}`;
      members.push({ score: nowMs, member });
      windows.set(key, { expires: now() + ttlSec * 1000, members });
      return { count: members.length, member };
    },
    async slidingWindowRemove(key, member) {
      const current = windows.get(key);
      if (current) current.members = current.members.filter((m) => m.member !== member);
    },
  };
}

// ─── redis ────────────────────────────────────────────────────────────

/** The ioredis calls the store makes (an ioredis client fits). Declared here so the store can be tested with a fake. */
export type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<string | null>;
  del(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  zrem(key: string, member: string): Promise<number>;
  multi(): {
    zremrangebyscore(key: string, min: number | string, max: number | string): unknown;
    zadd(key: string, score: number, member: string): unknown;
    zcard(key: string): unknown;
    expire(key: string, seconds: number): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
  quit(): Promise<unknown>;
};

export function createRedisKv(client: RedisLike): KvStore {
  return {
    async get(key) {
      return (await client.get(key)) ?? null;
    },
    async set(key, value, ttlSec) {
      await client.set(key, value, "EX", ttlSec);
    },
    async setNx(key, value, ttlSec) {
      return (await client.set(key, value, "EX", ttlSec, "NX")) === "OK";
    },
    async del(key) {
      await client.del(key);
    },
    async incr(key, ttlSec) {
      const v = await client.incr(key);
      if (v === 1) await client.expire(key, ttlSec);
      return v;
    },
    async slidingWindowAdd(key, nowMs, windowMs, ttlSec) {
      const member = `${nowMs}-${randomUUID()}`;
      const pipe = client.multi();
      pipe.zremrangebyscore(key, 0, nowMs - windowMs);
      pipe.zadd(key, nowMs, member);
      pipe.zcard(key);
      pipe.expire(key, ttlSec);
      const results = await pipe.exec();
      // results = [[err, value], ...]; zcard is index 2.
      const card = results?.[2]?.[1];
      return { count: Number(card ?? 0), member };
    },
    async slidingWindowRemove(key, member) {
      await client.zrem(key, member);
    },
    async close() {
      await client.quit();
    },
  };
}

// ─── postgres ─────────────────────────────────────────────────────────

/** Statements against migrations/0002_kv.sql. Expiry is judged by the database clock, so every server process agrees. */
export const KV_SQL = {
  get: "SELECT value FROM exclip_kv WHERE key = $1 AND expires_at > now()",
  set: `INSERT INTO exclip_kv (key, value, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
  // Inserts, or takes over an expired row. A live row is left alone and nothing is returned.
  setNx: `INSERT INTO exclip_kv (key, value, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
    WHERE exclip_kv.expires_at <= now() RETURNING key`,
  del: "DELETE FROM exclip_kv WHERE key = $1",
  incr: `INSERT INTO exclip_kv (key, value, expires_at) VALUES ($1, '1', now() + make_interval(secs => $2))
    ON CONFLICT (key) DO UPDATE SET
      value = CASE WHEN exclip_kv.expires_at <= now() THEN '1' ELSE (exclip_kv.value::bigint + 1)::text END,
      expires_at = CASE WHEN exclip_kv.expires_at <= now() THEN EXCLUDED.expires_at ELSE exclip_kv.expires_at END
    RETURNING value`,
  windowPrune: "DELETE FROM exclip_kv_windows WHERE key = $1 AND score <= $2",
  windowAdd: "INSERT INTO exclip_kv_windows (key, member, score, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))",
  windowCount: "SELECT count(*)::int AS n FROM exclip_kv_windows WHERE key = $1 AND score > $2",
  windowRemove: "DELETE FROM exclip_kv_windows WHERE key = $1 AND member = $2",
  sweepValues: "DELETE FROM exclip_kv WHERE expires_at <= now()",
  sweepWindows: "DELETE FROM exclip_kv_windows WHERE expires_at <= now()",
} as const;

export function createPostgresKv(pool: SqlPool): KvStore {
  let writes = 0;
  // Expired rows are ignored at once; every 500th write also deletes them, in the background.
  const sweep = () => {
    if (++writes % 500 !== 0) return;
    void pool.query(KV_SQL.sweepValues).then(() => pool.query(KV_SQL.sweepWindows)).catch(() => {});
  };
  return {
    async get(key) {
      const { rows } = await pool.query(KV_SQL.get, [key]);
      return rows.length ? String(rows[0]!.value) : null;
    },
    async set(key, value, ttlSec) {
      sweep();
      await pool.query(KV_SQL.set, [key, value, ttlSec]);
    },
    async setNx(key, value, ttlSec) {
      sweep();
      const { rows } = await pool.query(KV_SQL.setNx, [key, value, ttlSec]);
      return rows.length === 1;
    },
    async del(key) {
      await pool.query(KV_SQL.del, [key]);
    },
    async incr(key, ttlSec) {
      sweep();
      const { rows } = await pool.query(KV_SQL.incr, [key, ttlSec]);
      return Number(rows[0]!.value);
    },
    async slidingWindowAdd(key, nowMs, windowMs, ttlSec) {
      sweep();
      // Three statements, each committed on its own: prune, add, count. Of two concurrent requests, at least the later
      // count sees both adds, so a window is never over-admitted (at worst a request is refused that could have passed).
      const cutoff = nowMs - windowMs;
      const member = `${nowMs}-${randomUUID()}`;
      await pool.query(KV_SQL.windowPrune, [key, cutoff]);
      await pool.query(KV_SQL.windowAdd, [key, member, nowMs, ttlSec]);
      const { rows } = await pool.query(KV_SQL.windowCount, [key, cutoff]);
      return { count: Number(rows[0]?.n ?? 0), member };
    },
    async slidingWindowRemove(key, member) {
      await pool.query(KV_SQL.windowRemove, [key, member]);
    },
  };
}
