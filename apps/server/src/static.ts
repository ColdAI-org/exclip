/** Serving the built apps from this server (server.serveStatic, production only), chosen by Host. Requests for the
 * wallet origin's host get the wallet page, its hashed assets and its backup API, and nothing else, with the wallet's
 * security headers; every other host gets the web app (with a fallback to index.html for client-side routes) and the
 * rest of the API, with the app's headers. The two origins never share a response: the wallet API is not served on
 * the app host, and no app file is served on the wallet host. */
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import express, { type Request, type RequestHandler, type Response } from "express";
import { appSecurityHeaders, walletSecurityHeaders } from "@exclip/config";

export type StaticDirs = { web: string; wallet: string };

/** apps/web/dist and apps/wallet/dist under the repository root. */
export function distDirs(root: string): StaticDirs {
  return { web: join(root, "apps", "web", "dist"), wallet: join(root, "apps", "wallet", "dist") };
}

/** The builds that are missing (no index.html), for a warning at boot. */
export function missingBuilds(dirs: StaticDirs): string[] {
  return (Object.entries(dirs) as Array<[keyof StaticDirs, string]>)
    .filter(([, dir]) => !existsSync(join(dir, "index.html")))
    .map(([name]) => `apps/${name}/dist`);
}

/** The only files the wallet host serves besides its page: flat, hashed build output of a few known types. */
export const WALLET_ASSET = /^\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:js|css|svg|png|woff2)$/;
const WALLET_API = "/api/exclip/wallet";
const IMMUTABLE = "public, max-age=31536000, immutable";

const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

function notFound(res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.status(404).type("text/plain").send("Not found.");
}

/** Cookies and CORS headers never leave the wallet host, whatever set them: they are removed as the head is
 * written. */
function stripWalletHeaders(res: Response) {
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;
  res.writeHead = ((...args: unknown[]) => {
    for (const name of res.getHeaderNames()) {
      if (name === "set-cookie" || name.startsWith("access-control-")) res.removeHeader(name);
    }
    return writeHead(...args);
  }) as never;
}

function sendFile(res: Response, root: string, file: string, cacheControl: string) {
  res.setHeader("Cache-Control", cacheControl);
  res.sendFile(file, { root, dotfiles: "deny", cacheControl: false }, (error) => {
    if (error && !res.headersSent) notFound(res);
  });
}

const isRead = (req: Request) => req.method === "GET" || req.method === "HEAD";

/**
 * Two middlewares. `gate` runs before the API: it answers everything on the wallet host except the wallet API, and
 * refuses the wallet API on every other host. `web` runs after the API and serves the web app.
 */
export function createStaticSites(options: { walletOrigin: string; dirs: StaticDirs }): { gate: RequestHandler; web: RequestHandler } {
  const walletHost = new URL(options.walletOrigin).hostname;
  const walletHeaders = walletSecurityHeaders(true);
  const appHeaders = appSecurityHeaders(true);
  const { dirs } = options;

  const gate: RequestHandler = (req, res, next) => {
    // By host name, so the wallet's host on any port is still treated as the wallet.
    if ((req.hostname ?? "").toLowerCase() === walletHost) {
      stripWalletHeaders(res);
      for (const [name, value] of Object.entries(walletHeaders)) res.setHeader(name, value);
      if (isUnder(req.path, WALLET_API)) return next();
      // The page and its hashed assets alike stay no-store, as walletSecurityHeaders says: no cache keeps an older
      // wallet build, so a fixed one is what runs the next time the popup opens.
      if (isRead(req) && (req.path === "/" || req.path === "/index.html")) return sendFile(res, dirs.wallet, "index.html", "no-store");
      if (isRead(req) && WALLET_ASSET.test(req.path)) return sendFile(res, dirs.wallet, req.path.slice(1), "no-store");
      return notFound(res);
    }
    for (const [name, value] of Object.entries(appHeaders)) res.setHeader(name, value);
    if (isUnder(req.path, WALLET_API)) {
      res.setHeader("Cache-Control", "no-store");
      res.status(404).json({ error: { code: "NOT_FOUND", message: "API route not found." } });
      return;
    }
    next();
  };

  const files = express.static(dirs.web, {
    index: false,
    redirect: false,
    dotfiles: "ignore",
    cacheControl: false,
    setHeaders(res, file) {
      const inAssets = relative(dirs.web, file).startsWith(`assets${sep}`);
      res.setHeader("Cache-Control", inAssets ? IMMUTABLE : file.endsWith(".html") ? "no-store" : "no-cache");
    },
  });

  const web: RequestHandler = (req, res, next) => {
    files(req, res, (error?: unknown) => {
      if (error) return next(error);
      // Client-side routes: a page navigation the files didn't answer gets the app's index.html.
      const navigation = isRead(req) && !isUnder(req.path, "/assets") && (req.get("accept") ?? "").includes("text/html");
      if (navigation) return sendFile(res, dirs.web, "index.html", "no-store");
      next();
    });
  };

  return { gate, web };
}
