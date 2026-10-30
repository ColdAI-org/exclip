/** WebAuthn for the embedded wallet (docs/embedded-wallet.md).
 *
 * Every ceremony:
 *  - binds the passkey to this page's own host (assertRpId), never a parent domain;
 *  - requires user verification, a discoverable credential, no attestation, ES256 or EdDSA;
 *  - asks for the PRF extension with WALLET_PRF_INPUT and refuses to continue without a PRF result.
 *
 * What goes to the server is serialized here by hand. `clientExtensionResults` is always sent EMPTY: the PRF output is
 * the key to the wallet, and PublicKeyCredential.toJSON() would include it. */
import type { PasskeyPrf } from "@clip-wallet/vault";
import { WALLET_PRF_INPUT } from "./password.ts";
import { equalBytes, fromB64u, own, toB64u, wipe } from "./bytes.ts";
import { BRAND_NAME, assertRpId } from "./config.ts";

export const UNSUPPORTED_MESSAGE = "Your browser can't secure an embedded wallet. Use Chrome, Safari 18+, Edge, or the Clip Wallet extension.";
/** The name the passkey is saved under, in the password manager and the browser's prompts. */
export const PASSKEY_LABEL = `${BRAND_NAME} wallet`;
export const COSE_ALGS = [-7, -8] as const; // ES256, EdDSA

export type WebAuthnErrorCode = "UNSUPPORTED_BROWSER" | "CANCELLED" | "FAILED";
export class WebAuthnError extends Error {
  constructor(readonly code: WebAuthnErrorCode, message: string) {
    super(message);
    this.name = "WebAuthnError";
  }
}
const unsupported = () => new WebAuthnError("UNSUPPORTED_BROWSER", UNSUPPORTED_MESSAGE);

/** What this module needs from the browser (tests pass fakes). */
export type WebAuthnEnv = {
  credentials: Pick<CredentialsContainer, "create" | "get">;
  /** This page's origin (location.origin). */
  origin: string;
  dev: boolean;
  /** PublicKeyCredential.getClientCapabilities, when the browser has it. */
  getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
  /** PublicKeyCredential.signalUnknownCredential, when the browser has it (tidies a passkey the wallet can't use). */
  signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void>;
  random: (n: number) => Uint8Array;
};

export function browserEnv(): WebAuthnEnv {
  const PKC = (globalThis as unknown as { PublicKeyCredential?: Record<string, unknown> }).PublicKeyCredential;
  const caps = PKC?.getClientCapabilities as WebAuthnEnv["getClientCapabilities"];
  const signal = PKC?.signalUnknownCredential as WebAuthnEnv["signalUnknownCredential"];
  return {
    credentials: navigator.credentials,
    origin: location.origin,
    dev: false,
    getClientCapabilities: caps ? () => caps.call(PKC) : undefined,
    signalUnknownCredential: signal ? (o) => signal.call(PKC, o) : undefined,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
  };
}

/** "no" only when the browser says so; "unknown" is settled by the ceremony itself (prf.enabled / results). */
export async function prfSupport(env: WebAuthnEnv): Promise<"yes" | "no" | "unknown"> {
  if (!env.credentials || typeof env.credentials.create !== "function") return "no";
  if (!env.getClientCapabilities) return "unknown";
  try {
    const caps = await env.getClientCapabilities();
    if (caps["extension:prf"] === true) return "yes";
    if (caps["extension:prf"] === false) return "no";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/* ------------------------------------------------------------------ server-bound JSON */

/** RegistrationResponseJSON as apps/server checks it (exact keys, rawId = id, empty extension results). */
export type RegistrationJson = {
  id: string; rawId: string; type: "public-key";
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
  clientExtensionResults: Record<string, never>;
  authenticatorAttachment?: string;
};
export type AuthenticationJson = {
  id: string; rawId: string; type: "public-key";
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  clientExtensionResults: Record<string, never>;
  authenticatorAttachment?: string;
};

type PrfOutputs = { enabled?: boolean; results?: { first?: BufferSource } };
type CredentialLike = {
  type: string;
  rawId: ArrayBuffer;
  authenticatorAttachment?: string | null;
  response: Record<string, unknown>;
  getClientExtensionResults(): { prf?: PrfOutputs };
};

const bytesOf = (v: unknown): Uint8Array => {
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);
  throw new WebAuthnError("FAILED", "The passkey returned something unexpected.");
};

function asCredential(c: Credential | null): CredentialLike {
  const cred = c as unknown as CredentialLike | null;
  if (!cred || cred.type !== "public-key" || !cred.rawId || typeof cred.getClientExtensionResults !== "function") {
    throw new WebAuthnError("FAILED", "The passkey returned something unexpected.");
  }
  return cred;
}

/** The PRF output, or null. A copy: the browser's buffer is not ours to wipe or keep. */
function prfFirst(cred: CredentialLike): Uint8Array | null {
  const first = cred.getClientExtensionResults().prf?.results?.first;
  if (!first) return null;
  const out = bytesOf(first);
  if (out.length >= 32) return out;
  wipe(out);
  return null;
}

function mapDomError(e: unknown): WebAuthnError {
  if (e instanceof WebAuthnError) return e;
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError") return new WebAuthnError("CANCELLED", "The passkey request was cancelled or timed out.");
  if (name === "NotSupportedError") return unsupported();
  if (name === "SecurityError") return new WebAuthnError("FAILED", "This page isn't allowed to use that passkey.");
  return new WebAuthnError("FAILED", "The passkey couldn't be used. Try again.");
}

const PRF_EXTENSION = () => ({ prf: { eval: { first: own(WALLET_PRF_INPUT) } } });
const PRF_SUPPORT_MESSAGE = UNSUPPORTED_MESSAGE;

/* ------------------------------------------------------------------ ceremonies */

export type Created = { credentialId: Uint8Array; prfOutput: Uint8Array; response: RegistrationJson };
export type Asserted = { credentialId: Uint8Array; prfOutput: Uint8Array; response: AuthenticationJson };

/** Server challenge for this ceremony: {challenge, rpId, timeoutMs} from /api/exclip/wallet/challenge. */
export type Challenge = { challenge: string; rpId: string; timeoutMs: number };

const timeoutOf = (c: Challenge) => Math.max(30_000, Math.min(c.timeoutMs, 5 * 60_000));

/** Creates the wallet's passkey and returns its PRF output (second prompt only if the authenticator gives no PRF result
 * at creation, as Safari and some security keys do). */
export async function createPasskey(env: WebAuthnEnv, c: Challenge, exclude: Uint8Array[] = []): Promise<Created> {
  assertRpId(c.rpId, env.origin, env.dev);
  if ((await prfSupport(env)) === "no") throw unsupported();
  const userId = env.random(32); // random user handle: nothing about the person, nothing linkable
  let cred: CredentialLike;
  try {
    cred = asCredential(await env.credentials.create({
      publicKey: {
        rp: { id: c.rpId, name: PASSKEY_LABEL },
        user: { id: own(userId), name: PASSKEY_LABEL, displayName: PASSKEY_LABEL },
        challenge: own(fromB64u(c.challenge)),
        pubKeyCredParams: COSE_ALGS.map((alg) => ({ type: "public-key" as const, alg })),
        // Adding a passkey: not on an authenticator that already holds one of this wallet's passkeys.
        excludeCredentials: exclude.map((id) => ({ type: "public-key" as const, id: own(id) })),
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        attestation: "none",
        timeout: timeoutOf(c),
        extensions: PRF_EXTENSION() as AuthenticationExtensionsClientInputs,
      },
    }));
  } catch (e) {
    throw mapDomError(e);
  } finally {
    wipe(userId);
  }
  const credentialId = new Uint8Array(cred.rawId.slice(0));
  const ext = cred.getClientExtensionResults().prf;
  if (!ext || (ext.enabled !== true && !ext.results?.first)) {
    // The passkey exists but can't protect a wallet. Tell the browser to forget it where it can.
    await env.signalUnknownCredential?.({ rpId: c.rpId, credentialId: toB64u(credentialId) }).catch(() => {});
    throw new WebAuthnError("UNSUPPORTED_BROWSER", PRF_SUPPORT_MESSAGE);
  }
  const r = cred.response;
  const transports = typeof r.getTransports === "function" ? (r.getTransports as () => string[])() : undefined;
  const response: RegistrationJson = {
    id: toB64u(credentialId),
    rawId: toB64u(credentialId),
    type: "public-key",
    response: {
      clientDataJSON: toB64u(bytesOf(r.clientDataJSON)),
      attestationObject: toB64u(bytesOf(r.attestationObject)),
      ...(Array.isArray(transports) ? { transports: transports.filter((t) => typeof t === "string").slice(0, 8) } : {}),
    },
    clientExtensionResults: {},
    ...(cred.authenticatorAttachment ? { authenticatorAttachment: cred.authenticatorAttachment } : {}),
  };
  let prfOutput = prfFirst(cred);
  if (!prfOutput) {
    // PRF enabled without a result: evaluate it once with a local challenge (nothing is sent to the server).
    prfOutput = (await getAssertion(env, { challenge: toB64u(env.random(32)), rpId: c.rpId, timeoutMs: c.timeoutMs }, [credentialId])).prfOutput;
  }
  return { credentialId, prfOutput, response };
}

/** One user-verified assertion with PRF. `allow` empty → discoverable (the user picks the passkey). */
export async function getAssertion(env: WebAuthnEnv, c: Challenge, allow: Uint8Array[] = []): Promise<Asserted> {
  assertRpId(c.rpId, env.origin, env.dev);
  if ((await prfSupport(env)) === "no") throw unsupported();
  let cred: CredentialLike;
  try {
    cred = asCredential(await env.credentials.get({
      publicKey: {
        rpId: c.rpId,
        challenge: own(fromB64u(c.challenge)),
        allowCredentials: allow.map((id) => ({ type: "public-key" as const, id: own(id) })),
        userVerification: "required",
        timeout: timeoutOf(c),
        extensions: PRF_EXTENSION() as AuthenticationExtensionsClientInputs,
      },
      mediation: "optional",
    }));
  } catch (e) {
    throw mapDomError(e);
  }
  const credentialId = new Uint8Array(cred.rawId.slice(0));
  if (allow.length && !allow.some((id) => equalBytes(id, credentialId))) throw new WebAuthnError("FAILED", "That's not this wallet's passkey.");
  const prfOutput = prfFirst(cred);
  if (!prfOutput) throw new WebAuthnError("UNSUPPORTED_BROWSER", PRF_SUPPORT_MESSAGE);
  const r = cred.response;
  const userHandle = r.userHandle ? bytesOf(r.userHandle) : null;
  const response: AuthenticationJson = {
    id: toB64u(credentialId),
    rawId: toB64u(credentialId),
    type: "public-key",
    response: {
      clientDataJSON: toB64u(bytesOf(r.clientDataJSON)),
      authenticatorData: toB64u(bytesOf(r.authenticatorData)),
      signature: toB64u(bytesOf(r.signature)),
      ...(userHandle && userHandle.length ? { userHandle: toB64u(userHandle) } : {}),
    },
    clientExtensionResults: {},
    ...(cred.authenticatorAttachment ? { authenticatorAttachment: cred.authenticatorAttachment } : {}),
  };
  return { credentialId, prfOutput, response };
}

/* ------------------------------------------------------------------ the vault's PasskeyPrf */

/**
 * PasskeyPrf for ClipVault, backed by a PRF output this page already got from the ceremony the user just did, so a
 * create, sign-in or signature is one prompt rather than two. The vault may ignore its random prfInput (vault
 * passkey.ts says so): every embedded-wallet ceremony evaluates WALLET_PRF_INPUT, at enroll and at evaluate alike.
 *
 * Bound to one credential. Hands the vault copies (the vault wipes what it gets) and is wiped with dispose().
 */
export class CeremonyPrf implements PasskeyPrf {
  private output: Uint8Array | null;
  private readonly credentialId: Uint8Array;

  constructor(credentialId: Uint8Array, prfOutput: Uint8Array) {
    this.credentialId = credentialId.slice();
    this.output = prfOutput.slice();
  }

  private take(): Uint8Array {
    if (!this.output) throw new Error("passkey result already disposed");
    return this.output.slice();
  }

  async enroll(_prfInput: Uint8Array): Promise<{ credentialId: Uint8Array; prfOutput: Uint8Array }> {
    return { credentialId: this.credentialId.slice(), prfOutput: this.take() };
  }

  async evaluate(credentialId: Uint8Array, _prfInput: Uint8Array): Promise<Uint8Array> {
    if (!equalBytes(credentialId, this.credentialId)) throw new Error("a different passkey was used");
    return this.take();
  }

  dispose(): void {
    wipe(this.output);
    this.output = null;
  }
}
