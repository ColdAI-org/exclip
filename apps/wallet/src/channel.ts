/** The popup's side of the ExClip ↔ wallet messaging (protocol.ts).
 *
 *  1. Announce `ready` to the opener, once per allowed parent origin, each time naming that exact origin as the
 *     target: the browser drops every copy whose origin isn't the opener's, so nothing reaches another site.
 *  2. Accept exactly one request: event.source must be the opener AND event.origin one of PARENT_ORIGINS, and the
 *     data must parse. Everything else is ignored (not answered: an answer would tell a stranger we're here).
 *  3. Answer that request once, to the origin it came from. Then the channel is closed.
 *
 * Nothing in a request can change where answers go, what the popup trusts, or which origin is the parent. */
import { PROTOCOL_KIND, PROTOCOL_VERSION, READY_TIMEOUT_MS, ProtocolError, parseRequest, ready, type ErrorCode, type ResultMessage, type WalletRequest } from "./protocol.ts";
import { BRAND_NAME } from "./config.ts";

export type WindowLike = { postMessage(message: unknown, targetOrigin: string): void; closed?: boolean };
export type MessageEventLike = { data: unknown; origin: string; source: unknown };

export type ChannelEnv = {
  opener: WindowLike | null;
  parents: readonly string[];
  listen(fn: (e: MessageEventLike) => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
};

export class ChannelError extends Error {
  constructor(readonly code: "NO_OPENER" | "TIMEOUT") {
    super(code === "NO_OPENER" ? `Open the wallet from ${BRAND_NAME}.` : `${BRAND_NAME} didn't send a request in time.`);
    this.name = "ChannelError";
  }
}

export type Session = {
  request: WalletRequest;
  /** The exact origin that sent the request (one of PARENT_ORIGINS). */
  origin: string;
  /** Sends the one result. Later calls do nothing. */
  reply(result: Extract<ResultMessage, { ok: true }>["result"]): void;
  fail(code: ErrorCode, message: string): void;
  readonly answered: boolean;
};

export function openChannel(env: ChannelEnv, timeoutMs = READY_TIMEOUT_MS): Promise<Session> {
  const opener = env.opener;
  if (!opener || opener.closed || !env.parents.length) return Promise.reject(new ChannelError("NO_OPENER"));
  return new Promise((resolve, reject) => {
    let done = false;
    const stop = env.listen((e) => {
      if (done || e.source !== opener || !env.parents.includes(e.origin)) return;
      let request: WalletRequest;
      try {
        request = parseRequest(e.data);
      } catch (err) {
        if (err instanceof ProtocolError) return; // not ours, or malformed: ignore, keep waiting
        throw err;
      }
      done = true;
      stop();
      env.clearTimeout(timer);
      resolve(session(opener, e.origin, request));
    });
    const timer = env.setTimeout(() => {
      if (done) return;
      done = true;
      stop();
      reject(new ChannelError("TIMEOUT"));
    }, timeoutMs);
    for (const origin of env.parents) {
      try {
        opener.postMessage(ready(), origin);
      } catch {
        // A cross-origin opener throws nothing for a mismatched origin, but be defensive.
      }
    }
  });
}

function session(opener: WindowLike, origin: string, request: WalletRequest): Session {
  let answered = false;
  const send = (body: Record<string, unknown>) => {
    if (answered) return;
    answered = true;
    opener.postMessage({ v: PROTOCOL_VERSION, kind: PROTOCOL_KIND, id: request.id, type: "result", ...body }, origin);
  };
  return {
    request,
    origin,
    reply: (result) => send({ ok: true, result }),
    fail: (code, message) => send({ ok: false, error: { code, message: message.slice(0, 300) || "Something went wrong." } }),
    get answered() {
      return answered;
    },
  };
}

/** The browser wiring for openChannel. */
export function browserChannelEnv(parents: readonly string[]): ChannelEnv {
  return {
    opener: window.opener as WindowLike | null,
    parents,
    listen(fn) {
      const h = (e: MessageEvent) => fn(e);
      window.addEventListener("message", h);
      return () => window.removeEventListener("message", h);
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (t) => window.clearTimeout(t as number),
  };
}
