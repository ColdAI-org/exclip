/** Client for /api/exclip/wallet (apps/server), on the wallet's own origin: the server, or a proxy in front of it,
 * routes /api there. Only ciphertext (the vault's passkey backup blob) and WebAuthn responses leave this page: never a
 * wallet address (the hub-account lookup goes straight to Sonic, sodax/hub.ts). */
import type { AuthenticationJson, Challenge, RegistrationJson } from "./webauthn.ts";

export const API_BASE = "/api/exclip/wallet";
const B64U = /^[A-Za-z0-9_-]+$/;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** The text the popup shows for each server error code. The server's own `message` is never shown: a compromised
 * server could otherwise put its words ("type your recovery phrase at ...") inside the wallet origin.
 * A code not listed here becomes "ERROR" and gets the generic text. */
export const SERVICE_MESSAGES = {
  NOT_VERIFIED: "That passkey couldn't be verified. Try again.",
  BAD_REQUEST: "The wallet service refused the request. Try again.",
  CONFLICT: "Something changed at the same time. Try again.",
  UNAVAILABLE: "The wallet service is busy. Try again shortly.",
  BACKUP_INVALID: "The wallet service refused the backup. Nothing was saved.",
  SIGNUPS_PAUSED: "New wallets are paused for today. Try again tomorrow.",
  BACKUP_FULL: "This passkey has no room for another backup. Add a new passkey in Manage.",
  FORBIDDEN: "The wallet service refused the request.",
  NOT_FOUND: "The wallet service isn't available.",
  RATE_LIMITED: "Too many attempts. Wait a minute and try again.",
  ERROR: "The wallet service returned an error. Try again.",
  // Ours, not the server's: no answer at all, or an answer that doesn't parse.
  NETWORK: "The wallet service couldn't be reached. Check your connection.",
  BAD_RESPONSE: "The wallet service returned something unexpected.",
} as const;
export type ServiceCode = keyof typeof SERVICE_MESSAGES;

/** Only the code is taken from the server, and only if it is one we know; a proxy's 429 without our body is still a rate limit. */
export function serviceError(status: number, code: unknown): ApiError {
  const known = typeof code === "string" && Object.hasOwn(SERVICE_MESSAGES, code) ? (code as ServiceCode) : status === 429 ? "RATE_LIMITED" : "ERROR";
  return new ApiError(status, known, SERVICE_MESSAGES[known]);
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

export type StoredBackup = { version: number; backup: string };
/** More than the server's cap (exclip.config.ts wallet.maxBackupVersions allows up to 1,000) is refused as malformed. */
export const MAX_FETCHED_VERSIONS = 1_000;

/** A server challenge is accepted only by the operation it was issued for. */
export type ChallengePurpose = "register" | "fetch" | "append" | "retire";

export type WalletApi = {
  challenge(purpose: ChallengePurpose): Promise<Challenge>;
  /** `assertion`: a late registration, a fresh assertion by the same passkey on a "register" challenge. */
  register(response: RegistrationJson, backup: string, assertion?: AuthenticationJson): Promise<{ backedUp: boolean; deviceType: string }>;
  /** Every stored version, newest first. */
  fetchBackup(response: AuthenticationJson): Promise<{ backups: StoredBackup[] }>;
  appendBackup(response: AuthenticationJson, backup: string): Promise<{ version: number }>;
};

export function createApi(fetchImpl: FetchLike = (u, i) => fetch(u, i), timeoutMs = 20_000): WalletApi {
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(API_BASE + path, {
        method,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
    } catch {
      throw serviceError(0, "NETWORK");
    } finally {
      if (timer) clearTimeout(timer);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    const obj = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
    if (!res.ok) throw serviceError(res.status, ((obj.error ?? {}) as { code?: unknown }).code);
    return obj;
  }
  const bad = () => serviceError(502, "BAD_RESPONSE");

  return {
    async challenge(purpose) {
      const r = await call("POST", "/challenge", { purpose });
      if (typeof r.challenge !== "string" || !B64U.test(r.challenge) || typeof r.rpId !== "string" || typeof r.timeoutMs !== "number") throw bad();
      return { challenge: r.challenge, rpId: r.rpId, timeoutMs: r.timeoutMs };
    },
    async register(response, backup, assertion) {
      const r = await call("POST", "/credentials", assertion ? { response, backup, assertion } : { response, backup });
      return { backedUp: r.backedUp === true, deviceType: typeof r.deviceType === "string" ? r.deviceType : "unknown" };
    },
    async fetchBackup(response) {
      const r = await call("POST", "/backup/fetch", { response });
      const list = r.backups;
      if (!Array.isArray(list) || !list.length || list.length > MAX_FETCHED_VERSIONS) throw bad();
      const backups: StoredBackup[] = [];
      for (const item of list as unknown[]) {
        const b = item as Partial<StoredBackup> | null;
        if (!b || typeof b.backup !== "string" || !B64U.test(b.backup) || !Number.isSafeInteger(b.version) || b.version! < 1) throw bad();
        // Strictly newest first, so "try in order" means "newest first".
        if (backups.length && b.version! >= backups[backups.length - 1]!.version) throw bad();
        backups.push({ version: b.version!, backup: b.backup });
      }
      return { backups };
    },
    async appendBackup(response, backup) {
      const r = await call("POST", "/backup", { response, backup });
      if (typeof r.version !== "number") throw bad();
      return { version: r.version };
    },
  };
}
