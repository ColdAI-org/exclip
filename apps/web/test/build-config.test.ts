/**
 * vite.config.ts, run the way Vite runs it: what it bakes into the bundle, the headers it serves and the index.html it
 * writes. A change that lets a key or a server setting into __EXCLIP__, drops a security header in dev, or ships a page
 * the CSP would break fails here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ConfigEnv, Plugin, UserConfig } from "vite";
import { appSecurityHeaders, webBuildConfig } from "@exclip/config";
import { loadPublicConfig } from "@exclip/config/node";

// Set before vite.config.ts loads, as on a machine that builds the app and runs the server.
const KEY = "sodax-key-that-must-never-reach-a-bundle";
process.env.SODAX_API_KEY = KEY;
const { default: viteConfig } = await import("../vite.config.ts");

const run = (command: ConfigEnv["command"]) =>
  viteConfig({ command, mode: command === "build" ? "production" : "development", isSsrBuild: false, isPreview: false });

/** The index.html hook of vite.config.ts's exclip-web-page plugin. */
type PageHook = { order: string; handler: (html: string) => string };
function pageHook(config: UserConfig): PageHook {
  const plugin = ((config.plugins ?? []).flat() as unknown[]).find((p): p is Plugin => (p as Plugin | null)?.name === "exclip-web-page");
  assert.ok(plugin, "exclip-web-page plugin");
  return plugin.transformIndexHtml as unknown as PageHook;
}

const HEAD = `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>ExClip</title><link rel="icon" href="/logo.svg" />`;
const ENTRY = `<script type="module" crossorigin src="/assets/index-B4x_9kQ-.js"></script>`;

test("the bundle gets __EXCLIP__ and nothing else: the brand and the two origins, never a key", async () => {
  const config = await loadPublicConfig();
  for (const command of ["build", "serve"] as const) {
    const vite = await run(command);
    assert.deepEqual(Object.keys(vite.define ?? {}), ["__EXCLIP__"], command);
    assert.equal(JSON.stringify(vite.define).includes(KEY), false, command);
    assert.deepEqual(JSON.parse(vite.define?.__EXCLIP__), webBuildConfig(config, command === "serve"), command);
    assert.equal(vite.envDir, false, "no .env file can add VITE_* values to the bundle");
  }
  const dev = JSON.parse((await run("serve")).define?.__EXCLIP__);
  assert.deepEqual([dev.appOrigin, dev.walletOrigin], ["http://localhost:5173", "http://localhost:5311"]);
});

test("dev serves every security header but the CSP (Vite's dev client is inline script); preview serves them all", async () => {
  const headers = appSecurityHeaders(false);
  const { "content-security-policy": csp, ...rest } = headers;
  assert.match(csp ?? "", /script-src 'self'/);
  const vite = await run("serve");
  assert.deepEqual(vite.server?.headers, rest);
  assert.deepEqual(vite.preview?.headers, headers);
});

test("index.html gets the brand's name and logo as text; a production build fails on a page the CSP would break", async () => {
  const before = process.env.EXCLIP_CONFIG;
  process.env.EXCLIP_CONFIG = "apps/web/test/fixtures/brand.config.ts";
  try {
    const build = await run("build");
    assert.equal(JSON.parse(build.define?.__EXCLIP__).appOrigin, "https://swap.example.org", "production builds use the configured origins");
    const prod = pageHook(build);
    const dev = pageHook(await run("serve"));
    assert.equal(prod.order, "post", "runs after Vite has written the entry tags");

    // Escaped for HTML, and "$&" stays text rather than becoming a replacement pattern.
    const page = prod.handler(`${HEAD}${ENTRY}</head><body><div id="root"></div></body></html>`);
    assert.equal(page.match(/<title>.*<\/title>/)?.[0], `<title>Tom &#38; Jerry&#39;s &#34;$&#38;&#34; Swap</title>`);
    assert.equal(page.match(/<link rel="icon" href="[^"]*"/)?.[0], `<link rel="icon" href="https://cdn.example.com/brand/logo.svg?v=2&#38;size=64"`);

    // The source page (no built entry yet) is what dev serves; a production build stops on it, and on inline script.
    const source = `${HEAD}<script type="module" src="/src/main.tsx"></script></head><body><div id="root"></div></body></html>`;
    assert.doesNotThrow(() => dev.handler(source));
    assert.throws(() => prod.handler(source), /entry/);
    assert.throws(() => prod.handler(`${HEAD}${ENTRY}<script>window.x = 1</script></head><body></body></html>`), /inline <script>/);
  } finally {
    if (before === undefined) delete process.env.EXCLIP_CONFIG;
    else process.env.EXCLIP_CONFIG = before;
  }
});
