/** /api/exclip/wallet: the passkey wallet's encrypted-backup API. Served to the wallet origin only, behind
 * features.embeddedWallet (off → 404).
 *
 * Every read and write of a backup is authorised by WebAuthn: registration verification at create, a fresh
 * user-verified assertion against the stored public key for fetch, append and retire. Expected origin = the wallet
 * origin, expected rpId = its host. Challenges are single use with a short TTL, issued for one operation and
 * accepted only by that one. Errors are generic, bodies are schema-checked with unknown fields refused, and nothing
 * about a request (body, credential id, IP) is logged. */
import { Router, type RequestHandler, type Response } from "express";
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { ServerConfig } from "../services/config.ts";
import type { KvStore } from "../kv.ts";
import { kvRateConsume, publicRateLimit } from "../rateLimit.ts";
import {
  CHALLENGE_PURPOSES,
  CHALLENGE_TTL_MS,
  RETIRED_RETENTION_MS,
  countNewCredential,
  createChallengeStore,
  isCredentialId,
  parseBackupBlob,
  toBase64Url,
  type ChallengePurpose,
  type WalletCredential,
  type WalletStore,
} from "../services/walletBackup.ts";

/** ES256 and EdDSA only. */
export const WALLET_COSE_ALGS = [-7, -8];

export type WalletRouterOptions = {
  config: ServerConfig;
  store: WalletStore;
  kv: KvStore;
  now?: () => number;
  /** Per-IP limits. Defaults: limits in the shared KV store, failing closed (these routes guard money). */
  challengeLimit?: RequestHandler;
  writeLimit?: RequestHandler;
  /** Operational alerts, as codes only (EXCLIP_WALLET_*); never request data. */
  onError?: (code: string) => void;
};

type Fail = { status: number; code: string; message: string };
const NOT_VERIFIED: Fail = { status: 401, code: "NOT_VERIFIED", message: "That passkey couldn't be verified. Try again." };
const BAD_REQUEST: Fail = { status: 400, code: "BAD_REQUEST", message: "That request isn't valid." };
const FORBIDDEN: Fail = { status: 403, code: "FORBIDDEN", message: "Not allowed." };
const CONFLICT: Fail = { status: 409, code: "CONFLICT", message: "Something changed at the same time. Try again." };
const UNAVAILABLE: Fail = { status: 503, code: "UNAVAILABLE", message: "The wallet service is busy. Try again shortly." };
const SIGNUPS_PAUSED: Fail = { status: 429, code: "SIGNUPS_PAUSED", message: "New wallets are paused for today. Try again tomorrow." };
const BACKUP_FULL: Fail = { status: 409, code: "BACKUP_FULL", message: "This passkey has no room for another backup." };
const BACKUP_INVALID: Fail = { status: 413, code: "BACKUP_INVALID", message: "That backup is too large or not a wallet backup." };

function fail(res: Response, f: Fail) {
  res.status(f.status).json({ error: { code: f.code, message: f.message } });
}

/** The body is a plain object with exactly these keys (optional ones may be absent), nothing else. */
function exact(body: unknown, required: string[], optional: string[] = []): body is Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

const B64 = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);

/** Shape check before the WebAuthn library sees it: bounded strings, no extra keys at the top level. */
function isRegistrationJson(v: unknown): v is RegistrationResponseJSON {
  if (!exact(v, ["id", "rawId", "type", "response", "clientExtensionResults"], ["authenticatorAttachment"])) return false;
  const r = v.response as Record<string, unknown> | null;
  return isCredentialId(v.id) && v.rawId === v.id && v.type === "public-key"
    && typeof r === "object" && r !== null && B64(r.clientDataJSON, 4096) && B64(r.attestationObject, 8192)
    && typeof v.clientExtensionResults === "object" && v.clientExtensionResults !== null;
}

function isAuthenticationJson(v: unknown): v is AuthenticationResponseJSON {
  if (!exact(v, ["id", "rawId", "type", "response", "clientExtensionResults"], ["authenticatorAttachment"])) return false;
  const r = v.response as Record<string, unknown> | null;
  return isCredentialId(v.id) && v.rawId === v.id && v.type === "public-key"
    && typeof r === "object" && r !== null && B64(r.clientDataJSON, 4096) && B64(r.authenticatorData, 4096) && B64(r.signature, 1024)
    && typeof v.clientExtensionResults === "object" && v.clientExtensionResults !== null;
}

const TRANSPORTS = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);

export function createWalletRouter(options: WalletRouterOptions): Router {
  const { config, store, kv } = options;
  const now = options.now ?? Date.now;
  const challenges = createChallengeStore(kv, now);
  const challengeLimit = options.challengeLimit ?? publicRateLimit("exclip-wallet-challenge", 30, kvRateConsume(kv), { onUnavailable: "closed" });
  const writeLimit = options.writeLimit ?? publicRateLimit("exclip-wallet-write", 20, kvRateConsume(kv), { onUnavailable: "closed" });
  const onError = options.onError ?? (() => {});
  const expected = { expectedOrigin: config.walletOrigin, expectedRPID: config.walletRpId, requireUserVerification: true };

  const router = Router();

  // Off → the routes don't exist. On → only the wallet origin may call them (browsers always send Origin on POST).
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!config.embeddedWallet) { res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found." } }); return; }
    const origin = req.get("origin");
    if (origin !== undefined && origin !== config.walletOrigin) { fail(res, FORBIDDEN); return; }
    if (req.method === "POST" && origin === undefined) { fail(res, FORBIDDEN); return; }
    next();
  });

  /** Verifies a fresh assertion, made on a challenge issued for exactly this operation, against the stored key and
   * advances the sign count. */
  async function assert(response: AuthenticationResponseJSON, purpose: Exclude<ChallengePurpose, "register">): Promise<WalletCredential | Fail> {
    const credential = await store.getCredential(response.id);
    if (!credential || credential.retiredAt || credential.rpId !== config.walletRpId) {
      // Spend the challenge anyway, so a probe can't keep it alive for a second try.
      const claimed = challengeOf(response.response.clientDataJSON);
      if (claimed) await challenges.consume(claimed, purpose);
      return NOT_VERIFIED;
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        ...expected,
        expectedChallenge: (c: string) => challenges.consume(c, purpose),
        credential: { id: credential.credentialId, publicKey: new Uint8Array(credential.publicKey), counter: credential.signCount, transports: credential.transports as never },
      });
    } catch {
      return NOT_VERIFIED;
    }
    const info = verification.authenticationInfo;
    if (!verification.verified || !info.userVerified || info.rpID !== config.walletRpId || info.origin !== config.walletOrigin) return NOT_VERIFIED;
    // Sign-count rule (WebAuthn §6.1.1): when either side is nonzero, the new count must move forward.
    if ((info.newCounter > 0 || credential.signCount > 0) && info.newCounter <= credential.signCount) return NOT_VERIFIED;
    if (!(await store.recordUse(credential.credentialId, credential.signCount, info.newCounter, new Date(now())))) return CONFLICT;
    return { ...credential, signCount: info.newCounter };
  }

  router.post("/challenge", challengeLimit, async (req, res) => {
    if (!exact(req.body, ["purpose"]) || !CHALLENGE_PURPOSES.includes(req.body.purpose as ChallengePurpose)) return fail(res, BAD_REQUEST);
    try {
      const challenge = await challenges.issue(req.body.purpose as ChallengePurpose);
      res.json({ challenge, rpId: config.walletRpId, timeoutMs: CHALLENGE_TTL_MS });
    } catch {
      onError("EXCLIP_WALLET_KV");
      fail(res, UNAVAILABLE);
    }
  });

  /** Registration, fresh or late. Fresh: the registration's own challenge (purpose "register"). Late (the wallet's
   * "retry server backup" when the upload at create failed): the original registration, whose challenge is long
   * spent, plus `assertion`, a fresh user-verified assertion by that same credential on a new "register" challenge,
   * verified against the registration's public key. With attestation "none" nothing in a registration is signed, so
   * the assertion is the only proof either way, and the late path proves possession just as strongly. */
  router.post("/credentials", writeLimit, async (req, res) => {
    if (!exact(req.body, ["response", "backup"], ["assertion"]) || !isRegistrationJson(req.body.response)) return fail(res, BAD_REQUEST);
    const response = req.body.response;
    const late = req.body.assertion !== undefined;
    if (late && (!isAuthenticationJson(req.body.assertion) || req.body.assertion.id !== response.id)) return fail(res, BAD_REQUEST);
    const assertion = late ? (req.body.assertion as AuthenticationResponseJSON) : null;
    const blob = parseBackupBlob(req.body.backup);
    if (!blob) return fail(res, BACKUP_INVALID);
    try {
      // Late: spend the assertion's challenge first, whatever happens next.
      const lateChallenge = assertion ? challengeOf(assertion.response.clientDataJSON) : null;
      const lateChallengeOk = !!lateChallenge && (await challenges.consume(lateChallenge, "register"));
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response, ...expected, supportedAlgorithmIDs: WALLET_COSE_ALGS,
          expectedChallenge: late ? () => true : (c: string) => challenges.consume(c, "register"),
        });
      } catch {
        return fail(res, NOT_VERIFIED);
      }
      if (!verification.verified) return fail(res, NOT_VERIFIED);
      const info = verification.registrationInfo;
      if (!info.userVerified || info.rpID !== config.walletRpId || info.origin !== config.walletOrigin || info.credential.id !== response.id) {
        return fail(res, NOT_VERIFIED);
      }
      let signCount = info.credential.counter;
      if (assertion) {
        if (!lateChallengeOk) return fail(res, NOT_VERIFIED);
        let proof;
        try {
          proof = await verifyAuthenticationResponse({
            response: assertion, ...expected,
            expectedChallenge: (c: string) => c === lateChallenge,
            credential: { id: info.credential.id, publicKey: info.credential.publicKey, counter: info.credential.counter },
          });
        } catch {
          return fail(res, NOT_VERIFIED);
        }
        const p = proof.authenticationInfo;
        if (!proof.verified || !p.userVerified || p.rpID !== config.walletRpId || p.origin !== config.walletOrigin) return fail(res, NOT_VERIFIED);
        if ((p.newCounter > 0 || signCount > 0) && p.newCounter <= signCount) return fail(res, NOT_VERIFIED);
        signCount = p.newCounter;
      }
      // A server-wide daily allowance of new passkeys. Counted only for verified registrations; KV down → refused
      // (the outer catch). Alerts at 80% and when it runs out, through onError (codes only, no request data).
      const cap = config.walletDailyCredentials;
      const today = await countNewCredential(kv, now(), cap);
      if (today.count === Math.ceil(cap * 0.8)) onError("EXCLIP_WALLET_SIGNUPS_80PCT");
      if (!today.allowed) {
        if (today.count === cap + 1) onError("EXCLIP_WALLET_SIGNUPS_PAUSED");
        return fail(res, SIGNUPS_PAUSED);
      }
      const transports = (response.response.transports ?? []).filter((t) => TRANSPORTS.has(t)).slice(0, 8);
      const at = new Date(now());
      const created = await store.createCredential({
        credentialId: info.credential.id, publicKey: info.credential.publicKey, rpId: config.walletRpId,
        signCount, transports,
      }, blob, at);
      if (created === "exists") return fail(res, CONFLICT);
      store.purgeRetired(new Date(now() - RETIRED_RETENTION_MS)).catch(() => onError("EXCLIP_WALLET_PURGE"));
      res.status(201).json({ version: 1, backedUp: info.credentialBackedUp, deviceType: info.credentialDeviceType });
    } catch {
      onError("EXCLIP_WALLET_STORE");
      fail(res, UNAVAILABLE);
    }
  });

  router.post("/backup/fetch", writeLimit, async (req, res) => {
    if (!exact(req.body, ["response"]) || !isAuthenticationJson(req.body.response)) return fail(res, BAD_REQUEST);
    try {
      const credential = await assert(req.body.response, "fetch");
      if ("status" in credential) return fail(res, credential);
      // Every stored version (up to the cap), newest first: if the newest doesn't decrypt (a bad append), the wallet
      // falls back to an older one with this same assertion.
      const recent = await store.recentBackups(credential.credentialId, config.walletMaxVersions);
      if (!recent.length) return fail(res, NOT_VERIFIED);
      res.json({ backups: recent.map((b) => ({ version: b.version, backup: toBase64Url(b.blob) })) });
    } catch {
      onError("EXCLIP_WALLET_STORE");
      fail(res, UNAVAILABLE);
    }
  });

  router.post("/backup", writeLimit, async (req, res) => {
    if (!exact(req.body, ["response", "backup"]) || !isAuthenticationJson(req.body.response)) return fail(res, BAD_REQUEST);
    const blob = parseBackupBlob(req.body.backup);
    if (!blob) return fail(res, BACKUP_INVALID);
    try {
      const credential = await assert(req.body.response, "append");
      if ("status" in credential) return fail(res, credential);
      const version = await store.appendBackup(credential.credentialId, blob, new Date(now()), config.walletMaxVersions);
      if (version === "full") {
        onError("EXCLIP_WALLET_BACKUP_FULL");
        return fail(res, BACKUP_FULL);
      }
      res.status(201).json({ version });
    } catch {
      onError("EXCLIP_WALLET_STORE");
      fail(res, UNAVAILABLE);
    }
  });

  router.post("/credentials/retire", writeLimit, async (req, res) => {
    if (!exact(req.body, ["response"]) || !isAuthenticationJson(req.body.response)) return fail(res, BAD_REQUEST);
    try {
      const credential = await assert(req.body.response, "retire");
      if ("status" in credential) return fail(res, credential);
      await store.retireCredential(credential.credentialId, new Date(now()));
      res.json({ retired: true, purgeAfterDays: RETIRED_RETENTION_MS / 86_400_000 });
    } catch {
      onError("EXCLIP_WALLET_STORE");
      fail(res, UNAVAILABLE);
    }
  });

  // No hub-wallet lookup here: the wallet reads the SODAX factory on Sonic itself, so this server never learns a
  // wallet address and can't name the hub account a deposit goes to.

  return router;
}

/** The challenge a client data blob claims (only to spend it on an early refusal; verification re-checks it). */
function challengeOf(clientDataJSON: string): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as { challenge?: unknown };
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}
