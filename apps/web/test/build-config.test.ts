/**
 * vite.config.ts, run the way Vite runs it: what it bakes into the bundle, the headers it serves and the index.html it
 * writes. A change that lets a key or a server setting into __EXCLIP__, drops a security header in dev, ships a page
 * the CSP would break, or puts ExClip's icons on someone else's brand fails here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { ConfigEnv, Plugin, UserConfig } from "vite";
import { appSecurityHeaders, webBuildConfig } from "@exclip/config";
import { loadPublicConfig } from "@exclip/config/node";

// Set before vite.config.ts loads, as on a machine that builds the app and runs the server.
const KEY = "sodax-key-that-must-never-reach-a-bundle";
process.env.SODAX_API_KEY = KEY;
const { default: viteConfig } = await import("../vite.config.ts");

const run = (command: ConfigEnv["command"]) =>
  viteConfig({ command, mode: command === "build" ? "production" : "development", isSsrBuild: false, isPreview: false });

/** Runs `fn` with EXCLIP_CONFIG naming `file`, as a deployment with that exclip.config.ts would. */
async function withConfig(file: string, fn: () => Promise<void>) {
  const before = process.env.EXCLIP_CONFIG;
  process.env.EXCLIP_CONFIG = file;
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env.EXCLIP_CONFIG;
    else process.env.EXCLIP_CONFIG = before;
  }
}

/** vite.config.ts's exclip-web-page plugin. */
function pagePlugin(config: UserConfig): Plugin {
  const plugin = ((config.plugins ?? []).flat() as unknown[]).find((p): p is Plugin => (p as Plugin | null)?.name === "exclip-web-page");
  assert.ok(plugin, "exclip-web-page plugin");
  return plugin;
}

/** The plugin's index.html hook. */
type PageHook = { order: string; handler: (html: string) => string };
const pageHook = (config: UserConfig) => pagePlugin(config).transformIndexHtml as unknown as PageHook;

/** The manifest the plugin writes into a build. */
type EmittedFile = { type: string; fileName: string; source: string };
function builtManifest(config: UserConfig): string {
  const files: EmittedFile[] = [];
  const generate = pagePlugin(config).generateBundle as unknown as (this: { emitFile(file: EmittedFile): void }) => void;
  generate.call({ emitFile: (file) => void files.push(file) });
  assert.deepEqual(files.map((f) => [f.type, f.fileName]), [["asset", "manifest.webmanifest"]]);
  return files[0]!.source;
}

/** What the dev server answers for /manifest.webmanifest. */
type Middleware = (req: object, res: { setHeader(name: string, value: string): void; end(body: string): void }) => void;
function servedManifest(config: UserConfig): string {
  const routes = new Map<string, Middleware>();
  const configure = pagePlugin(config).configureServer as unknown as (server: object) => void;
  configure({ middlewares: { use: (path: string, handler: Middleware) => void routes.set(path, handler) } });
  const headers = new Map<string, string>();
  let body = "";
  routes.get("/manifest.webmanifest")?.({}, { setHeader: (name, value) => void headers.set(name, value), end: (b) => void (body = b) });
  assert.equal(headers.get("content-type"), "application/manifest+json");
  return body;
}

const HEAD = `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>ExClip</title><link rel="icon" href="/logo.svg" />`;
const ENTRY = `<script type="module" crossorigin src="/assets/index-B4x_9kQ-.js"></script>`;
const BUILT_PAGE = `${HEAD}${ENTRY}</head><body><div id="root"></div></body></html>`;

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
  await withConfig("apps/web/test/fixtures/brand.config.ts", async () => {
    const build = await run("build");
    assert.equal(JSON.parse(build.define?.__EXCLIP__).appOrigin, "https://swap.example.org", "production builds use the configured origins");
    const prod = pageHook(build);
    const dev = pageHook(await run("serve"));
    assert.equal(prod.order, "post", "runs after Vite has written the entry tags");

    // Escaped for HTML, and "$&" stays text rather than becoming a replacement pattern.
    const page = prod.handler(BUILT_PAGE);
    assert.equal(page.match(/<title>.*<\/title>/)?.[0], `<title>Tom &#38; Jerry&#39;s &#34;$&#38;&#34; Swap</title>`);
    assert.equal(page.match(/<link rel="icon" href="[^"]*"/)?.[0], `<link rel="icon" href="https://cdn.example.com/brand/logo.svg?v=2&#38;size=64"`);

    // The source page (no built entry yet) is what dev serves; a production build stops on it, and on inline script.
    const source = `${HEAD}<script type="module" src="/src/main.tsx"></script></head><body><div id="root"></div></body></html>`;
    assert.doesNotThrow(() => dev.handler(source));
    assert.throws(() => prod.handler(source), /entry/);
    assert.throws(() => prod.handler(`${HEAD}${ENTRY}<script>window.x = 1</script></head><body></body></html>`), /inline <script>/);
  });
});

test("a rebrand's manifest names its own logo, and its page gets none of ExClip's icons", async () => {
  await withConfig("apps/web/test/fixtures/brand.config.ts", async () => {
    const build = await run("build");
    const page = pageHook(build).handler(BUILT_PAGE);
    assert.match(page, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
    assert.doesNotMatch(page, /apple-touch-icon|\/icons\//);
    const manifest = builtManifest(build);
    // JSON, not HTML: the name and the URL go in as they are.
    assert.deepEqual(JSON.parse(manifest), {
      name: `Tom & Jerry's "$&" Swap`,
      short_name: `Tom & Jerry's "$&" Swap`,
      start_url: "/",
      scope: "/",
      display: "browser",
      background_color: "#07080A",
      theme_color: "#07080A",
      icons: [{ src: "https://cdn.example.com/brand/logo.svg?v=2&size=64", sizes: "any", type: "image/svg+xml" }],
    });
    assert.equal(servedManifest(await run("serve")), manifest, "dev serves the manifest the build writes");
  });
});

test("ExClip's own brand gets the rendered icons, and every icon the page or the manifest names is in public/", async () => {
  await withConfig("apps/web/test/fixtures/default.config.ts", async () => {
    const build = await run("build");
    const page = pageHook(build).handler(BUILT_PAGE);
    const touchIcon = page.match(/<link rel="apple-touch-icon" href="([^"]+)" \/>/)?.[1];
    assert.equal(touchIcon, "/icons/exclip-180.png");
    const manifest = JSON.parse(builtManifest(build)) as { icons: { src: string; sizes: string; purpose?: string }[] };
    assert.deepEqual(manifest.icons.map((icon) => [icon.src, icon.sizes, icon.purpose ?? "any"]), [
      ["/icons/exclip-192.png", "192x192", "any"],
      ["/icons/exclip-512.png", "512x512", "any"],
      ["/icons/exclip-maskable-512.png", "512x512", "maskable"],
    ]);

    // Each file exists, and each PNG has the size it is listed at (width and height from its IHDR chunk).
    const sizeOf = (png: Buffer) => `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
    const file = (src: string) => new URL(`../public${src}`, import.meta.url);
    assert.ok(existsSync(file("/logo.svg")));
    assert.equal(sizeOf(readFileSync(file(touchIcon!))), "180x180");
    for (const icon of manifest.icons) assert.equal(sizeOf(readFileSync(file(icon.src))), icon.sizes, icon.src);
  });
});
