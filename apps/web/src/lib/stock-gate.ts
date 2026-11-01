/**
 * Tokenised stocks (docs/tokenised-stocks.md): the signed self-certification this browser keeps after the user confirms
 * the statements, and the refusal reasons the server's stock check gives. The server signs the attestation and is the
 * only judge of it; this side keeps it, sends it back in x-exclip-stocks-attestation, and forgets one past its expiry.
 *
 * No React and no network here, so the trade code and the SDK bridge can use it as they are.
 */
import { STOCK_REFUSALS, STOCKS_ATTESTATION_HEADER, type StockRefusal } from "@exclip/config/stocks";

export type StockPass = { attestation: string; expiresAt: string };

const KEY = "exclip.stocks.attestation";
const listeners = new Set<() => void>();
let cached: StockPass | null | undefined;

function stored(): StockPass | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<StockPass> | null;
    if (typeof value?.attestation === "string" && typeof value.expiresAt === "string") return { attestation: value.attestation, expiresAt: value.expiresAt };
  } catch { /* blocked or malformed */ }
  return null;
}

/** The attestation this browser holds, or null when it has none or the one it had has expired. */
export function stockPass(): StockPass | null {
  if (cached === undefined) cached = typeof window === "undefined" ? null : stored();
  if (cached && !(Date.parse(cached.expiresAt) > Date.now())) cached = null;
  return cached;
}

export function setStockPass(pass: StockPass | null) {
  cached = pass;
  try {
    if (pass) window.localStorage.setItem(KEY, JSON.stringify(pass));
    else window.localStorage.removeItem(KEY);
  } catch { /* blocked: it lasts as long as the page */ }
  listeners.forEach(l => l());
}

export function onStockPass(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Another tab confirmed (or the storage was cleared): read it again on next use.
if (typeof window !== "undefined") {
  window.addEventListener("storage", e => {
    if (e.key !== KEY && e.key !== null) return;
    cached = undefined;
    listeners.forEach(l => l());
  });
}

/** The header that carries the attestation, when there is one. */
export function stockPassHeaders(): Record<string, string> {
  const pass = stockPass();
  return pass ? { [STOCKS_ATTESTATION_HEADER]: pass.attestation } : {};
}

const REFUSALS: ReadonlySet<string> = new Set(Object.keys(STOCK_REFUSALS));

const refusal = (code: unknown): StockRefusal | null => (typeof code === "string" && REFUSALS.has(code) ? code as StockRefusal : null);
const bodyRefusal = (body: unknown) => refusal((body as { error?: { code?: unknown } } | null | undefined)?.error?.code);

/** The stock check's reason in a refusal from this server (a 451), however deep an SDK wrapped it: an ApiError carries
 * it as its code, the SDK's HTTP errors as the response body, on themselves or in their context. Null for any other
 * error, including those codes under any other status. */
export function stockRefusalOf(error: unknown): StockRefusal | null {
  let e = error;
  for (let depth = 0; depth < 8 && typeof e === "object" && e !== null; depth++) {
    const x = e as { status?: unknown; code?: unknown; body?: unknown; context?: { status?: unknown; body?: unknown }; cause?: unknown };
    const found = (x.status === 451 ? refusal(x.code) ?? bodyRefusal(x.body) : null) ?? (x.context?.status === 451 ? bodyRefusal(x.context.body) : null);
    if (found) return found;
    e = x.cause;
  }
  return null;
}

/** What to tell the user about a refusal from the stock check, or null when the error is something else. */
export function stockRefusalText(error: unknown): string | null {
  const code = stockRefusalOf(error);
  return code ? STOCK_REFUSALS[code] : null;
}
