/** The server as index.ts builds it: createApp with memory stores and a stubbed upstream. Covers /api/exclip/config,
 * the SODAX key never reaching a browser or a log line, the fee defaults, the error handler, and serving the built
 * apps by Host (server.serveStatic). Requests go through node:http so the Host header can be set. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import type { Express } from "express";
import { DEV_ORIGINS, WALLET_CSP, appSecurityHeaders, resolveConfig, walletSecurityHeaders, type Env, type ExclipConfigInput } from "@exclip/config";
import { createApp } from "../src/app.ts";
import { createMemoryKv } from "../src/kv.ts";
import { SODAX_DEFAULT_BASE } from "../src/services/config.ts";
import { createMemoryWalletStore } from "../src/services/walletBackup.ts";
import type { FetchLike } from "../src/services/sodaxProxy.ts";

/** A sentinel, not a real key: if it shows up anywhere a browser or a log can see, the test fails. */
const KEY = "sentinel-sodax-key-5c1e7a90d4";
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const STATIC_DIRS = { web: join(FIXTURES, "web"), wallet: join(FIXTURES, "wallet") };
const APP_HOST = "exclip.example.com";
const WALLET_HOST = "wallet.example.com";
const WALLET_ORIGIN = `https://${WALLET_HOST}`;
const IMMUTABLE = "public, max-age=31536000, immutable";
const HTML = { accept: "text/html,application/xhtml+xml" };
const ATTACKER = "0x2222222222222222222222222222222222222222";
const QUOTE = {
  tokenSrc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", tokenSrcChainKey: "0x2105.base",
  tokenDst: "0x0000000000000000000000000000000000000000", tokenDstChainKey: "sonic",
  amount: "1000000", quoteType: "exact_input",
};
const INTENT = {
  srcChainKey: "0x2105.base", inputToken: QUOTE.tokenSrc, dstChainKey: "sonic", outputToken: QUOTE.tokenDst,
  inputAmount: "1000000", minOutputAmount: "1", srcAddress: `0x${"33".repeat(20)}`, dstAddress: `0x${"33".repeat(20)}`,
};

// ---- harness -----------------------------------------------------------------------------------------------

function makeApp(o: { input?: ExclipConfigInput; env?: Env; dev?: boolean; fetch?: FetchLike; onError?: (code: string) => void } = {}): Express {
  const { config, secrets } = resolveConfig(o.input ?? {}, o.env ?? {});
  return createApp({
    config, secrets, dev: o.dev ?? false, kv: createMemoryKv(), walletStore: createMemoryWalletStore(),
    fetch: o.fetch, sleep: async () => {}, onError: o.onError, staticDirs: STATIC_DIRS,
  });
}

type Reply = { status: number; headers: IncomingHttpHeaders; text: string };
type Ask = { method?: string; host?: string; headers?: Record<string, string> };

/** Serves `app` on a random port. `prelude` runs on every response before the app sees it (a stray middleware that
 * sets cookies or CORS headers, say). */
async function serve(t: TestContext, app: Express, prelude?: (res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    prelude?.(res);
    app(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const { port } = server.address() as AddressInfo;
  const send = (path: string, ask: Ask, body?: unknown) => new Promise<Reply>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, agent: false, method: ask.method ?? (payload === undefined ? "GET" : "POST"),
      headers: {
        ...(ask.host ? { host: ask.host } : {}),
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }),
        ...ask.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload);
  });
  return {
    get: (path: string, ask: Ask = {}) => send(path, ask),
    post: (path: string, body: unknown, ask: Ask = {}) => send(path, { ...ask, method: "POST" }, body),
  };
}

const bodyOf = (reply: Reply) => JSON.parse(reply.text) as Record<string, unknown>;

/** Everything written through console during the test, formatted as it would be printed. */
function captureConsole(t: TestContext): string[] {
  const lines: string[] = [];
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const name of Object.keys(saved) as Array<keyof typeof saved>) {
    console[name] = (first?: unknown, ...rest: unknown[]) => { lines.push(format(first, ...rest)); };
  }
  t.after(() => { Object.assign(console, saved); });
  return lines;
}

type Upstream = { url: string; method: string; headers: Record<string, string>; body: string };

/** Stands in for SODAX and CoinGecko: records every call, answers with `reply` (given the SODAX path). */
function upstream(calls: Upstream[], reply: (path: string, call: Upstream) => Response | Promise<Response>): FetchLike {
  return async (input, init) => {
    const call = {
      url: input, method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    return reply(input.startsWith(`${SODAX_DEFAULT_BASE}/`) ? new URL(input).pathname.replace(/^\/v1\//, "") : input, call);
  };
}

/** Upstream headers that carry the key, as a careless upstream or a debugging proxy might send them. */
const ECHO_HEADERS = { "x-api-key": KEY, "x-echo": `key=${KEY}`, "set-cookie": `k=${KEY}; Path=/`, "www-authenticate": `Bearer ${KEY}` };

const upstreamJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A SODAX that echoes the key everywhere it can: in the token list, in every body, in the headers. */
const echoingSodax = (calls: Upstream[]) => upstream(calls, (path, call) => {
  if (!call.url.startsWith(SODAX_DEFAULT_BASE)) return upstreamJson([]);
  if (path === "swaps/tokens") {
    return upstreamJson({ "0x2105.base": [{ chainKey: "0x2105.base", address: QUOTE.tokenSrc, symbol: "USDC", isRwa: false, note: KEY }] }, 200, ECHO_HEADERS);
  }
  return upstreamJson({ echo: KEY, nested: { apiKey: KEY, list: [KEY, `Bearer ${KEY}`] }, requestHeaders: call.headers }, 200, ECHO_HEADERS);
});

/** A 200 whose body fails mid-read, the error quoting the key. */
const brokenBody = () => new Response(new ReadableStream({
  start(controller) { controller.error(new Error(`stream reset (${KEY})`)); },
}), { status: 200 });

/** The key appears nowhere a browser can read it: no header name or value, no byte of the body. */
function assertNoKey(reply: Reply, label: string) {
  assert.ok(!reply.text.includes(KEY), `${label}: body`);
  assert.ok(!JSON.stringify(reply.headers).includes(KEY), `${label}: headers`);
}

function assertHeaders(reply: Reply, expected: Record<string, string>, label: string) {
  for (const [name, value] of Object.entries(expected)) assert.equal(reply.headers[name], value, `${label}: ${name}`);
}

// ---- the app -----------------------------------------------------------------------------------------------

test("createApp with memory stores answers /api/exclip/config: the defaults, no fee, no key", async (t) => {
  const s = await serve(t, makeApp());
  const r = await s.get("/api/exclip/config");
  assert.equal(r.status, 200);
  assert.deepEqual(bodyOf(r), {
    tradingEnabled: true, sodaxConfigured: false, partnerFeeBps: 0, feeReceiver: null, feeSplit: null,
    embeddedWallet: true, walletOrigin: WALLET_ORIGIN, unbackedLimitUsd: 100, stocksEnabled: false, stocksTermsVersion: null,
  });
  assert.equal(r.headers["cache-control"], "public, max-age=30");
  assert.equal(r.headers["x-powered-by"], undefined);
  // The API alone (no static serving): JSON that nothing may frame, sniff or run.
  assert.equal(r.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  // Development: the wallet is on its localhost port. Off: no wallet origin at all.
  const dev = await serve(t, makeApp({ dev: true }));
  assert.equal(bodyOf(await dev.get("/api/exclip/config")).walletOrigin, DEV_ORIGINS.wallet);
  const off = await serve(t, makeApp({ input: { features: { embeddedWallet: false } } }));
  assert.equal(bodyOf(await off.get("/api/exclip/config")).walletOrigin, null);
});

test("unknown routes: JSON 404 under /api, plain 404 elsewhere; an error answer never echoes internals", async (t) => {
  const s = await serve(t, makeApp());
  const api = await s.get("/api/exclip/nope");
  assert.equal(api.status, 404);
  assert.deepEqual(bodyOf(api), { error: { code: "NOT_FOUND", message: "API route not found." } });
  assert.equal(api.headers["cache-control"], "no-store");
  assert.equal((await s.post("/api/other", {})).status, 404);
  const page = await s.get("/somewhere", { headers: HTML });
  assert.equal(page.status, 404);
  assert.equal(page.text, "Not found.");
  assert.match(String(page.headers["content-type"]), /^text\/plain/);
  // A path the router can't decode: 400 with our message, not the parser's (which quotes the input).
  const bad = await s.get("/api/exclip/markets/%E0%A4%A/chart");
  assert.equal(bad.status, 400);
  assert.deepEqual(bodyOf(bad), { error: { code: "INVALID_REQUEST", message: "The request could not be processed." } });
  assert.equal(bad.headers["cache-control"], "no-store");
});

// ---- the SODAX key never reaches a browser -----------------------------------------------------------------

test("SODAX key 1/4: /config says a key is set and carries it nowhere, body or headers", async (t) => {
  const s = await serve(t, makeApp({ env: { SODAX_API_KEY: KEY }, fetch: echoingSodax([]) }));
  const r = await s.get("/api/exclip/config");
  assert.equal(r.status, 200);
  assert.equal(bodyOf(r).sodaxConfigured, true);
  assertNoKey(r, "/config");
});

test("SODAX key 2/4: proxied answers never carry it, even when SODAX echoes it in the body and the headers", async (t) => {
  const logs = captureConsole(t);
  const s = await serve(t, makeApp({ env: { SODAX_API_KEY: KEY }, fetch: echoingSodax([]) }));
  const replies = {
    "tokens (miss)": await s.get("/api/exclip/sodax/swaps/tokens"),
    "tokens (hit)": await s.get("/api/exclip/sodax/swaps/tokens"),
    quote: await s.post("/api/exclip/sodax/swaps/quote", QUOTE),
    intent: await s.post("/api/exclip/sodax/swaps/intents", INTENT),
    status: await s.get(`/api/exclip/sodax/swaps/intents/${"ab12".repeat(8)}`),
  };
  for (const [label, reply] of Object.entries(replies)) {
    assert.equal(reply.status, 200, label);
    assertNoKey(reply, label);
    assert.ok(reply.text.includes("[redacted]"), `${label}: the echo was there, and was redacted`);
    assert.equal(reply.headers["set-cookie"], undefined, `${label}: no upstream header is copied`);
    assert.equal(reply.headers["x-echo"], undefined, label);
  }
  assert.deepEqual([replies["tokens (miss)"].headers["x-cache"], replies["tokens (hit)"].headers["x-cache"]], ["miss", "hit"]);
  assert.deepEqual(logs.filter((line) => line.includes(KEY)), []);
});

test("SODAX key 3/4: upstream errors, timeouts and failures carry it nowhere, and no log line has it", async (t) => {
  const logs = captureConsole(t);
  const calls: Upstream[] = [];
  const fetch = upstream(calls, (path) => {
    switch (path) {
      case "swaps/intents/submit": return upstreamJson({ message: `internal error for ${KEY}` }, 500, ECHO_HEADERS);
      case "swaps/fees/partner": return upstreamJson({ message: `bad request from ${KEY}`, key: KEY }, 400, ECHO_HEADERS);
      case "swaps/deadline": return new Response(`<html>${KEY}</html>`, { status: 200, headers: { "content-type": "text/html", ...ECHO_HEADERS } });
      case "swaps/fees/solver": return upstreamJson({ message: `slow down ${KEY}` }, 429, { ...ECHO_HEADERS, "retry-after": "1" });
      case "swaps/submit-tx/status": throw Object.assign(new Error(`The operation was aborted due to timeout (${KEY})`), { name: "TimeoutError" });
      case "swaps/intents/cancel": throw new TypeError(`fetch failed: connect ECONNREFUSED (x-api-key: ${KEY})`);
      case "swaps/intents/status": return brokenBody();
      default: return upstreamJson({}, 404);
    }
  });
  const s = await serve(t, makeApp({ env: { SODAX_API_KEY: KEY }, fetch }));
  const cases: Array<[string, () => Promise<Reply>, number, string | null]> = [
    ["500", () => s.post("/api/exclip/sodax/swaps/intents/submit", { txHash: "0x01" }), 502, "SODAX_UPSTREAM"],
    ["400", () => s.get("/api/exclip/sodax/swaps/fees/partner?amount=1"), 400, null],
    ["not JSON", () => s.get("/api/exclip/sodax/swaps/deadline"), 502, "SODAX_BAD_RESPONSE"],
    ["429", () => s.get("/api/exclip/sodax/swaps/fees/solver?amount=1"), 429, "SODAX_RATE_LIMITED"],
    ["timeout", () => s.get("/api/exclip/sodax/swaps/submit-tx/status?txHash=0x01&srcChainKey=sonic"), 504, "SODAX_TIMEOUT"],
    ["unreachable", () => s.post("/api/exclip/sodax/swaps/intents/cancel", { intentHash: "0x01" }), 502, "SODAX_UNREACHABLE"],
    ["broken body", () => s.post("/api/exclip/sodax/swaps/intents/status", { intentHash: "0x01" }), 502, "SODAX_UPSTREAM"],
  ];
  for (const [label, run, status, code] of cases) {
    const reply = await run();
    assert.equal(reply.status, status, label);
    assertNoKey(reply, label);
    if (code) assert.equal((bodyOf(reply).error as { code?: string }).code, code, label);
    assert.equal(reply.headers["cache-control"], "no-store", label);
  }
  // The real 400 passes through, with the key it quoted replaced.
  assert.match((await s.get("/api/exclip/sodax/swaps/fees/partner?amount=1")).text, /bad request from \[redacted\]/);
  // Retried where safe (the 429 and the timeout), and each attempt went upstream with the key in its header only.
  assert.equal(calls.filter((c) => c.url.includes("/swaps/fees/solver")).length, 4);
  assert.equal(calls.filter((c) => c.url.includes("/swaps/submit-tx/status")).length, 4);
  // The unexpected failure raised an alert: a code and a fixed sentence, nothing from the request or the error.
  assert.ok(logs.some((line) => line.includes("EXCLIP_PROXY_FAILED")));
  assert.deepEqual(logs.filter((line) => line.includes(KEY)), []);
});

test("SODAX key 4/4: it is sent upstream in x-api-key, only to SODAX, never in a URL or a body, whatever the client sends", async (t) => {
  const calls: Upstream[] = [];
  const s = await serve(t, makeApp({ env: { SODAX_API_KEY: KEY }, fetch: echoingSodax(calls) }));
  const client = { headers: { "x-api-key": "client-key-0000", authorization: "Bearer client" } };
  assert.equal((await s.get("/api/exclip/sodax/swaps/tokens", client)).status, 200);
  assert.equal((await s.post("/api/exclip/sodax/swaps/quote", QUOTE, client)).status, 200);
  assert.equal((await s.post("/api/exclip/sodax/swaps/intents", INTENT, client)).status, 200);
  assert.equal((await s.get("/api/exclip/markets", client)).status, 200);
  const toSodax = calls.filter((c) => c.url.startsWith(`${SODAX_DEFAULT_BASE}/`));
  const elsewhere = calls.filter((c) => !c.url.startsWith(`${SODAX_DEFAULT_BASE}/`));
  assert.equal(toSodax.length, 3);
  assert.equal(elsewhere.length, 1, "the market data request");
  for (const c of toSodax) {
    assert.equal(c.headers["x-api-key"], KEY, c.url);
    assert.equal(c.headers.authorization, undefined, "no client header is forwarded");
  }
  for (const c of calls) {
    assert.ok(!c.url.includes(KEY), c.url);
    assert.ok(!c.body.includes(KEY), c.url);
  }
  assert.ok(!JSON.stringify(elsewhere).includes(KEY), "the key goes to SODAX and nowhere else");
});

test("defaults: no fee in /config, and a client's partnerFee (and hook) is stripped before SODAX sees the quote", async (t) => {
  assert.deepEqual(resolveConfig().config.fees, {
    partnerFeeBps: 0, rate: 0, receiver: null, receiverName: "ExClip", partnerFee: null, rateFee: null, split: null,
  });
  const calls: Upstream[] = [];
  // The defaults, plus a key from the environment so the quote can go upstream.
  const s = await serve(t, makeApp({ env: { SODAX_API_KEY: KEY }, fetch: echoingSodax(calls) }));
  const config = bodyOf(await s.get("/api/exclip/config"));
  assert.equal(config.partnerFeeBps, 0);
  assert.equal(config.feeReceiver, null);
  const quote = await s.post("/api/exclip/sodax/swaps/quote", { ...QUOTE, partnerFee: { address: ATTACKER, percentage: 100 }, hook: { address: ATTACKER } });
  assert.equal(quote.status, 200);
  const sent = calls.find((c) => c.url === `${SODAX_DEFAULT_BASE}/swaps/quote`);
  assert.ok(sent);
  assert.deepEqual(JSON.parse(sent.body), QUOTE);
  assert.ok(!sent.body.includes(ATTACKER));
});

test("an unexpected failure answers 500 with a generic message, and its log line has the key and the secrets redacted", async (t) => {
  const logs = captureConsole(t);
  const edge = "sentinel-edge-secret-8b2f";
  const signing = "sentinel-attestation-secret-41d6e0c9a7b35f28";
  const app = makeApp({
    input: { stocks: { enabled: true, countryHeader: "cf-ipcountry" } },
    env: { SODAX_API_KEY: KEY, EXCLIP_EDGE_SECRET: edge, EXCLIP_ATTESTATION_SECRET: signing },
    fetch: upstream([], () => brokenBody()),
    // The alert sink itself failing is about the only thing left for the last-resort handler to catch.
    onError: () => { throw new Error(`alert sink unavailable (${KEY} ${edge} ${signing})`); },
  });
  const s = await serve(t, app);
  const r = await s.post("/api/exclip/sodax/swaps/intents/status", { intentHash: "0x01" });
  assert.equal(r.status, 500);
  assert.deepEqual(bodyOf(r), { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
  assert.equal(r.headers["cache-control"], "no-store");
  assertNoKey(r, "500");
  const line = logs.find((l) => l.includes("POST /api/exclip/sodax/swaps/intents/status failed"));
  assert.ok(line, "the failure is logged");
  assert.match(line, /alert sink unavailable \(\[redacted\] \[redacted\] \[redacted\]\)/);
  assert.deepEqual(logs.filter((l) => l.includes(KEY) || l.includes(edge) || l.includes(signing)), []);
});

// ---- serving the built apps --------------------------------------------------------------------------------

/** What a stray middleware or a proxy library might add to every response. */
function strayHeaders(res: ServerResponse) {
  res.setHeader("Set-Cookie", "session=stray; Path=/; HttpOnly");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

const corsHeaders = (reply: Reply) => Object.keys(reply.headers).filter((name) => name.startsWith("access-control-"));

test("serveStatic, wallet host: the wallet page, its hashed assets and its backup API, nothing else, with the wallet's headers", async (t) => {
  const s = await serve(t, makeApp({ input: { server: { serveStatic: true } } }), strayHeaders);
  const host = WALLET_HOST;
  const page = await s.get("/", { host, headers: HTML });
  assert.equal(page.status, 200);
  assert.match(page.text, /wallet fixture/);
  assert.match(String(page.headers["content-type"]), /^text\/html/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["content-security-policy"], WALLET_CSP);
  const index = await s.get("/index.html", { host });
  assert.equal(index.status, 200);
  assert.match(index.text, /wallet fixture/);
  assert.equal(index.headers["cache-control"], "no-store");
  const asset = await s.get("/assets/wallet-abc123.js", { host });
  assert.equal(asset.status, 200);
  assert.match(asset.text, /wallet bundle/);
  assert.match(String(asset.headers["content-type"]), /javascript/);
  assert.equal(asset.headers["cache-control"], "no-store", "hashed or not, nothing from the wallet origin is cached");
  const api = await s.post("/api/exclip/wallet/challenge", { purpose: "register" }, { host, headers: { origin: WALLET_ORIGIN } });
  assert.equal(api.status, 200);
  assert.equal(typeof bodyOf(api).challenge, "string");
  assert.equal(api.headers["cache-control"], "no-store");

  const refused: Reply[] = [];
  for (const path of ["/api/exclip/config", "/api/exclip/sodax/swaps/tokens", "/api/exclip/wallet/../config", "/assets/app-abc123.js",
    "/logo.svg", "/swap", "/index.htm", "/assets/../index.html", "/assets/.hidden.js", "/assets/sub/wallet-abc123.js",
    "/assets/wallet-abc123.js.map"]) {
    const r = await s.get(path, { host, headers: HTML });
    assert.equal(r.status, 404, path);
    assert.equal(r.headers["cache-control"], "no-store", path);
    assert.ok(!r.text.includes("fixture"), path);
    refused.push(r);
  }
  const write = await s.post("/", {}, { host });
  assert.equal(write.status, 404);

  for (const r of [page, index, asset, api, write, ...refused]) {
    assertHeaders(r, walletSecurityHeaders(true), "wallet host");
    // Cookies and CORS headers never leave the wallet host, whatever set them.
    assert.equal(r.headers["set-cookie"], undefined);
    assert.deepEqual(corsHeaders(r), []);
  }
});

test("serveStatic, app host: the web app with a fallback for client routes, the API without the wallet's, the app's headers", async (t) => {
  const s = await serve(t, makeApp({ input: { server: { serveStatic: true } } }), strayHeaders);
  const host = APP_HOST;
  const home = await s.get("/", { host, headers: HTML });
  assert.equal(home.status, 200);
  assert.match(home.text, /web fixture/);
  assert.equal(home.headers["cache-control"], "no-store");
  const route = await s.get("/markets/BTC", { host, headers: HTML });
  assert.equal(route.status, 200);
  assert.match(route.text, /web fixture/);
  assert.equal(route.headers["cache-control"], "no-store");
  const index = await s.get("/index.html", { host });
  assert.equal(index.status, 200);
  assert.equal(index.headers["cache-control"], "no-store");
  const asset = await s.get("/assets/app-abc123.js", { host });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers["cache-control"], IMMUTABLE);
  const logo = await s.get("/logo.svg", { host });
  assert.equal(logo.status, 200);
  assert.equal(logo.headers["cache-control"], "no-cache");
  assert.match(String(logo.headers["content-type"]), /^image\/svg\+xml/);

  // Not a page navigation, or under /assets: a plain 404, never the app's page.
  for (const [path, headers] of [["/missing.js", {}], ["/assets/missing.js", HTML], ["/assets/wallet-abc123.js", {}]] as const) {
    const r = await s.get(path, { host, headers });
    assert.equal(r.status, 404, path);
    assert.equal(r.text, "Not found.", path);
  }

  // The API is here, except the wallet's, which is served on the wallet host only.
  const config = await s.get("/api/exclip/config", { host });
  assert.equal(config.status, 200);
  assert.equal(bodyOf(config).walletOrigin, WALLET_ORIGIN);
  for (const [method, path] of [["POST", "/api/exclip/wallet/challenge"], ["GET", "/api/exclip/wallet"], ["POST", "/api/exclip/wallet/backup/fetch"]] as const) {
    const r = method === "POST" ? await s.post(path, { purpose: "register" }, { host, headers: { origin: WALLET_ORIGIN } }) : await s.get(path, { host });
    assert.equal(r.status, 404, path);
    assert.deepEqual(bodyOf(r), { error: { code: "NOT_FOUND", message: "API route not found." } });
    assert.equal(r.headers["cache-control"], "no-store", path);
  }
  // An unknown API path is JSON, never the app's page.
  const missing = await s.get("/api/exclip/nope", { host, headers: HTML });
  assert.equal(missing.status, 404);
  assert.deepEqual(bodyOf(missing), { error: { code: "NOT_FOUND", message: "API route not found." } });

  for (const r of [home, route, index, asset, logo, config, missing]) assertHeaders(r, appSecurityHeaders(true), "app host");
  // Control: the stray headers do reach the app host, so their absence on the wallet host is the server's doing.
  assert.equal(home.headers["access-control-allow-origin"], "*");
});

test("serveStatic: the host name decides (any port, any case); X-Forwarded-Host counts only behind a trusted proxy; --dev serves nothing", async (t) => {
  const s = await serve(t, makeApp({ input: { server: { serveStatic: true } } }));
  const page = async (host: string, headers: Record<string, string> = {}) => (await s.get("/", { host, headers: { ...HTML, ...headers } })).text;
  assert.match(await page("wallet.example.com:8443"), /wallet fixture/);
  assert.match(await page("WALLET.EXAMPLE.COM"), /wallet fixture/);
  assert.match(await page(APP_HOST), /web fixture/);
  assert.match(await page("unknown.example.net"), /web fixture/);
  assert.match(await page(APP_HOST, { "x-forwarded-host": WALLET_HOST }), /web fixture/);
  assert.match(await page(WALLET_HOST, { "x-forwarded-host": APP_HOST }), /wallet fixture/);

  // Behind one trusted proxy (server.trustProxy: 1), the host the proxy forwards decides.
  const proxied = await serve(t, makeApp({ input: { server: { serveStatic: true, trustProxy: 1 } } }));
  const viaProxy = await proxied.get("/", { host: "10.0.0.5:8080", headers: { ...HTML, "x-forwarded-host": WALLET_HOST } });
  assert.match(viaProxy.text, /wallet fixture/);

  // Development: Vite serves both apps, so this server serves neither.
  const dev = await serve(t, makeApp({ dev: true, input: { server: { serveStatic: true } } }));
  for (const host of ["localhost:8080", WALLET_HOST]) {
    const r = await dev.get("/", { host, headers: HTML });
    assert.equal(r.status, 404, host);
    assert.equal(r.text, "Not found.", host);
  }
  assert.equal((await dev.get("/api/exclip/config")).status, 200);
});
