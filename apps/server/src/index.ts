/** Starts the ExClip server: `node src/index.ts` (production) or `node src/index.ts --dev`. Reads exclip.config.ts
 * at the repository root, opens storage and listens on server.port. */
import { ConfigError, usesPlaceholderOrigins, type FeeSplit } from "@exclip/config";
import { formatRate } from "@exclip/config/fee-split";
import { findRepoRoot, loadExclipConfig, type LoadedConfig } from "@exclip/config/node";
import { createApp } from "./app.ts";
import { distDirs, missingBuilds } from "./static.ts";
import { openStorage, planStorage } from "./storage.ts";

const dev = process.argv.includes("--dev");

let loaded: LoadedConfig;
try {
  loaded = await loadExclipConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error("[exclip] the configuration can't be used:");
  for (const problem of error.problems) console.error(`  - ${problem}`);
  process.exit(1);
}
const { config, secrets, file } = loaded;

const plan = planStorage(config, secrets, dev);
if (plan.refusal) {
  console.error(`[exclip] ${plan.refusal}`);
  process.exit(1);
}
const storage = await openStorage(plan, secrets);
const app = createApp({ config, secrets, dev, kv: storage.kv, walletStore: storage.walletStore });

const where = { redis: "Redis", postgres: "Postgres", memory: "memory (this process only)" } as const;
const splitNote = (s: FeeSplit) => `fee split ${formatRate(s.totalRate)} % to splitter ${s.splitter} (${s.platformName} `
  + `${formatRate(s.platformRate)} %, operator ${formatRate(s.operatorRate)} %); on stock swaps `
  + (s.stockFee ? `${s.stockFee.percentage} bps to the operator` : "no fee");
const notes = [
  `${dev ? "development" : "production"} on port ${config.server.port}; configuration from ${file ?? "defaults (no exclip.config.ts)"}`,
  `storage: rate limits and challenges in ${where[plan.kv]}`
    + (config.features.embeddedWallet ? `; passkey wallet backups in ${where[plan.wallet]}` : "; passkey wallet off"),
  secrets.sodaxApiKey ? "SODAX API key: set" : "SODAX API key: not set (quotes and trading answer 503 until it is)",
  `trading ${config.features.trading ? "on" : "off"}; `
    + (config.fees.split ? splitNote(config.fees.split) : `partner fee ${config.fees.partnerFee ? `${config.fees.partnerFee.percentage} bps` : "none"}`),
  config.stocks.enabled
    ? `tokenised stocks: on; country from ${config.stocks.countryHeader} with the edge secret; terms version ${config.stocks.termsVersion}`
    : "tokenised stocks: off",
];
const warnings: string[] = [];
if (!dev && usesPlaceholderOrigins(config)) {
  warnings.push("origins are still the example placeholders (exclip.example.com, wallet.example.com): set origins in exclip.config.ts");
}
if (config.server.serveStatic && dev) notes.push("server.serveStatic is ignored with --dev (the Vite dev servers serve the apps)");
if (config.server.serveStatic && !dev) {
  const missing = missingBuilds(distDirs(findRepoRoot()));
  if (missing.length) warnings.push(`server.serveStatic is on but ${missing.join(" and ")} is missing: run pnpm build`);
}

/** Why the server can't listen, with the fix for the usual causes. */
function listenProblem(error: NodeJS.ErrnoException): string {
  if (error.code === "EADDRINUSE") return "another process is using it. Stop that process, or set PORT to a free port.";
  if (error.code === "EACCES") return "permission denied. Ports below 1024 usually need extra privileges: set PORT to a higher port.";
  return error.message;
}

// Express calls this with the error when listening fails (a port that's taken, say): report it and stop, rather than
// print the start-up lines of a server that isn't listening.
const server = app.listen(config.server.port, (error) => {
  if (error) {
    console.error(`[exclip] can't listen on port ${config.server.port}: ${listenProblem(error)}`);
    process.exit(1);
  }
  for (const note of notes) console.log(`[exclip] ${note}`);
  for (const warning of warnings) console.warn(`[exclip] warning: ${warning}`);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  // Let requests in flight finish, then release the stores; give up after 10 s.
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => {
    storage.close().then(() => process.exit(0), () => process.exit(1));
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
