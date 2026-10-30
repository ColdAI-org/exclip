/** ExClip configuration.
 *
 * Copy this file to exclip.config.ts (git-ignored, so your key stays out of commits), add your SODAX key and your
 * origins, then restart `pnpm dev` or rebuild. Every setting is optional: one you leave out takes the value shown here.
 * Node 24 runs this file as it is, so keep to plain values and type annotations (no enums or namespaces).
 * docs/configuration.md explains each setting and the environment variables that override them. */
import type { ExclipConfigInput } from "@exclip/config";

export default {
  sodax: {
    // Your SODAX API key. Only apps/server reads it; it is never sent to a browser. The SODAX_API_KEY environment
    // variable wins when set. Without a key, the app loads but every quote answers "Trading isn't connected".
    apiKey: "",
  },

  fees: {
    // Partner fee in basis points: 0 (no fee) up to 100 (1 %), taken from each swap by SODAX and paid to receiver.
    partnerFeeBps: 0,
    // The EVM address that receives the fee. It must also be listed in apps/wallet/fee-receivers.json (a change made
    // only by a reviewed commit), or the passkey wallet refuses every swap that carries a fee.
    receiver: null,
  },

  origins: {
    // Your production origins: exact https://host, lower case, nothing after the host. Development ignores them and
    // uses http://localhost:5173 (app) and http://localhost:5311 (wallet). The wallet needs a host of its own: never
    // the app's host, and the app never on a subdomain of the wallet's.
    app: "https://exclip.example.com",
    wallet: "https://wallet.example.com",
  },

  brand: {
    name: "ExClip",
    // Who runs this deployment (you), shown in the footer.
    operator: "",
    // A file in apps/web/public, or an https URL.
    logo: "/logo.svg",
    colors: {
      accent: "#00B4F0",
      accentHover: "#38C8FF",
      accentInk: "#0077B6",
      gradientTo: "#2563EB",
    },
    // Your terms of use and privacy notice (https), linked from the footer.
    termsUrl: null,
    privacyUrl: null,
  },

  features: {
    // Off: prices, quotes and order status keep working, and every route that builds a transaction is refused.
    trading: true,
    // The passkey wallet (apps/wallet) and its encrypted-backup API.
    embeddedWallet: true,
  },

  wallet: {
    // Until a passkey wallet is backed up (recovery phrase saved, or a second passkey added), the app shows a backup
    // banner with this limit in US dollars, and the wallet hides its deposit address once it holds this much.
    unbackedLimitUsd: 100,
    // Encrypted backup versions kept per passkey.
    maxBackupVersions: 50,
    // New passkeys accepted per UTC day across all users; registration pauses after that until the next day.
    dailyNewPasskeys: 2000,
  },

  server: {
    port: 8080,
    // Postgres for the wallet's encrypted backups (apply apps/server/migrations first), and for rate-limit counters
    // and one-time challenges when there is no Redis. DATABASE_URL wins when set.
    databaseUrl: null,
    // Redis for rate-limit counters and one-time challenges. REDIS_URL wins when set.
    redisUrl: null,
    // `pnpm start` refuses to run on in-memory storage (backups would vanish on restart) unless this is true.
    allowMemoryStore: false,
    // Behind a reverse proxy or load balancer: the number of proxy hops to trust for the client address.
    trustProxy: 0,
    // Serve the built app and wallet from this server, chosen by the Host header (docs/self-hosting.md).
    serveStatic: false,
    // Optional CoinGecko Pro key for market data; the public API is used without one. COINGECKO_API_KEY wins.
    coingeckoApiKey: null,
  },
} satisfies ExclipConfigInput;
