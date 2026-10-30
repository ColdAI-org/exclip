/**
 * ExClip's side of the embedded wallet popup (docs/embedded-wallet.md). No React, no wallet SDK.
 *
 *  - The popup is opened synchronously inside the click handler (WalletPopup.open), before any await, so browsers
 *    don't block it. Everything slow (quotes, RPC) happens after, while the popup waits for its request.
 *  - Messages are accepted only from that popup window AND the configured wallet origin, and must parse
 *    (wallet-protocol.ts). The request is posted to that exact origin. One request per popup.
 *  - Timeouts: the popup must say `ready` in time; each request has its own limit; closing the window cancels.
 */
import {
  PROTOCOL_KIND, PROTOCOL_VERSION, READY_TIMEOUT_MS, REQUEST_TIMEOUT_MS, newRequestId, parseResponse, resultFits,
  type ConnectIntent, type ConnectResult, type ErrorCode, type ManageAction, type ManageResult, type ResultMessage,
  type SignRequest, type SignResult, type WalletRequest,
} from "./wallet-protocol";

export type PopupWindow = { postMessage(message: unknown, targetOrigin: string): void; close(): void; readonly closed: boolean };
export type PopupMessage = { data: unknown; origin: string; source: unknown };
export type PopupEnv = {
  open(url: string): PopupWindow | null;
  listen(fn: (e: PopupMessage) => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(t: unknown): void;
};

export type EmbeddedErrorCode = ErrorCode | "POPUP_BLOCKED";
export class EmbeddedWalletError extends Error {
  constructor(readonly code: EmbeddedErrorCode, message: string) {
    super(message);
    this.name = "EmbeddedWalletError";
  }
}

const CLOSED_CHECK_MS = 500;

/** Exact https origin (http only for localhost in dev). Anything else and the embedded wallet stays off. */
export function validWalletOrigin(origin: string | null | undefined, dev = false): origin is string {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return u.origin === origin && (u.protocol === "https:" || (dev && local && u.protocol === "http:"));
  } catch {
    return false;
  }
}

type Body = WalletRequest extends infer R ? (R extends WalletRequest ? Omit<R, "v" | "kind" | "id"> : never) : never;
type Pending = { req: WalletRequest; resolve(v: unknown): void; reject(e: Error): void; timer: unknown };

export class WalletPopup {
  private isReady = false;
  private readyWaiters: { resolve(): void; reject(e: Error): void }[] = [];
  private pending: Pending | null = null;
  private used = false;
  private disposed = false;
  private readonly stopListening: () => void;
  private readonly closedTimer: unknown;
  private readonly readyTimer: unknown;

  private constructor(private readonly win: PopupWindow, private readonly origin: string, private readonly env: PopupEnv) {
    this.stopListening = env.listen((e) => this.onMessage(e));
    this.closedTimer = env.setInterval(() => {
      if (this.win.closed) this.fail(new EmbeddedWalletError("CANCELLED", "You closed the wallet window."));
    }, CLOSED_CHECK_MS);
    this.readyTimer = env.setTimeout(() => {
      if (!this.isReady) this.fail(new EmbeddedWalletError("TIMEOUT", "The wallet window didn't load. Try again."), true);
    }, READY_TIMEOUT_MS);
  }

  /** Call synchronously from the click handler. Throws POPUP_BLOCKED when the browser refuses. */
  static open(walletOrigin: string, env: PopupEnv = browserPopupEnv()): WalletPopup {
    const win = env.open(`${walletOrigin}/`);
    if (!win) throw new EmbeddedWalletError("POPUP_BLOCKED", "Your browser blocked the wallet window. Allow pop-ups for this site and try again.");
    return new WalletPopup(win, walletOrigin, env);
  }

  connect(intent: ConnectIntent): Promise<ConnectResult> {
    return this.request({ type: "connect", intent }) as Promise<ConnectResult>;
  }

  sign(body: Omit<SignRequest, "v" | "kind" | "id" | "type">): Promise<SignResult> {
    return this.request({ type: "sign", ...body }) as Promise<SignResult>;
  }

  /** `heldUsd` (receive only) is a hint that can only make the popup stricter; see ManageRequest. */
  manage(action: ManageAction, heldUsd?: number): Promise<ManageResult> {
    const body = heldUsd === undefined ? { type: "manage" as const, action } : { type: "manage" as const, action, heldUsd };
    return this.request(body) as Promise<ManageResult>;
  }

  /** Closes the window and ends any wait (e.g. building the trade failed before anything was sent). */
  close(reason = "Cancelled."): void {
    this.fail(new EmbeddedWalletError("CANCELLED", reason), true);
  }

  private async request(body: Body): Promise<unknown> {
    if (this.used) throw new Error("one request per wallet window");
    this.used = true;
    await this.whenReady();
    const req = { v: PROTOCOL_VERSION, kind: PROTOCOL_KIND, id: newRequestId(), ...body } as WalletRequest;
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(new EmbeddedWalletError("CANCELLED", "You closed the wallet window."));
      const timer = this.env.setTimeout(
        () => this.fail(new EmbeddedWalletError("TIMEOUT", "The wallet didn't answer in time. Nothing was signed."), true),
        REQUEST_TIMEOUT_MS[req.type],
      );
      this.pending = { req, resolve, reject, timer };
      this.win.postMessage(req, this.origin);
    });
  }

  private whenReady(): Promise<void> {
    if (this.disposed) return Promise.reject(new EmbeddedWalletError("CANCELLED", "You closed the wallet window."));
    if (this.isReady) return Promise.resolve();
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  private onMessage(e: PopupMessage): void {
    if (this.disposed || e.source !== this.win || e.origin !== this.origin) return;
    let msg;
    try {
      msg = parseResponse(e.data);
    } catch {
      return;
    }
    if (msg.type === "ready") {
      if (this.isReady) return;
      this.isReady = true;
      this.env.clearTimeout(this.readyTimer);
      for (const w of this.readyWaiters.splice(0)) w.resolve();
      return;
    }
    const p = this.pending;
    if (!p || !resultFits(p.req, msg as ResultMessage)) return;
    this.dispose(false);
    const res = msg as ResultMessage;
    if (res.ok) p.resolve(res.result);
    else p.reject(new EmbeddedWalletError(res.error.code, res.error.message));
  }

  private fail(err: Error, closeWindow = false): void {
    if (this.disposed) return;
    const p = this.pending;
    this.dispose(closeWindow);
    for (const w of this.readyWaiters.splice(0)) w.reject(err);
    p?.reject(err);
  }

  private dispose(closeWindow: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopListening();
    this.env.clearInterval(this.closedTimer);
    this.env.clearTimeout(this.readyTimer);
    if (this.pending) this.env.clearTimeout(this.pending.timer);
    this.pending = null;
    if (closeWindow) {
      try {
        this.win.close();
      } catch {
        /* already gone */
      }
    }
  }
}

export function browserPopupEnv(): PopupEnv {
  return {
    // "_blank" (never a reused name) and no "noopener": the popup needs window.opener to answer.
    open: (url) => window.open(url, "_blank", "popup=yes,width=420,height=720") as PopupWindow | null,
    listen(fn) {
      const h = (e: MessageEvent) => fn(e);
      window.addEventListener("message", h);
      return () => window.removeEventListener("message", h);
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (t) => window.clearTimeout(t as number),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (t) => window.clearInterval(t as number),
  };
}
