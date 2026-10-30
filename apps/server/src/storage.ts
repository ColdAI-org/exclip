/** Where the server keeps its state. Two stores: the KV store (rate-limit windows, one-time passkey challenges, the
 * daily new-passkey counter) and the wallet store (passkey public keys and encrypted backups).
 *
 * KV: Redis when REDIS_URL / server.redisUrl is set, else Postgres when DATABASE_URL / server.databaseUrl is set
 * (migrations/0002_kv.sql), else memory. Wallet: Postgres when a database is set (migrations/0001_wallet.sql), else
 * memory. Memory lives in this one process and is gone on restart, so production refuses it unless
 * server.allowMemoryStore says otherwise. */
import type { ExclipConfig, ExclipSecrets } from "@exclip/config";
import type { SqlPool } from "./db.ts";
import { createMemoryKv, createPostgresKv, createRedisKv, type KvStore, type RedisLike } from "./kv.ts";
import { createMemoryWalletStore, createPostgresWalletStore, type WalletStore } from "./services/walletBackup.ts";

export type StoragePlan = {
  kv: "redis" | "postgres" | "memory";
  wallet: "postgres" | "memory";
  /** Why the server must not start with this plan, or null. */
  refusal: string | null;
};

export function planStorage(config: ExclipConfig, secrets: ExclipSecrets, dev: boolean): StoragePlan {
  const kv = secrets.redisUrl ? "redis" : secrets.databaseUrl ? "postgres" : "memory";
  const wallet = secrets.databaseUrl ? "postgres" : "memory";
  const inMemory = [
    ...(kv === "memory" ? ["rate limits and passkey challenges"] : []),
    ...(config.features.embeddedWallet && wallet === "memory" ? ["passkey wallet backups"] : []),
  ];
  const refusal = !dev && inMemory.length && !config.server.allowMemoryStore
    ? `production needs shared storage, but ${inMemory.join(" and ")} would be kept in this process's memory (lost on `
      + "restart and not shared between processes). Set DATABASE_URL (or server.databaseUrl) and apply "
      + "apps/server/migrations, or set server.allowMemoryStore: true for a single-process trial."
    : null;
  return { kv, wallet, refusal };
}

export type Storage = { kv: KvStore; walletStore: WalletStore; close(): Promise<void> };

/** Replaces the password in a connection URL wherever it appears in `text` (driver errors can quote the URL). */
function scrub(text: string, url: string | null): string {
  if (!url) return text;
  try {
    const password = new URL(url).password;
    if (!password) return text;
    return [password, decodeURIComponent(password)].reduce((out, secret) => out.split(secret).join("***"), text);
  } catch {
    return text;
  }
}

/** One warning per minute per source, so a store that is down doesn't flood the log. */
function throttledWarn(label: string, url: string | null) {
  let last = 0;
  return (error: Error) => {
    const t = Date.now();
    if (t - last < 60_000) return;
    last = t;
    console.warn(`[exclip] ${label}: ${scrub(`${error.name}: ${error.message}`, url)}`);
  };
}

export async function openStorage(plan: StoragePlan, secrets: ExclipSecrets): Promise<Storage> {
  let pool: (SqlPool & { end(): Promise<void> }) | null = null;
  if (plan.kv === "postgres" || plan.wallet === "postgres") {
    const { default: pg } = await import("pg");
    const pgPool = new pg.Pool({ connectionString: secrets.databaseUrl!, max: 10 });
    // An idle connection that drops emits "error" on the pool; without a listener it would end the process.
    pgPool.on("error", throttledWarn("database", secrets.databaseUrl));
    pool = pgPool;
  }
  let kv: KvStore;
  if (plan.kv === "redis") {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(secrets.redisUrl!, { maxRetriesPerRequest: 2, enableReadyCheck: true, lazyConnect: false });
    client.on("error", throttledWarn("redis", secrets.redisUrl));
    kv = createRedisKv(client as unknown as RedisLike);
  } else {
    kv = plan.kv === "postgres" ? createPostgresKv(pool!) : createMemoryKv();
  }
  const walletStore = plan.wallet === "postgres" ? createPostgresWalletStore(pool!) : createMemoryWalletStore();
  return {
    kv,
    walletStore,
    async close() {
      await kv.close?.();
      await pool?.end();
    },
  };
}
