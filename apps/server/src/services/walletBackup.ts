/** ExClip passkey wallet: the server half. It stores passkey PUBLIC keys and ClipVault backup CIPHERTEXT, and hands a
 * backup back only to a fresh, user-verified WebAuthn assertion from the wallet origin. It never sees a PRF output, a
 * phrase, a vault password or a wallet address, and nothing here is logged. */
import { randomBytes } from "node:crypto";
import { transaction, type SqlPool } from "../db.ts";
import type { KvStore } from "../kv.ts";

export const BACKUP_MAX_BYTES = 16 * 1024;
/** "CLPB" | 0x01 | salt(32) | nonce(24) | ciphertext+tag(≥16): the ClipVault passkey backup layout
 * (packages/clip-wallet-vault). */
export const BACKUP_MIN_BYTES = 4 + 1 + 32 + 24 + 16;
export const CHALLENGE_TTL_MS = 120_000;
export const RETIRED_RETENTION_MS = 30 * 24 * 60 * 60_000;
const CHALLENGE_PREFIX = "exclip-wallet:challenge:";
const USED_PREFIX = "exclip-wallet:used:";

/** One purpose per operation: an assertion the user gave to read their backup can't be spent on an append or a
 * retire, and the reverse. Not bound to the request body: the backup is encrypted under the PRF output of the very
 * ceremony that signs the challenge, so the body can't exist before the challenge does. */
export type ChallengePurpose = "register" | "fetch" | "append" | "retire";
export const CHALLENGE_PURPOSES: readonly ChallengePurpose[] = ["register", "fetch", "append", "retire"];

const B64URL = /^[A-Za-z0-9_-]+$/;

export function isCredentialId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 512 && B64URL.test(value);
}

export function fromBase64Url(value: string): Uint8Array | null {
  if (!B64URL.test(value) || value.length % 4 === 1) return null;
  const buf = Buffer.from(value, "base64url");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** Sanity check of a backup before it is stored: size cap and the ClipVault magic/version. The content stays opaque. */
export function parseBackupBlob(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > Math.ceil((BACKUP_MAX_BYTES * 4) / 3) + 4) return null;
  const bytes = fromBase64Url(value);
  if (!bytes || bytes.length < BACKUP_MIN_BYTES || bytes.length > BACKUP_MAX_BYTES) return null;
  if (bytes[0] !== 0x43 || bytes[1] !== 0x4c || bytes[2] !== 0x50 || bytes[3] !== 0x42 || bytes[4] !== 0x01) return null;
  return bytes;
}

// ---- single-use challenges ---------------------------------------------------------------------------------

/** Challenges live in the shared KV store. Single use: the first consumer wins a SET NX tombstone, so a replayed
 * or concurrent second use fails even before the challenge key itself is deleted. Expiry is checked against the
 * injected clock (the KV TTL only cleans up). */
export function createChallengeStore(kv: KvStore, now: () => number = Date.now, ttlMs = CHALLENGE_TTL_MS) {
  const ttlSec = Math.ceil(ttlMs / 1000);
  return {
    async issue(purpose: ChallengePurpose): Promise<string> {
      const challenge = randomBytes(32).toString("base64url");
      await kv.set(CHALLENGE_PREFIX + challenge, JSON.stringify({ p: purpose, exp: now() + ttlMs }), ttlSec);
      return challenge;
    },
    async consume(challenge: string, purpose: ChallengePurpose): Promise<boolean> {
      if (typeof challenge !== "string" || challenge.length !== 43 || !B64URL.test(challenge)) return false;
      if (!(await kv.setNx(USED_PREFIX + challenge, "1", ttlSec * 2))) return false;
      const raw = await kv.get(CHALLENGE_PREFIX + challenge);
      await kv.del(CHALLENGE_PREFIX + challenge);
      if (!raw) return false;
      try {
        const v = JSON.parse(raw) as { p?: unknown; exp?: unknown };
        return v.p === purpose && typeof v.exp === "number" && v.exp > now();
      } catch {
        return false;
      }
    },
  };
}

export type ChallengeStore = ReturnType<typeof createChallengeStore>;

// ---- server-wide registration cap --------------------------------------------------------------------------

const NEW_CREDENTIALS_PREFIX = "exclip-wallet:new-credentials:";

/** Counts one new passkey against today's (UTC) server-wide allowance. `allowed` is false once `cap` is used up.
 * Registration is open (attestation "none"), so storage is capped server-wide, not only per IP. */
export async function countNewCredential(kv: KvStore, now: number, cap: number): Promise<{ allowed: boolean; count: number }> {
  const count = await kv.incr(NEW_CREDENTIALS_PREFIX + new Date(now).toISOString().slice(0, 10), 2 * 86_400);
  return { allowed: count <= cap, count };
}

// ---- credential + backup storage ---------------------------------------------------------------------------

export type WalletCredential = {
  credentialId: string;
  publicKey: Uint8Array;
  rpId: string;
  signCount: number;
  transports: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  retiredAt: Date | null;
};

export type NewWalletCredential = Pick<WalletCredential, "credentialId" | "publicKey" | "rpId" | "signCount" | "transports">;
export type StoredBackup = { version: number; blob: Uint8Array; createdAt: Date };

export interface WalletStore {
  /** Inserts the credential and its backup as version 1, atomically. "exists" when the id is already known. */
  createCredential(credential: NewWalletCredential, backup: Uint8Array, now: Date): Promise<"created" | "exists">;
  getCredential(credentialId: string): Promise<WalletCredential | null>;
  /** Compare-and-set of the sign count (and last_used_at). False when another request moved it first. */
  recordUse(credentialId: string, expectedSignCount: number, newSignCount: number, now: Date): Promise<boolean>;
  /** The newest `limit` versions, newest first (the client falls back to an older one that decrypts). */
  recentBackups(credentialId: string, limit: number): Promise<StoredBackup[]>;
  /** Appends the next version (never rewrites one). Returns the new version number, or "full" when the passkey
   * already has `maxVersions` (refused, never made room for, so old good versions survive). */
  appendBackup(credentialId: string, blob: Uint8Array, now: Date, maxVersions: number): Promise<number | "full">;
  retireCredential(credentialId: string, now: Date): Promise<void>;
  /** Hard-deletes credentials retired before `before`, with their backups. Returns how many. */
  purgeRetired(before: Date): Promise<number>;
}

/** In-memory store for tests and local development without a database. */
export function createMemoryWalletStore(): WalletStore & { dump(): { credentials: WalletCredential[]; backups: Array<StoredBackup & { credentialId: string }> } } {
  const credentials = new Map<string, WalletCredential>();
  const backups: Array<StoredBackup & { credentialId: string }> = [];
  return {
    async createCredential(c, backup, now) {
      if (credentials.has(c.credentialId)) return "exists";
      credentials.set(c.credentialId, { ...c, transports: [...c.transports], createdAt: now, lastUsedAt: null, retiredAt: null });
      backups.push({ credentialId: c.credentialId, version: 1, blob: backup.slice(), createdAt: now });
      return "created";
    },
    async getCredential(id) {
      const c = credentials.get(id);
      return c ? { ...c, transports: [...c.transports] } : null;
    },
    async recordUse(id, expected, next, now) {
      const c = credentials.get(id);
      if (!c || c.signCount !== expected) return false;
      c.signCount = next;
      c.lastUsedAt = now;
      return true;
    },
    async recentBackups(id, limit) {
      return backups.filter((b) => b.credentialId === id).sort((a, b) => b.version - a.version).slice(0, limit)
        .map((b) => ({ version: b.version, blob: b.blob.slice(), createdAt: b.createdAt }));
    },
    async appendBackup(id, blob, now, maxVersions) {
      const mine = backups.filter((b) => b.credentialId === id);
      if (mine.length >= maxVersions) return "full";
      const version = Math.max(0, ...mine.map((b) => b.version)) + 1;
      backups.push({ credentialId: id, version, blob: blob.slice(), createdAt: now });
      return version;
    },
    async retireCredential(id, now) {
      const c = credentials.get(id);
      if (c && !c.retiredAt) c.retiredAt = now;
    },
    async purgeRetired(before) {
      let n = 0;
      for (const [id, c] of credentials) {
        if (c.retiredAt && c.retiredAt < before) {
          credentials.delete(id);
          for (let i = backups.length - 1; i >= 0; i--) if (backups[i]!.credentialId === id) backups.splice(i, 1);
          n++;
        }
      }
      return n;
    },
    dump: () => ({ credentials: [...credentials.values()], backups: [...backups] }),
  };
}

/** Statements against migrations/0001_wallet.sql. */
export const WALLET_SQL = {
  insertCredential: `INSERT INTO exclip_wallet_credentials (credential_id, public_key, rp_id, sign_count, transports, created_at)
    VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (credential_id) DO NOTHING RETURNING credential_id`,
  insertBackup: `INSERT INTO exclip_wallet_backups (credential_id, version, blob, created_at)
    VALUES ($1, $2, $3, $4) RETURNING version`,
  getCredential: `SELECT credential_id, public_key, rp_id, sign_count, transports, created_at, last_used_at, retired_at
    FROM exclip_wallet_credentials WHERE credential_id = $1`,
  recordUse: `UPDATE exclip_wallet_credentials SET sign_count = $3, last_used_at = $4
    WHERE credential_id = $1 AND sign_count = $2 RETURNING credential_id`,
  recentBackups: `SELECT version, blob, created_at FROM exclip_wallet_backups
    WHERE credential_id = $1 ORDER BY version DESC LIMIT $2`,
  lockCredential: "SELECT credential_id FROM exclip_wallet_credentials WHERE credential_id = $1 FOR UPDATE",
  backupStats: `SELECT count(*)::int AS n, coalesce(max(version), 0)::int AS top FROM exclip_wallet_backups
    WHERE credential_id = $1`,
  retire: "UPDATE exclip_wallet_credentials SET retired_at = $2 WHERE credential_id = $1 AND retired_at IS NULL",
  purgeRetired: "DELETE FROM exclip_wallet_credentials WHERE retired_at < $1 RETURNING credential_id",
} as const;

const bytes = (value: unknown) => new Uint8Array(value as Uint8Array);

/** Postgres store (tables from migrations/0001_wallet.sql). */
export function createPostgresWalletStore(pool: SqlPool): WalletStore {
  return {
    async createCredential(credential, backup, now) {
      return transaction(pool, async (client) => {
        const inserted = await client.query(WALLET_SQL.insertCredential, [credential.credentialId, Buffer.from(credential.publicKey),
          credential.rpId, credential.signCount, credential.transports, now]);
        if (!inserted.rows.length) return "exists" as const;
        await client.query(WALLET_SQL.insertBackup, [credential.credentialId, 1, Buffer.from(backup), now]);
        return "created" as const;
      });
    },
    async getCredential(id) {
      const { rows } = await pool.query(WALLET_SQL.getCredential, [id]);
      const row = rows[0];
      if (!row) return null;
      return {
        credentialId: String(row.credential_id),
        publicKey: bytes(row.public_key),
        rpId: String(row.rp_id),
        // bigint arrives as a string; sign counts are 32-bit.
        signCount: Number(row.sign_count),
        transports: [...(row.transports as string[])],
        createdAt: row.created_at as Date,
        lastUsedAt: (row.last_used_at as Date | null) ?? null,
        retiredAt: (row.retired_at as Date | null) ?? null,
      };
    },
    async recordUse(id, expected, next, now) {
      const { rows } = await pool.query(WALLET_SQL.recordUse, [id, expected, next, now]);
      return rows.length === 1;
    },
    async recentBackups(id, limit) {
      const { rows } = await pool.query(WALLET_SQL.recentBackups, [id, limit]);
      return rows.map((row) => ({ version: Number(row.version), blob: bytes(row.blob), createdAt: row.created_at as Date }));
    },
    async appendBackup(id, blob, now, maxVersions) {
      return transaction(pool, async (client) => {
        // The credential row lock serialises appends per passkey, so the count below can't be raced past the cap.
        await client.query(WALLET_SQL.lockCredential, [id]);
        const stats = (await client.query(WALLET_SQL.backupStats, [id])).rows[0];
        const count = Number(stats?.n ?? 0), top = Number(stats?.top ?? 0);
        if (count >= maxVersions) return "full" as const;
        // The (credential_id, version) unique key still turns any duplicate into an error.
        const inserted = await client.query(WALLET_SQL.insertBackup, [id, top + 1, Buffer.from(blob), now]);
        return Number(inserted.rows[0]!.version);
      });
    },
    async retireCredential(id, now) {
      await pool.query(WALLET_SQL.retire, [id, now]);
    },
    async purgeRetired(before) {
      const { rows } = await pool.query(WALLET_SQL.purgeRetired, [before]);
      return rows.length;
    },
  };
}
