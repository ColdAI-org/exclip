/** Tokenised stocks: who may trade them (docs/tokenised-stocks.md). Four checks, in this order, and the first that fails
 * decides: the switch (stocks.enabled), a country this server can trust, the blocklists (ExClip's baseline and
 * stocks.blockedCountries), and a self-certification this server signed for the current terms and that country, less
 * than 30 days old.
 *
 * The country is read from stocks.countryHeader only on a request that also carries EXCLIP_EDGE_SECRET in
 * x-exclip-edge-secret. The reverse proxy sets both and drops any copy the client sent, so a country header a visitor
 * sets themselves counts for nothing: without the secret, the country is unknown. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  ISO_COUNTRY_CODES, STOCK_REFUSALS, STOCK_STATEMENTS, STOCKS_ATTESTATION_DAYS, STOCKS_ATTESTATION_HEADER,
  STOCKS_EDGE_SECRET_HEADER, type StockRefusal,
} from "@exclip/config";
import type { ServerConfig } from "./config.ts";
import type { ProxyResult } from "./sodaxProxy.ts";

export type Eligibility =
  | { eligible: true; country: string; expiresAt: number }
  | { eligible: false; code: StockRefusal; country: string | null };

const LIFETIME_S = STOCKS_ATTESTATION_DAYS * 86_400;
/** An attestation dated a few minutes ahead still counts: servers behind one proxy may disagree on the time. */
const SKEW_S = 300;
/** Longer than any attestation this server issues. */
const MAX_ATTESTATION = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const STATEMENT_IDS: readonly string[] = STOCK_STATEMENTS.map((s) => s.id);
/** Signed into every attestation, so a release that changes what users confirm voids the earlier attestations even
 * when stocks.termsVersion stays the same. */
const STATEMENTS_DIGEST = createHash("sha256").update(JSON.stringify(STOCK_STATEMENTS)).digest("base64url");

const sha256 = (text: string) => createHash("sha256").update(text).digest();
/** Constant time, whatever the lengths. */
const same = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));
/** A header sent once; Node joins a repeated one with commas, which no check below accepts. */
const single = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

const answer = (status: number, body: unknown): ProxyResult => ({ status, body, headers: { "Cache-Control": "no-store" } });
const refuse = (status: number, code: string, message: string) => answer(status, { error: { code, message } });

export function createStockGate(stocks: ServerConfig["stocks"], now: () => number = Date.now) {
  if (stocks.enabled && (!stocks.edgeSecret || (stocks.attestationSecret ?? "").length < 32)) {
    // loadExclipConfig refuses this before the server starts; this stops a caller that skipped it.
    throw new Error("tokenised stocks are on without EXCLIP_EDGE_SECRET and a 32-character EXCLIP_ATTESTATION_SECRET");
  }
  const blocked = new Set(stocks.blockedCountries);

  /** The visitor's country: the code the proxy put in stocks.countryHeader, on a request that carries the edge secret.
   * Else null, and null too for a code that isn't an assigned country (Cloudflare's XX for unknown, T1 for Tor). */
  function countryOf(headers: IncomingHttpHeaders): string | null {
    const secret = single(headers[STOCKS_EDGE_SECRET_HEADER]);
    if (!stocks.edgeSecret || !stocks.countryHeader || secret === null || !same(secret, stocks.edgeSecret)) return null;
    const code = single(headers[stocks.countryHeader])?.trim().toUpperCase() ?? "";
    return ISO_COUNTRY_CODES.has(code) ? code : null;
  }

  const sign = (payload: string) => createHmac("sha256", stocks.attestationSecret ?? "")
    .update(`exclip-stocks-attestation.${STATEMENTS_DIGEST}.${payload}`).digest("base64url");

  /** When the attestation the request carries expires (ms), or null unless this server signed it for these terms and
   * this country, it is dated no later than now and it is less than 30 days old. */
  function expiryOf(headers: IncomingHttpHeaders, country: string): number | null {
    const token = single(headers[STOCKS_ATTESTATION_HEADER]);
    if (token === null || token.length > MAX_ATTESTATION) return null;
    const [payload, signature, ...rest] = token.split(".");
    if (rest.length || !payload || !signature || !BASE64URL.test(payload) || !same(signature, sign(payload))) return null;
    let claims: unknown;
    try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
    if (typeof claims !== "object" || claims === null) return null;
    const { v, t, c, iat } = claims as Record<string, unknown>;
    if (v !== 1 || t !== stocks.termsVersion || c !== country || typeof iat !== "number" || !Number.isSafeInteger(iat)) return null;
    const nowS = Math.floor(now() / 1000);
    if (iat > nowS + SKEW_S || nowS >= iat + LIFETIME_S) return null;
    return (iat + LIFETIME_S) * 1000;
  }

  /** May this request trade a tokenised stock? The SODAX proxy asks for every request with a stock leg. */
  function check(headers: IncomingHttpHeaders): Eligibility {
    if (!stocks.enabled) return { eligible: false, code: "STOCKS_DISABLED", country: null };
    const country = countryOf(headers);
    if (!country) return { eligible: false, code: "COUNTRY_UNKNOWN", country: null };
    if (blocked.has(country)) return { eligible: false, code: "COUNTRY_RESTRICTED", country };
    const expiresAt = expiryOf(headers, country);
    if (expiresAt === null) return { eligible: false, code: "SELF_CERT_REQUIRED", country };
    return { eligible: true, country, expiresAt };
  }

  /** GET /stocks/eligibility: always 200. The answer says whether this request may trade a tokenised stock and, if
   * not, why, in the words of the 451 the proxy would answer. */
  function eligibility(headers: IncomingHttpHeaders): ProxyResult {
    const verdict = check(headers);
    return answer(200, {
      eligible: verdict.eligible,
      code: verdict.eligible ? null : verdict.code,
      message: verdict.eligible ? null : STOCK_REFUSALS[verdict.code],
      country: verdict.country,
      termsVersion: stocks.enabled ? stocks.termsVersion : null,
      expiresAt: verdict.eligible ? new Date(verdict.expiresAt).toISOString() : null,
    });
  }

  /** POST /stocks/attest: every statement confirmed for the current terms, from a country where stocks may be offered,
   * gives a signed attestation that the app keeps and sends back in x-exclip-stocks-attestation. */
  function attest(headers: IncomingHttpHeaders, body: unknown): ProxyResult {
    const verdict = check(headers);
    if (!verdict.eligible && verdict.code !== "SELF_CERT_REQUIRED") return refuse(451, verdict.code, STOCK_REFUSALS[verdict.code]);
    const country = verdict.country!;
    const { termsVersion, statements } = (body ?? {}) as { termsVersion?: unknown; statements?: unknown };
    if (typeof body !== "object" || body === null || Array.isArray(body) || typeof termsVersion !== "string"
      || Object.keys(body).some((key) => key !== "termsVersion" && key !== "statements")) {
      return refuse(400, "BAD_BODY", "Expected a JSON object with termsVersion and statements.");
    }
    if (termsVersion !== stocks.termsVersion) {
      return refuse(409, "TERMS_CHANGED", "The terms have changed since this page loaded. Read them again, then confirm.");
    }
    if (!Array.isArray(statements) || statements.length !== STATEMENT_IDS.length || !STATEMENT_IDS.every((id) => statements.includes(id))) {
      return refuse(400, "STATEMENTS_REQUIRED", "Confirm every statement to continue.");
    }
    const iat = Math.floor(now() / 1000);
    const payload = Buffer.from(JSON.stringify({ v: 1, t: stocks.termsVersion, c: country, iat })).toString("base64url");
    return answer(200, {
      attestation: `${payload}.${sign(payload)}`,
      country,
      termsVersion: stocks.termsVersion,
      expiresAt: new Date((iat + LIFETIME_S) * 1000).toISOString(),
    });
  }

  return { check, eligibility, attest };
}

export type StockGate = ReturnType<typeof createStockGate>;
