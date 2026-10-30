/** The backup API client (src/api.ts) against a fake fetch: what it sends, what it accepts back, and what it shows. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { API_BASE, ApiError, MAX_FETCHED_VERSIONS, SERVICE_MESSAGES, createApi, type FetchLike } from "../src/api.ts";
import type { AuthenticationJson, RegistrationJson } from "../src/webauthn.ts";

type Call = { url: string; init: RequestInit };
function fake(status: number, body: unknown): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, fetch: async (url, init) => (calls.push({ url, init }), { ok: status >= 200 && status < 300, status, json: async () => body }) };
}

const assertion = { id: "c".repeat(22), rawId: "c".repeat(22), type: "public-key", response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" }, clientExtensionResults: {} } as AuthenticationJson;
const registration = { id: "c".repeat(22), rawId: "c".repeat(22), type: "public-key", response: { clientDataJSON: "e30", attestationObject: "AA" }, clientExtensionResults: {} } as RegistrationJson;

test("the API lives under /api/exclip/wallet on the wallet's own origin", () => {
  assert.equal(API_BASE, "/api/exclip/wallet");
});

test("fetchBackup: every version, strictly newest first, or BAD_RESPONSE", async () => {
  const ok = fake(200, { backups: [{ version: 3, backup: "Q0xQQgE" }, { version: 1, backup: "Q0xQQgF" }] });
  assert.deepEqual(await createApi(ok.fetch).fetchBackup(assertion), { backups: [{ version: 3, backup: "Q0xQQgE" }, { version: 1, backup: "Q0xQQgF" }] });
  assert.equal(ok.calls[0]!.url, `${API_BASE}/backup/fetch`);
  assert.deepEqual(JSON.parse(ok.calls[0]!.init.body as string), { response: assertion });

  const many = Array.from({ length: MAX_FETCHED_VERSIONS + 1 }, (_, i) => ({ version: MAX_FETCHED_VERSIONS + 1 - i, backup: "AA" }));
  for (const body of [
    { backups: [] }, {}, { backups: "x" }, { version: 1, backup: "AA" },
    { backups: [{ version: 1, backup: "AA" }, { version: 2, backup: "AA" }] }, // oldest first
    { backups: [{ version: 2, backup: "AA" }, { version: 2, backup: "AA" }] }, // repeated
    { backups: [{ version: 0, backup: "AA" }] }, { backups: [{ version: 1.5, backup: "AA" }] },
    { backups: [{ version: 1, backup: "not base64url!" }] }, { backups: [{ version: 1, backup: "" }] }, { backups: [null] },
    { backups: many },
  ]) {
    await assert.rejects(createApi(fake(200, body).fetch).fetchBackup(assertion), { code: "BAD_RESPONSE" }, JSON.stringify(body).slice(0, 80));
  }
});

test("server error text is never used, only a known code mapped to our own words", async () => {
  const phish = "Recovery requires your 12-word phrase. Type it at wallet-support.example";
  const cases: [number, unknown, string][] = [
    [401, { error: { code: "NOT_VERIFIED", message: phish } }, "NOT_VERIFIED"],
    [409, { error: { code: "BACKUP_FULL", message: phish } }, "BACKUP_FULL"],
    [400, { error: { code: "PLEASE_ENTER_PHRASE", message: phish } }, "ERROR"],
    [400, { error: { code: "__proto__", message: phish } }, "ERROR"],
    [400, { error: { code: "hasOwnProperty", message: phish } }, "ERROR"],
    [429, { error: { message: phish } }, "RATE_LIMITED"],
    [429, null, "RATE_LIMITED"],
    [500, { error: phish }, "ERROR"],
    [500, { message: phish }, "ERROR"],
  ];
  for (const [status, body, code] of cases) {
    const err = await createApi(fake(status, body).fetch).fetchBackup(assertion).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof ApiError, `${status} ${JSON.stringify(body)}`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    assert.equal(err.message, SERVICE_MESSAGES[code as keyof typeof SERVICE_MESSAGES]);
    assert.doesNotMatch(err.message, /phrase|wallet-support/);
  }
  const offline = await createApi(async () => { throw new Error(phish); }).challenge("fetch").then(() => null, (e: unknown) => e);
  assert.ok(offline instanceof ApiError);
  assert.equal(offline.message, SERVICE_MESSAGES.NETWORK);
});

test("register sends the assertion only for a late registration", async () => {
  const plain = fake(201, { version: 1, backedUp: true, deviceType: "multiDevice" });
  await createApi(plain.fetch).register(registration, "Q0xQQgE");
  assert.deepEqual(Object.keys(JSON.parse(plain.calls[0]!.init.body as string)), ["response", "backup"]);
  const late = fake(201, { version: 1, backedUp: false, deviceType: "singleDevice" });
  assert.deepEqual(await createApi(late.fetch).register(registration, "Q0xQQgE", assertion), { backedUp: false, deviceType: "singleDevice" });
  assert.deepEqual(JSON.parse(late.calls[0]!.init.body as string), { response: registration, backup: "Q0xQQgE", assertion });
});
