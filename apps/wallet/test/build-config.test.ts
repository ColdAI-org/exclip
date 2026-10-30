// Build-time trust settings baked into the wallet bundle (vite.config.ts) and the checks that guard them
// (build-guards.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import {
  DEV_ORIGINS, PLACEHOLDER_ORIGINS, WALLET_CSP, resolveConfig, walletBuildConfig, walletSecurityHeaders, type ExclipConfigInput,
} from "@exclip/config";
import { loadPublicConfig } from "@exclip/config/node";
import { FEE_RECEIVERS_FILE, assertProductionOrigins, buildWarnings, parseFeeReceivers } from "../build-guards.ts";
import viteConfig from "../vite.config.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const configOf = (input: ExclipConfigInput) => resolveConfig(input).config;
const OWN_ORIGINS = { app: "https://swap.example.org", wallet: "https://wallet.example.net" };

test("fee receivers come from the committed fee-receivers.json, never from the environment", () => {
  // The committed file parses; the build reads only it, and no environment variable at all.
  const committed = parseFeeReceivers(readFileSync(FEE_RECEIVERS_FILE, "utf8"));
  assert.ok(Array.isArray(committed));
  for (const file of ["../vite.config.ts", "../build-guards.ts"]) assert.doesNotMatch(read(file), /process\.env|import\.meta\.env/, file);

  const a = "0x" + "Ab".repeat(20);
  assert.deepEqual(parseFeeReceivers(JSON.stringify({ receivers: [] })), []);
  assert.deepEqual(parseFeeReceivers(JSON.stringify({ receivers: [a] })), [a.toLowerCase()]);
  for (const bad of [
    {}, { receivers: "0x" + "ab".repeat(20) }, { receivers: [a, a.toLowerCase()] }, { receivers: ["0x1234"] },
    { receivers: [42] }, { receivers: [a + " "] }, { receivers: ["ab".repeat(20)] },
  ]) {
    assert.throws(() => parseFeeReceivers(JSON.stringify(bad)), /fee-receivers\.json/, JSON.stringify(bad));
  }
  assert.throws(() => parseFeeReceivers("not json"));
});

test("the repository ships an empty fee allowlist, so the wallet signs only fee-free intents", () => {
  // A deployment that charges a partner fee adds its receiver to fee-receivers.json in a reviewed commit and updates
  // this test in the same commit (docs/embedded-wallet.md).
  assert.deepEqual(parseFeeReceivers(readFileSync(FEE_RECEIVERS_FILE, "utf8")), []);
});

test("production build guard: an app origin that shares the wallet's rpId is refused; distinct hosts pass", () => {
  for (const [app, wallet] of [
    [PLACEHOLDER_ORIGINS.app, PLACEHOLDER_ORIGINS.wallet],
    [OWN_ORIGINS.app, OWN_ORIGINS.wallet],
    ["https://app.example.com", "https://wallet.example.com"],
    // A parent domain can't claim a subdomain's rpId, so the app may sit above the wallet.
    ["https://example.com", "https://wallet.example.com"],
  ] as const) {
    assert.doesNotThrow(() => assertProductionOrigins([app], wallet), `${app} → ${wallet}`);
  }
  // The wallet's host, any port on it, or a subdomain of it: a page there could use the wallet's passkeys itself.
  for (const app of ["https://wallet.example.com", "https://wallet.example.com:8443", "https://app.wallet.example.com"]) {
    assert.throws(() => assertProductionOrigins([app], "https://wallet.example.com"), /shares the wallet's rpId/, app);
  }
  // Every parent is checked, not only the first.
  assert.throws(() => assertProductionOrigins([PLACEHOLDER_ORIGINS.app, "https://x.wallet.example.com"], PLACEHOLDER_ORIGINS.wallet), /shares the wallet's rpId/);
});

test("production build guard: exact https origins only, and at least one parent", () => {
  const notExact = [
    "http://wallet.example.com", "https://wallet.example.com/", "https://wallet.example.com/app", "https://Wallet.example.com",
    "https://wallet.example.com:443", "wallet.example.com", "", "http://localhost:5311",
  ];
  for (const bad of notExact) {
    assert.throws(() => assertProductionOrigins([PLACEHOLDER_ORIGINS.app], bad), /wallet origin: not an exact https origin/, bad);
  }
  for (const bad of [...notExact.map((o) => o.replace("wallet", "exclip")), "http://localhost:5173"]) {
    assert.throws(() => assertProductionOrigins([bad], PLACEHOLDER_ORIGINS.wallet), /parent origin: not an exact https origin/, bad);
  }
  assert.throws(() => assertProductionOrigins([], PLACEHOLDER_ORIGINS.wallet), /no parent origin/);
});

test("build warnings: the example origins (production only), and a partner fee whose receiver the wallet doesn't list", () => {
  assert.match(buildWarnings(configOf({}), [], true).join("\n"), /origins are still the examples/);
  assert.deepEqual(buildWarnings(configOf({}), [], false), [], "development uses DEV_ORIGINS");
  assert.deepEqual(buildWarnings(configOf({ origins: OWN_ORIGINS }), [], true), []);

  const receiver = "0x" + "Cd".repeat(20);
  const fee = configOf({ origins: OWN_ORIGINS, fees: { partnerFeeBps: 30, receiver } });
  for (const production of [true, false]) {
    assert.match(buildWarnings(fee, [], production).join("\n"), /the wallet will refuse every swap that carries a fee/);
    assert.match(buildWarnings(fee, ["0x" + "ab".repeat(20)], production).join("\n"), /refuse every swap that carries a fee/);
  }
  // fee-receivers.json entries are lower case once parsed; the config's receiver may be checksummed.
  assert.deepEqual(buildWarnings(fee, [receiver.toLowerCase()], true), []);
  // A receiver without a fee: nothing to list.
  assert.deepEqual(buildWarnings(configOf({ origins: OWN_ORIGINS, fees: { partnerFeeBps: 0, receiver } }), [], true), []);
});

test("what the wallet bakes in: the configured origins in production, DEV_ORIGINS in development", () => {
  const config = configOf({ origins: OWN_ORIGINS, brand: { name: "Swapper", operator: "Example Ltd" }, wallet: { unbackedLimitUsd: 250 } });
  const names = { brandName: "Swapper", operator: "Example Ltd", unbackedLimitUsd: 250 };
  assert.deepEqual(walletBuildConfig(config, false), { ...names, parentOrigins: [OWN_ORIGINS.app], walletOrigin: OWN_ORIGINS.wallet });
  assert.deepEqual(walletBuildConfig(config, true), { ...names, parentOrigins: [DEV_ORIGINS.app], walletOrigin: DEV_ORIGINS.wallet });
  assert.equal(walletBuildConfig(configOf({}), false).unbackedLimitUsd, 100, "the default limit");
});

test("vite.config.ts: every define from exclip.config.ts or fee-receivers.json, the security headers, no .env, no WebAssembly", async () => {
  const config = await loadPublicConfig();
  const declared = [...read("../src/defines.d.ts").matchAll(/declare const (__EXCLIP_\w+__)/g)].map((m) => m[1]).sort();
  const headers = walletSecurityHeaders(false);
  const { "content-security-policy": csp, ...withoutCsp } = headers;
  assert.equal(csp, WALLET_CSP);

  for (const command of ["serve", "build"] as const) {
    const dev = command === "serve";
    const vite = await viteConfig({ command, mode: dev ? "development" : "production" });
    const wallet = walletBuildConfig(config, dev);
    const define = vite.define as Record<string, string>;
    assert.deepEqual(Object.keys(define).sort(), declared, "every define is declared in src/defines.d.ts, and nothing else");
    assert.deepEqual(Object.fromEntries(Object.entries(define).map(([k, v]) => [k, JSON.parse(v)])), {
      __EXCLIP_PARENT_ORIGINS__: wallet.parentOrigins,
      __EXCLIP_FEE_RECEIVERS__: parseFeeReceivers(readFileSync(FEE_RECEIVERS_FILE, "utf8")),
      __EXCLIP_DEV__: dev,
      __EXCLIP_WALLET_ORIGIN__: wallet.walletOrigin,
      __EXCLIP_BRAND_NAME__: wallet.brandName,
      __EXCLIP_OPERATOR__: wallet.operator,
      __EXCLIP_UNBACKED_LIMIT_USD__: wallet.unbackedLimitUsd,
    }, command);
    assert.equal(vite.envDir, false, "no .env file can add VITE_* values to the bundle");

    // The dev server sends every header but the CSP (Vite's client injects styles); preview sends all of them.
    assert.deepEqual(vite.server?.headers, withoutCsp);
    assert.deepEqual(vite.preview?.headers, headers);
    assert.equal(String(vite.server?.port), new URL(DEV_ORIGINS.wallet).port, "the dev server is the dev wallet origin");
    assert.deepEqual(vite.server?.proxy, { "/api": { target: DEV_ORIGINS.server, changeOrigin: false } });

    // hash-wasm (WebAssembly, which the CSP forbids) is replaced by the pure-JS stub.
    const alias = vite.resolve?.alias as Record<string, string>;
    assert.equal(alias["hash-wasm"], fileURLToPath(new URL("../src/no-wasm.ts", import.meta.url)));
  }
});

test("the CSP guard refuses an index.html with inline script or style, or an external URL", async () => {
  const vite = await viteConfig({ command: "build", mode: "production" });
  const guard = (vite.plugins as Plugin[]).find((p) => p.name === "exclip-wallet-csp-guard");
  assert.ok(guard);
  assert.equal(guard.apply, "build");
  const generate = guard.generateBundle as unknown as (options: object, bundle: object) => void;
  const bundle = (source: string) => ({ "index.html": { type: "asset", fileName: "index.html", source } });
  generate({}, bundle(read("../index.html")));
  for (const [html, why] of [
    ["<script>alert(1)</script>", /inline <script>/],
    ['<script type="module">import "/src/main.ts"</script>', /inline <script>/],
    ["<style>body { color: red }</style>", /inline style/],
    ['<p style="color: red">x</p>', /inline style/],
    ['<script type="module" src="https://cdn.example.com/x.js"></script>', /external URL/],
    ['<link rel="stylesheet" href="//cdn.example.com/x.css" />', /external URL/],
  ] as const) {
    assert.throws(() => generate({}, bundle(html)), why, html);
  }
});
