/** Per-IP limits: the client key, the shared sliding window (add, then roll back a denied request), the per-process
 * burst bucket, and what happens when the shared store is down: fail open for public reads, closed for the wallet. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { createMemoryKv, type KvStore } from "../src/kv.ts";
import { createRateMemory, kvRateConsume, publicClientKey, publicRateLimit } from "../src/rateLimit.ts";

/** One route behind `limiter`; the client address comes from X-Forwarded-For (trust proxy on). */
async function serve(t: TestContext, limiter: RequestHandler) {
  const app = express();
  app.set("trust proxy", true);
  app.get("/", limiter, (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return async (ip = "198.51.100.20") => {
    const res = await fetch(url, { headers: { "x-forwarded-for": ip } });
    return { status: res.status, retryAfter: res.headers.get("retry-after"), cacheControl: res.headers.get("cache-control"), body: (await res.json()) as unknown };
  };
}

function captureWarnings(t: TestContext): string[] {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  t.after(() => { console.warn = original; });
  return lines;
}

test("client key: one per IPv4 address or IPv6 /64; anything unreadable shares one 'unknown' key", () => {
  assert.equal(publicClientKey("203.0.113.7"), "ip4:203.0.113.7");
  assert.equal(publicClientKey("::ffff:203.0.113.7"), "ip4:203.0.113.7");
  assert.equal(publicClientKey("2001:db8:abcd:12:1:2:3:4"), "ip6:2001:db8:abcd:12::/64");
  assert.equal(publicClientKey("2001:DB8:ABCD:0012::99"), "ip6:2001:db8:abcd:12::/64");
  assert.equal(publicClientKey("2001:db8:abcd:13::1"), "ip6:2001:db8:abcd:13::/64");
  for (const bad of [undefined, "", "garbage", "256.1.1.1", "1:2:3:4:5:6:7:8:9", "1::2::3", "x".repeat(60)]) {
    assert.equal(publicClientKey(bad), "ip:unknown", String(bad));
  }
});

test("shared window: perMinute per client in any 60 s; a denied request is rolled back and doesn't extend the lockout", async () => {
  const clock = { t: 5_000_000 };
  const kv = createMemoryKv(() => clock.t);
  const keys: string[] = [];
  const spy: KvStore = { ...kv, slidingWindowAdd: (key, ...rest) => { keys.push(key); return kv.slidingWindowAdd(key, ...rest); } };
  const consume = kvRateConsume(spy, () => clock.t);
  const take = () => consume("ip4:198.51.100.1", "test-window", 3);
  assert.deepEqual([await take(), await take(), await take(), await take()], [true, true, true, false]);
  assert.equal(keys[0], "exclip-rate:test-window:ip4:198.51.100.1");
  clock.t += 59_999;
  assert.equal(await take(), false, "still inside the window");
  clock.t += 1;
  assert.equal(await take(), true, "60 s after the first three: the denied attempts were not counted");
  assert.equal(await consume("ip4:198.51.100.2", "test-window", 3), true, "another client has its own budget");
  // No limit set: allowed without asking the store.
  const asked = keys.length;
  assert.equal(await consume("ip4:198.51.100.1", "test-window", 0), true);
  assert.equal(keys.length, asked);
});

test("shared window: a rollback that fails still refuses (best effort)", async () => {
  const kv = createMemoryKv();
  const flaky: KvStore = { ...kv, slidingWindowRemove: async () => { throw new Error("store hiccup"); } };
  const consume = kvRateConsume(flaky);
  assert.deepEqual([await consume("k", "b", 1), await consume("k", "b", 1)], [true, false]);
});

test("over the limit: 429 RATE_LIMITED with Retry-After 60 and no-store", async (t) => {
  const call = await serve(t, publicRateLimit("test-429", 5, async () => false, { memory: createRateMemory() }));
  const r = await call();
  assert.equal(r.status, 429);
  assert.equal(r.retryAfter, "60");
  assert.equal(r.cacheControl, "no-store");
  assert.deepEqual(r.body, { error: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly.", retryable: true } });
});

test("through the KV store: the middleware enforces the shared window per client", async (t) => {
  const call = await serve(t, publicRateLimit("test-kv", 2, kvRateConsume(createMemoryKv()), { memory: createRateMemory() }));
  assert.deepEqual([(await call()).status, (await call()).status, (await call()).status], [200, 200, 429]);
  assert.equal((await call("198.51.100.99")).status, 200);
});

test("burst bucket: perMinute tokens per client, refilled across the minute, checked before the shared store", async (t) => {
  const clock = { t: 0 };
  let asked = 0;
  const limiter = publicRateLimit("test-burst", 2, async () => { asked++; return true; }, { memory: createRateMemory({ now: () => clock.t }) });
  const call = await serve(t, limiter);
  assert.deepEqual([(await call()).status, (await call()).status, (await call()).status], [200, 200, 429]);
  assert.equal(asked, 2, "the refused burst never reached the shared store");
  assert.equal((await call("198.51.100.21")).status, 200, "another client has its own bucket");
  clock.t += 30_000; // one token back at 2 a minute
  assert.deepEqual([(await call()).status, (await call()).status], [200, 429]);
});

test("burst bucket: addresses in one IPv6 /64 share a budget; separate IPv4 addresses don't", async (t) => {
  const call = await serve(t, publicRateLimit("test-v6", 1, async () => true, { memory: createRateMemory() }));
  assert.equal((await call("2001:db8:1:2::1")).status, 200);
  assert.equal((await call("2001:db8:1:2:ffff::9")).status, 429);
  assert.equal((await call("2001:db8:1:3::1")).status, 200);
  assert.equal((await call("198.51.100.30")).status, 200);
  assert.equal((await call("198.51.100.31")).status, 200);
});

test("burst bucket: two limiters sharing a bucket name keep separate budgets", async (t) => {
  const memory = createRateMemory();
  const a = await serve(t, publicRateLimit("test-shared", 1, async () => true, { memory }));
  const b = await serve(t, publicRateLimit("test-shared", 1, async () => true, { memory }));
  assert.deepEqual([(await a()).status, (await b()).status, (await a()).status], [200, 200, 429]);
});

test("burst bucket: LRU-bounded; dropping a key resets that client to a full bucket (never stricter)", () => {
  const memory = createRateMemory({ maxKeys: 2, now: () => 0 });
  assert.equal(memory.take("a", 1), true);
  assert.equal(memory.take("a", 1), false);
  memory.take("b", 1);
  memory.take("c", 1); // "a" is the oldest: dropped
  assert.equal(memory.size(), 2);
  assert.equal(memory.take("a", 1), true);
});

test("store down, fail open (public reads): admitted, still under the burst bucket; one warning, no client address", async (t) => {
  const warnings = captureWarnings(t);
  const call = await serve(t, publicRateLimit("test-open", 2, async () => { throw new Error("connection refused"); }, { memory: createRateMemory() }));
  assert.deepEqual([(await call()).status, (await call()).status, (await call()).status], [200, 200, 429]);
  assert.equal(warnings.length, 1, "at most one warning a minute per bucket");
  assert.match(warnings[0]!, /test-open.*fail open/);
  assert.ok(!warnings[0]!.includes("198.51.100") && !warnings[0]!.includes("connection refused"));
});

test("store down, fail closed (the wallet): 503 RATE_LIMIT_UNAVAILABLE with Retry-After 30 and no-store", async (t) => {
  const warnings = captureWarnings(t);
  const call = await serve(t, publicRateLimit("test-closed", 5, async () => { throw new Error("timeout"); }, { onUnavailable: "closed", memory: createRateMemory() }));
  const r = await call();
  assert.equal(r.status, 503);
  assert.equal(r.retryAfter, "30");
  assert.equal(r.cacheControl, "no-store");
  assert.deepEqual(r.body, { error: { code: "RATE_LIMIT_UNAVAILABLE", message: "Temporarily unavailable. Try again shortly.", retryable: true } });
  assert.equal((await call()).status, 503);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /test-closed.*fail closed/);
});
