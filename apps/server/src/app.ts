/** The ExClip server as an Express app: the /api/exclip routes, an API 404, optionally the built web app and wallet
 * (server.serveStatic, production only), and an error handler that never echoes internals. index.ts listens; tests
 * call createApp with memory stores and a stubbed fetch. */
import express, { type ErrorRequestHandler, type Express } from "express";
import type { ExclipConfig, ExclipSecrets } from "@exclip/config";
import { findRepoRoot } from "@exclip/config/node";
import { serverConfig } from "./services/config.ts";
import type { FetchLike } from "./services/sodaxProxy.ts";
import type { WalletStore } from "./services/walletBackup.ts";
import type { KvStore } from "./kv.ts";
import { createExclipRouter } from "./routes/exclip.ts";
import { createStaticSites, distDirs, type StaticDirs } from "./static.ts";

export type AppOptions = {
  config: ExclipConfig;
  secrets: ExclipSecrets;
  /** Development: the wallet origin is DEV_ORIGINS.wallet and nothing is served statically. */
  dev: boolean;
  kv: KvStore;
  walletStore: WalletStore;
  fetch?: FetchLike;
  now?: () => number;
  /** The SODAX proxy's retry back-off; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
  /** The built apps (default: apps/web/dist and apps/wallet/dist in this repository). */
  staticDirs?: StaticDirs;
  /** Operational alerts, as codes; default: one console.warn line each. */
  onError?: (code: string) => void;
};

/** What each alert code means, for the log line. Codes only: no request data ever reaches an alert. */
const ALERTS: Readonly<Record<string, string>> = {
  EXCLIP_WALLET_KV: "a passkey challenge could not be issued: the shared store is unavailable",
  EXCLIP_WALLET_STORE: "a passkey wallet request failed in storage",
  EXCLIP_WALLET_PURGE: "removing retired passkeys failed (retried on the next registration)",
  EXCLIP_WALLET_SIGNUPS_80PCT: "80% of today's new-passkey allowance is used (wallet.dailyNewPasskeys)",
  EXCLIP_WALLET_SIGNUPS_PAUSED: "today's new-passkey allowance is used up; new wallets are paused until 00:00 UTC (wallet.dailyNewPasskeys)",
  EXCLIP_WALLET_BACKUP_FULL: "a passkey reached its backup version cap (wallet.maxBackupVersions)",
  EXCLIP_PROXY_FAILED: "a SODAX proxy request failed unexpectedly",
};

export function logAlert(code: string): void {
  console.warn(`[exclip] ${code}: ${ALERTS[code] ?? "operational alert"}`);
}

/** The only messages an error response carries, by status. */
const PUBLIC: Readonly<Record<number, { code: string; message: string }>> = {
  400: { code: "INVALID_REQUEST", message: "The request could not be processed." },
  401: { code: "UNAUTHENTICATED", message: "Authentication is required." },
  403: { code: "FORBIDDEN", message: "This request is not permitted." },
  404: { code: "NOT_FOUND", message: "The requested resource was not found." },
  405: { code: "METHOD_NOT_ALLOWED", message: "This method is not supported." },
  413: { code: "PAYLOAD_TOO_LARGE", message: "The request body exceeds the limit for this route." },
  415: { code: "UNSUPPORTED_MEDIA_TYPE", message: "The request content type is not supported." },
  429: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
};

function statusOf(err: unknown): number {
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const status = e?.status ?? e?.statusCode;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

export function createApp(options: AppOptions): Express {
  const { config, secrets, dev } = options;
  const server = serverConfig(config, secrets, dev);
  const onError = options.onError ?? logAlert;
  const app = express();
  app.disable("x-powered-by");
  // Rate limits are per client address: trust exactly as many proxies as sit in front (server.trustProxy).
  app.set("trust proxy", config.server.trustProxy);

  const sites = config.server.serveStatic && !dev
    ? createStaticSites({ walletOrigin: server.walletOrigin, dirs: options.staticDirs ?? distDirs(findRepoRoot()) })
    : null;
  if (sites) {
    app.use(sites.gate);
  } else {
    // The API alone: JSON that nothing may frame, sniff or run.
    app.use("/api", (_req, res, next) => {
      res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      next();
    });
  }

  // Before any body parser: the router parses its own JSON, with its own small limit.
  app.use("/api/exclip", createExclipRouter({
    config: server, kv: options.kv, walletStore: options.walletStore,
    fetch: options.fetch, sleep: options.sleep, now: options.now, onError,
  }));

  app.use("/api", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ error: { code: "NOT_FOUND", message: "API route not found." } });
  });

  if (sites) app.use(sites.web);

  app.use((_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).type("text/plain").send("Not found.");
  });

  // Last: whatever escaped a route. The status survives when it is a client error; the message is always ours.
  app.use(((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = statusOf(err);
    if (status >= 500) {
      const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : typeof err;
      const hidden = [secrets.sodaxApiKey, secrets.edgeSecret, secrets.attestationSecret].filter((s): s is string => !!s);
      console.error(`[exclip] ${req.method} ${req.path} failed: ${hidden.reduce((text, s) => text.split(s).join("[redacted]"), detail)}`);
    }
    const known = PUBLIC[status] ?? (status < 500
      ? { code: "REQUEST_FAILED", message: "The request could not be processed." }
      : { code: "INTERNAL_ERROR", message: "An unexpected error occurred." });
    res.setHeader("Cache-Control", "no-store");
    res.status(status).json({ error: known });
  }) as ErrorRequestHandler);

  return app;
}
