/** /api/exclip/wallet: WebAuthn-guarded encrypted backups for the passkey wallet. A software authenticator
 * (node:crypto keys, CBOR from @simplewebauthn/server/helpers) produces real registration and assertion responses;
 * the KV store and the wallet store are in memory; the clock is injected. No real keys or phrases are involved:
 * backups are random bytes behind the ClipVault header. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign as nodeSign, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { ConfigError, DEV_ORIGINS, resolveConfig, type ExclipConfigInput } from "@exclip/config";
import { createExclipRouter } from "../src/routes/exclip.ts";
import { publicConfig, serverConfig } from "../src/services/config.ts";
import { createChallengeStore, createMemoryWalletStore, BACKUP_MAX_BYTES, RETIRED_RETENTION_MS, type ChallengePurpose } from "../src/services/walletBackup.ts";
import { createMemoryKv } from "../src/kv.ts";
import { publicRateLimit } from "../src/rateLimit.ts";

const ORIGIN = "https://wallet.example.com";
const RP_ID = "wallet.example.com";
const APP_ORIGIN = "https://exclip.example.com";
const PARENT_DOMAIN = "example.com";
const pass: express.RequestHandler = (_req, _res, next) => next();
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | Buffer | string) => createHash("sha256").update(b).digest();

/** ClipVault backup header ("CLPB" | 0x01) + random filler: shape-valid, content meaningless. */
function fakeBackup(size = 101): string {
  const bytes = randomBytes(size);
  bytes.set([0x43, 0x4c, 0x50, 0x42, 0x01], 0);
  return b64u(bytes);
}

type Alg = "ES256" | "EdDSA" | "RS256";

/** A software passkey: real keys, real CBOR, real signatures. */
class SoftAuthenticator {
  readonly id = randomBytes(32);
  readonly alg: Alg;
  readonly key: KeyObject;
  readonly cose: Uint8Array;
  counter = 0;
  constructor(alg: Alg = "ES256") {
    this.alg = alg;
    if (alg === "ES256") {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const jwk = publicKey.export({ format: "jwk" });
      this.key = privateKey;
      this.cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    } else if (alg === "EdDSA") {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const jwk = publicKey.export({ format: "jwk" });
      this.key = privateKey;
      this.cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x!, "base64url")]]));
    } else {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const jwk = publicKey.export({ format: "jwk" });
      this.key = privateKey;
      this.cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 3], [3, -257],
        [-1, Buffer.from(jwk.n!, "base64url")], [-2, Buffer.from(jwk.e!, "base64url")]]));
    }
  }
  get credentialId() { return b64u(this.id); }

  private authData(rpId: string, flags: number, attested: boolean) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const parts: Uint8Array[] = [sha256(rpId), Buffer.from([flags]), count];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.id.length);
      parts.push(Buffer.alloc(16), len, this.id, this.cose);
    }
    return Buffer.concat(parts);
  }

  register(challenge: string, o: { origin?: string; rpId?: string; uv?: boolean } = {}) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }));
    const flags = 0x01 | (o.uv === false ? 0 : 0x04) | 0x40;
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData(o.rpId ?? RP_ID, flags, true)]]) as never);
    return {
      id: this.credentialId, rawId: this.credentialId, type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal", "hybrid"] },
      clientExtensionResults: {}, authenticatorAttachment: "platform",
    };
  }

  assert(challenge: string, o: { origin?: string; rpId?: string; uv?: boolean; counter?: number } = {}) {
    this.counter = o.counter ?? this.counter + 1;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }));
    const authenticatorData = this.authData(o.rpId ?? RP_ID, 0x01 | (o.uv === false ? 0 : 0x04), false);
    const data = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
    const signature = nodeSign(this.alg === "EdDSA" ? null : "sha256", data, this.key);
    return {
      id: this.credentialId, rawId: this.credentialId, type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature) },
      clientExtensionResults: {},
    };
  }
}

type Json = {
  error?: { code: string; message: string };
  version?: number;
  challenge?: string;
  backups?: Array<{ version: number; backup: string }>;
  [key: string]: unknown;
};

async function serve(options: { input?: ExclipConfigInput; clock?: { t: number }; writeLimit?: express.RequestHandler; dev?: boolean } = {}) {
  const clock = options.clock ?? { t: Date.UTC(2026, 9, 16, 12) };
  const store = createMemoryWalletStore();
  const kv = createMemoryKv(() => clock.t);
  const errors: string[] = [];
  const { config, secrets } = resolveConfig(options.input ?? {});
  const app = express();
  app.set("trust proxy", true);
  app.use("/api/exclip", createExclipRouter({
    config: serverConfig(config, secrets, options.dev ?? false), kv, walletStore: store,
    now: () => clock.t, readLimit: pass, proxyLimit: pass, onError: (c) => errors.push(c),
    wallet: { challengeLimit: pass, writeLimit: options.writeLimit ?? pass },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/exclip/wallet`;
  const origin = options.dev ? DEV_ORIGINS.wallet : ORIGIN;
  const post = async (p: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + p, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin, ...headers } });
    return { status: res.status, headers: res.headers, body: (await res.json()) as Json };
  };
  const challenge = async (purpose: ChallengePurpose) => (await post("/challenge", { purpose })).body.challenge as string;
  const register = async (auth: SoftAuthenticator, backup = fakeBackup()) =>
    post("/credentials", { response: auth.register(await challenge("register")), backup });
  return { base, post, challenge, register, store, errors, clock, close: () => new Promise((r) => server.close(r)) };
}

// ---- switch + config --------------------------------------------------------------------------------------

test("wallet routes are 404 while features.embeddedWallet is off", async (t) => {
  const s = await serve({ input: { features: { embeddedWallet: false } } });
  t.after(s.close);
  for (const r of [await s.post("/challenge", { purpose: "register" }), await s.post("/backup/fetch", {})]) {
    assert.equal(r.status, 404);
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
});

test("config: the wallet origin is origins.wallet in production and DEV_ORIGINS.wallet in development; the rpId is its host", () => {
  const { config, secrets } = resolveConfig({ origins: { app: "https://swap.example.org", wallet: "https://keys.example.net" } });
  const production = serverConfig(config, secrets, false);
  assert.equal(production.walletOrigin, "https://keys.example.net");
  assert.equal(production.walletRpId, "keys.example.net", "the wallet host itself, never a parent domain");
  const dev = serverConfig(config, secrets, true);
  assert.equal(dev.walletOrigin, DEV_ORIGINS.wallet);
  assert.equal(dev.walletRpId, "localhost");
  // The origin comes only from the file: the environment can't move it.
  const fromEnv = resolveConfig({}, { EXCLIP_WALLET_ORIGIN: "https://evil.example", WALLET_ORIGIN: "https://evil.example" });
  assert.equal(serverConfig(fromEnv.config, fromEnv.secrets, false).walletOrigin, ORIGIN);
  // A wallet on the app's host, or on a parent of it, could share passkeys with the app: refused at start.
  assert.throws(() => resolveConfig({ origins: { app: "https://example.org", wallet: "https://example.org" } }), ConfigError);
  assert.throws(() => resolveConfig({ origins: { app: "https://app.example.org", wallet: "https://example.org" } }), ConfigError);
  assert.throws(() => resolveConfig({ origins: { wallet: "http://wallet.example.org" } }), ConfigError);
});

test("development: the wallet API answers the localhost wallet origin only", async (t) => {
  const s = await serve({ dev: true });
  t.after(s.close);
  const a = new SoftAuthenticator();
  const c = await s.challenge("register");
  assert.ok(c);
  const reg = await s.post("/credentials", { response: a.register(c, { origin: DEV_ORIGINS.wallet, rpId: "localhost" }), backup: fakeBackup() });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const fetched = await s.post("/backup/fetch", { response: a.assert(await s.challenge("fetch"), { origin: DEV_ORIGINS.wallet, rpId: "localhost" }) });
  assert.equal(fetched.status, 200);
  assert.equal((await s.post("/challenge", { purpose: "fetch" }, { origin: ORIGIN })).status, 403, "the production origin is not the dev wallet");
});

test("/config exposes the passkey wallet switch, origin and unbacked limit (and nothing secret)", async (t) => {
  const { config, secrets } = resolveConfig({}, { SODAX_API_KEY: "test-key-not-real" });
  const app = express();
  app.use("/api/exclip", createExclipRouter({ config: serverConfig(config, secrets, false), kv: createMemoryKv(), walletStore: createMemoryWalletStore(), readLimit: pass, proxyLimit: pass }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/exclip/config`)).json() as Record<string, unknown>;
  assert.equal(body.embeddedWallet, true);
  assert.equal(body.walletOrigin, ORIGIN);
  assert.equal(body.unbackedLimitUsd, 100);
  assert.ok(!JSON.stringify(body).includes("test-key-not-real"));
  const off = resolveConfig({ features: { embeddedWallet: false } });
  assert.equal(publicConfig(serverConfig(off.config, off.secrets, false)).walletOrigin, null);
});

// ---- registration + assertion ------------------------------------------------------------------------------

test("register (ES256) stores the public key + backup v1; a fresh assertion fetches it back", async (t) => {
  const s = await serve();
  t.after(s.close);
  const auth = new SoftAuthenticator("ES256");
  const backup = fakeBackup();
  const reg = await s.register(auth, backup);
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.equal(reg.body.version, 1);
  assert.equal(reg.headers.get("cache-control"), "no-store");

  const { credentials, backups } = s.store.dump();
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0]!.credentialId, auth.credentialId);
  assert.equal(credentials[0]!.rpId, RP_ID);
  assert.deepEqual(credentials[0]!.transports, ["internal", "hybrid"]);
  assert.deepEqual(Buffer.from(credentials[0]!.publicKey), Buffer.from(auth.cose));
  assert.equal(backups.length, 1);

  const fetched = await s.post("/backup/fetch", { response: auth.assert(await s.challenge("fetch")) });
  assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
  assert.deepEqual(fetched.body, { backups: [{ version: 1, backup }] });
  assert.equal((await s.store.getCredential(auth.credentialId))!.signCount, 1);
});

test("EdDSA passkeys are accepted; RS256 is refused (ES256 + EdDSA only)", async (t) => {
  const s = await serve();
  t.after(s.close);
  const ed = new SoftAuthenticator("EdDSA");
  assert.equal((await s.register(ed)).status, 201);
  assert.equal((await s.post("/backup/fetch", { response: ed.assert(await s.challenge("fetch")) })).status, 200);
  assert.equal((await s.register(new SoftAuthenticator("RS256"))).status, 401);
});

test("challenges are single use: a replayed registration or assertion is refused", async (t) => {
  const s = await serve();
  t.after(s.close);
  const auth = new SoftAuthenticator();
  const c = await s.challenge("register");
  const response = auth.register(c);
  assert.equal((await s.post("/credentials", { response, backup: fakeBackup() })).status, 201);
  const again = await s.post("/credentials", { response, backup: fakeBackup() });
  assert.equal(again.status, 401);

  const ac = await s.challenge("fetch");
  assert.equal((await s.post("/backup/fetch", { response: auth.assert(ac) })).status, 200);
  assert.equal((await s.post("/backup/fetch", { response: auth.assert(ac) })).status, 401);
});

test("challenges expire after two minutes and are bound to their purpose", async (t) => {
  const clock = { t: Date.UTC(2026, 9, 16, 12) };
  const s = await serve({ clock });
  t.after(s.close);
  const auth = new SoftAuthenticator();
  const c = await s.challenge("register");
  clock.t += 121_000;
  assert.equal((await s.post("/credentials", { response: auth.register(c), backup: fakeBackup() })).status, 401);
  assert.equal((await s.register(auth)).status, 201);
  // A registration challenge can't authorise a backup read.
  assert.equal((await s.post("/backup/fetch", { response: auth.assert(await s.challenge("register")) })).status, 401);
});

test("an assertion authorises only the operation its challenge was issued for", async (t) => {
  const s = await serve();
  t.after(s.close);
  const a = new SoftAuthenticator();
  assert.equal((await s.register(a)).status, 201);
  const ops = {
    fetch: (response: unknown) => s.post("/backup/fetch", { response }),
    append: (response: unknown) => s.post("/backup", { response, backup: fakeBackup() }),
    retire: (response: unknown) => s.post("/credentials/retire", { response }),
  };
  // Every wrong pairing is refused, and the challenge is spent by the refusal (it can't be retried on the right route).
  for (const [issued, spentOn] of [["fetch", "retire"], ["fetch", "append"], ["append", "fetch"], ["append", "retire"], ["retire", "fetch"], ["retire", "append"]] as const) {
    const response = a.assert(await s.challenge(issued));
    assert.equal((await ops[spentOn](response)).status, 401, `${issued} → ${spentOn}`);
    assert.equal((await ops[issued](response)).status, 401, `${issued} challenge spent`);
  }
  assert.equal(s.store.dump().backups.length, 1, "nothing was appended");
  assert.equal(s.store.dump().credentials[0]!.retiredAt, null, "nothing was retired");
  // There is no catch-all purpose.
  assert.equal((await s.post("/challenge", { purpose: "authenticate" })).status, 400);
  // The right pairings still work.
  assert.equal((await ops.fetch(a.assert(await s.challenge("fetch")))).status, 200);
  assert.equal((await ops.append(a.assert(await s.challenge("append")))).status, 201);
  assert.equal((await ops.retire(a.assert(await s.challenge("retire")))).status, 200);
});

test("challenge store: concurrent consumers, exactly one wins", async () => {
  const store = createChallengeStore(createMemoryKv(), () => 1_000);
  const c = await store.issue("fetch");
  const results = await Promise.all([store.consume(c, "fetch"), store.consume(c, "fetch"), store.consume(c, "fetch")]);
  assert.deepEqual(results.filter(Boolean).length, 1);
  assert.equal(await store.consume("not-a-challenge", "fetch"), false);
  // The wrong purpose fails, and spends the challenge.
  const d = await store.issue("fetch");
  assert.equal(await store.consume(d, "retire"), false);
  assert.equal(await store.consume(d, "fetch"), false);
});

test("wrong origin or wrong rpId (the parent domain) in the ceremony is refused", async (t) => {
  const s = await serve();
  t.after(s.close);
  const a = new SoftAuthenticator();
  assert.equal((await s.post("/credentials", { response: a.register(await s.challenge("register"), { origin: APP_ORIGIN }), backup: fakeBackup() })).status, 401);
  assert.equal((await s.post("/credentials", { response: a.register(await s.challenge("register"), { rpId: PARENT_DOMAIN }), backup: fakeBackup() })).status, 401);
  assert.equal((await s.register(a)).status, 201);
  assert.equal((await s.post("/backup/fetch", { response: a.assert(await s.challenge("fetch"), { origin: "https://evil.example" }) })).status, 401);
  assert.equal((await s.post("/backup/fetch", { response: a.assert(await s.challenge("fetch"), { rpId: PARENT_DOMAIN }) })).status, 401);
  // And the HTTP Origin itself must be the wallet origin; a POST without one is refused too.
  const cross = await s.post("/challenge", { purpose: "fetch" }, { origin: APP_ORIGIN });
  assert.equal(cross.status, 403);
  const bare = await fetch(`${s.base}/challenge`, { method: "POST", body: JSON.stringify({ purpose: "fetch" }), headers: { "content-type": "application/json" } });
  assert.equal(bare.status, 403);
});

test("user verification is required at registration and at every assertion", async (t) => {
  const s = await serve();
  t.after(s.close);
  const a = new SoftAuthenticator();
  assert.equal((await s.post("/credentials", { response: a.register(await s.challenge("register"), { uv: false }), backup: fakeBackup() })).status, 401);
  assert.equal((await s.register(a)).status, 201);
  assert.equal((await s.post("/backup/fetch", { response: a.assert(await s.challenge("fetch"), { uv: false }) })).status, 401);
});

test("a sign count that doesn't move forward is refused (cloned authenticator)", async (t) => {
  const s = await serve();
  t.after(s.close);
  const a = new SoftAuthenticator();
  assert.equal((await s.register(a)).status, 201);
  assert.equal((await s.post("/backup/fetch", { response: a.assert(await s.challenge("fetch"), { counter: 5 }) })).status, 200);
  assert.equal((await s.post("/backup/fetch", { response: a.assert(await s.challenge("fetch"), { counter: 5 }) })).status, 401);
  assert.equal((await s.post("/backup/fetch", { response: a.assert(await s.challenge("fetch"), { counter: 3 }) })).status, 401);
  assert.equal((await s.post("/backup/fetch", { response: a.assert(await s.challenge("fetch"), { counter: 6 }) })).status, 200);
});

test("an assertion from an unknown passkey is refused, and a registered id can't be registered twice", async (t) => {
  const s = await serve();
  t.after(s.close);
  const a = new SoftAuthenticator();
  assert.equal((await s.post("/backup/fetch", { response: a.assert(await s.challenge("fetch")) })).status, 401);
  assert.equal((await s.register(a)).status, 201);
  assert.equal((await s.register(a)).status, 409);
});

// ---- versions, size, retire --------------------------------------------------------------------------------

test("backups are append-only versions; fetch returns them all newest first; nothing is overwritten", async (t) => {
  const s = await serve();
  t.after(s.close);
  const a = new SoftAuthenticator();
  const v1 = fakeBackup(), v2 = fakeBackup(), v3 = fakeBackup(200);
  assert.equal((await s.register(a, v1)).status, 201);
  assert.deepEqual((await s.post("/backup", { response: a.assert(await s.challenge("append")), backup: v2 })).body, { version: 2 });
  assert.deepEqual((await s.post("/backup", { response: a.assert(await s.challenge("append")), backup: v3 })).body, { version: 3 });
  const all = await s.post("/backup/fetch", { response: a.assert(await s.challenge("fetch")) });
  assert.deepEqual(all.body, { backups: [{ version: 3, backup: v3 }, { version: 2, backup: v2 }, { version: 1, backup: v1 }] });
  assert.deepEqual(s.store.dump().backups.map((b) => [b.version, b64u(b.blob)]), [[1, v1], [2, v2], [3, v3]]);
  // At most wallet.maxBackupVersions of them (the newest).
  const capped = await serve({ input: { wallet: { maxBackupVersions: 2 } } });
  t.after(capped.close);
  const b = new SoftAuthenticator();
  await capped.register(b, v1);
  await capped.post("/backup", { response: b.assert(await capped.challenge("append")), backup: v2 });
  await capped.store.appendBackup(b.credentialId, Buffer.from(v3, "base64url"), new Date(), 99); // stored under an older, higher cap
  const fetched = await capped.post("/backup/fetch", { response: b.assert(await capped.challenge("fetch")) });
  assert.deepEqual(fetched.body.backups!.map((x) => x.version), [3, 2]);
});

test("late registration: the original registration plus a fresh assertion by the same key", async (t) => {
  const s = await serve();
  t.after(s.close);
  const a = new SoftAuthenticator();
  // Made at create; its upload failed and its challenge is long gone.
  const original = a.register(await s.challenge("register"));
  const late = async (assertion: unknown, response: unknown = original) => s.post("/credentials", { response, backup: fakeBackup(), assertion });

  // The assertion must be by the registered key, user-verified, on a fresh challenge issued for "register".
  assert.equal((await late(a.assert(await s.challenge("fetch")))).status, 401, "wrong purpose");
  assert.equal((await late(a.assert(await s.challenge("register"), { uv: false }))).status, 401, "no user verification");
  assert.equal((await late(a.assert("A".repeat(43)))).status, 401, "a challenge the server never issued");
  const other = new SoftAuthenticator();
  assert.equal((await late({ ...other.assert(await s.challenge("register")), id: a.credentialId, rawId: a.credentialId })).status, 401, "another key");
  assert.equal((await late(other.assert(await s.challenge("register")))).status, 400, "ids differ");
  assert.equal((await late(a.assert(await s.challenge("register"), { origin: APP_ORIGIN }))).status, 401, "wrong origin");
  assert.equal(s.store.dump().credentials.length, 0);

  const proof = a.assert(await s.challenge("register"), { counter: 7 });
  const ok = await late(proof);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(s.store.dump().credentials[0]!.signCount, 7, "the assertion's counter");
  assert.equal((await late(proof)).status, 401, "single use");
  assert.equal((await late(a.assert(await s.challenge("register")))).status, 409, "already on the server");
  // It then works like any other passkey.
  assert.equal((await s.post("/backup/fetch", { response: a.assert(await s.challenge("fetch")) })).status, 200);
});

test("caps: versions per passkey and new passkeys per day, from the config file with safe defaults", async (t) => {
  const defaults = resolveConfig({});
  const limits = serverConfig(defaults.config, defaults.secrets, false);
  assert.deepEqual([limits.walletMaxVersions, limits.walletDailyCredentials], [50, 2_000]);
  const set = resolveConfig({ wallet: { maxBackupVersions: 7, dailyNewPasskeys: 300 } });
  const setLimits = serverConfig(set.config, set.secrets, false);
  assert.deepEqual([setLimits.walletMaxVersions, setLimits.walletDailyCredentials], [7, 300]);
  for (const bad of [0, -1, 1.5, 1001]) assert.throws(() => resolveConfig({ wallet: { maxBackupVersions: bad } }), ConfigError, String(bad));
  for (const bad of [0, 1.5, 1_000_001]) assert.throws(() => resolveConfig({ wallet: { dailyNewPasskeys: bad } }), ConfigError, String(bad));

  // Versions: appends past the cap are refused; nothing is deleted to make room.
  const s = await serve({ input: { wallet: { maxBackupVersions: 3 } } });
  t.after(s.close);
  const a = new SoftAuthenticator();
  const v1 = fakeBackup();
  assert.equal((await s.register(a, v1)).status, 201);
  for (const v of [2, 3]) assert.deepEqual((await s.post("/backup", { response: a.assert(await s.challenge("append")), backup: fakeBackup() })).body, { version: v });
  const full = await s.post("/backup", { response: a.assert(await s.challenge("append")), backup: fakeBackup() });
  assert.equal(full.status, 409);
  assert.equal(full.body.error?.code, "BACKUP_FULL");
  assert.deepEqual(s.store.dump().backups.map((b) => b.version), [1, 2, 3]);
  assert.equal(b64u(s.store.dump().backups[0]!.blob), v1, "version 1 is still there");
  assert.deepEqual(s.errors, ["EXCLIP_WALLET_BACKUP_FULL"]);

  // New passkeys: a server-wide allowance per UTC day, alerting at 80% and when it runs out.
  const clock = { t: Date.UTC(2026, 9, 16, 23, 59) };
  const d = await serve({ clock, input: { wallet: { dailyNewPasskeys: 5 } } });
  t.after(d.close);
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) statuses.push((await d.register(new SoftAuthenticator())).status);
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429, 429]);
  assert.equal(d.store.dump().credentials.length, 5);
  assert.deepEqual(d.errors, ["EXCLIP_WALLET_SIGNUPS_80PCT", "EXCLIP_WALLET_SIGNUPS_PAUSED"], "each alert once");
  const paused = await d.register(new SoftAuthenticator());
  assert.deepEqual(paused.body, { error: { code: "SIGNUPS_PAUSED", message: "New wallets are paused for today. Try again tomorrow." } });
  // A registration that doesn't verify doesn't use the allowance up (counted after verification only).
  clock.t += 2 * 60_000; // the next UTC day
  assert.equal((await d.register(new SoftAuthenticator("RS256"))).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await d.register(new SoftAuthenticator())).status, 201);
  assert.equal((await d.register(new SoftAuthenticator())).status, 429);
});

test("backup size limit (16 KB) and format check", async (t) => {
  const s = await serve();
  t.after(s.close);
  const a = new SoftAuthenticator();
  assert.equal((await s.register(a, fakeBackup(BACKUP_MAX_BYTES + 1))).status, 413);
  assert.equal((await s.post("/credentials", { response: a.register(await s.challenge("register")), backup: b64u(randomBytes(120)) })).status, 413);
  assert.equal((await s.register(a, fakeBackup(BACKUP_MAX_BYTES))).status, 201);
  assert.equal(s.store.dump().credentials.length, 1);
});

test("unknown fields and malformed bodies are refused", async (t) => {
  const s = await serve();
  t.after(s.close);
  assert.equal((await s.post("/challenge", { purpose: "register", extra: 1 })).status, 400);
  assert.equal((await s.post("/challenge", { purpose: "sign" })).status, 400);
  const a = new SoftAuthenticator();
  const response = a.register(await s.challenge("register"));
  assert.equal((await s.post("/credentials", { response, backup: fakeBackup(), email: "x@example.com" })).status, 400);
  assert.equal((await s.post("/credentials", { response: { ...response, extra: true }, backup: fakeBackup() })).status, 400);
  assert.equal((await s.post("/backup/fetch", { response: "nope" })).status, 400);
});

test("retire marks the passkey retired (no hard delete); it is purged with its backups after 30 days", async (t) => {
  const clock = { t: Date.UTC(2026, 9, 16, 12) };
  const s = await serve({ clock });
  t.after(s.close);
  const a = new SoftAuthenticator();
  assert.equal((await s.register(a)).status, 201);
  const r = await s.post("/credentials/retire", { response: a.assert(await s.challenge("retire")) });
  assert.deepEqual(r.body, { retired: true, purgeAfterDays: 30 });
  assert.ok(s.store.dump().credentials[0]!.retiredAt);
  assert.equal(s.store.dump().backups.length, 1);
  assert.equal((await s.post("/backup/fetch", { response: a.assert(await s.challenge("fetch")) })).status, 401);
  clock.t += RETIRED_RETENTION_MS + 1;
  assert.equal((await s.register(new SoftAuthenticator())).status, 201);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.store.dump().credentials.map((c) => c.credentialId).includes(a.credentialId), false);
  assert.equal(s.store.dump().backups.length, 1);
});

// ---- limits, privacy ---------------------------------------------------------------------------------------

test("per-IP rate limit on writes", async (t) => {
  const limiter = publicRateLimit("exclip-wallet-test", 2, async () => true, { onUnavailable: "closed" });
  const s = await serve({ writeLimit: limiter });
  t.after(s.close);
  const a = new SoftAuthenticator();
  const ip = { "x-forwarded-for": "203.0.113.7" };
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await s.post("/backup/fetch", { response: a.assert(await s.challenge("fetch")) }, ip)).status);
  assert.deepEqual(statuses, [401, 401, 429]);
});

test("the default wallet limits fail closed when the shared store is down", async (t) => {
  const { config, secrets } = resolveConfig({});
  const down = createMemoryKv();
  down.slidingWindowAdd = async () => { throw new Error("store down"); };
  const warned: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args); };
  t.after(() => { console.warn = original; });
  const app = express();
  app.use("/api/exclip", createExclipRouter({ config: serverConfig(config, secrets, false), kv: down, walletStore: createMemoryWalletStore(), readLimit: pass, proxyLimit: pass }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/exclip/wallet/challenge`, {
    method: "POST", body: JSON.stringify({ purpose: "fetch" }), headers: { "content-type": "application/json", origin: ORIGIN },
  });
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as Json).error?.code, "RATE_LIMIT_UNAVAILABLE");
  assert.equal(warned.length, 1);
});

test("no secret or personal data in responses, storage or logs", async (t) => {
  const logged: unknown[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(originals) as Array<keyof typeof originals>) console[k] = (...args: unknown[]) => { logged.push(args); };
  t.after(() => Object.assign(console, originals));
  const s = await serve();
  t.after(s.close);
  const a = new SoftAuthenticator();
  const backup = fakeBackup();
  await s.register(a, backup);
  const bad = await s.post("/backup/fetch", { response: new SoftAuthenticator().assert(await s.challenge("fetch")) }, { "x-forwarded-for": "198.51.100.9" });
  assert.deepEqual(bad.body, { error: { code: "NOT_VERIFIED", message: "That passkey couldn't be verified. Try again." } });
  const stored = JSON.stringify(s.store.dump(), (_k, v: unknown) => (v instanceof Uint8Array ? b64u(v) : v));
  assert.ok(!stored.includes("198.51.100.9") && !stored.includes("127.0.0.1"));
  assert.deepEqual(Object.keys(s.store.dump().credentials[0]!).sort(), ["createdAt", "credentialId", "lastUsedAt", "publicKey", "retiredAt", "rpId", "signCount", "transports"]);
  assert.deepEqual(logged, []);
  assert.deepEqual(s.errors, []);
});

// ---- no hub wallet lookup ----------------------------------------------------------------------------------

test("no hub-wallet route: the wallet reads the SODAX factory itself; no wallet address reaches this server", async (t) => {
  const s = await serve();
  t.after(s.close);
  const addr = "0x" + "12".repeat(20);
  for (const chain of ["0x2105.base", "sonic"]) {
    const res = await fetch(`${s.base}/hub-wallet?chain=${chain}&address=${addr}`, { headers: { origin: ORIGIN } });
    await res.arrayBuffer();
    assert.equal(res.status, 404, chain);
  }
});
