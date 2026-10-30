/**
 * ExClip's static catalog: what each asset and network is called, how it is drawn, and where its explorer is.
 * Token addresses, decimals and which networks an asset trades on come live from SODAX (/api/exclip/sodax/swaps/tokens);
 * prices from /api/exclip/markets. Nothing here is a price or a balance, so it can ship in the bundle.
 */

export type AssetKind = "crypto" | "stable";

export type AssetMeta = {
  symbol: string;
  name: string;
  kind: AssetKind;
  /** Brand-neutral monogram colour for the generated icon. */
  hue: number;
  about: string;
  /** SODAX token symbols that are this asset (wrapped and bridged forms). */
  aliases?: string[];
  /** Listed recently on SODAX: shown in the "New" card. */
  isNew?: boolean;
};

const crypto = (symbol: string, name: string, hue: number, about: string, extra: Partial<AssetMeta> = {}): AssetMeta =>
  ({ symbol, name, kind: "crypto", hue, about, ...extra });
const stable = (symbol: string, name: string, about: string, extra: Partial<AssetMeta> = {}): AssetMeta =>
  ({ symbol, name, kind: "stable", hue: 205, about, ...extra });

export const ASSETS: AssetMeta[] = [
  crypto("BTC", "Bitcoin", 33, "The first cryptocurrency: a fixed supply of 21 million coins, secured by proof of work. Here it trades natively on Bitcoin and as wrapped BTC on EVM networks.", { aliases: ["BTC", "WBTC", "cbBTC", "BTCB", "BTC.b", "tBTC", "UBTC"] }),
  crypto("ETH", "Ethereum", 230, "The native asset of Ethereum and most of its layer-2 networks, used to pay for computation and secured by proof of stake.", { aliases: ["ETH", "WETH", "WETH.e", "UETH"] }),
  crypto("SOL", "Solana", 275, "The native asset of Solana, a high-throughput chain with sub-second blocks and low fees.", { aliases: ["SOL", "USOL"] }),
  crypto("HBAR", "Hedera", 0, "The native asset of Hedera, a public network governed by a council of global organisations."),
  crypto("BNB", "BNB", 45, "The native asset of BNB Smart Chain, used for fees and staking."),
  crypto("AVAX", "Avalanche", 0, "The native asset of the Avalanche C-Chain, a fast EVM network."),
  crypto("SUI", "Sui", 200, "The native asset of Sui, an object-based chain built in the Move language."),
  crypto("XLM", "Stellar", 220, "The native asset of Stellar, a payments network for fast, low-cost transfers."),
  crypto("NEAR", "NEAR", 160, "The native asset of NEAR, a sharded chain with human-readable accounts."),
  crypto("INJ", "Injective", 195, "The native asset of Injective, a chain built for trading applications."),
  crypto("POL", "Polygon", 265, "The native asset of Polygon PoS, the successor to MATIC."),
  crypto("HYPE", "Hyperliquid", 165, "The native asset of Hyperliquid, a chain that runs an on-chain order book and HyperEVM.", { isNew: true }),
  crypto("S", "Sonic", 210, "The native asset of Sonic, the network that hosts the SODAX hub, where every swap here is settled.", { aliases: ["S", "wS"] }),
  crypto("ICX", "ICON", 180, "The native asset of ICON, an interoperability-focused chain."),
  crypto("STX", "Stacks", 25, "The native asset of Stacks, a smart-contract layer anchored to Bitcoin."),
  crypto("KAIA", "Kaia", 150, "The native asset of Kaia, formed from the Klaytn and Finschia networks.", { isNew: true }),
  crypto("LINK", "Chainlink", 220, "The token of Chainlink, the oracle network that supplies prices to many on-chain applications."),
  crypto("AAVE", "Aave", 290, "The governance token of Aave, a lending protocol."),
  crypto("UNI", "Uniswap", 325, "The governance token of Uniswap, a decentralised exchange protocol."),
  crypto("DOGE", "Dogecoin", 48, "A proof-of-work currency that began as a joke and became one of the most traded assets."),
  crypto("XRP", "XRP", 210, "The native asset of the XRP Ledger, a payments-focused network."),
  crypto("ADA", "Cardano", 220, "The native asset of Cardano, a proof-of-stake chain."),
  crypto("DOT", "Polkadot", 330, "The native asset of Polkadot, a network of connected chains."),
  crypto("PEPE", "Pepe", 120, "A meme token on Ethereum. Highly volatile.", { isNew: true }),
  crypto("ENA", "Ethena", 240, "The governance token of Ethena, issuer of the USDe synthetic dollar."),
  crypto("ARB", "Arbitrum", 210, "The governance token of Arbitrum, an Ethereum layer-2 network."),
  crypto("OP", "Optimism", 0, "The governance token of OP Mainnet, an Ethereum layer-2 network."),
  crypto("CAKE", "PancakeSwap", 30, "The token of PancakeSwap, a decentralised exchange on BNB Chain."),
  crypto("JUP", "Jupiter", 150, "The governance token of Jupiter, a Solana trading aggregator.", { isNew: true }),
  crypto("BONK", "Bonk", 35, "A community meme token on Solana. Highly volatile."),
  crypto("PYTH", "Pyth Network", 270, "The token of Pyth, a market-data oracle network."),
  crypto("ZEC", "Zcash", 45, "A privacy-focused proof-of-work currency."),
  crypto("CRV", "Curve DAO", 0, "The governance token of Curve, a stablecoin exchange protocol."),
  stable("USDC", "USD Coin", "A dollar stablecoin issued by Circle and backed by cash and short-term US Treasuries."),
  stable("USDT", "Tether", "The largest dollar stablecoin by supply, issued by Tether.", { aliases: ["USDT", "USDT0"] }),
  stable("DAI", "Dai", "A decentralised dollar stablecoin backed by crypto collateral."),
];

export type NetworkMeta = {
  key: string;
  name: string;
  short: string;
  /** One or two letters for the generated network badge. */
  monogram: string;
  hue: number;
  /** Explorer URL prefix for a transaction hash; null when there is no public explorer we trust yet. */
  txUrl: string | null;
  /** Typical source-chain confirmation, used for the "est. time" line before SODAX reports a real one. */
  confirmSeconds: number;
};

const net = (key: string, name: string, short: string, monogram: string, hue: number, txUrl: string | null, confirmSeconds = 15): NetworkMeta =>
  ({ key, name, short, monogram, hue, txUrl, confirmSeconds });

/** SODAX spoke chains by chainKey (as in /swaps/tokens). */
export const NETWORKS: NetworkMeta[] = [
  net("hedera", "Hedera", "Hedera", "H", 0, "https://hashscan.io/mainnet/transaction/", 5),
  net("ethereum", "Ethereum", "Ethereum", "E", 230, "https://etherscan.io/tx/", 60),
  net("0x2105.base", "Base", "Base", "B", 220, "https://basescan.org/tx/", 10),
  net("0xa4b1.arbitrum", "Arbitrum One", "Arbitrum", "A", 210, "https://arbiscan.io/tx/", 10),
  net("0xa.optimism", "OP Mainnet", "Optimism", "OP", 0, "https://optimistic.etherscan.io/tx/", 10),
  net("0x89.polygon", "Polygon", "Polygon", "P", 265, "https://polygonscan.com/tx/", 20),
  net("0x38.bsc", "BNB Smart Chain", "BNB Chain", "BN", 45, "https://bscscan.com/tx/", 10),
  net("0xa86a.avax", "Avalanche C-Chain", "Avalanche", "AV", 0, "https://snowtrace.io/tx/", 5),
  net("sonic", "Sonic", "Sonic", "S", 210, "https://sonicscan.org/tx/", 5),
  net("hyper", "HyperEVM", "HyperEVM", "HY", 165, "https://hyperevmscan.io/tx/", 5),
  net("solana", "Solana", "Solana", "SO", 275, "https://solscan.io/tx/", 5),
  net("sui", "Sui", "Sui", "SU", 200, "https://suiscan.xyz/mainnet/tx/", 5),
  net("stellar", "Stellar", "Stellar", "XL", 220, "https://stellar.expert/explorer/public/tx/", 6),
  net("near", "NEAR", "NEAR", "N", 160, "https://nearblocks.io/txns/", 5),
  net("injective-1", "Injective", "Injective", "IN", 195, "https://explorer.injective.network/transaction/", 5),
  net("bitcoin", "Bitcoin", "Bitcoin", "BT", 33, "https://mempool.space/tx/", 1200),
  net("stacks", "Stacks", "Stacks", "ST", 25, "https://explorer.hiro.so/txid/", 60),
  net("0x1.icon", "ICON", "ICON", "IC", 180, "https://tracker.icon.community/transaction/", 10),
  net("0x2019.kaia", "Kaia", "Kaia", "K", 150, "https://kaiascan.io/tx/", 5),
  net("lightlink", "LightLink", "LightLink", "LL", 50, "https://phoenix.lightlink.io/tx/", 5),
  net("redbelly", "Redbelly", "Redbelly", "R", 350, "https://redbelly.routescan.io/tx/", 5),
  net("robinhood", "Robinhood Chain", "Robinhood", "RH", 140, null, 10),
];

/** Where every intent is settled (the SODAX hub). */
export const HUB_TX_URL = "https://sonicscan.org/tx/";

const assetBySymbol = new Map(ASSETS.map(a => [a.symbol.toUpperCase(), a]));
const networkByKey = new Map(NETWORKS.map(n => [n.key, n]));

/** SODAX token symbol (e.g. "WETH") -> catalog symbol ("ETH"). */
const aliasToSymbol = new Map<string, string>();
for (const a of ASSETS) for (const s of a.aliases ?? [a.symbol]) aliasToSymbol.set(s.toUpperCase(), a.symbol);

/** Two letters for a network the catalog doesn't know yet: "0x2105.base" -> "BA". */
function monogramOf(key: string): string {
  return (key.split(".").pop() ?? key).replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";
}

export function assetMeta(symbol: string): AssetMeta | undefined { return assetBySymbol.get(symbol.toUpperCase()); }
export function networkMeta(key: string): NetworkMeta {
  return networkByKey.get(key) ?? { key, name: key, short: key, monogram: monogramOf(key), hue: 0, txUrl: null, confirmSeconds: 30 };
}
export function canonicalSymbol(tokenSymbol: string): string | null { return aliasToSymbol.get(tokenSymbol.toUpperCase()) ?? null; }

/** Display name for any symbol in the catalog. */
export function nameOf(symbol: string): string { return assetMeta(symbol)?.name ?? symbol.toUpperCase(); }

/** Pairs shown in Advanced, e.g. "ETH-USDC". */
export const QUOTE_SYMBOL = "USDC";
export function pairOf(param: string | undefined): { base: string; quote: string } | null {
  const m = /^([A-Za-z0-9]{1,12})-([A-Za-z0-9]{1,12})$/.exec(param ?? "");
  if (!m) return null;
  const base = m[1]!.toUpperCase(), quote = m[2]!.toUpperCase();
  if (base === quote || !assetMeta(base) || !assetMeta(quote)) return null;
  return { base, quote };
}

/** The pairs Advanced offers in its pair menu: every non-stable asset against USDC. */
export const TRADE_PAIRS = ASSETS.filter(a => a.kind !== "stable").map(a => `${a.symbol}-${QUOTE_SYMBOL}`);
