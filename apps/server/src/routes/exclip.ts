/** /api/exclip: ExClip's public routes. Unauthenticated: a wallet is the account.
 * Mounted before any app-wide body parser so this router owns its (small) body limit. */
import express, { Router, type RequestHandler, type Response } from "express";
import { publicConfig, type ServerConfig } from "../services/config.ts";
import { createSodaxProxy, type FetchLike, type ProxyResult } from "../services/sodaxProxy.ts";
import { createStockGate } from "../services/stocks.ts";
import { createMarkets, CHART_RANGES, type ChartRange } from "../services/markets.ts";
import type { WalletStore } from "../services/walletBackup.ts";
import type { KvStore } from "../kv.ts";
import { kvRateConsume, publicRateLimit } from "../rateLimit.ts";
import { createWalletRouter, type WalletRouterOptions } from "./wallet.ts";

export const EXCLIP_BODY_LIMIT = "32kb";

export type ExclipRouterOptions = {
  config: ServerConfig;
  /** Shared state: rate-limit windows and the wallet's challenges. */
  kv: KvStore;
  walletStore: WalletStore;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Per-IP limits; default to limits in the shared KV store. */
  readLimit?: RequestHandler;
  proxyLimit?: RequestHandler;
  stocksLimit?: RequestHandler;
  onError?: (code: string) => void;
  /** Overrides for the passkey wallet's limits in tests. */
  wallet?: Pick<WalletRouterOptions, "challengeLimit" | "writeLimit">;
};

function send(res: Response, result: ProxyResult) {
  for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
  res.status(result.status).json(result.body);
}

export function createExclipRouter(options: ExclipRouterOptions): Router {
  const { config, kv } = options;
  const now = options.now ?? Date.now;
  const proxy = createSodaxProxy({ config, fetch: options.fetch, sleep: options.sleep, now });
  const stocks = createStockGate(config.stocks, now);
  const markets = createMarkets({ config, fetch: options.fetch, now });
  const readLimit = options.readLimit ?? publicRateLimit("exclip-read", 240, kvRateConsume(kv));
  const proxyLimit = options.proxyLimit ?? publicRateLimit("exclip-sodax", 120, kvRateConsume(kv));
  const stocksLimit = options.stocksLimit ?? publicRateLimit("exclip-stocks", 60, kvRateConsume(kv));

  const router = Router();
  router.use(express.json({ limit: EXCLIP_BODY_LIMIT }));
  // JSON body errors (too large, malformed) answer here, without echoing the body.
  router.use(((err, _req, res, next) => {
    const e = err as { type?: string; status?: number };
    if (e?.type === "entity.too.large") { res.status(413).json({ error: { code: "BODY_TOO_LARGE", message: `Request bodies are limited to ${EXCLIP_BODY_LIMIT}.` } }); return; }
    if (e?.type === "entity.parse.failed") { res.status(400).json({ error: { code: "BAD_JSON", message: "The request body is not valid JSON." } }); return; }
    next(err);
  }) as express.ErrorRequestHandler);

  router.get("/config", readLimit, (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json(publicConfig(config));
  });

  // Tokenised stocks: may this visitor trade them, and the self-certification that lets them (services/stocks.ts).
  router.get("/stocks/eligibility", stocksLimit, (req, res) => { send(res, stocks.eligibility(req.headers)); });
  router.post("/stocks/attest", stocksLimit, (req, res) => { send(res, stocks.attest(req.headers, req.body)); });

  // The passkey wallet's backup API (404 while features.embeddedWallet is off).
  router.use("/wallet", createWalletRouter({ config, store: options.walletStore, kv, now, onError: options.onError, ...options.wallet }));

  router.get("/markets", readLimit, async (_req, res) => {
    const payload = await markets.list();
    res.setHeader("Cache-Control", payload.status === "ok" ? "public, max-age=30" : "no-store");
    res.json(payload);
  });

  router.get("/markets/:symbol/chart", readLimit, async (req, res) => {
    const range = String(req.query.range ?? "1D").toUpperCase() as ChartRange;
    if (!CHART_RANGES.includes(range)) { res.status(400).json({ error: { code: "BAD_RANGE", message: `range must be one of ${CHART_RANGES.join(", ")}.` } }); return; }
    const payload = await markets.chart(String(req.params.symbol).toUpperCase(), range);
    if (!payload) { res.status(404).json({ error: { code: "UNKNOWN_ASSET", message: "No reference price for this asset." } }); return; }
    res.setHeader("Cache-Control", payload.status === "ok" ? "public, max-age=60" : "no-store");
    res.json(payload);
  });

  router.all("/sodax/*path", proxyLimit, async (req, res) => {
    const path = req.path.replace(/^\/sodax\//, "");
    try {
      send(res, await proxy.handle(req.method, path, req.query as Record<string, unknown>, req.method === "POST" ? req.body : undefined,
        () => stocks.check(req.headers)));
    } catch {
      options.onError?.("EXCLIP_PROXY_FAILED");
      res.setHeader("Cache-Control", "no-store");
      res.status(502).json({ error: { code: "SODAX_UPSTREAM", message: "The exchange network had a problem. Try again." } });
    }
  });

  return router;
}
