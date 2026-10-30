/** Per-IP limits for ExClip's anonymous routes. Two layers: this process's in-memory token bucket refuses bursts with
 * 429 before the shared store is asked, then a 60 s sliding window in the shared KV store (kv.ts) enforces one budget
 * per client across server processes. Requires the app's `trust proxy` (server.trustProxy) to match the proxies in
 * front, so req.ip is the client and not a proxy. */
import type { RequestHandler, Response } from "express";
import type { KvStore } from "./kv.ts";

/** Takes one request from the client's budget in the shared store: true when allowed. Throws when the store can't
 * answer. */
export type RateConsume = (clientKey: string, bucket: string, perMinute: number) => Promise<boolean>;

const WINDOW_MS = 60_000;
const TTL_SEC = 65;

/** The shared sliding window, add-then-rollback: always add (so the check is race-free across processes), then remove
 * the member just added when the count is over the cap. Denied attempts stay out of the window, so a sustained
 * over-limit burst doesn't keep extending the lockout past the window. */
export function kvRateConsume(kv: KvStore, now: () => number = Date.now): RateConsume {
  return async (clientKey, bucket, perMinute) => {
    if (!Number.isFinite(perMinute) || perMinute <= 0) return true;
    const key = `exclip-rate:${bucket}:${clientKey}`;
    const { count, member } = await kv.slidingWindowAdd(key, now(), WINDOW_MS, TTL_SEC);
    if (count <= perMinute) return true;
    try {
      await kv.slidingWindowRemove(key, member);
    } catch {
      // Best effort: a leaked member only counts one extra request and ages out within the window.
    }
    return false;
  };
}

function ipv6Prefix(value: string): string | null {
  const parts = value.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [], tail = parts[1] ? parts[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (parts.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<string>(parts.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, "")).join(":");
}

/** One client key per IPv4 address or IPv6 /64 (the unit a subscriber controls), so rotating addresses inside one
 * allocation does not multiply the budget. */
export function publicClientKey(ip: string | undefined): string {
  let value = (ip ?? "").trim().toLowerCase();
  if (value.startsWith("::ffff:") && value.includes(".")) value = value.slice(7);
  if (/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(value)) return "ip4:" + value;
  const prefix = value.length <= 45 ? ipv6Prefix(value) : null;
  return prefix ? "ip6:" + prefix + "::/64" : "ip:unknown";
}

/**
 * Token bucket with capacity `perMinute`, refilled at `perMinute / 60` per second. It admits any sequence that the
 * shared 60 s sliding window admits (at most `perMinute` requests in any 60 s), so a compliant client is never refused
 * here; it only refuses bursts beyond the shared limit on this process. LRU-bounded at `maxKeys`: dropping a key
 * resets that client to a full bucket (more lenient, never stricter). Entries idle for 60 s are full anyway.
 */
export function createRateMemory({ maxKeys = 50_000, now = Date.now }: { maxKeys?: number; now?: () => number } = {}) {
  const entries = new Map<string, { tokens: number; at: number }>();
  return {
    /** Takes one token for `key`; false when the bucket is empty (the request should be refused with 429). */
    take(key: string, perMinute: number): boolean {
      if (!(perMinute > 0) || maxKeys < 1) return true;
      const t = now();
      const entry = entries.get(key);
      let tokens = perMinute;
      if (entry) {
        tokens = Math.min(perMinute, entry.tokens + Math.max(0, t - entry.at) * perMinute / 60_000);
        entries.delete(key);
      }
      // Float tolerance: a client exactly at the sliding-window limit is admitted, as the shared window would.
      const allowed = tokens >= 1 - 1e-9;
      entries.set(key, { tokens: allowed ? Math.max(0, tokens - 1) : tokens, at: t });
      if (entries.size > maxKeys) entries.delete(entries.keys().next().value!);
      return allowed;
    },
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}
export type RateMemory = ReturnType<typeof createRateMemory>;

/** This process's burst buckets, shared by every limiter (each keeps its own keys, see below). */
export const publicRateMemory = createRateMemory();

export type PublicRateLimitOptions = {
  /**
   * What happens when the shared store can't answer:
   * - "open" (default): admit. For cheap, cached, bounded public reads, where a store outage must not take market
   *   data and quotes down. They stay limited by the per-process memory bucket, never unlimited.
   * - "closed": answer 503. For the passkey wallet's routes, which guard backups and must never run unmetered.
   */
  onUnavailable?: "open" | "closed";
  /** The burst bucket; defaults to the process-wide one. */
  memory?: RateMemory;
};

let limiterSeq = 0;
const lastUnavailableLog = new Map<string, number>();

/** Per-IP limit for an anonymous route: `perMinute` requests per client in any 60 s. Outages of the shared store are
 * logged at most once per minute per bucket, without the client's address. */
export function publicRateLimit(bucket: string, perMinute: number, consume: RateConsume, options: PublicRateLimitOptions = {}): RequestHandler {
  const failClosed = options.onUnavailable === "closed";
  const memory = options.memory ?? publicRateMemory;
  // Each middleware keeps its own buckets: two routes sharing a bucket name never drain each other's memory budget.
  const memoryPrefix = `${++limiterSeq}|${bucket}|`;
  const refuse = (res: Response) => {
    res.setHeader("Retry-After", "60");
    res.setHeader("Cache-Control", "no-store");
    res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly.", retryable: true } });
  };
  return async (req, res, next) => {
    const clientKey = publicClientKey(req.ip);
    if (!memory.take(memoryPrefix + clientKey, perMinute)) return refuse(res);
    let allowed: boolean;
    try {
      allowed = await consume(clientKey, bucket, perMinute);
    } catch (error) {
      const now = Date.now();
      if (now - (lastUnavailableLog.get(bucket) ?? 0) > 60_000) {
        lastUnavailableLog.set(bucket, now);
        const name = error instanceof Error ? error.name : typeof error;
        console.warn(failClosed
          ? `[exclip] rate limits (${bucket}): the shared store is unavailable (${name}); refusing requests (fail closed)`
          : `[exclip] rate limits (${bucket}): the shared store is unavailable (${name}); admitting requests under the per-process limit (fail open)`);
      }
      if (!failClosed) return next();
      res.setHeader("Retry-After", "30");
      res.setHeader("Cache-Control", "no-store");
      res.status(503).json({ error: { code: "RATE_LIMIT_UNAVAILABLE", message: "Temporarily unavailable. Try again shortly.", retryable: true } });
      return;
    }
    if (allowed) return next();
    return refuse(res);
  };
}
