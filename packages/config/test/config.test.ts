import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import example from "../../../exclip.config.example.ts";
import {
  ConfigError,
  DEV_ORIGINS,
  ISO_COUNTRY_CODES,
  PARTNER_FEE_MAX_BPS,
  PLACEHOLDER_ORIGINS,
  STOCKS_BASELINE_COUNTRIES,
  STOCK_STATEMENTS,
  WALLET_CSP,
  appSecurityHeaders,
  originsFor,
  parseOrigin,
  resolveConfig,
  secretProblems,
  sharesRpId,
  usesPlaceholderOrigins,
  walletBuildConfig,
  walletSecurityHeaders,
  webBuildConfig,
  type Env,
  type ExclipConfigInput,
} from "../src/index.ts";
import { findRepoRoot, loadExclipConfig, loadPublicConfig } from "../src/node.ts";

const RECEIVER = "0x1111111111111111111111111111111111111111";
const SECRET = "sodax-test-key-must-never-leave-the-server";
/** Stocks switched on as the documentation shows, and the two secrets the server then needs. */
const STOCKS_ON = { enabled: true, countryHeader: "cf-ipcountry" } as const;
const STOCK_SECRETS = { EXCLIP_EDGE_SECRET: "edge-test-secret-not-real", EXCLIP_ATTESTATION_SECRET: "a".repeat(32) };

function problemsOf(input: unknown, env: Env = {}): readonly string[] {
  try {
    resolveConfig(input as ExclipConfigInput, env);
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return e.problems;
  }
  assert.fail("expected a ConfigError");
}

/** A folder holding `exclip.config.ts` with `source`, as an ES module. */
function configDir(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "exclip-config-"));
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  writeFileSync(join(dir, "exclip.config.ts"), source);
  return dir;
}

test("defaults: no partner fee, nothing pinned, no key, the ExClip brand and the placeholder origins", () => {
  const { config, secrets } = resolveConfig();
  assert.equal(config.fees.partnerFeeBps, 0);
  assert.equal(config.fees.receiver, null);
  assert.equal(config.fees.partnerFee, null);
  assert.equal(config.brand.name, "ExClip");
  assert.deepEqual(config.origins, { ...PLACEHOLDER_ORIGINS });
  assert.equal(usesPlaceholderOrigins(config), true);
  assert.deepEqual(config.features, { trading: true, embeddedWallet: true });
  assert.deepEqual(config.wallet, { unbackedLimitUsd: 100, maxBackupVersions: 50, dailyNewPasskeys: 2000 });
  assert.deepEqual(config.server, { port: 8080, allowMemoryStore: false, trustProxy: 0, serveStatic: false });
  assert.deepEqual(config.stocks, { enabled: false, countryHeader: null, blockedCountries: [], termsVersion: "1" });
  assert.deepEqual(secrets, {
    sodaxApiKey: null, coingeckoApiKey: null, databaseUrl: null, redisUrl: null, edgeSecret: null, attestationSecret: null,
  });
});

test("the shipped exclip.config.example.ts is valid, sets every section, charges no fee and has no key", () => {
  const { config, secrets } = resolveConfig(example);
  assert.equal(example.fees.partnerFeeBps, 0);
  assert.equal(config.fees.partnerFee, null);
  assert.equal(secrets.sodaxApiKey, null);
  assert.deepEqual(Object.keys(example).sort(), ["brand", "features", "fees", "origins", "server", "sodax", "stocks", "wallet"]);
  assert.equal(example.stocks.enabled, false, "tokenised stocks stay off until an operator switches them on");
  // The example spells out the defaults, so copying it changes nothing until you edit it.
  assert.deepEqual(config, resolveConfig().config);
});

test("tokenised stocks: off by default; on, they need the proxy's country header, and the lists are checked", () => {
  const { config } = resolveConfig({
    stocks: { ...STOCKS_ON, countryHeader: "CF-IPCountry", blockedCountries: ["gb", "CA", "GB"], termsVersion: "2026-11-01" },
  });
  assert.deepEqual(config.stocks, { enabled: true, countryHeader: "cf-ipcountry", blockedCountries: ["CA", "GB"], termsVersion: "2026-11-01" });
  // Settings may sit ready while stocks stay off.
  assert.equal(resolveConfig({ stocks: { countryHeader: "cf-ipcountry" } }).config.stocks.enabled, false);

  assert.deepEqual(problemsOf({ stocks: { enabled: true } }), [
    "stocks.countryHeader is required when stocks.enabled is true: the header your reverse proxy sets to the visitor's country code (docs/tokenised-stocks.md)",
  ]);
  for (const bad of ["cf_ipcountry", "x country", "-x", "x--y", "x-", "a".repeat(65), 7, true, ["cf-ipcountry"]]) {
    assert.match(problemsOf({ stocks: { countryHeader: bad } })[0]!, /stocks.countryHeader must be a header name/, String(bad));
  }
  for (const own of ["x-exclip-edge-secret", "X-Exclip-Stocks-Attestation"]) {
    assert.match(problemsOf({ stocks: { countryHeader: own } })[0]!, /ExClip uses that header itself/, own);
  }
  // Codes that look like countries but aren't ISO 3166-1 alpha-2 ones would block nobody, so they're refused.
  for (const bad of ["UK", "XK", "EU", "XX", "USA", "U", "", 1, null]) {
    assert.match(problemsOf({ stocks: { blockedCountries: [bad] } })[0]!, /is not an ISO 3166-1 alpha-2 country code/, String(bad));
  }
  assert.match(problemsOf({ stocks: { blockedCountries: "GB" } })[0]!, /stocks.blockedCountries must be a list/);
  for (const bad of ["", "two words", "a".repeat(33), "-1", 2, null]) {
    assert.match(problemsOf({ stocks: { termsVersion: bad } })[0]!, /stocks.termsVersion must be/, String(bad));
  }
  assert.match(problemsOf({ stocks: { enabled: "yes" } })[0]!, /stocks.enabled must be true or false/);
  assert.deepEqual(problemsOf({ stocks: { allowedCountries: ["DE"] } }), ["unknown setting stocks.allowedCountries"]);
});

test("the baseline is exported, made of real country codes, and always holds the United States", () => {
  assert.equal(ISO_COUNTRY_CODES.size, 249);
  for (const code of ISO_COUNTRY_CODES) assert.match(code, /^[A-Z]{2}$/);
  assert.ok(Object.isFrozen(STOCKS_BASELINE_COUNTRIES));
  assert.deepEqual([...STOCKS_BASELINE_COUNTRIES].sort(), STOCKS_BASELINE_COUNTRIES, "sorted, so a change reads clearly in a diff");
  for (const code of STOCKS_BASELINE_COUNTRIES) assert.ok(ISO_COUNTRY_CODES.has(code), code);
  for (const code of ["US", "PR", "GU", "VI", "AS", "MP", "UM"]) assert.ok(STOCKS_BASELINE_COUNTRIES.includes(code), code);
  // The operator's list adds to the baseline; the baseline isn't copied into it.
  assert.deepEqual(resolveConfig({ stocks: { blockedCountries: ["US", "FR"] } }).config.stocks.blockedCountries, ["FR", "US"]);
  assert.deepEqual(STOCK_STATEMENTS.map((s) => s.id), ["not-us-person", "permitted", "risks", "own-decision"]);
});

test("stocks: the environment switches them off but never on, and supplies their two secrets", () => {
  const on = resolveConfig({ stocks: STOCKS_ON }, STOCK_SECRETS);
  assert.equal(on.config.stocks.enabled, true);
  assert.equal(on.secrets.edgeSecret, STOCK_SECRETS.EXCLIP_EDGE_SECRET);
  assert.equal(on.secrets.attestationSecret, STOCK_SECRETS.EXCLIP_ATTESTATION_SECRET);
  assert.equal(resolveConfig({ stocks: STOCKS_ON }, { ...STOCK_SECRETS, EXCLIP_DISABLE_STOCKS: "1" }).config.stocks.enabled, false);
  assert.equal(resolveConfig({ stocks: STOCKS_ON }, { EXCLIP_DISABLE_STOCKS: "0" }).config.stocks.enabled, true);
  assert.equal(resolveConfig({}, { EXCLIP_DISABLE_STOCKS: "0", ...STOCK_SECRETS }).config.stocks.enabled, false);
});

test("start-up: stocks on without the edge secret or a 32-character attestation secret stop the server, not a build", async () => {
  const problemsFor = (env: Env, stocks: ExclipConfigInput["stocks"] = STOCKS_ON) => {
    const { config, secrets } = resolveConfig({ stocks }, env);
    return secretProblems(config, secrets);
  };
  assert.deepEqual(problemsFor(STOCK_SECRETS), []);
  const neither = problemsFor({});
  assert.equal(neither.length, 2, neither.join("\n"));
  assert.match(neither[0]!, /^EXCLIP_EDGE_SECRET is required when stocks.enabled is true/);
  assert.match(neither[1]!, /^EXCLIP_ATTESTATION_SECRET must be at least 32 characters/);
  assert.deepEqual(problemsFor({ ...STOCK_SECRETS, EXCLIP_EDGE_SECRET: "   " }).length, 1);
  assert.match(problemsFor({ ...STOCK_SECRETS, EXCLIP_ATTESTATION_SECRET: "a".repeat(31) }).join(), /EXCLIP_ATTESTATION_SECRET/);
  // Off, or switched off by the environment: nothing is needed, so the emergency brake works without the secrets.
  assert.deepEqual(problemsFor({}, { ...STOCKS_ON, enabled: false }), []);
  assert.deepEqual(problemsFor({ EXCLIP_DISABLE_STOCKS: "1" }), []);

  // The server's loader refuses; the builds' loader reads the same file without any secret.
  const dir = configDir(`export default { stocks: { enabled: true, countryHeader: "cf-ipcountry" } };\n`);
  await assert.rejects(loadExclipConfig({}, dir), (e: unknown) => e instanceof ConfigError && e.problems.length === 2);
  assert.equal((await loadExclipConfig(STOCK_SECRETS, dir)).config.stocks.enabled, true);
  assert.equal((await loadPublicConfig({}, dir)).stocks.enabled, true);
});

test("partner fee: whole basis points up to 1 %, and only with a receiver", () => {
  const { config } = resolveConfig({ fees: { partnerFeeBps: 25, receiver: RECEIVER } });
  assert.deepEqual(config.fees.partnerFee, { address: RECEIVER, percentage: 25 });
  assert.equal(PARTNER_FEE_MAX_BPS, 100);
  for (const bad of [-1, 2.5, 101, Number.NaN, Number.POSITIVE_INFINITY, "25"]) {
    assert.match(problemsOf({ fees: { partnerFeeBps: bad, receiver: RECEIVER } })[0]!, /fees.partnerFeeBps must be a whole number from 0 to 100/, String(bad));
  }
  assert.match(problemsOf({ fees: { partnerFeeBps: 10 } })[0]!, /fees.receiver is required/);
  assert.match(problemsOf({ fees: { receiver: "0x1234" } })[0]!, /EVM address/);
});

test("a receiver without a rate pins nothing", () => {
  const { config } = resolveConfig({ fees: { receiver: RECEIVER } });
  assert.equal(config.fees.receiver, RECEIVER);
  assert.equal(config.fees.partnerFee, null);
});

test("origins: exact https origins, and the wallet on a host of its own", () => {
  assert.equal(parseOrigin("https://wallet.example.org"), "https://wallet.example.org");
  for (const bad of ["http://wallet.example.org", "https://wallet.example.org/", "https://wallet.example.org/x",
    "https://Wallet.example.org", "https://user@wallet.example.org", "https://wallet.example.org:443", "wallet.example.org"]) {
    assert.equal(parseOrigin(bad), null, bad);
  }
  assert.equal(parseOrigin("http://localhost:5311", true), "http://localhost:5311");
  assert.equal(parseOrigin("http://localhost:5311"), null);

  assert.equal(sharesRpId("wallet.example.org", "wallet.example.org"), true);
  assert.equal(sharesRpId("app.wallet.example.org", "wallet.example.org"), true);
  assert.equal(sharesRpId("exclip.example.org", "wallet.example.org"), false);
  assert.equal(sharesRpId("mywallet.example.org", "wallet.example.org"), false);

  const { config } = resolveConfig({ origins: { app: "https://swap.example.org", wallet: "https://wallet.example.org" } });
  assert.deepEqual(config.origins, { app: "https://swap.example.org", wallet: "https://wallet.example.org" });
  assert.equal(usesPlaceholderOrigins(config), false);
  // A page on the wallet's host, or below it, could claim the wallet's passkeys: refused.
  assert.match(problemsOf({ origins: { app: "https://x.wallet.example.org", wallet: "https://wallet.example.org" } })[0]!, /host of its own/);
  assert.match(problemsOf({ origins: { app: "https://example.org", wallet: "https://example.org" } })[0]!, /host of its own/);
  assert.match(problemsOf({ origins: { wallet: "http://wallet.example.org" } })[0]!, /origins.wallet/);
});

test("development uses the localhost origins whatever is configured", () => {
  const { config } = resolveConfig({ origins: { app: "https://swap.example.org", wallet: "https://wallet.example.org" } });
  assert.deepEqual(originsFor(config, true), { app: DEV_ORIGINS.app, wallet: DEV_ORIGINS.wallet });
  assert.deepEqual(originsFor(config, false), config.origins);
  assert.deepEqual(walletBuildConfig(config, true).parentOrigins, [DEV_ORIGINS.app]);
  assert.deepEqual(walletBuildConfig(config, false).parentOrigins, ["https://swap.example.org"]);
});

test("brand, switches and limits are validated, never passed through", () => {
  const { config } = resolveConfig({
    brand: {
      name: "Swapper",
      colors: { accent: "#a1b2c3" },
      logo: "https://cdn.example.org/logo.svg",
      termsUrl: "https://example.org/terms",
    },
    features: { trading: false, embeddedWallet: false },
    wallet: { unbackedLimitUsd: 250 },
  });
  assert.equal(config.brand.name, "Swapper");
  assert.equal(config.brand.accent, "#A1B2C3");
  assert.equal(config.brand.accentHover, "#38C8FF", "colours left out keep their defaults");
  assert.equal(config.brand.logo, "https://cdn.example.org/logo.svg");
  assert.equal(config.brand.termsUrl, "https://example.org/terms");
  assert.deepEqual(config.features, { trading: false, embeddedWallet: false });
  assert.equal(config.wallet.unbackedLimitUsd, 250);
  assert.equal(walletBuildConfig(config, false).unbackedLimitUsd, 250, "the popup enforces the configured limit");
  assert.equal(walletBuildConfig(resolveConfig().config, false).unbackedLimitUsd, 100);

  const problems = problemsOf({
    brand: {
      name: "<script>",
      colors: { accent: "blue" },
      logo: "javascript:alert(1)",
      termsUrl: "http://example.org/terms",
    },
    features: { trading: "off" },
    wallet: { maxBackupVersions: 0 },
  });
  assert.equal(problems.length, 6, problems.join("\n"));
  assert.match(problemsOf({ brand: { logo: "/../secret" } })[0]!, /brand.logo/);
});

test("a misspelt setting is an error, not silently ignored", () => {
  assert.deepEqual(problemsOf({ fees: { partnerFeeBp: 10 } }), ["unknown setting fees.partnerFeeBp"]);
  assert.deepEqual(problemsOf({ brand: { colours: {} } }), ["unknown setting brand.colours"]);
  assert.deepEqual(problemsOf({ sodaxKey: "x" }), ["unknown setting sodaxKey"]);
  assert.deepEqual(problemsOf("not an object"), ["the default export must be an object"]);
});

test("the environment supplies credentials and the port, and can switch features off but never on", () => {
  const { config, secrets } = resolveConfig(
    { sodax: { apiKey: "from-file" }, server: { port: 3000 } },
    { SODAX_API_KEY: "from-env", PORT: "9000", REDIS_URL: "redis://cache:6379" },
  );
  assert.equal(secrets.sodaxApiKey, "from-env");
  assert.equal(secrets.redisUrl, "redis://cache:6379");
  assert.equal(config.server.port, 9000);
  assert.equal(resolveConfig({ sodax: { apiKey: "from-file" } }, { SODAX_API_KEY: "  " }).secrets.sodaxApiKey, "from-file");

  const off = resolveConfig({}, { EXCLIP_DISABLE_TRADING: "1", EXCLIP_DISABLE_EMBEDDED_WALLET: "true" }).config;
  assert.deepEqual(off.features, { trading: false, embeddedWallet: false });
  const stillOff = resolveConfig({ features: { trading: false } }, { EXCLIP_DISABLE_TRADING: "0" }).config;
  assert.equal(stillOff.features.trading, false);
  assert.match(problemsOf({}, { PORT: "80a" })[0]!, /PORT/);
});

test("what a build bakes in never carries a secret", () => {
  const { config, secrets } = resolveConfig(
    {
      sodax: { apiKey: SECRET },
      server: { coingeckoApiKey: SECRET, databaseUrl: `postgres://u:${SECRET}@db/x`, redisUrl: `redis://:${SECRET}@cache` },
      brand: { name: "Swapper" },
      stocks: STOCKS_ON,
    },
    { SODAX_API_KEY: SECRET, EXCLIP_EDGE_SECRET: SECRET, EXCLIP_ATTESTATION_SECRET: SECRET },
  );
  assert.equal(secrets.sodaxApiKey, SECRET);
  assert.equal(secrets.edgeSecret, SECRET);
  assert.ok(!JSON.stringify(config).includes(SECRET), "the public settings hold no credential");
  for (const dev of [true, false]) {
    assert.ok(!JSON.stringify(webBuildConfig(config, dev)).includes(SECRET));
    assert.ok(!JSON.stringify(walletBuildConfig(config, dev)).includes(SECRET));
  }
});

test("loadExclipConfig reads exclip.config.ts, and loadPublicConfig drops the credentials", async () => {
  const dir = configDir(`export default { brand: { name: "FromFile" }, sodax: { apiKey: "${SECRET}" } };\n`);
  const loaded = await loadExclipConfig({}, dir);
  assert.equal(loaded.file, join(dir, "exclip.config.ts"));
  assert.equal(loaded.config.brand.name, "FromFile");
  assert.equal(loaded.secrets.sodaxApiKey, SECRET);
  assert.equal((await loadExclipConfig({ SODAX_API_KEY: "from-env" }, dir)).secrets.sodaxApiKey, "from-env");

  const publicOnly = await loadPublicConfig({}, dir);
  assert.equal(publicOnly.brand.name, "FromFile");
  assert.ok(!JSON.stringify(publicOnly).includes(SECRET));
});

test("loadExclipConfig: no file means the defaults; a broken file stops the start", async () => {
  const empty = mkdtempSync(join(tmpdir(), "exclip-config-"));
  const none = await loadExclipConfig({}, empty);
  assert.equal(none.file, null);
  assert.equal(none.config.fees.partnerFeeBps, 0);

  await assert.rejects(loadExclipConfig({ EXCLIP_CONFIG: "missing.config.ts" }, empty), ConfigError);
  await assert.rejects(loadExclipConfig({}, configDir("export const brand = {};\n")), /export default/);
  await assert.rejects(loadExclipConfig({}, configDir("export default { fees: { partnerFeeBps: 500 } };\n")), ConfigError);
});

test("findRepoRoot finds this workspace", () => {
  assert.ok(existsSync(join(findRepoRoot(), "pnpm-workspace.yaml")));
  assert.equal(findRepoRoot(), findRepoRoot(join(import.meta.dirname, "..", "src")));
});

test("security headers: the wallet runs only its own code and can't be framed", () => {
  const h = walletSecurityHeaders(true);
  assert.equal(h["content-security-policy"], WALLET_CSP);
  assert.match(WALLET_CSP, /default-src 'none'/);
  assert.match(WALLET_CSP, /script-src 'self';/);
  assert.match(WALLET_CSP, /frame-ancestors 'none'/);
  assert.match(WALLET_CSP, /require-trusted-types-for 'script'/);
  assert.doesNotMatch(WALLET_CSP, /unsafe-(inline|eval)|wasm/);
  assert.equal(h["x-frame-options"], "DENY");
  assert.equal(h["cross-origin-opener-policy"], "unsafe-none", "the popup answers through window.opener");
  assert.equal(h["cache-control"], "no-store", "no cache keeps an older wallet build");
  assert.match(h["permissions-policy"]!, /^publickey-credentials-get=\(self\), publickey-credentials-create=\(self\)/);
  assert.ok(h["strict-transport-security"]);
  assert.equal(walletSecurityHeaders(false)["strict-transport-security"], undefined);

  const app = appSecurityHeaders(true);
  assert.match(app["content-security-policy"]!, /script-src 'self';/);
  assert.match(app["content-security-policy"]!, /upgrade-insecure-requests/);
  assert.doesNotMatch(appSecurityHeaders(false)["content-security-policy"]!, /upgrade-insecure-requests/);
  assert.equal(app["cross-origin-opener-policy"], "same-origin-allow-popups", "keeps the wallet popup's opener");
  assert.match(app["permissions-policy"]!, /publickey-credentials-get=\(\)/, "the app itself never runs the wallet's passkeys");
});
