/** ExClip passkey wallet (docs/embedded-wallet.md). Vanilla TypeScript, no framework, no CDN.
 *
 * Build config baked into the bundle (src/config.ts reads it; nothing comes from the URL, the opener or a .env file):
 *  - From exclip.config.ts, through walletBuildConfig: the one page origin allowed to open and talk to the popup
 *    (origins.app), the wallet's own origin (origins.wallet), brand.name, brand.operator, wallet.unbackedLimitUsd,
 *    stocks.enabled, and a plain fee's rate (fees.rate, fees.stockFeeBps) and receiver's name (fees.receiverName).
 *    Development (vite serve) always uses DEV_ORIGINS: the app on http://localhost:5173, this on :5311.
 *  - Where a partner fee may go: fee-receivers.json's plain receivers and fee splits (committed; no env). The build
 *    stops on an entry it can't vouch for, such as a split its factory would refuse.
 * A production build refuses origins that aren't exact https origins or that let the app share the wallet's rpId
 * (build-guards.ts), and warns while the origins are still the examples. brand.logo becomes the window's tab icon.
 *
 * Dev: http://localhost:5311, /api proxied to apps/server on :8080. `vite preview` serves the build with the production
 * security headers so the CSP can be checked locally. */
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { walletBuildConfig, walletSecurityHeaders } from "@exclip/config";
import { parseFeeAllowList } from "@exclip/config/fee-split";
import { loadPublicConfig } from "@exclip/config/node";
import { FEE_RECEIVERS_FILE, assertProductionOrigins, buildWarnings, feeSplitTerms } from "./build-guards.ts";

const DEV_PORT = 5311;
/** The wallet origin's headers (packages/config/src/headers.ts): the same ones apps/server sends when it serves the
 * build (server.serveStatic), and the ones any other web server in front of it must send (docs/self-hosting.md). */
const SECURITY_HEADERS = walletSecurityHeaders(false);

/** The built index.html must stay CSP-clean: no inline script or style, no external URL. */
function cspGuard(): Plugin {
  return {
    name: "exclip-wallet-csp-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !file.fileName.endsWith(".html")) continue;
        const html = String(file.source);
        if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) throw new Error("inline <script> in index.html");
        if (/<style\b|\sstyle=/i.test(html)) throw new Error("inline style in index.html");
        if (/(?:src|href)="(?:https?:)?\/\//i.test(html)) throw new Error("external URL in index.html");
      }
    },
  };
}

const ICON_TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp" };

/** brand.logo as the window's tab icon, inlined as a data: URL, which the CSP allows for images (img-src 'self' data:).
 * Only a logo that is a file in apps/web/public can be inlined. An https:// logo is on another origin, which the CSP
 * refuses, so the window then keeps the browser's default icon. */
export function brandIcon(logo: string): Plugin {
  const type = logo.startsWith("/") ? ICON_TYPES[extname(logo).toLowerCase()] : undefined;
  let icon: string | undefined;
  if (type) {
    const file = new URL(`../web/public${logo}`, import.meta.url);
    if (!existsSync(file)) throw new Error(`brand.logo is ${logo}, but apps/web/public${logo} doesn't exist`);
    icon = `<link rel="icon" href="data:${type};base64,${readFileSync(file).toString("base64")}" />`;
  }
  return {
    name: "exclip-wallet-icon",
    transformIndexHtml: (html) => (icon ? html.replace(/(\s*)<\/head>/, (_, space: string) => `${space}  ${icon}${space}</head>`) : html),
  };
}

/** Prints buildWarnings through Vite's logger: settings that build, but not into a wallet that works. */
function configWarnings(warnings: readonly string[]): Plugin {
  return {
    name: "exclip-wallet-config-warnings",
    configResolved(config) {
      for (const warning of warnings) config.logger.warn(warning);
    },
  };
}

export default defineConfig(async ({ command, isPreview }) => {
  const dev = command === "serve";
  const config = await loadPublicConfig();
  const wallet = walletBuildConfig(config, dev);
  const allowList = parseFeeAllowList(readFileSync(FEE_RECEIVERS_FILE, "utf8"));
  if (command === "build") assertProductionOrigins(wallet.parentOrigins, wallet.walletOrigin);
  // Preview serves an existing build: its warnings were printed when it was built.
  const warnings = isPreview ? [] : buildWarnings(config, allowList, command === "build");
  return {
    root: import.meta.dirname,
    base: "/",
    // No .env files: they could add VITE_* values to the bundle. Everything it holds is set below.
    envDir: false as const,
    define: {
      __EXCLIP_PARENT_ORIGINS__: JSON.stringify(wallet.parentOrigins),
      __EXCLIP_FEE_RECEIVERS__: JSON.stringify(allowList.receivers),
      __EXCLIP_FEE_SPLITS__: JSON.stringify(feeSplitTerms(allowList)),
      __EXCLIP_FEE_RATE__: JSON.stringify(wallet.feeRate),
      __EXCLIP_DEV__: JSON.stringify(dev),
      __EXCLIP_WALLET_ORIGIN__: JSON.stringify(wallet.walletOrigin),
      __EXCLIP_BRAND_NAME__: JSON.stringify(wallet.brandName),
      __EXCLIP_OPERATOR__: JSON.stringify(wallet.operator),
      __EXCLIP_FEE_RECEIVER_NAME__: JSON.stringify(wallet.feeReceiverName),
      __EXCLIP_UNBACKED_LIMIT_USD__: JSON.stringify(wallet.unbackedLimitUsd),
      __EXCLIP_STOCKS__: JSON.stringify(wallet.stocks),
    },
    plugins: [cspGuard(), configWarnings(warnings), brandIcon(config.brand.logo)],
    // The vault's default Argon2id is WebAssembly, which the CSP doesn't allow: src/no-wasm.ts stands in for it.
    resolve: { alias: { "hash-wasm": fileURLToPath(new URL("./src/no-wasm.ts", import.meta.url)) } },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "es2022",
      sourcemap: false,
      // No polyfill script, no data: inlining: everything is a same-origin file the CSP allows.
      modulePreload: { polyfill: false },
      assetsInlineLimit: 0,
      cssCodeSplit: false,
    },
    server: {
      port: DEV_PORT,
      strictPort: true,
      // Vite's dev client needs inline styles and eval-free HMR; the CSP is applied in preview and wherever the built
      // files are served.
      headers: Object.fromEntries(Object.entries(SECURITY_HEADERS).filter(([k]) => k !== "content-security-policy")),
      proxy: { "/api": { target: "http://localhost:8080", changeOrigin: false } },
    },
    preview: {
      port: DEV_PORT,
      strictPort: true,
      headers: SECURITY_HEADERS,
      proxy: { "/api": { target: "http://localhost:8080", changeOrigin: false } },
    },
  };
});
