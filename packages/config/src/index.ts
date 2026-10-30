/** ExClip configuration: the shape of `exclip.config.ts`, its defaults and validation, and the part each app may see.
 *
 * One file configures a deployment: `exclip.config.ts` at the repository root (git-ignored; start from
 * `exclip.config.example.ts`). resolveConfig splits it in two. `config` holds the public settings (brand, origins, fee,
 * switches) and the server's non-secret ones; `secrets` holds the SODAX key and the other credentials. Only
 * apps/server is ever handed `secrets`. The builds of apps/web and apps/wallet take a projection of `config` made by
 * webBuildConfig and walletBuildConfig, which pick fields one by one, so a secret has no path into a browser bundle.
 *
 * Erasable TypeScript only and no Node imports: Node loads this file directly when Vite imports it from an app's
 * vite.config.ts, and its types are shared with browser code. Reading the file from disk lives in `./node.ts`. */

export * from "./headers.ts";

export type BrandInput = {
  /** Product name: the app, the wallet window and passkey prompts. Default "ExClip". */
  name?: string;
  /** Who runs this deployment (a company or a person), shown in the footer. Default: not shown. */
  operator?: string;
  /** A path served by apps/web (its `public/` folder), like "/logo.svg", or an https URL. */
  logo?: string;
  /** Colours (#RRGGBB). accent: buttons, focus rings and links on the dark canvas (buttons put dark text on it);
   * accentHover: hover and pressed; accentInk: small text and links on light surfaces; gradientTo: the second stop of
   * the brand gradient. */
  colors?: { accent?: string; accentHover?: string; accentInk?: string; gradientTo?: string };
  /** Your terms of use and privacy notice (https), linked from the footer. */
  termsUrl?: string | null;
  privacyUrl?: string | null;
};

export type ExclipConfigInput = {
  sodax?: {
    /** Your SODAX API key. The SODAX_API_KEY environment variable, when set, wins. Only apps/server reads it. */
    apiKey?: string | null;
  };
  fees?: {
    /** Partner fee in basis points (100 = 1 %, the maximum), added to every swap through SODAX's partner fee.
     * Default 0. */
    partnerFeeBps?: number;
    /** The EVM address that receives the fee; required when partnerFeeBps is above 0. The passkey wallet must also
     * list it in apps/wallet/fee-receivers.json, or it refuses every swap that carries a fee. */
    receiver?: string | null;
  };
  /** Production origins: exact `https://host`, lower case, no path or trailing slash. Development always uses
   * DEV_ORIGINS. The wallet needs a host of its own (never the app's host or a parent of it). */
  origins?: { app?: string; wallet?: string };
  brand?: BrandInput;
  features?: {
    /** Build trades. Off: quotes, market data and order status still work; every route that builds a transaction is
     * refused. Default on. */
    trading?: boolean;
    /** Offer the passkey wallet (apps/wallet) and serve its backup API. Default on. */
    embeddedWallet?: boolean;
  };
  wallet?: {
    /** Until a passkey wallet is backed up (phrase saved or a second passkey), deposits above this many US dollars
     * are refused. Default 100. */
    unbackedLimitUsd?: number;
    /** Encrypted backup versions one passkey may store. Default 50. */
    maxBackupVersions?: number;
    /** New passkeys accepted per UTC day across all users; registration then pauses until the next day.
     * Default 2,000. */
    dailyNewPasskeys?: number;
  };
  server?: {
    /** Default 8080. The PORT environment variable wins. */
    port?: number;
    /** Postgres for the passkey wallet's encrypted backups (apply apps/server/migrations first), and for rate-limit
     * counters and challenges when there is no Redis. DATABASE_URL wins. Default: memory. */
    databaseUrl?: string | null;
    /** Redis for rate-limit counters and one-time challenges. REDIS_URL wins. */
    redisUrl?: string | null;
    /** Production refuses to start on memory storage (backups would vanish on restart) unless this is true. */
    allowMemoryStore?: boolean;
    /** Behind a reverse proxy: how many hops to trust for the client address (rate limits are per address). */
    trustProxy?: number;
    /** Serve the built web app and wallet from this server, chosen by Host (docs/self-hosting.md). */
    serveStatic?: boolean;
    /** Optional CoinGecko Pro key for market data. COINGECKO_API_KEY wins. Default: the public API. */
    coingeckoApiKey?: string | null;
  };
};

export type Brand = {
  name: string;
  operator: string;
  logo: string;
  accent: string;
  accentHover: string;
  accentInk: string;
  gradientTo: string;
  termsUrl: string | null;
  privacyUrl: string | null;
};

/** Everything except credentials. Safe to log; never handed to a browser as a whole (see the projections below). */
export type ExclipConfig = {
  brand: Brand;
  /** Production origins. Development always uses DEV_ORIGINS (see originsFor). */
  origins: { app: string; wallet: string };
  fees: {
    partnerFeeBps: number;
    receiver: string | null;
    /** What the server pins on every quote and intent: null unless a receiver is set and the rate is above 0. */
    partnerFee: { address: string; percentage: number } | null;
  };
  features: { trading: boolean; embeddedWallet: boolean };
  wallet: { unbackedLimitUsd: number; maxBackupVersions: number; dailyNewPasskeys: number };
  server: { port: number; allowMemoryStore: boolean; trustProxy: number; serveStatic: boolean };
};

/** Credentials. Only apps/server receives these. */
export type ExclipSecrets = {
  sodaxApiKey: string | null;
  coingeckoApiKey: string | null;
  databaseUrl: string | null;
  redisUrl: string | null;
};

/** Environment variables that override the file: credentials, the port, and two switches that can only turn things
 * off (an operator's emergency brake that needs no code change). */
export type Env = Readonly<Record<string, string | undefined>>;

/** ExClip's ceiling on the partner fee: 1 %. The wallet window refuses anything above it. */
export const PARTNER_FEE_MAX_BPS = 100;

/** Local development: web app, wallet window and server on fixed localhost ports. */
export const DEV_ORIGINS = {
  app: "http://localhost:5173",
  wallet: "http://localhost:5311",
  server: "http://localhost:8080",
} as const;

/** The production origins until you set your own: reserved example domains nobody can serve, so a build left on
 * them offers the passkey wallet nowhere. */
export const PLACEHOLDER_ORIGINS = {
  app: "https://exclip.example.com",
  wallet: "https://wallet.example.com",
} as const;

export const DEFAULT_BRAND: Brand = {
  name: "ExClip",
  operator: "",
  logo: "/logo.svg",
  accent: "#00B4F0",
  accentHover: "#38C8FF",
  accentInk: "#0077B6",
  gradientTo: "#2563EB",
  termsUrl: null,
  privacyUrl: null,
};

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`exclip.config.ts: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ON = /^(1|true|on|yes)$/i;

/** The settings resolveConfig knows, for reporting typos in a hand-written file. */
const KNOWN_KEYS: Record<string, readonly string[]> = {
  "": ["sodax", "fees", "origins", "brand", "features", "wallet", "server"],
  sodax: ["apiKey"],
  fees: ["partnerFeeBps", "receiver"],
  origins: ["app", "wallet"],
  brand: ["name", "operator", "logo", "colors", "termsUrl", "privacyUrl"],
  "brand.colors": ["accent", "accentHover", "accentInk", "gradientTo"],
  features: ["trading", "embeddedWallet"],
  wallet: ["unbackedLimitUsd", "maxBackupVersions", "dailyNewPasskeys"],
  server: ["port", "databaseUrl", "redisUrl", "allowMemoryStore", "trustProxy", "serveStatic", "coingeckoApiKey"],
};

const isLocalHost = (host: string) => host === "localhost" || host === "127.0.0.1";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** An exact origin: https, or http on localhost when `allowLocalHttp`. No path, query, credentials, default port or
 * upper case. Returns the origin, or null when `value` isn't exactly one. */
export function parseOrigin(value: unknown, allowLocalHttp = false): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(allowLocalHttp && url.protocol === "http:" && isLocalHost(url.hostname))) return null;
  return value === url.origin ? url.origin : null;
}

/** True when a page on `appHost` could claim `walletHost` as its WebAuthn rpId (the same host, or a subdomain of it),
 * and so could use the wallet's passkeys itself. */
export function sharesRpId(appHost: string, walletHost: string): boolean {
  return appHost === walletHost || appHost.endsWith(`.${walletHost}`);
}

/** Validates the file, applies the environment overrides and fills in defaults. Throws ConfigError listing every
 * problem: a build or a server start with a broken setting stops, rather than running with a fee, an origin or a
 * switch nobody asked for. */
export function resolveConfig(input: ExclipConfigInput = {}, env: Env = {}): { config: ExclipConfig; secrets: ExclipSecrets } {
  const problems: string[] = [];

  // Unknown keys, at every level the file has.
  const walk = (value: unknown, path: string) => {
    if (!isRecord(value)) return;
    const known = KNOWN_KEYS[path];
    if (!known) return;
    for (const key of Object.keys(value)) {
      const child = path ? `${path}.${key}` : key;
      if (!known.includes(key)) problems.push(`unknown setting ${child}`);
      else walk(value[key], child);
    }
  };
  if (!isRecord(input)) problems.push("the default export must be an object");
  else walk(input, "");

  const section = (key: keyof ExclipConfigInput): Record<string, unknown> => {
    const value = isRecord(input) ? input[key] : undefined;
    if (value === undefined) return {};
    if (isRecord(value)) return value;
    problems.push(`${key} must be an object`);
    return {};
  };
  const text = (value: unknown, fallback: string, field: string, max: number): string => {
    if (value === undefined) return fallback;
    if (typeof value === "string" && value.length <= max && !hasControlOrMarkup(value)) return value.trim();
    problems.push(`${field} must be plain text of at most ${max} characters`);
    return fallback;
  };
  const optionalText = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "string" && !/\s/.test(value)) return value;
    problems.push(`${field} must be a string without spaces, or null`);
    return null;
  };
  const color = (value: unknown, fallback: string, field: string): string => {
    if (value === undefined) return fallback;
    if (typeof value === "string" && HEX_COLOR.test(value)) return value.toUpperCase();
    problems.push(`${field} must be a #RRGGBB colour`);
    return fallback;
  };
  const httpsUrl = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "string") {
      try {
        if (new URL(value).protocol === "https:") return value;
      } catch {
        // reported below
      }
    }
    problems.push(`${field} must be an https URL or null`);
    return null;
  };
  const flag = (value: unknown, fallback: boolean, field: string): boolean => {
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    problems.push(`${field} must be true or false`);
    return fallback;
  };
  const whole = (value: unknown, fallback: number, min: number, max: number, field: string): number => {
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max) return value;
    problems.push(`${field} must be a whole number from ${min} to ${max}`);
    return fallback;
  };
  const fromEnv = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };

  const b = section("brand");
  const colors = isRecord(b.colors) ? b.colors : {};
  if (b.colors !== undefined && !isRecord(b.colors)) problems.push("brand.colors must be an object");
  let logo = DEFAULT_BRAND.logo;
  if (b.logo !== undefined) {
    const sitePath = typeof b.logo === "string" && /^\/[A-Za-z0-9._/-]+$/.test(b.logo) && !b.logo.includes("..");
    if (sitePath || (typeof b.logo === "string" && /^https:\/\/[^\s"'<>()\\]+$/.test(b.logo))) logo = b.logo as string;
    else problems.push("brand.logo must be a path under apps/web/public (like /logo.svg) or an https URL");
  }
  const brand: Brand = {
    name: text(b.name, DEFAULT_BRAND.name, "brand.name", 40) || DEFAULT_BRAND.name,
    operator: text(b.operator, DEFAULT_BRAND.operator, "brand.operator", 80),
    logo,
    accent: color(colors.accent, DEFAULT_BRAND.accent, "brand.colors.accent"),
    accentHover: color(colors.accentHover, DEFAULT_BRAND.accentHover, "brand.colors.accentHover"),
    accentInk: color(colors.accentInk, DEFAULT_BRAND.accentInk, "brand.colors.accentInk"),
    gradientTo: color(colors.gradientTo, DEFAULT_BRAND.gradientTo, "brand.colors.gradientTo"),
    termsUrl: httpsUrl(b.termsUrl, "brand.termsUrl"),
    privacyUrl: httpsUrl(b.privacyUrl, "brand.privacyUrl"),
  };

  const o = section("origins");
  const app = parseOrigin(o.app ?? PLACEHOLDER_ORIGINS.app);
  const wallet = parseOrigin(o.wallet ?? PLACEHOLDER_ORIGINS.wallet);
  if (!app) problems.push("origins.app must be an exact https origin such as https://exclip.example.com");
  if (!wallet) problems.push("origins.wallet must be an exact https origin such as https://wallet.example.com");
  if (app && wallet && sharesRpId(new URL(app).hostname, new URL(wallet).hostname)) {
    problems.push("origins.wallet needs a host of its own: the app may not be on the wallet's host or a subdomain of it");
  }

  const f = section("fees");
  const partnerFeeBps = whole(f.partnerFeeBps, 0, 0, PARTNER_FEE_MAX_BPS, "fees.partnerFeeBps");
  let receiver: string | null = null;
  if (f.receiver !== undefined && f.receiver !== null && f.receiver !== "") {
    if (typeof f.receiver === "string" && EVM_ADDRESS.test(f.receiver)) receiver = f.receiver;
    else problems.push("fees.receiver must be an EVM address (0x and 40 hex digits) or null");
  }
  if (partnerFeeBps > 0 && receiver === null) problems.push("fees.receiver is required when fees.partnerFeeBps is above 0");

  const ft = section("features");
  const features = {
    trading: flag(ft.trading, true, "features.trading") && !ON.test(fromEnv("EXCLIP_DISABLE_TRADING") ?? ""),
    embeddedWallet: flag(ft.embeddedWallet, true, "features.embeddedWallet") && !ON.test(fromEnv("EXCLIP_DISABLE_EMBEDDED_WALLET") ?? ""),
  };

  const w = section("wallet");
  const walletLimits = {
    unbackedLimitUsd: whole(w.unbackedLimitUsd, 100, 0, 1_000_000, "wallet.unbackedLimitUsd"),
    maxBackupVersions: whole(w.maxBackupVersions, 50, 1, 1_000, "wallet.maxBackupVersions"),
    dailyNewPasskeys: whole(w.dailyNewPasskeys, 2_000, 1, 1_000_000, "wallet.dailyNewPasskeys"),
  };

  const s = section("server");
  const portEnv = fromEnv("PORT");
  const port = portEnv !== undefined
    ? whole(/^\d+$/.test(portEnv) ? Number(portEnv) : Number.NaN, 8080, 1, 65_535, "PORT")
    : whole(s.port, 8080, 1, 65_535, "server.port");
  const server = {
    port,
    allowMemoryStore: flag(s.allowMemoryStore, false, "server.allowMemoryStore"),
    trustProxy: whole(s.trustProxy, 0, 0, 10, "server.trustProxy"),
    serveStatic: flag(s.serveStatic, false, "server.serveStatic"),
  };

  const sx = section("sodax");
  const secrets: ExclipSecrets = {
    sodaxApiKey: fromEnv("SODAX_API_KEY") ?? optionalText(sx.apiKey, "sodax.apiKey"),
    coingeckoApiKey: fromEnv("COINGECKO_API_KEY") ?? optionalText(s.coingeckoApiKey, "server.coingeckoApiKey"),
    databaseUrl: fromEnv("DATABASE_URL") ?? optionalText(s.databaseUrl, "server.databaseUrl"),
    redisUrl: fromEnv("REDIS_URL") ?? optionalText(s.redisUrl, "server.redisUrl"),
  };

  if (problems.length || !app || !wallet) throw new ConfigError(problems);
  return {
    config: {
      brand,
      origins: { app, wallet },
      fees: {
        partnerFeeBps,
        receiver,
        partnerFee: partnerFeeBps > 0 && receiver ? { address: receiver, percentage: partnerFeeBps } : null,
      },
      features,
      wallet: walletLimits,
      server,
    },
    secrets,
  };
}

function hasControlOrMarkup(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || ch === "<" || ch === ">") return true;
  }
  return false;
}

/** True while either production origin is still the example placeholder. */
export function usesPlaceholderOrigins(config: ExclipConfig): boolean {
  return config.origins.app === PLACEHOLDER_ORIGINS.app || config.origins.wallet === PLACEHOLDER_ORIGINS.wallet;
}

/** The origins in force: the configured ones in production, DEV_ORIGINS in development. */
export function originsFor(config: ExclipConfig, dev: boolean): { app: string; wallet: string } {
  return dev ? { app: DEV_ORIGINS.app, wallet: DEV_ORIGINS.wallet } : { ...config.origins };
}

/** What apps/web bakes into its bundle: the brand and the two origins, picked field by field. Switches that may change
 * without a rebuild (trading, the passkey wallet, the fee) come from the server's `/api/exclip/config` instead. */
export function webBuildConfig(config: ExclipConfig, dev: boolean) {
  const origins = originsFor(config, dev);
  const b = config.brand;
  return {
    brand: {
      name: b.name,
      operator: b.operator,
      logo: b.logo,
      accent: b.accent,
      accentHover: b.accentHover,
      accentInk: b.accentInk,
      gradientTo: b.gradientTo,
      termsUrl: b.termsUrl,
      privacyUrl: b.privacyUrl,
    },
    appOrigin: origins.app,
    walletOrigin: origins.wallet,
  };
}

export type WebBuildConfig = ReturnType<typeof webBuildConfig>;

/** What apps/wallet bakes into its bundle: the one page origin it answers, its own origin, the names it shows and the
 * deposit limit for a wallet that isn't backed up yet (the popup enforces its own copy; the page's is only a hint). */
export function walletBuildConfig(config: ExclipConfig, dev: boolean) {
  const origins = originsFor(config, dev);
  return {
    brandName: config.brand.name,
    operator: config.brand.operator,
    parentOrigins: [origins.app],
    walletOrigin: origins.wallet,
    unbackedLimitUsd: config.wallet.unbackedLimitUsd,
  };
}

export type WalletBuildConfig = ReturnType<typeof walletBuildConfig>;
