/** Choosing a concrete SODAX token (asset + network) and reading the wallet's balance of it. */
import type { SodaxToken } from "./api";
import { fromUnits } from "./format";
import type { WalletState } from "./wallet";

const PREFERRED_CHAINS = ["0x2105.base", "hedera", "0xa4b1.arbitrum", "ethereum", "sonic"];

export function balanceOf(wallet: WalletState, t: { chainKey: string; address: string }): bigint {
  const raw = wallet.balances[t.chainKey]?.[t.address.toLowerCase()];
  try { return raw ? BigInt(raw) : 0n; } catch { return 0n; }
}

/** The network to use for an asset: the one asked for, else where the wallet holds most of it, else a well-supported default. */
export function pickChain(list: SodaxToken[], wallet: WalletState, prefer?: string | null): string | null {
  if (!list.length) return null;
  if (prefer && list.some(t => t.chainKey === prefer)) return prefer;
  const held = list.map(t => [t, Number(fromUnits(balanceOf(wallet, t), t.decimals))] as const).filter(([, b]) => b > 0);
  if (held.length) return held.sort((a, b) => b[1] - a[1])[0]![0].chainKey;
  for (const c of PREFERRED_CHAINS) if (list.some(t => t.chainKey === c)) return c;
  return list[0]!.chainKey;
}
