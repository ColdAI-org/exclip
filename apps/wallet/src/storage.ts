/** IndexedDB persistence for the wallet origin (docs/embedded-wallet.md).
 *
 * One database, one object store of string values. It holds the ClipVault record (ciphertext: Argon2id/XChaCha
 * wrapped, passkey wraps, encrypted metadata) and a small non-secret status record (WalletStatusRecord). Never a
 * phrase, key, PRF output or password. Only code on the wallet origin can open it (same-origin storage).
 *
 * The status record is written by one popup at a time (navigator.locks) and carries an HMAC under a key sealed with
 * the seed, checked at every unlock. */
import type { VaultStorage } from "@clip-wallet/vault";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { equalBytes, toB64u, utf8 } from "./bytes.ts";

// Storage names (database, keys, locks, MAC domains) are part of the on-device format: renaming one later orphans
// the vaults already stored under it.
export const DB_NAME = "exclip-wallet";
export const DB_VERSION = 1;
export const STORE = "kv";
export const VAULT_KEY = "clip-wallet/vault/v1";
export const STATUS_KEY = "exclip-wallet/status/v1";

/** The subset of the IndexedDB API this module uses (so tests can pass a fake). */
export type IdbFactoryLike = Pick<IDBFactory, "open">;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export class IdbStorage implements VaultStorage {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly idb: IdbFactoryLike = indexedDB) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    }).catch((e: unknown) => {
      this.db = null;
      throw e;
    });
    return this.db;
  }

  private async run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    const tx = db.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
    const result = await request(fn(tx.objectStore(STORE)));
    await done; // a write only counts once it is committed
    return result;
  }

  async get(key: string): Promise<string | undefined> {
    const v = await this.run("readonly", (s) => s.get(key) as IDBRequest<unknown>);
    return typeof v === "string" ? v : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    if (typeof value !== "string") throw new TypeError("value must be a string");
    await this.run("readwrite", (s) => s.put(value, key));
  }

  async remove(key: string): Promise<void> {
    await this.run("readwrite", (s) => s.delete(key));
  }
}

/** Non-secret facts the wallet keeps about itself. */
export type WalletStatusRecord = {
  v: 1;
  /** The user saved the phrase, or there are at least two passkeys. */
  phraseSaved: boolean;
  /** EVM recipients sent to before (lower-case), newest first, at most 20. Used for first-time and look-alike warnings. */
  recipients: string[];
  /** SODAX hub wallet per source chain key (lower-case), pinned on first use: a later lookup that disagrees is refused. */
  hubWallets: Record<string, string>;
  /** The credential whose PRF derived this device's vault password (base64url). See wallet.ts "password". */
  passwordCredential: string | null;
  /** Credential ids (base64url) whose server backup is known to be stored. */
  backedUpCredentials: string[];
  /** At the recovery step the user confirmed their passkey is saved in a synced password manager. */
  syncConfirmed: boolean;
};

const ADDR = /^0x[0-9a-f]{40}$/;
const CHAIN = /^[a-z0-9][a-z0-9.-]{1,31}$/;
const CRED = /^[A-Za-z0-9_-]{16,1366}$/;
const empty = (): WalletStatusRecord => ({ v: 1, phraseSaved: false, recipients: [], hubWallets: {}, passwordCredential: null, backedUpCredentials: [], syncConfirmed: false });

/** The record as stored. Not verified: its MAC is checked only where a key is at hand (attestStatus, keyed writes). */
export async function readStatus(storage: VaultStorage): Promise<WalletStatusRecord> {
  return parseStatus(await storage.get(STATUS_KEY));
}

function parseStatus(raw: string | undefined): WalletStatusRecord {
  if (!raw) return empty();
  try {
    const v = JSON.parse(raw) as Partial<WalletStatusRecord>;
    const hub: Record<string, string> = {};
    if (v.hubWallets && typeof v.hubWallets === "object") {
      for (const [k, a] of Object.entries(v.hubWallets)) if (CHAIN.test(k) && typeof a === "string" && ADDR.test(a)) hub[k] = a;
    }
    return {
      v: 1,
      phraseSaved: v.phraseSaved === true,
      recipients: Array.isArray(v.recipients) ? v.recipients.filter((r): r is string => typeof r === "string" && ADDR.test(r)).slice(0, 20) : [],
      hubWallets: hub,
      passwordCredential: typeof v.passwordCredential === "string" && CRED.test(v.passwordCredential) ? v.passwordCredential : null,
      backedUpCredentials: Array.isArray(v.backedUpCredentials) ? v.backedUpCredentials.filter((c): c is string => typeof c === "string" && CRED.test(c)).slice(0, 20) : [],
      syncConfirmed: v.syncConfirmed === true,
    };
  } catch {
    return empty();
  }
}

/* ------------------------------------------------------------------ one writer at a time */

/** The part of the Web Locks API (navigator.locks) the writers use, so tests can pass one. */
export type LockManagerLike = { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
export const STATUS_LOCK = "exclip-wallet/status";

/** Where Web Locks is missing: one queue for this page (two tabs can still race there). */
function pageLocks(): LockManagerLike {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const run = (tails.get(name) ?? Promise.resolve()).then(callback, callback);
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}
const PAGE_LOCKS = pageLocks();

/** navigator.locks: exclusive across every tab and popup on this origin. */
export function defaultLocks(): LockManagerLike {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  return locks && typeof locks.request === "function" ? locks : PAGE_LOCKS;
}

/** Read-modify-write of the status record under one exclusive lock, so two popups at once (two tabs) can't lose each
 * other's update. `change` gets the record as it is now and returns the fields to replace. It must not call
 * updateStatus itself (the lock isn't re-entrant).
 *
 * With `macKey` the record is written with its MAC, and a stored record that doesn't verify isn't built on: the change
 * applies to the safe defaults instead, so an edit made behind the wallet's back can't be signed into the record by
 * the next legitimate write. */
export function updateStatus(
  storage: VaultStorage,
  change: (current: WalletStatusRecord) => Partial<Omit<WalletStatusRecord, "v">>,
  locks: LockManagerLike = defaultLocks(),
  macKey?: Uint8Array,
): Promise<WalletStatusRecord> {
  return locks.request(STATUS_LOCK, async () => {
    const raw = await storage.get(STATUS_KEY);
    let current = parseStatus(raw);
    if (macKey && raw !== undefined && !verified(raw, current, macKey)) current = empty();
    const next = { ...current, ...change(current), v: 1 as const };
    next.recipients = next.recipients.slice(0, 20);
    await storage.set(STATUS_KEY, JSON.stringify(macKey ? { ...next, mac: statusMac(macKey, next) } : next));
    return next;
  });
}

/** A patch that doesn't depend on the current record. */
export function writeStatus(storage: VaultStorage, patch: Partial<Omit<WalletStatusRecord, "v">>, locks?: LockManagerLike, macKey?: Uint8Array): Promise<WalletStatusRecord> {
  return updateStatus(storage, () => patch, locks, macKey);
}

/* ------------------------------------------------------------------ integrity */

const MAC_DOMAIN = "exclip-wallet/status-mac/v1";

/** HMAC-SHA256 over every field in a fixed order (hub pins sorted by network), base64url. The key is random per wallet
 * and sealed under the seed (wallet.ts STATUS_MAC_BOX_KEY), so only an unlocked vault can produce or check a MAC. */
export function statusMac(key: Uint8Array, r: WalletStatusRecord): string {
  const hubs = Object.entries(r.hubWallets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify([MAC_DOMAIN, r.v, r.phraseSaved, r.recipients, hubs, r.passwordCredential, r.backedUpCredentials, r.syncConfirmed]);
  return toB64u(hmac(sha256, key, utf8(canonical)));
}

/** The MAC is over the record as parsed: an entry the parser drops can't matter, and anything it keeps is covered. */
function verified(raw: string, record: WalletStatusRecord, key: Uint8Array): boolean {
  let mac: unknown;
  try {
    mac = (JSON.parse(raw) as { mac?: unknown } | null)?.mac;
  } catch {
    return false;
  }
  return typeof mac === "string" && equalBytes(utf8(mac), utf8(statusMac(key, record)));
}

/** At unlock (wallet.ts): `key()` opens or makes the MAC key, inside the status lock so two popups agree on one. A record
 * that doesn't verify (edited, or its key box missing or forged) is reset to the safe defaults: not backed up, no
 * known recipients, no pinned hubs. Returns the key, and whether a stored record was reset. No record yet: nothing to
 * reset. */
export function attestStatus(
  storage: VaultStorage,
  key: () => Promise<Uint8Array>,
  locks: LockManagerLike = defaultLocks(),
): Promise<{ key: Uint8Array; reset: boolean }> {
  return locks.request(STATUS_LOCK, async () => {
    const k = await key();
    const raw = await storage.get(STATUS_KEY);
    if (raw === undefined || verified(raw, parseStatus(raw), k)) return { key: k, reset: false };
    const safe = empty();
    await storage.set(STATUS_KEY, JSON.stringify({ ...safe, mac: statusMac(k, safe) }));
    return { key: k, reset: true };
  });
}
