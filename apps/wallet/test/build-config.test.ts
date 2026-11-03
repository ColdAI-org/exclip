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
import { EMPTY_FEE_ALLOW_LIST, parseFeeAllowList, type FeeAllowList } from "@exclip/config/fee-split";
import { loadPublicConfig } from "@exclip/config/node";
import { FEE_RECEIVERS_FILE, assertProductionOrigins, buildWarnings, feeSplitTerms, parseFeeReceivers } from "../build-guards.ts";
import viteConfig, { brandIcon } from "../vite.config.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const configOf = (input: ExclipConfigInput, allowList?: FeeAllowList) => resolveConfig(input, {}, allowList).config;
const OWN_ORIGINS = { app: "https://swap.example.org", wallet: "https://wallet.example.net" };

// The local dry run's factory, as a reviewer lists it from the chain (contracts/fee-split/README.md), and the README's
// split under it, whose splitter is 0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe.
const DRY_RUN = (JSON.parse(read("../../../contracts/fee-split/test/vectors/splitters.json")) as {
  factories: { address: string; platform: string; platformRate: number; maxTotalRate: number; initCodeHash: string }[];
}).factories[0]!;
const FACTORY = { address: DRY_RUN.address, platformName: "Platform", platform: DRY_RUN.platform, platformRate: DRY_RUN.platformRate, maxTotalRate: DRY_RUN.maxTotalRate, initCodeHash: DRY_RUN.initCodeHash };
const SPLIT = { factory: DRY_RUN.address, operator: "0x" + "22".repeat(20), operatorRate: 100 };
const allowList = (receivers: string[], splits: unknown[] = []) => parseFeeAllowList(JSON.stringify({ receivers, factories: [FACTORY], splits }));

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

test("the build stops on a fee-split factory or split the allow-list can't vouch for", () => {
  const receiver = "0x" + "33".repeat(20);
  const file = (factories: unknown[], splits: unknown[]) => JSON.stringify({ receivers: [receiver], factories, splits });

  // Listed properly, a split adds nothing to the plain-fee receivers.
  assert.deepEqual(parseFeeReceivers(file([FACTORY], [SPLIT])), [receiver]);
  for (const [factories, splits, why] of [
    [[{ ...FACTORY, initCodeHash: "0x" + "00".repeat(32) }], [], /initCodeHash/],
    [[{ ...FACTORY, platformRate: 1_876 }], [], /factories\[0\]/],
    [[FACTORY], [{ ...SPLIT, factory: "0x" + "44".repeat(20) }], /is not in "factories"/],
    [[FACTORY], [{ ...SPLIT, operator: DRY_RUN.platform }], /\(OperatorIsPlatform\)/],
    [[FACTORY], [{ ...SPLIT, operatorRate: 1_001 }], /operatorRate/],
    [[FACTORY], [SPLIT, SPLIT], /listed twice/],
  ] as const) {
    assert.throws(() => parseFeeReceivers(file([...factories], [...splits])), (e: unknown) => e instanceof Error && /^fee-receivers\.json: /.test(e.message) && why.test(e.message), why.source);
  }
});

test("the wallet gets each listed split with its factory's values and the platform's name, and works the splitter out itself", () => {
  assert.deepEqual(feeSplitTerms(allowList([], [SPLIT])), [{
    factory: DRY_RUN.address, platform: DRY_RUN.platform, platformName: "Platform", platformRate: 875, maxTotalRate: 1_875,
    operator: SPLIT.operator, operatorRate: 100,
  }]);
  assert.deepEqual(feeSplitTerms(allowList([])), []);
  assert.deepEqual(feeSplitTerms(EMPTY_FEE_ALLOW_LIST), []);
});

test("the repository ships an empty fee allowlist, so the wallet signs only fee-free intents", () => {
  // A deployment that charges a fee adds its receiver, or its fee-split factory and split, to fee-receivers.json in a
  // reviewed commit and updates this test in the same commit (docs/fees.md, CONTRIBUTING.md). No other test pins what
  // the file lists.
  assert.deepEqual(parseFeeAllowList(readFileSync(FEE_RECEIVERS_FILE, "utf8")), { receivers: [], factories: [], splits: [] });
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

test("build warnings: the example origins (production only), and a plain fee whose receiver the wallet doesn't list", () => {
  const none = EMPTY_FEE_ALLOW_LIST;
  const receiving = (receivers: string[]): FeeAllowList => ({ ...none, receivers });
  assert.match(buildWarnings(configOf({}), none, true).join("\n"), /origins are still the examples/);
  assert.deepEqual(buildWarnings(configOf({}), none, false), [], "development uses DEV_ORIGINS");
  assert.deepEqual(buildWarnings(configOf({ origins: OWN_ORIGINS }), none, true), []);

  const receiver = "0x" + "Cd".repeat(20);
  const fee = configOf({ origins: OWN_ORIGINS, fees: { partnerFeeBps: 30, receiver } });
  for (const production of [true, false]) {
    assert.match(buildWarnings(fee, none, production).join("\n"), /the wallet will refuse every swap that carries a fee/);
    assert.match(buildWarnings(fee, receiving(["0x" + "ab".repeat(20)]), production).join("\n"), /refuse every swap that carries a fee/);
  }
  // fee-receivers.json entries are lower case once parsed; the config's receiver may be checksummed.
  assert.deepEqual(buildWarnings(fee, receiving([receiver.toLowerCase()]), true), []);
  // A receiver without a fee: nothing to list.
  assert.deepEqual(buildWarnings(configOf({ origins: OWN_ORIGINS, fees: { partnerFeeBps: 0, receiver } }), none, true), []);

  // A fee rate goes to the same list, and so does its fee on stock swaps, which is paid to the same receiver.
  const rate = configOf({ origins: OWN_ORIGINS, fees: { rate: 875, stockFeeBps: 25, receiver }, stocks: { enabled: true, countryHeader: "cf-ipcountry" } });
  for (const production of [true, false]) {
    assert.match(buildWarnings(rate, none, production).join("\n"), /the partner fee goes to 0xCdCd.*the wallet will refuse every swap that carries a fee/);
  }
  assert.deepEqual(buildWarnings(rate, receiving([receiver.toLowerCase()]), true), []);
  assert.deepEqual(buildWarnings(configOf({ origins: OWN_ORIGINS, fees: { rate: 0, receiver } }), none, true), []);
});

test("build warnings: a fee split whose split the wallet doesn't list, and a stock-swap fee whose receiver it doesn't list", () => {
  const factoryOnly = allowList([]);
  const listed = allowList([], [SPLIT]);
  const split = configOf({ origins: OWN_ORIGINS, fees: { split: SPLIT } }, factoryOnly);
  assert.equal(split.fees.split?.splitter, "0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe");
  for (const production of [true, false]) {
    assert.match(buildWarnings(split, factoryOnly, production).join("\n"), /0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe .*the wallet will refuse every swap that carries the split's fee/);
  }
  assert.deepEqual(buildWarnings(split, listed, true), []);
  // The same operator at another rate is another split, with another splitter.
  assert.match(buildWarnings(split, allowList([], [{ ...SPLIT, operatorRate: 101 }]), true).join("\n"), /refuse every swap that carries the split's fee/);

  // With stocks on, a swap with a stock carries the operator's own plain fee instead, paid to its address: a receiver.
  const stocks = { stocks: { enabled: true, countryHeader: "cf-ipcountry" } };
  const stockFee = configOf({ origins: OWN_ORIGINS, fees: { split: { ...SPLIT, stockFeeBps: 25 } }, ...stocks }, factoryOnly);
  assert.match(
    buildWarnings(stockFee, listed, true).join("\n"),
    /the fee on swaps with a tokenised stock goes to 0x2222222222222222222222222222222222222222, .*refuse every such swap that carries a fee/,
  );
  assert.deepEqual(buildWarnings(stockFee, allowList([SPLIT.operator], [SPLIT]), true), []);
  // Stocks off, or no fee on stock swaps: nothing to list.
  assert.deepEqual(buildWarnings(configOf({ origins: OWN_ORIGINS, fees: { split: { ...SPLIT, stockFeeBps: 25 } } }, factoryOnly), listed, true), []);
  assert.deepEqual(buildWarnings(configOf({ origins: OWN_ORIGINS, fees: { split: SPLIT }, ...stocks }, factoryOnly), listed, true), []);
});

test("what the wallet bakes in: the configured origins in production, DEV_ORIGINS in development", () => {
  const config = configOf({ origins: OWN_ORIGINS, brand: { name: "Swapper", operator: "Example Ltd" }, wallet: { unbackedLimitUsd: 250 } });
  const names = { brandName: "Swapper", operator: "Example Ltd", unbackedLimitUsd: 250, stocks: false, feeRate: null, feeReceiverName: "Swapper" };
  assert.deepEqual(walletBuildConfig(config, false), { ...names, parentOrigins: [OWN_ORIGINS.app], walletOrigin: OWN_ORIGINS.wallet });
  assert.deepEqual(walletBuildConfig(config, true), { ...names, parentOrigins: [DEV_ORIGINS.app], walletOrigin: DEV_ORIGINS.wallet });
  assert.equal(walletBuildConfig(configOf({}), false).unbackedLimitUsd, 100, "the default limit");
});

test("the wallet gets a plain fee's rate and the name its review gives the receiver from exclip.config.ts", () => {
  const receiver = "0x" + "Cd".repeat(20);
  const brand = { name: "Swapper", operator: "Example Operator Ltd" };
  const fee = (input: ExclipConfigInput, list?: FeeAllowList) => {
    const { feeRate, feeReceiverName } = walletBuildConfig(configOf({ brand, ...input }, list), false);
    return { feeRate, feeReceiverName };
  };
  assert.deepEqual(fee({ fees: { rate: 875, stockFeeBps: 25, receiver, receiverName: "Example Ltd" } }), { feeRate: { rate: 875, stockFeeBps: 25 }, feeReceiverName: "Example Ltd" });
  // No fee on stock swaps is 0, and with no name the review names the brand, as the app's does.
  assert.deepEqual(fee({ fees: { rate: 875, receiver } }), { feeRate: { rate: 875, stockFeeBps: 0 }, feeReceiverName: "Swapper" });
  // A fee in basis points has no rate for the wallet to hold it to, only the cap; its receiver may have a name too.
  assert.deepEqual(fee({ fees: { partnerFeeBps: 30, receiver, receiverName: "Example Ltd" } }), { feeRate: null, feeReceiverName: "Example Ltd" });
  assert.deepEqual(fee({ fees: { rate: 0, receiver } }), { feeRate: null, feeReceiverName: "Swapper" });
  // With a split, the plain fee is its fee on stock swaps, which goes to the operator: the review names the operator.
  assert.deepEqual(fee({ fees: { split: { ...SPLIT, stockFeeBps: 25 } } }, allowList([])), { feeRate: null, feeReceiverName: "Example Operator Ltd" });
  assert.deepEqual(fee({ brand: { name: "Swapper" }, fees: { split: SPLIT } }, allowList([])), { feeRate: null, feeReceiverName: "Swapper" });
});

test("the wallet signs tokenised stocks only in a build with stocks.enabled, and EXCLIP_DISABLE_STOCKS there switches them off", () => {
  const stocks = { stocks: { enabled: true, countryHeader: "cf-ipcountry" } };
  assert.equal(walletBuildConfig(configOf({}), false).stocks, false, "off by default");
  for (const dev of [false, true]) assert.equal(walletBuildConfig(configOf(stocks), dev).stocks, true);
  assert.equal(walletBuildConfig(resolveConfig(stocks, { EXCLIP_DISABLE_STOCKS: "1" }).config, false).stocks, false);
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
      __EXCLIP_FEE_SPLITS__: feeSplitTerms(parseFeeAllowList(readFileSync(FEE_RECEIVERS_FILE, "utf8"))),
      __EXCLIP_FEE_RATE__: wallet.feeRate,
      __EXCLIP_DEV__: dev,
      __EXCLIP_WALLET_ORIGIN__: wallet.walletOrigin,
      __EXCLIP_BRAND_NAME__: wallet.brandName,
      __EXCLIP_OPERATOR__: wallet.operator,
      __EXCLIP_FEE_RECEIVER_NAME__: wallet.feeReceiverName,
      __EXCLIP_UNBACKED_LIMIT_USD__: wallet.unbackedLimitUsd,
      __EXCLIP_STOCKS__: wallet.stocks,
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

test("the window's tab icon is brand.logo inlined as a data: URL; an https logo, which the CSP would block, gives none", async () => {
  const page = read("../index.html");
  const iconOf = (logo: string) => (brandIcon(logo).transformIndexHtml as unknown as (html: string) => string)(page);
  const href = iconOf("/logo.svg").match(/<link rel="icon" href="data:image\/svg\+xml;base64,([^"]+)" \/>/)?.[1];
  assert.ok(href, "a data: URL icon in the page");
  assert.equal(Buffer.from(href, "base64").toString("utf8"), read("../../web/public/logo.svg"));
  assert.equal(iconOf("https://cdn.example.com/brand/logo.svg"), page);
  assert.throws(() => brandIcon("/no-such-logo.svg"), /apps\/web\/public\/no-such-logo\.svg doesn't exist/);

  // The built page with the icon still passes the CSP guard, and the plugin is in the build.
  const vite = await viteConfig({ command: "build", mode: "production" });
  assert.ok((vite.plugins as Plugin[]).some((p) => p.name === "exclip-wallet-icon"));
  const guard = (vite.plugins as Plugin[]).find((p) => p.name === "exclip-wallet-csp-guard");
  const generate = guard?.generateBundle as unknown as (options: object, bundle: object) => void;
  generate({}, { "index.html": { type: "asset", fileName: "index.html", source: iconOf("/logo.svg") } });
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
