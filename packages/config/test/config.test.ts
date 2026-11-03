import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import example from "../../../exclip.config.example.ts";
import { EMPTY_FEE_ALLOW_LIST, parseFeeAllowList } from "../src/fee-split.ts";
import {
  ConfigError,
  DEV_ORIGINS,
  FEE_RATE_MAX,
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
import { FEE_ALLOW_LIST_FILE, findRepoRoot, loadExclipConfig, loadPublicConfig, readFeeAllowList } from "../src/node.ts";

const RECEIVER = "0x1111111111111111111111111111111111111111";
/** The platform and the operator of the local dry run's sample split (contracts/fee-split/README.md). */
const PLATFORM = RECEIVER;
const OPERATOR = "0x2222222222222222222222222222222222222222";
type VectorFactory = { address: string; platform: string; platformRate: number; maxTotalRate: number; initCodeHash: string };
/** The factories real FeeSplitterFactory contracts gave on anvil (contracts/fee-split/script/Vectors.s.sol), listed as
 * a reviewer lists them. The first is the dry run's: the platform 0x1111…1111 at 875, a cap of 1,875. */
const VECTOR_FACTORIES = (JSON.parse(
  readFileSync(new URL("../../../contracts/fee-split/test/vectors/splitters.json", import.meta.url), "utf8"),
) as { factories: VectorFactory[] }).factories.map(({ address, platform, platformRate, maxTotalRate, initCodeHash }, i) => (
  { address, platformName: `Platform ${i + 1}`, platform, platformRate, maxTotalRate, initCodeHash }
));
const ALLOW_LIST_JSON = JSON.stringify({ receivers: [], factories: VECTOR_FACTORIES });
const ALLOW_LIST = parseFeeAllowList(ALLOW_LIST_JSON);
const [DRY_RUN, , NO_PLATFORM_FEE, NO_ROOM] = ALLOW_LIST.factories.map((f) => f.address) as [string, string, string, string];
const SPLIT = { factory: DRY_RUN, operator: OPERATOR, operatorRate: 100 };
/** The refusals of a second kind of fee. */
const SPLIT_AND_PLAIN = "fees.split can't be set with fees.partnerFeeBps, fees.rate, fees.receiver or fees.receiverName: a config sets a plain fee or a split, never both";
const STOCK_FEE_WITHOUT_RATE = "fees.stockFeeBps can be set only with fees.rate above 0: fees.partnerFeeBps is charged on every swap, stocks included, and a split has fees.split.stockFeeBps";
const SECRET = "sodax-test-key-must-never-leave-the-server";
/** Stocks switched on as the documentation shows, and the two secrets the server then needs. */
const STOCKS_ON = { enabled: true, countryHeader: "cf-ipcountry" } as const;
const STOCK_SECRETS = { EXCLIP_EDGE_SECRET: "edge-test-secret-not-real", EXCLIP_ATTESTATION_SECRET: "a".repeat(32) };

function problemsOf(input: unknown, env: Env = {}, allowList = EMPTY_FEE_ALLOW_LIST): readonly string[] {
  try {
    resolveConfig(input as ExclipConfigInput, env, allowList);
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
  assert.equal(config.fees.rate, 0);
  assert.equal(config.fees.receiver, null);
  assert.equal(config.fees.receiverName, "ExClip");
  assert.equal(config.fees.partnerFee, null);
  assert.equal(config.fees.rateFee, null);
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
  assert.equal(config.fees.rateFee, null);
});

test("fee rate: a whole number per 100,000 of the amount sold up to 1 %, only with a receiver, never with partnerFeeBps", () => {
  const { config } = resolveConfig({ fees: { rate: 875, receiver: RECEIVER } });
  assert.deepEqual(config.fees.rateFee, { address: RECEIVER, rate: 875, stockFee: null });
  assert.equal(config.fees.rate, 875);
  assert.equal(config.fees.partnerFee, null, "nothing in basis points");
  assert.equal(FEE_RATE_MAX, 1_000);
  for (const rate of [1, 1_000]) assert.equal(resolveConfig({ fees: { rate, receiver: RECEIVER } }).config.fees.rateFee?.rate, rate);
  for (const bad of [-1, 2.5, 1_001, Number.NaN, Number.POSITIVE_INFINITY, "875", null]) {
    assert.deepEqual(problemsOf({ fees: { rate: bad, receiver: RECEIVER } }), ["fees.rate must be a whole number from 0 to 1000"], String(bad));
  }
  // 0 is no fee, and the example's partnerFeeBps 0 isn't a fee in basis points.
  assert.equal(resolveConfig({ fees: { rate: 0, receiver: RECEIVER } }).config.fees.rateFee, null);
  assert.equal(resolveConfig({ fees: { partnerFeeBps: 0, rate: 875, receiver: RECEIVER } }).config.fees.rateFee?.rate, 875);
  assert.deepEqual(problemsOf({ fees: { rate: 875 } }), ["fees.receiver is required when fees.rate is above 0"]);
  assert.deepEqual(problemsOf({ fees: { rate: 875, receiver: null } }), ["fees.receiver is required when fees.rate is above 0"]);
  assert.match(problemsOf({ fees: { rate: 875, receiver: "0x1234" } })[0]!, /fees.receiver must be an EVM address/);
  // One plain fee: in basis points or as a rate.
  assert.deepEqual(problemsOf({ fees: { partnerFeeBps: 10, rate: 100, receiver: RECEIVER } }), [
    "fees.partnerFeeBps and fees.rate can't both be set: a plain fee is given in basis points or as a rate, never both",
  ]);
});

test("fee rate: its own fee on stock swaps, in basis points to the same receiver, and only with a rate", () => {
  const { config } = resolveConfig({ fees: { rate: 875, stockFeeBps: 25, receiver: RECEIVER } });
  assert.deepEqual(config.fees.rateFee, { address: RECEIVER, rate: 875, stockFee: { address: RECEIVER, percentage: 25 } });
  assert.equal(resolveConfig({ fees: { rate: 875, stockFeeBps: 100, receiver: RECEIVER } }).config.fees.rateFee?.stockFee?.percentage, 100);
  assert.equal(resolveConfig({ fees: { rate: 875, stockFeeBps: 0, receiver: RECEIVER } }).config.fees.rateFee?.stockFee, null);
  for (const bad of [-1, 2.5, 101, "25", null]) {
    assert.deepEqual(problemsOf({ fees: { rate: 875, stockFeeBps: bad, receiver: RECEIVER } }), ["fees.stockFeeBps must be a whole number from 0 to 100"], String(bad));
  }
  // partnerFeeBps stays the same fee on every swap, stocks included, and a split has a stock fee of its own.
  assert.deepEqual(problemsOf({ fees: { partnerFeeBps: 30, stockFeeBps: 25, receiver: RECEIVER } }), [STOCK_FEE_WITHOUT_RATE]);
  assert.deepEqual(problemsOf({ fees: { stockFeeBps: 25, receiver: RECEIVER } }), [STOCK_FEE_WITHOUT_RATE]);
  assert.deepEqual(problemsOf({ fees: { stockFeeBps: 25, split: SPLIT } }, {}, ALLOW_LIST), [STOCK_FEE_WITHOUT_RATE]);
  assert.deepEqual(resolveConfig({ fees: { partnerFeeBps: 30, stockFeeBps: 0, receiver: RECEIVER } }).config.fees.partnerFee, { address: RECEIVER, percentage: 30 });
});

test("the fee's receiver name: brand.name by default, plain text like a platform's name, with either plain fee", () => {
  const nameOf = (input: ExclipConfigInput) => resolveConfig(input).config.fees.receiverName;
  assert.equal(nameOf({ brand: { name: "Swapper" }, fees: { rate: 875, receiver: RECEIVER } }), "Swapper");
  assert.equal(nameOf({ brand: { name: "Swapper" }, fees: { rate: 875, receiver: RECEIVER, receiverName: "Example Ltd" } }), "Example Ltd");
  assert.equal(nameOf({ fees: { partnerFeeBps: 30, receiver: RECEIVER, receiverName: "Example Ltd" } }), "Example Ltd");
  // It may sit ready while no fee is charged.
  assert.equal(nameOf({ fees: { receiverName: "x".repeat(40) } }), "x".repeat(40));
  for (const bad of ["", " Example Ltd", "Example Ltd ", "x".repeat(41), "<b>Example</b>", "Example\nLtd", "Example\tLtd", 7, null]) {
    assert.deepEqual(
      problemsOf({ fees: { rate: 875, receiver: RECEIVER, receiverName: bad } }),
      ["fees.receiverName must be plain text of 1 to 40 characters, with no space at either end"],
      JSON.stringify(bad),
    );
  }
});

test("the example's commented fee rate is valid once uncommented, with a receiver set", async () => {
  const source = readFileSync(new URL("../../../exclip.config.example.ts", import.meta.url), "utf8");
  const block = source.match(/^ *\/\/ {3}rate: .*\n(?: *\/\/ {3}\w+: .*\n)+/m)?.[0];
  assert.ok(block, "the example shows a fee rate");
  const module = `export default { ${block.replace(/^ *\/\/ {3}/gm, "")} };`;
  const { default: rate } = (await import(`data:text/javascript,${encodeURIComponent(module)}`)) as { default: ExclipConfigInput["fees"] };
  // In place, next to the example's partnerFeeBps 0, with the receiver the comment asks for.
  const { config } = resolveConfig({ fees: { ...example.fees, ...rate, receiver: RECEIVER } });
  assert.deepEqual(config.fees.rateFee, { address: RECEIVER, rate: 875, stockFee: null });
  assert.equal(config.fees.receiverName, "Example Ltd");
  assert.deepEqual(problemsOf({ fees: { ...example.fees, ...rate } }), ["fees.receiver is required when fees.rate is above 0"]);
});

test("fee split: the factory's values from the allow-list, the operator's from the config, and the splitter they give", () => {
  const { config } = resolveConfig({ fees: { split: SPLIT } }, {}, ALLOW_LIST);
  assert.deepEqual(config.fees.split, {
    factory: DRY_RUN,
    // The README's sample splitter, which the dry-run factory itself predicted and created.
    splitter: "0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe",
    platformName: "Platform 1",
    platform: PLATFORM,
    platformRate: 875,
    operator: OPERATOR,
    operatorRate: 100,
    totalRate: 975,
    stockFee: null,
  });
  assert.equal(config.fees.partnerFee, null, "no plain fee");
  assert.equal(resolveConfig().config.fees.split, null, "no split by default");

  // Lower case in, EIP-55 out. The example's partnerFeeBps 0 and receiver null aren't a plain fee.
  const lower = resolveConfig({ fees: { partnerFeeBps: 0, receiver: null, split: { ...SPLIT, factory: DRY_RUN.toLowerCase() } } }, {}, ALLOW_LIST);
  assert.equal(lower.config.fees.split?.factory, DRY_RUN);
  assert.equal(lower.config.fees.split?.splitter, "0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe");
  // From only the platform's rate to the operator's 1 % on top, the 1.875 % the factory allows in all.
  for (const [operatorRate, totalRate] of [[0, 875], [1, 876], [1_000, 1_875]] as const) {
    assert.equal(resolveConfig({ fees: { split: { ...SPLIT, operatorRate } } }, {}, ALLOW_LIST).config.fees.split?.totalRate, totalRate);
  }
  // The operator's own plain fee on stock swaps, paid straight to its address.
  const stocks = resolveConfig({ fees: { split: { ...SPLIT, stockFeeBps: 25 } } }, {}, ALLOW_LIST).config.fees.split;
  assert.deepEqual(stocks?.stockFee, { address: OPERATOR, percentage: 25 });
});

test("fee split: refused unless the allow-list lists the factory, and wherever the factory would refuse it", () => {
  const only = (input: unknown, allowList = ALLOW_LIST) => {
    const problems = problemsOf(input, {}, allowList);
    assert.equal(problems.length, 1, problems.join("\n"));
    return problems[0]!;
  };
  const notListed = /fees\.split\.factory 0x5b73C5498c1E3b4dbA84de0F1833c4a029d90519 is not listed in apps\/wallet\/fee-receivers\.json/;
  assert.match(only({ fees: { split: SPLIT } }, EMPTY_FEE_ALLOW_LIST), notListed);
  assert.match(only({ fees: { split: { ...SPLIT, factory: DRY_RUN.toLowerCase() } } }, EMPTY_FEE_ALLOW_LIST), notListed);
  // The factory's four refusals, from the listed platform, rate and cap.
  assert.match(only({ fees: { split: { ...SPLIT, operator: `0x${"0".repeat(40)}` } } }), /fees\.split: .*\(ZeroAddress\)/);
  assert.match(only({ fees: { split: { ...SPLIT, operator: PLATFORM } } }), /fees\.split: .*\(OperatorIsPlatform\)/);
  assert.match(only({ fees: { split: { ...SPLIT, factory: NO_ROOM, operatorRate: 1 } } }), /operatorRate 1 is above the 0 the factory leaves an operator \(RateTooHigh\)/);
  assert.match(only({ fees: { split: { ...SPLIT, factory: NO_PLATFORM_FEE, operatorRate: 0 } } }), /\(ZeroRates\)/);
  // The operator's limit, whatever room the factory leaves: NO_PLATFORM_FEE's cap would allow 1,875.
  for (const operatorRate of [1_001, 1_875, -1, 2.5, "100", null]) {
    assert.match(only({ fees: { split: { ...SPLIT, factory: NO_PLATFORM_FEE, operatorRate } } }), /fees\.split\.operatorRate must be a whole number from 0 to 1000/, String(operatorRate));
  }
  assert.match(only({ fees: { split: { factory: DRY_RUN, operator: OPERATOR } } }), /fees\.split\.operatorRate must be/);
  // One kind of fee or the other.
  assert.equal(only({ fees: { partnerFeeBps: 10, receiver: RECEIVER, split: SPLIT } }), SPLIT_AND_PLAIN);
  assert.equal(only({ fees: { rate: 100, receiver: RECEIVER, split: SPLIT } }), SPLIT_AND_PLAIN);
  assert.equal(only({ fees: { receiver: RECEIVER, split: SPLIT } }), SPLIT_AND_PLAIN);
  assert.equal(only({ fees: { receiverName: "Example Ltd", split: SPLIT } }), SPLIT_AND_PLAIN);
  // Addresses: 0x and 40 hex digits, with a valid checksum when in mixed case.
  assert.match(only({ fees: { split: { ...SPLIT, factory: "0x5B73C5498c1E3b4dbA84de0F1833c4a029d90519" } } }), /fees\.split\.factory must be 0x and 40 hex digits/);
  assert.match(only({ fees: { split: { ...SPLIT, operator: "0x2222" } } }), /fees\.split\.operator must be/);
  assert.match(only({ fees: { split: { ...SPLIT, stockFeeBps: 101 } } }), /fees\.split\.stockFeeBps must be a whole number from 0 to 100/);
  assert.match(only({ fees: { split: "0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe" } }), /fees\.split must be an object, or null/);
  assert.deepEqual(problemsOf({ fees: { split: { ...SPLIT, splitter: "0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe" } } }, {}, ALLOW_LIST), [
    "unknown setting fees.split.splitter",
  ]);
  assert.equal(resolveConfig({ fees: { split: null } }, {}, ALLOW_LIST).config.fees.split, null);
});

test("the example's commented split is valid once uncommented, with its factory listed", async () => {
  const source = readFileSync(new URL("../../../exclip.config.example.ts", import.meta.url), "utf8");
  const block = source.match(/^ *\/\/ {3}split: \{\n(?: *\/\/ {5}.*\n)+ *\/\/ {3}\},$/m)?.[0];
  assert.ok(block, "the example shows a split");
  const module = `export default { ${block.replace(/^ *\/\/ {3}/gm, "")} };`;
  const { default: fees } = (await import(`data:text/javascript,${encodeURIComponent(module)}`)) as { default: ExclipConfigInput["fees"] };
  assert.equal(resolveConfig({ fees }, {}, ALLOW_LIST).config.fees.split?.splitter, "0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe");
  assert.match(problemsOf({ fees }).join("\n"), /is not listed/, "refused without its factory listed");
});

test("the config check reads the allow-list at the root: a split needs its factory there, and a broken file stops it", async () => {
  // By default, the repository's own. Only apps/wallet/test/build-config.test.ts pins what it lists.
  assert.deepEqual(readFeeAllowList(), parseFeeAllowList(readFileSync(join(findRepoRoot(), FEE_ALLOW_LIST_FILE), "utf8")));

  const dir = configDir(`export default { fees: { split: ${JSON.stringify(SPLIT)} } };\n`);
  await assert.rejects(loadExclipConfig({}, dir), (e: unknown) => e instanceof ConfigError && /is not listed/.test(e.problems.join()));
  mkdirSync(join(dir, "apps", "wallet"), { recursive: true });
  writeFileSync(join(dir, FEE_ALLOW_LIST_FILE), ALLOW_LIST_JSON);
  assert.equal((await loadExclipConfig({}, dir)).config.fees.split?.splitter, "0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe");
  assert.equal((await loadPublicConfig({}, dir)).fees.split?.totalRate, 975);

  writeFileSync(join(dir, FEE_ALLOW_LIST_FILE), JSON.stringify({ receivers: [], factories: [{ ...VECTOR_FACTORIES[0], initCodeHash: `0x${"0".repeat(64)}` }] }));
  await assert.rejects(loadExclipConfig({}, dir), (e: unknown) => e instanceof ConfigError && /^fee-receivers\.json: factories\[0\]: initCodeHash/.test(e.problems[0]!));
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
