/**
 * Tokenised stocks, when this server offers them (stocks.enabled; docs/tokenised-stocks.md): which SODAX tokens are
 * stocks, whether this visitor may trade them, and the self-certification that lets them. The server decides; the app
 * only shows its answer, and sends nothing for stocks while they're off.
 */
import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { StockRefusal, StockStatementId } from "@exclip/config/stocks";
import { api, API_BASE, tokensBySymbol, type SodaxToken, type TokensByChain } from "./api";
import { assetMeta, canonicalSymbol } from "./catalog";
import { onStockPass, setStockPass, stockPass } from "./stock-gate";

/** One tokenised stock: its symbol and name as SODAX lists them, and its token on each network. */
export type StockListing = { symbol: string; name: string; tokens: SodaxToken[] };

/** SODAX's tokenised stocks (the tokens it flags isRwa) by symbol, in symbol order. A stock whose symbol is also a
 * crypto asset's in the catalog is left out, so a stock can never pass for a coin, or a coin for a stock. */
export function stockListings(tokens: TokensByChain | undefined): Map<string, StockListing> {
  const bySymbol = new Map<string, StockListing>();
  for (const [chainKey, list] of Object.entries(tokens ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (t?.isRwa !== true || typeof t.symbol !== "string" || !t.symbol.trim()) continue;
      const key = t.symbol.toUpperCase();
      if (assetMeta(key) || canonicalSymbol(key)) continue;
      const token = { ...t, chainKey: t.chainKey ?? chainKey };
      const known = bySymbol.get(key);
      if (known) known.tokens.push(token);
      else bySymbol.set(key, { symbol: t.symbol, name: t.name?.trim() || t.symbol, tokens: [token] });
    }
  }
  return new Map([...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)).map(s => [s.symbol, s]));
}

/** What the trade sheet offers, by symbol: the catalog's crypto assets, never with a stock among their tokens, and each
 * of `stocks` under its own symbol. With stocks off, `stocks` is empty and no stock is offered at all. */
export function tradableAssets(tokens: TokensByChain | undefined, stocks: ReadonlyMap<string, StockListing>): Map<string, SodaxToken[]> {
  const out = tokensBySymbol(tokens);
  for (const [symbol, list] of out) {
    const crypto = list.filter(t => !t.isRwa);
    if (crypto.length) out.set(symbol, crypto); else out.delete(symbol);
  }
  for (const s of stocks.values()) out.set(s.symbol, s.tokens);
  return out;
}

/** GET /api/exclip/stocks/eligibility: whether this visitor may trade stocks now and, if not, why. */
export type StockEligibility = {
  eligible: boolean;
  code: StockRefusal | null;
  message: string | null;
  country: string | null;
  termsVersion: string | null;
  expiresAt: string | null;
};

/** The attestation this browser holds (lib/stock-gate.ts), as React state. */
export function useStockPass() {
  return useSyncExternalStore(onStockPass, stockPass, () => null);
}

export function useStockEligibility(enabled: boolean) {
  const pass = useStockPass();
  return useQuery({
    // A new attestation is a new question.
    queryKey: ["exclip", "stocks", "eligibility", pass?.attestation ?? null],
    queryFn: ({ signal }) => api<StockEligibility>(`${API_BASE}/stocks/eligibility`, { signal }),
    enabled,
    staleTime: 60_000,
    retry: 1,
  });
}

/** POST /api/exclip/stocks/attest with the statements the user ticked, for the terms they read. Keeps the attestation the
 * server signs; throws the server's refusal (an ApiError) otherwise. */
export async function confirmStatements(termsVersion: string, statements: readonly StockStatementId[]): Promise<void> {
  const signed = await api<{ attestation: string; expiresAt: string }>(`${API_BASE}/stocks/attest`, { body: { termsVersion, statements } });
  setStockPass({ attestation: signed.attestation, expiresAt: signed.expiresAt });
}

/** A country code as the user's language names it ("DE" → "Germany"), or the code where the browser can't. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
