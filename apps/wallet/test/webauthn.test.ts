import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRpId, rpIdFor } from "../src/config.ts";
import { CeremonyPrf, createPasskey, getAssertion, prfSupport, WebAuthnError, UNSUPPORTED_MESSAGE } from "../src/webauthn.ts";
import { WALLET_PRF_INPUT } from "../src/password.ts";
import { toB64u } from "../src/bytes.ts";
import { FakeAuthenticator, RP_ID, random } from "./fakes.ts";

const challenge = () => ({ challenge: toB64u(random(32)), rpId: RP_ID, timeoutMs: 120_000 });

test("rpId is always the page's own host", () => {
  assert.equal(rpIdFor("https://wallet.example.com"), "wallet.example.com");
  assert.throws(() => assertRpId("example.com", "https://wallet.example.com"), /wallet host/);
  assert.throws(() => assertRpId("evil.test", "https://wallet.example.com"), /wallet host/);
  assert.throws(() => rpIdFor("http://wallet.example.com"), /https/);
  assert.throws(() => rpIdFor("http://localhost:5311"), /https/, "plain http only in a dev build");
  assert.equal(rpIdFor("http://localhost:5311", true), "localhost");
  assert.throws(() => rpIdFor("http://evil.test", true), /https/);
  assert.throws(() => rpIdFor("https://wallet.example.com/path"), /not an origin/);
});

test("ceremonies refuse an rpId that isn't this host before touching the authenticator", async () => {
  const auth = new FakeAuthenticator();
  await assert.rejects(createPasskey(auth.env(), { ...challenge(), rpId: "test" }), /wallet host/);
  await assert.rejects(getAssertion(auth.env(), { ...challenge(), rpId: "other.test" }), /wallet host/);
  await assert.rejects(createPasskey(auth.env("https://evil.test"), challenge()), /wallet host/);
  assert.equal(auth.calls.length, 0);
});

test("create: the options the brief requires, PRF evaluated with the wallet input, nothing secret in the response", async () => {
  const auth = new FakeAuthenticator();
  const c = await createPasskey(auth.env(), challenge());
  const pk = (auth.calls[0]!.options as CredentialCreationOptions).publicKey!;
  assert.equal(pk.rp.id, RP_ID);
  assert.deepEqual(pk.authenticatorSelection, { residentKey: "required", requireResidentKey: true, userVerification: "required" });
  assert.equal(pk.attestation, "none");
  assert.deepEqual(pk.pubKeyCredParams, [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }]);
  const userId = new Uint8Array(pk.user.id as ArrayBuffer);
  assert.equal(userId.length, 32);
  assert.ok(userId.some((b) => b !== 0), "a random user handle, nothing about the person");
  await createPasskey(auth.env(), challenge());
  const userId2 = new Uint8Array((auth.calls[1]!.options as CredentialCreationOptions).publicKey!.user.id as ArrayBuffer);
  assert.notDeepEqual(userId2, userId);
  const first = new Uint8Array((pk.extensions as { prf: { eval: { first: ArrayBuffer } } }).prf.eval.first);
  assert.deepEqual(first, WALLET_PRF_INPUT);
  assert.equal(c.prfOutput.length, 32);
  assert.deepEqual(c.response.clientExtensionResults, {});
  assert.equal(c.response.id, c.response.rawId);
  assert.deepEqual(Object.keys(c.response).sort(), ["authenticatorAttachment", "clientExtensionResults", "id", "rawId", "response", "type"]);
  assert.deepEqual(c.response.response.transports, ["internal", "hybrid"]);
});

test("PRF support detection", async () => {
  assert.equal(await prfSupport(new FakeAuthenticator({ capability: true }).env()), "yes");
  assert.equal(await prfSupport(new FakeAuthenticator({ capability: false }).env()), "no");
  assert.equal(await prfSupport(new FakeAuthenticator().env()), "unknown");
  const env = new FakeAuthenticator().env();
  assert.equal(await prfSupport({ ...env, credentials: undefined as never }), "no");
  assert.equal(await prfSupport({ ...env, getClientCapabilities: async () => { throw new Error("x"); } }), "unknown");
});

test("no PRF: the browser message, and the useless passkey is signalled away", async () => {
  const auth = new FakeAuthenticator({ noPrf: true });
  await assert.rejects(createPasskey(auth.env(), challenge()), (e: unknown) =>
    e instanceof WebAuthnError && e.code === "UNSUPPORTED_BROWSER" && e.message === UNSUPPORTED_MESSAGE);
  assert.equal(auth.signalled.length, 1);
});

test("assertions: UV required, cancel maps to CANCELLED, a passkey outside the allow list is refused", async () => {
  const auth = new FakeAuthenticator();
  const created = await createPasskey(auth.env(), challenge());
  const a = await getAssertion(auth.env(), challenge(), [created.credentialId]);
  assert.deepEqual(a.prfOutput, created.prfOutput, "same PRF output at create and get");
  assert.equal((auth.calls[1]!.options as CredentialRequestOptions).publicKey!.userVerification, "required");
  assert.deepEqual(a.response.clientExtensionResults, {});

  const empty = new FakeAuthenticator();
  await assert.rejects(getAssertion(empty.env(), challenge()), (e: unknown) => e instanceof WebAuthnError && e.code === "CANCELLED");

  // An authenticator that answers with a different credential than the one asked for.
  const other = new FakeAuthenticator();
  await createPasskey(other.env(), challenge());
  const env = other.env();
  const get = env.credentials.get;
  env.credentials.get = (o) => get({ ...o, publicKey: { ...o!.publicKey!, allowCredentials: [] } });
  await assert.rejects(getAssertion(env, challenge(), [created.credentialId]), /not this wallet's passkey/);
});

test("CeremonyPrf hands out copies, is bound to one credential, and is wiped by dispose", async () => {
  const id = random(32), out = random(32);
  const prf = new CeremonyPrf(id, out);
  const enrolled = await prf.enroll(random(32));
  assert.deepEqual(enrolled.prfOutput, out);
  enrolled.prfOutput.fill(0); // the vault wipes what it gets
  assert.deepEqual(await prf.evaluate(id, random(32)), out);
  await assert.rejects(prf.evaluate(random(32), random(32)), /different passkey/);
  prf.dispose();
  await assert.rejects(prf.evaluate(id, random(32)), /disposed/);
});
