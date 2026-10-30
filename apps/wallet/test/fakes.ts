/** Test doubles: a WebAuthn authenticator with PRF (HMAC-SHA256 per credential, like CTAP hmac-secret), the backup
 * API in memory, and the slice of IndexedDB that storage.ts uses. No real keys: every secret here is random. */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromB64u, toB64u, utf8 } from "../src/bytes.ts";
import { ApiError, type ChallengePurpose, type WalletApi } from "../src/api.ts";
import type { WebAuthnEnv } from "../src/webauthn.ts";

export const ORIGIN = "https://wallet.test";
export const RP_ID = "wallet.test";
export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

type Stored = { id: Uint8Array; secret: Uint8Array; userHandle: Uint8Array; rpId: string };

export type AuthenticatorOptions = {
  /** No PRF at all (old browser / authenticator). */
  noPrf?: boolean;
  /** PRF enabled at create but no results (Safari-like): a second ceremony is needed. */
  prfOnlyOnGet?: boolean;
  /** getClientCapabilities answer for "extension:prf"; undefined → the method is absent. */
  capability?: boolean;
};

/** A passkey provider. Credentials can be shared between two "devices" (synced passkeys) with `sync`. */
export class FakeAuthenticator {
  readonly creds: Stored[] = [];
  readonly calls: { kind: "create" | "get"; options: CredentialCreationOptions | CredentialRequestOptions }[] = [];
  readonly signalled: string[] = [];
  /** Which credential a discoverable get picks (index into creds); default the last one. */
  pick: number | null = null;
  constructor(readonly opts: AuthenticatorOptions = {}) {}

  sync(from: FakeAuthenticator): this {
    this.creds.push(...from.creds);
    return this;
  }

  private prf(c: Stored, input: BufferSource | undefined) {
    if (this.opts.noPrf || !input) return undefined;
    return hmac(sha256, c.secret, new Uint8Array(input as ArrayBuffer)).buffer as ArrayBuffer;
  }

  private credential(c: Stored, response: Record<string, unknown>, prf: Record<string, unknown> | undefined) {
    return {
      type: "public-key",
      id: toB64u(c.id),
      rawId: c.id.slice().buffer,
      authenticatorAttachment: "platform",
      response,
      getClientExtensionResults: () => (prf ? { prf } : {}),
      // A real browser's toJSON would include the PRF results; the wallet must never use it.
      toJSON: () => ({ leaked: true }),
    } as unknown as Credential;
  }

  env(origin = ORIGIN): WebAuthnEnv {
    return {
      origin,
      dev: false,
      random,
      getClientCapabilities: this.opts.capability === undefined ? undefined : async () => ({ "extension:prf": this.opts.capability }),
      signalUnknownCredential: async ({ credentialId }) => {
        this.signalled.push(credentialId);
      },
      credentials: {
        create: async (options?: CredentialCreationOptions) => {
          this.calls.push({ kind: "create", options: options! });
          const pk = options!.publicKey!;
          const excluded = (pk.excludeCredentials ?? []).map((d) => toB64u(new Uint8Array(d.id as ArrayBuffer)));
          if (this.creds.some((c) => excluded.includes(toB64u(c.id)))) throw Object.assign(new Error("excluded"), { name: "InvalidStateError" });
          const c: Stored = { id: random(32), secret: random(32), userHandle: new Uint8Array(pk.user.id as ArrayBuffer).slice(), rpId: pk.rp.id! };
          this.creds.push(c);
          const first = (pk.extensions as { prf?: { eval?: { first?: BufferSource } } } | undefined)?.prf?.eval?.first;
          const prf = this.opts.noPrf ? undefined : this.opts.prfOnlyOnGet ? { enabled: true } : { enabled: true, results: { first: this.prf(c, first) } };
          return this.credential(c, {
            clientDataJSON: utf8(JSON.stringify({ type: "webauthn.create", challenge: toB64u(new Uint8Array(pk.challenge as ArrayBuffer)), origin })).buffer,
            attestationObject: random(64).buffer,
            getTransports: () => ["internal", "hybrid"],
          }, prf);
        },
        get: async (options?: CredentialRequestOptions) => {
          this.calls.push({ kind: "get", options: options! });
          const pk = options!.publicKey!;
          const allow = (pk.allowCredentials ?? []).map((d) => toB64u(new Uint8Array(d.id as ArrayBuffer)));
          const usable = this.creds.filter((c) => c.rpId === pk.rpId && (!allow.length || allow.includes(toB64u(c.id))));
          if (!usable.length) throw Object.assign(new Error("no credential"), { name: "NotAllowedError" });
          const c = allow.length ? usable[usable.length - 1]! : (this.pick !== null ? this.creds[this.pick]! : usable[usable.length - 1]!);
          const first = (pk.extensions as { prf?: { eval?: { first?: BufferSource } } } | undefined)?.prf?.eval?.first;
          const results = this.prf(c, first);
          return this.credential(c, {
            clientDataJSON: utf8(JSON.stringify({ type: "webauthn.get", challenge: toB64u(new Uint8Array(pk.challenge as ArrayBuffer)), origin })).buffer,
            authenticatorData: random(37).buffer,
            signature: random(70).buffer,
            userHandle: c.userHandle.slice().buffer,
          }, results ? { results: { first: results } } : undefined);
        },
      },
    };
  }
}

/** The backup API as the server keeps it: backups by credential id, nothing else. */
export class FakeApi implements WalletApi {
  readonly backups = new Map<string, string[]>();
  readonly registered: unknown[] = [];
  failRegister = false;
  synced = true;
  readonly purposes: ChallengePurpose[] = [];

  async challenge(purpose: ChallengePurpose) {
    this.purposes.push(purpose);
    return { challenge: toB64u(random(32)), rpId: RP_ID, timeoutMs: 120_000 };
  }
  /** Late registrations: credential ids registered with an assertion as proof. */
  readonly late: string[] = [];
  async register(response: { id: string }, backup: string, assertion?: { id: string }) {
    if (this.failRegister) throw new Error("offline");
    fromB64u(backup);
    if (assertion) {
      if (assertion.id !== response.id) throw new ApiError(400, "BAD_REQUEST", "x");
      if (this.backups.has(response.id)) throw new ApiError(409, "CONFLICT", "x");
      this.late.push(response.id);
    }
    this.registered.push(response);
    this.backups.set(response.id, [backup]);
    return { backedUp: this.synced, deviceType: "multiDevice" };
  }
  async fetchBackup(response: { id: string }) {
    const list = this.backups.get(response.id);
    if (!list) throw new Error("NOT_VERIFIED");
    return { backups: list.map((backup, i) => ({ version: i + 1, backup })).reverse() };
  }
  async appendBackup(response: { id: string }, backup: string) {
    const list = this.backups.get(response.id) ?? [];
    list.push(backup);
    this.backups.set(response.id, list);
    return { version: list.length };
  }
}

/** The popup's own hub-account lookup on Sonic (sodax/hub.ts): one answer, every question recorded. */
export class FakeSonic {
  hub = "0x1111111111111111111111111111111111111111";
  offline = false;
  readonly asked: [string, string][] = [];
  readonly lookup = async (chainKey: string, evm: string): Promise<string> => {
    this.asked.push([chainKey, evm]);
    if (this.offline) throw new Error("offline");
    return this.hub;
  };
}

/* ------------------------------------------------------------------ IndexedDB */

type Req<T> = { result: T; error: Error | null; onsuccess: (() => void) | null; onerror: (() => void) | null };
const later = (fn: () => void) => setTimeout(fn, 0);

function req<T>(compute: () => T, after?: () => void): Req<T> {
  const r: Req<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null };
  later(() => {
    try {
      r.result = compute();
      r.onsuccess?.();
    } catch (e) {
      r.error = e as Error;
      r.onerror?.();
    }
    after?.();
  });
  return r;
}

/** Enough of IDBFactory for storage.ts: one database, object stores of key → value, transactions that complete. */
export function fakeIndexedDb() {
  const dbs = new Map<string, Map<string, Map<string, unknown>>>();
  let opens = 0;
  const factory = {
    get opens() {
      return opens;
    },
    open(name: string) {
      opens++;
      const isNew = !dbs.has(name);
      const stores = dbs.get(name) ?? new Map<string, Map<string, unknown>>();
      dbs.set(name, stores);
      const db = {
        objectStoreNames: { contains: (s: string) => stores.has(s) },
        createObjectStore: (s: string) => stores.set(s, new Map()),
        transaction(storeName: string, mode: string) {
          const tx = { oncomplete: null as null | (() => void), onerror: null, onabort: null, error: null,
            objectStore() {
              const store = stores.get(storeName)!;
              const done = () => later(() => tx.oncomplete?.());
              return {
                get: (k: string) => req(() => store.get(k), done),
                put: (v: unknown, k: string) => {
                  if (mode !== "readwrite") throw new Error("read-only transaction");
                  return req(() => (store.set(k, structuredClone(v)), k), done);
                },
                delete: (k: string) => req(() => (store.delete(k), undefined), done),
              };
            } };
          return tx;
        },
      };
      const r = { result: db, error: null, onsuccess: null as null | (() => void), onerror: null, onblocked: null, onupgradeneeded: null as null | (() => void) };
      later(() => {
        if (isNew) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
  return factory as unknown as IDBFactory & { opens: number };
}
