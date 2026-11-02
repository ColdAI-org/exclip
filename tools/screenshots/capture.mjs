#!/usr/bin/env node
/**
 * Captures the documentation's screenshots: seven screens, each in the dark and the light theme, at desktop and phone
 * size.
 *
 *   pnpm run screenshots                      # every screen
 *   pnpm run screenshots stocks eligibility   # only the screens named
 *   pnpm run screenshots --brand              # under your own config (below); screen names work here too
 *
 * Writes docs/media/{home,trade,portfolio,asset,approval,stocks,eligibility}-{dark,light}-{desktop,phone}.png. It starts
 * the web app and the wallet on their usual dev servers (stop `pnpm dev` first; apps/server isn't needed) and drives
 * them in headless Chromium through Playwright, or in Google Chrome where Playwright's Chromium won't start. Re-run it
 * after a visible UI change and commit the PNGs.
 *
 * With --brand it takes the same screenshots under the repository's own config instead: exclip.config.ts, or the file
 * EXCLIP_CONFIG names, with its name, operator, logo, colours, fee and origins. They go to screenshots/, which git
 * ignores, so a rebranded copy never overwrites the README's.
 *
 * Nothing goes to a network. The browser resolves no host but localhost. Every /api/exclip call is answered from
 * fixtures/, a made-up snapshot of 2026-10-30 12:00 UTC (not market data), and the browser's clock is pinned to that
 * moment. Every other request that isn't for one of the two dev servers is aborted, and the run ends by listing them.
 * The connected wallet is a made-up account (fixtures/account.json) put straight into the app's wallet state, so no
 * wallet SDK loads. The passkey wallet's review is approval.ts, the wallet's own screens on a canned swap, shown as if
 * served from the example wallet origin.
 *
 * Tokenised stocks are off, the default, on every screen but two: the Stocks screen and its eligibility sheet are
 * answered as a server with stocks switched on would answer, with the made-up stocks in fixtures/stocks.json and a
 * visitor who has yet to confirm the statements.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { DEV_ORIGINS, PLACEHOLDER_ORIGINS, STOCK_REFUSALS } from "@exclip/config";
import { loadPublicConfig } from "@exclip/config/node";
import { ASSETS, canonicalSymbol } from "../../apps/web/src/lib/catalog.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const HERE = join(ROOT, "tools/screenshots");
/** With --brand, the repository's own config. */
const OWN = process.argv.includes("--brand") ? await loadPublicConfig() : null;
const OUT = join(ROOT, OWN ? "screenshots" : "docs/media");

// Read by the apps' vite.config.ts: ExClip's own name, logo and colours, whatever the repository's config says.
if (!OWN) process.env.EXCLIP_CONFIG = relative(ROOT, join(HERE, "screenshots.config.ts"));

const APP = DEV_ORIGINS.app;
const WALLET = DEV_ORIGINS.wallet;
/** Where the review is shown from: the wallet origin, opened by the app origin. The examples, unless --brand. */
const ORIGINS = OWN?.origins ?? PLACEHOLDER_ORIGINS;
const WALLET_PAGE = ORIGINS.wallet;
const SNAPSHOT = Date.parse("2026-10-30T12:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const THEMES = ["dark", "light"];
const SIZES = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
/** The wallet's window on a desktop: the app opens it with window.open(…, "popup=yes,width=420,height=720"). */
const POPUP = { viewport: { width: 420, height: 720 }, deviceScaleFactor: 1 };

/* ------------------------------------------------------------------ fixtures */

const fixture = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));
/** /api/exclip/config. With --brand it carries the configured fee, a plain one in basis points or as a rate, or a split,
 * as apps/server's publicConfig would. */
const SPLIT = OWN?.fees.split;
const RATE = OWN?.fees.rateFee;
const PLAIN = OWN?.fees.partnerFee ?? RATE;
const CONFIG = {
  ...fixture("config.json"),
  ...(OWN && {
    partnerFeeBps: OWN.fees.partnerFee?.percentage ?? 0,
    feeReceiver: PLAIN?.address ?? null,
    feeRate: RATE ? { rate: RATE.rate, stockFeeBps: RATE.stockFee?.percentage ?? 0 } : null,
    feeReceiverName: PLAIN ? OWN.fees.receiverName : null,
    feeSplit: SPLIT
      ? {
        receiver: SPLIT.splitter,
        totalRate: SPLIT.totalRate,
        platform: { name: SPLIT.platformName, rate: SPLIT.platformRate },
        operator: { name: OWN.brand.operator || OWN.brand.name, rate: SPLIT.operatorRate },
        stockFee: SPLIT.stockFee ? { receiver: SPLIT.stockFee.address, bps: SPLIT.stockFee.percentage } : null,
      }
      : null,
  }),
};
const ACCOUNT = fixture("account.json");
const MARKET = new Map(fixture("markets.json").rows.map((r) => [r.symbol, r]));
const TOKENS = Object.fromEntries(
  Object.entries(fixture("tokens.json").chains).map(([chainKey, list]) => [
    chainKey,
    list.map(([symbol, name, decimals, address]) => ({ symbol, name, decimals, address, chainKey })),
  ]),
);
const STOCKS = fixture("stocks.json");
/** The token list with stocks on: TOKENS and the made-up stocks, flagged isRwa as SODAX flags tokenised stocks. */
const STOCK_TOKENS = { ...TOKENS };
for (const [chainKey, list] of Object.entries(STOCKS.chains)) {
  STOCK_TOKENS[chainKey] = [
    ...(TOKENS[chainKey] ?? []),
    ...list.map(([symbol, name, decimals, address]) => ({ symbol, name, decimals, address, chainKey, isRwa: true })),
  ];
}
const STABLE = new Set(ASSETS.filter((a) => a.kind === "stable").map((a) => a.symbol));
for (const a of ASSETS) if (!MARKET.has(a.symbol)) throw new Error(`fixtures/markets.json has no row for ${a.symbol}`);

/** FNV-1a, so each chart is seeded by its name. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32: a small seeded generator, so every run draws the same charts. */
function random(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gaussian = (next) => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());

/** Each chart range: its points, their spacing, and the first price as a share of the last. */
const RANGES = {
  "1H": { n: 13, step: 5 * MINUTE, start: (r) => 1 / (1 + r.change1h / 100) },
  "1D": { n: 240, step: DAY / 239, start: (r) => 1 / (1 + r.change24h / 100) },
  "1W": { n: 168, step: (7 * DAY) / 167, start: (r) => 1 / (1 + r.change7d / 100) },
  "1M": { n: 240, step: (30 * DAY) / 239, start: (r, next) => 1 / (1 + (1.6 * r.change7d + 16 * (next() - 0.5)) / 100) },
  "1Y": { n: 365, step: DAY, start: (_r, next) => Math.exp(-0.9 + 1.4 * next()) },
  ALL: { n: 240, step: (5 * 365 * DAY) / 239, start: (_r, next) => 1 / (3 + 30 * next()) },
};

const charts = new Map();

/** A chart that ends at the snapshot price and starts where the range's change says: a seeded random walk in log
 * price, bent to meet both ends (a Brownian bridge). */
function series(row, range) {
  const key = `${row.symbol}|${range}`;
  if (charts.has(key)) return charts.get(key);
  const { n, step, start } = RANGES[range];
  const next = random(hash(key));
  const stable = STABLE.has(row.symbol);
  const ratio = stable && !["1H", "1D", "1W"].includes(range) ? 1 : start(row, next);
  const daily = stable ? 0.0004 : Math.min(0.08, 0.015 + (Math.abs(row.change24h) + Math.abs(row.change7d) / 3) / 200);
  const sigma = daily * Math.sqrt(step / DAY);
  const walk = [0];
  for (let i = 1; i < n; i++) walk.push(walk[i - 1] + sigma * gaussian(next));
  const first = Math.log(row.price * ratio);
  const last = Math.log(row.price);
  const from = SNAPSHOT - (n - 1) * step;
  const points = walk.map((w, i) => {
    const t = i / (n - 1);
    const price = i === n - 1 ? row.price : Number(Math.exp(first + (last - first) * t + w - walk[n - 1] * t).toPrecision(6));
    return [Math.round(from + i * step), price];
  });
  charts.set(key, points);
  return points;
}

/** `count` values spread evenly over `values`, first and last included. */
const spread = (values, count) => Array.from({ length: count }, (_, i) => values[Math.round((i * (values.length - 1)) / (count - 1))]);

/** /api/exclip/markets rows (apps/server/src/services/markets.ts), by rank. */
const ROWS = [...MARKET.values()].map((r) => {
  const day = series(r, "1D").map(([, p]) => p);
  return {
    symbol: r.symbol,
    price: r.price,
    change24h: r.change24h,
    change1h: r.change1h,
    change7d: r.change7d,
    marketCap: Math.round(r.price * r.circulatingSupply),
    volume24h: r.volume24h,
    circulatingSupply: r.circulatingSupply,
    totalSupply: r.totalSupply,
    maxSupply: r.maxSupply,
    high24h: Math.max(...day),
    low24h: Math.min(...day),
    rank: r.rank,
    sparkline: spread(series(r, "1W").map(([, p]) => p), 42),
  };
});

const priceOf = (tokenSymbol) => MARKET.get(canonicalSymbol(tokenSymbol) ?? "")?.price;
const tokenAt = (chainKey, address) => TOKENS[chainKey]?.find((t) => t.address.toLowerCase() === String(address).toLowerCase());

/** What SODAX might pay out for a swap: the fixtures' prices, less 0.25 % for the solver. */
function quote(body) {
  const src = tokenAt(body?.tokenSrcChainKey, body?.tokenSrc);
  const dst = tokenAt(body?.tokenDstChainKey, body?.tokenDst);
  const pIn = src && priceOf(src.symbol);
  const pOut = dst && priceOf(dst.symbol);
  if (!pIn || !pOut || !/^\d+$/.test(body.amount ?? "")) return null;
  const scaled = (price) => BigInt(Math.round(price * 1e12));
  const out = (BigInt(body.amount) * scaled(pIn) * 9975n * 10n ** BigInt(dst.decimals)) / (scaled(pOut) * 10_000n * 10n ** BigInt(src.decimals));
  return { quotedAmount: out.toString() };
}

/** What the made-up account holds: [network, token, amount]. */
const HOLDINGS = [
  ["0x2105.base", "USDC", "1842.5"],
  ["0x2105.base", "ETH", "0.84"],
  ["0x2105.base", "cbBTC", "0.0425"],
  ["0xa4b1.arbitrum", "ETH", "0.35"],
  ["0xa4b1.arbitrum", "LINK", "64.2"],
  ["solana", "SOL", "12.5"],
  ["solana", "JUP", "420"],
  ["hyper", "HYPE", "18.4"],
];

const units = (amount, decimals) => {
  const [whole, fraction = ""] = amount.split(".");
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"))).toString();
};

/** The app's wallet state (apps/web/src/lib/wallet.ts) for browser wallets connected on EVM and Solana. */
function walletState() {
  const balances = {};
  for (const [chainKey, symbol, amount] of HOLDINGS) {
    const token = TOKENS[chainKey]?.find((t) => t.symbol === symbol);
    if (!token) throw new Error(`fixtures/tokens.json has no ${symbol} on ${chainKey}`);
    balances[chainKey] = { ...balances[chainKey], [token.address.toLowerCase()]: units(amount, token.decimals) };
  }
  return { accounts: { EVM: ACCOUNT.evm, SOLANA: ACCOUNT.solana }, balances };
}

/** Four finished swaps in this browser's activity (apps/web/src/lib/activity.ts), with made-up transaction hashes. */
const ACTIVITY = [
  ["2026-10-29T16:42:00Z", ["USDC", "0x2105.base", "500"], ["ETH", "0x2105.base", "0.1292"]],
  ["2026-10-27T09:15:00Z", ["USDC", "0x2105.base", "1000"], ["BTC", "0x2105.base", "0.00924"]],
  ["2026-10-24T18:03:00Z", ["ETH", "0xa4b1.arbitrum", "0.25"], ["LINK", "0xa4b1.arbitrum", "52.4"]],
  ["2026-10-20T11:27:00Z", ["USDC", "0x2105.base", "1200"], ["SOL", "solana", "6.1"]],
].map(([when, [fromSymbol, fromChain, fromAmount], [toSymbol, toChain, toAmount]]) => {
  const at = Date.parse(when);
  const next = random(hash(when));
  const txHash = () => `0x${Array.from({ length: 64 }, () => Math.floor(next() * 16).toString(16)).join("")}`;
  return {
    id: `swap-${at.toString(36)}`,
    kind: "swap",
    createdAt: at,
    updatedAt: at + 41_000,
    status: "settled",
    from: { symbol: fromSymbol, chainKey: fromChain, amount: fromAmount },
    to: { symbol: toSymbol, chainKey: toChain, amount: toAmount },
    srcTxHash: txHash(),
    hubTxHash: txHash(),
  };
});

/* ------------------------------------------------------------------ the browser's network */

/** Answers the app's /api calls from the fixtures; anything else under /api gets a 404 and is listed at the end. With
 * `stocks`, the answers are a server's with tokenised stocks switched on. */
function api(route, request, url, log, stocks) {
  const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const method = request.method();
  const path = url.pathname;
  const chart = /^\/api\/exclip\/markets\/([^/]+)\/chart$/.exec(path);
  if (method === "GET" && path === "/api/exclip/config") {
    return json(stocks ? { ...CONFIG, stocksEnabled: true, stocksTermsVersion: STOCKS.termsVersion } : CONFIG);
  }
  if (method === "GET" && path === "/api/exclip/markets") return json({ status: "ok", asOf: SNAPSHOT, rows: ROWS });
  if (method === "GET" && chart) {
    const row = MARKET.get(decodeURIComponent(chart[1]).toUpperCase());
    const range = url.searchParams.get("range");
    if (row && Object.hasOwn(RANGES, range)) return json({ status: "ok", symbol: row.symbol, range, points: series(row, range) });
  }
  if (method === "GET" && path === "/api/exclip/sodax/swaps/tokens") return json(stocks ? STOCK_TOKENS : TOKENS);
  if (method === "POST" && path === "/api/exclip/sodax/swaps/quote") {
    const answer = quote(request.postDataJSON());
    if (answer) return json(answer);
  }
  if (method === "GET" && path === "/api/exclip/sodax/swaps/fees/partner") return json({ fee: "0" });
  // A visitor the server places in a country where stocks are offered, with no attestation yet.
  if (stocks && method === "GET" && path === "/api/exclip/stocks/eligibility") {
    const code = "SELF_CERT_REQUIRED";
    return json({ eligible: false, code, message: STOCK_REFUSALS[code], country: STOCKS.country, termsVersion: STOCKS.termsVersion, expiresAt: null });
  }
  log.unanswered.add(`${method} ${path}${url.search}`);
  return json({ error: { code: "NOT_FOUND", message: "Not in the screenshot fixtures." } }, 404);
}

/** The wallet's index.html with approval.ts in place of main.ts. /@vite/env sets the build's defines, which the dev
 * server otherwise leaves to its client script. */
const WALLET_HTML = (() => {
  const page = readFileSync(join(ROOT, "apps/wallet/index.html"), "utf8");
  const scripts = [`/@vite/env`, `/@fs${pathToFileURL(join(HERE, "approval.ts")).pathname}`]
    .map((src) => `<script type="module" src="${src}"></script>`)
    .join("\n    ");
  const html = page
    .replace(`<main id="app"`, `<main id="app" data-opener="${ORIGINS.app}"`)
    .replace(`<script type="module" src="/src/main.ts"></script>`, scripts);
  if (!html.includes("data-opener") || !html.includes("approval.ts")) throw new Error("apps/wallet/index.html has changed: update WALLET_HTML");
  return html;
})();

/** The wallet page at the example origin. Its files come from the wallet's dev server, fetched by this script (Node,
 * on localhost), so the browser never looks the example host up. */
async function walletPage(route, request, url, log) {
  if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: WALLET_HTML });
  if (url.pathname.startsWith("/api/")) {
    log.unanswered.add(`${request.method()} ${url.href}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  }
  const headers = { ...request.headers() };
  for (const name of ["host", "origin", "referer", "if-none-match", "if-modified-since"]) delete headers[name];
  const response = await route.fetch({ url: `${WALLET}${url.pathname}${url.search}`, headers });
  const sent = { ...response.headers() };
  for (const name of ["content-encoding", "content-length", "transfer-encoding"]) delete sent[name];
  return route.fulfill({ response, headers: sent });
}

/** Every request is answered here, continued to one of the two dev servers, or aborted and logged. A WebSocket to
 * anything but localhost (Vite's own) is logged and left open with nothing behind it: it never reaches a server, and
 * Vite's client, which polls and reloads the page when its socket closes, stays quiet. */
async function guard(context, log, stocks) {
  await context.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === APP && url.pathname.startsWith("/api/")) return api(route, request, url, log, stocks);
    if (url.origin === APP || url.origin === WALLET) return route.continue();
    if (url.origin === WALLET_PAGE) return walletPage(route, request, url, log);
    log.blocked.push(`${request.method()} ${request.url()}`);
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket(
    (url) => url.hostname !== "localhost",
    (ws) => {
      log.blocked.push(`WebSocket ${ws.url().split("?")[0]}`);
    },
  );
}

/* ------------------------------------------------------------------ screens */

/** Each screen: where it is, whether a wallet is connected or stocks are on, what to wait for, and what to scroll up to
 * at each size. */
const SHOTS = [
  {
    name: "home",
    url: `${APP}/`,
    ready: (page) => page.locator(".x-table", { hasText: "Bitcoin" }).first().waitFor(),
    // The market lists: on a desktop the movers, trending and new cards above the full list, on a phone the full list.
    scroll: { desktop: ".x-grid-3", phone: "[aria-labelledby='x-markets-title']" },
  },
  {
    name: "trade",
    url: `${APP}/`,
    connected: true,
    ready: async (page) => {
      await page.evaluate(() => import("/src/lib/ui.ts").then((ui) => ui.openTrade("buy", "ETH")));
      // The sheet receives on the network it pays from (Base). Receive on Arbitrum instead: one swap, two networks. The
      // rows are looked up in the sheet, as the page behind it lists Ethereum too.
      const sheet = page.locator(".x-sheet");
      const row = (list, title) =>
        sheet
          .getByRole("list", { name: list })
          .locator(".x-row-btn")
          .filter({ has: page.locator(".x-row-title", { hasText: new RegExp(`^${title}$`) }) });
      await sheet.getByRole("button", { name: /^Receive: / }).click();
      await row("Assets", "Ethereum").click();
      await row("Networks", "Arbitrum One").click();
      await sheet.getByRole("button", { name: /^Receive: Ethereum on Arbitrum One\./ }).waitFor();
      await page.locator("#x-amount-input").fill("250");
      await page.locator(".x-quote-line", { hasText: "You receive about" }).waitFor();
    },
  },
  {
    name: "portfolio",
    url: `${APP}/portfolio`,
    connected: true,
    ready: (page) => page.locator(".x-holdings .x-table", { hasText: "Ethereum" }).waitFor(),
    // On a phone the holdings are under the allocation card.
    scroll: { phone: ".x-holdings" },
  },
  {
    name: "asset",
    url: `${APP}/asset/ETH`,
    connected: true,
    ready: async (page) => {
      await page.locator(".x-chart svg").waitFor();
      await page.getByRole("heading", { name: "Your ETH" }).waitFor();
    },
  },
  {
    name: "approval",
    url: `${WALLET_PAGE}/`,
    wallet: true,
    ready: (page) => page.locator("dl.review").waitFor(),
  },
  {
    name: "stocks",
    url: `${APP}/stocks`,
    stocks: true,
    ready: async (page) => {
      await page.getByRole("list", { name: "Tokenised stocks" }).waitFor();
      await page.getByRole("button", { name: "Read and confirm" }).waitFor();
    },
  },
  {
    name: "eligibility",
    url: `${APP}/stocks`,
    stocks: true,
    // The sheet as it opens: the disclosures first, nothing ticked.
    ready: async (page) => {
      await page.getByRole("button", { name: "Read and confirm" }).click();
      await page.locator(".x-sheet .x-stock-form").waitFor();
    },
  },
];

/** Scrolls `selector` up under the sticky top bar, keeping the gap it has to the element before it, so that element
 * ends right at the bar's edge. */
async function scrollUnderBar(page, selector) {
  await page.locator(selector).first().evaluate((el) => {
    const bar = document.querySelector(".x-top").getBoundingClientRect().bottom;
    const top = el.getBoundingClientRect().top;
    const gap = el.previousElementSibling ? top - el.previousElementSibling.getBoundingClientRect().bottom : 0;
    window.scrollTo({ top: top + window.scrollY - bar - gap, behavior: "instant" });
  });
}

/** Waits until no skeleton, loading chart or busy region is left, the fonts are in, and two more frames have been
 * drawn. */
async function settle(page) {
  await page.waitForFunction(() => !document.querySelector(".x-skel, .is-loading, [aria-busy='true']"), undefined, { timeout: 20_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.waitForTimeout(250);
}

/** Opens one screen in a fresh browser context and, given a file, saves it there. */
async function shoot(browser, shot, theme, size, log, file) {
  const context = await browser.newContext({
    ...(shot.wallet && size === "desktop" ? POPUP : SIZES[size]),
    colorScheme: theme,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  try {
    await context.clock.setFixedTime(SNAPSHOT);
    await guard(context, log, !!shot.stocks);
    await context.addInitScript(
      ({ app, theme, activity }) => {
        if (location.origin !== app) return;
        localStorage.setItem("exclip.theme", theme);
        if (activity) localStorage.setItem("exclip.activity.v1", JSON.stringify(activity));
      },
      { app: APP, theme, activity: shot.connected ? ACTIVITY : null },
    );
    const page = await context.newPage();
    page.on("pageerror", (e) => log.errors.add(`${shot.name}: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().includes("ERR_BLOCKED_BY_CLIENT")) log.errors.add(`${shot.name}: ${m.text()}`);
    });
    await page.goto(shot.url);
    // Gone if the page reloads (Vite does that when it re-bundles dependencies), along with the state set below.
    await page.evaluate(() => (window.__screenshot = true));
    if (!shot.wallet) await page.locator(".x-app").waitFor();
    if (shot.connected) {
      await page.evaluate((state) => import("/src/lib/wallet.ts").then((wallet) => wallet.setWalletState(state)), walletState());
      await page.locator(".x-addr").first().waitFor({ state: "attached" });
    }
    await shot.ready(page);
    if (shot.scroll?.[size]) await scrollUnderBar(page, shot.scroll[size]);
    await settle(page);
    if (!(await page.evaluate(() => window.__screenshot === true))) throw new Error("the page reloaded");
    if (file) await page.screenshot({ path: file, animations: "disabled", caret: "hide", fullPage: !!shot.wallet });
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ run */

async function startVite(app) {
  const dir = join(ROOT, "apps", app);
  const { createServer } = await import(pathToFileURL(createRequire(join(dir, "package.json")).resolve("vite")).href);
  const server = await createServer({ root: dir, configFile: join(dir, "vite.config.ts"), logLevel: "warn", clearScreen: false });
  try {
    await server.listen();
  } catch (e) {
    await server.close();
    throw new Error(`apps/${app}: ${e.message} Stop \`pnpm dev\` and run this again.`, { cause: e });
  }
  return server;
}

/** No host resolves but localhost, so nothing the routes might miss could reach a network either. */
const BROWSER_ARGS = ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"];

async function launch() {
  try {
    return await chromium.launch({ args: BROWSER_ARGS });
  } catch (e) {
    console.warn(`Playwright's Chromium didn't start (${e.message.split("\n")[0]}); trying Google Chrome.`);
    return chromium.launch({ channel: "chrome", args: BROWSER_ARGS });
  }
}

const tally = (items) => [...items.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map())];
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

/** The screens named on the command line, or all of them. pnpm may pass on a `--` before the names; `--brand` isn't one. */
const named = process.argv.slice(2).filter((arg) => arg !== "--" && arg !== "--brand");
const unknown = named.filter((name) => !SHOTS.some((shot) => shot.name === name));
if (unknown.length) throw new Error(`No screen called ${unknown.join(" or ")}: the screens are ${SHOTS.map((shot) => shot.name).join(", ")}.`);
const TAKEN = named.length ? SHOTS.filter((shot) => named.includes(shot.name)) : SHOTS;

const log = { blocked: [], unanswered: new Set(), errors: new Set() };
const written = [];
const failed = [];
const servers = [];
let browser;
try {
  // One at a time, so the web server is still closed below if the wallet's fails to start.
  servers.push(await startVite("web"));
  servers.push(await startVite("wallet"));
  browser = await launch();
  console.log(`Dev servers on ${APP} and ${WALLET}; Chromium ${browser.version()}.`);
  // Vite transforms each page and bundles its dependencies on first load, and may reload a page while it does, so
  // every screen is opened once before anything is captured.
  for (const shot of TAKEN) {
    await shoot(browser, shot, "dark", "desktop", log, null).catch((e) => console.warn(`warm-up ${shot.name}: ${e.message.split("\n")[0]}`));
  }
  mkdirSync(OUT, { recursive: true });
  for (const shot of TAKEN) {
    for (const theme of THEMES) {
      for (const size of Object.keys(SIZES)) {
        const file = join(OUT, `${shot.name}-${theme}-${size}.png`);
        for (let attempt = 1; ; attempt++) {
          try {
            await shoot(browser, shot, theme, size, log, file);
            written.push(file);
            console.log(`  ${relative(ROOT, file)}  ${kb(statSync(file).size)}`);
            break;
          } catch (e) {
            const why = e.message.split("\n")[0];
            if (attempt === 3) {
              failed.push(`${relative(ROOT, file)}: ${why}`);
              break;
            }
            console.warn(`  ${relative(ROOT, file)}: ${why}; trying again`);
          }
        }
      }
    }
  }
} finally {
  await browser?.close();
  await Promise.all(servers.map((s) => s.close()));
}

const total = written.reduce((sum, file) => sum + statSync(file).size, 0);
console.log(`\n${written.length} screenshots in ${relative(ROOT, OUT)}, ${(total / 1024 / 1024).toFixed(2)} MB.`);
const hosts = tally(log.blocked.map((entry) => new URL(entry.slice(entry.indexOf(" ") + 1)).host));
console.log(
  `Requests stopped in the browser (none reached a network): ${log.blocked.length}` +
    (hosts.length ? `, to ${hosts.map(([host, n]) => `${host} (${n})`).join(", ")}` : ""),
);
for (const [what, n] of tally(log.blocked)) console.log(`  ${n} × ${what}`);
if (log.unanswered.size) console.log(`API calls the fixtures don't answer (404):\n  ${[...log.unanswered].join("\n  ")}`);
if (log.errors.size) console.log(`Errors in the pages:\n  ${[...log.errors].join("\n  ")}`);
if (failed.length) {
  console.error(`Not captured:\n  ${failed.join("\n  ")}`);
  process.exitCode = 1;
}
