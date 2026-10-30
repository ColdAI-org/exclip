/** ExClip web app: markets, swaps and portfolio. React, no CDN.
 *
 * Build config baked into the bundle as __EXCLIP__ (src/vite-env.d.ts; nothing comes from the URL or a .env file):
 * webBuildConfig's projection of exclip.config.ts, which is the brand and the two origins. Development (vite serve)
 * always uses DEV_ORIGINS: this app on http://localhost:5173, the wallet on :5311. Switches that may change without a
 * rebuild (trading, the passkey wallet, the partner fee) come from the server's /api/exclip/config at runtime.
 * index.html takes the brand's name and logo here, and a production build fails if the page would break under the
 * app's CSP (src/lib/page-policy.ts).
 *
 * Dev: http://localhost:5173, /api proxied to apps/server on :8080. `vite preview` serves the build with the production
 * security headers so the CSP can be checked locally. */
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { appSecurityHeaders, DEV_ORIGINS, webBuildConfig, type WebBuildConfig } from "@exclip/config";
import { loadPublicConfig } from "@exclip/config/node";
import { strictPage } from "./src/lib/page-policy.ts";

const DEV_PORT = Number(new URL(DEV_ORIGINS.app).port);
/** The app origin's headers (packages/config/src/headers.ts): the same ones apps/server sends when it serves the
 * build, and the ones any other web server in front of it must send. */
const SECURITY_HEADERS = appSecurityHeaders(false);
const API_PROXY = { "/api": { target: DEV_ORIGINS.server, changeOrigin: false } };

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Puts the brand's name and logo in index.html, and with `strict` (production builds) checks the page against the
 * CSP. It runs after Vite has written the entry tags, so the check sees the page as it ships. */
function brandPage(web: WebBuildConfig, strict: boolean): Plugin {
  return {
    name: "exclip-web-page",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        // Replacer functions: a "$" in the brand name is text, not a replacement pattern.
        const page = html
          .replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(web.brand.name)}</title>`)
          .replace(/<link rel="icon" href="[^"]*"/, () => `<link rel="icon" href="${escapeHtml(web.brand.logo)}"`);
        return strict ? strictPage(page) : page;
      },
    },
  };
}

export default defineConfig(async ({ command }) => {
  const dev = command === "serve";
  const web = webBuildConfig(await loadPublicConfig(), dev);
  return {
    root: import.meta.dirname,
    base: "/",
    // No .env files: they could add VITE_* values to the bundle. Everything it holds is set below.
    envDir: false as const,
    define: { __EXCLIP__: JSON.stringify(web) },
    plugins: [react(), brandPage(web, !dev)],
    // The SODAX SDKs take React as a peer: one copy, or their hooks run against another React.
    resolve: { dedupe: ["react", "react-dom"] },
    build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
    server: {
      port: DEV_PORT,
      strictPort: true,
      // Vite's dev client and the React refresh preamble are inline scripts, which the CSP forbids; the CSP is applied
      // in preview and wherever the built files are served.
      headers: Object.fromEntries(Object.entries(SECURITY_HEADERS).filter(([k]) => k !== "content-security-policy")),
      proxy: API_PROXY,
    },
    preview: { port: DEV_PORT, strictPort: true, headers: SECURITY_HEADERS, proxy: API_PROXY },
  };
});
