/** The SODAX contracts and networks the embedded wallet will sign for. Reviewed constants: every address below is
 * copied from @sodax/types 2.2.0 (node_modules/@sodax/types/dist), and anything not listed is refused.
 *
 * Sources (@sodax/types 2.2.0):
 *  - EIP-155 chain ids:         dist/chains/chains.js baseChainInfo[*].chainId
 *  - spoke asset managers:      dist/chains/chains.js spokeChainConfig[*].addresses.assetManager
 *  - Sonic wallet router:       dist/chains/chains.js spokeChainConfig.sonic.addresses.walletRouter
 *  - intent relay chain ids:    dist/chains/chains.js RelayChainIdMap
 *  - intents contract (hub):    dist/common/constants.js solver mainnet intentsContract
 * Call shapes (@sodax/sdk 2.2.0 dist/index.mjs): EvmSpokeService.deposit (assetManager.transfer), SonicSpokeService
 * .createSwapIntent (intents.createIntent from the EOA), EvmSolverService.constructCreateIntentData (hub calls
 * [approve, createIntent]), SwapService.approve (spender = asset manager on spokes, intents contract on Sonic).
 *
 * A change here changes what users can sign: have a second person review it (docs/embedded-wallet.md). */

export type EvmChain = {
  key: string;
  name: string;
  chainId: number;
  relayId: bigint;
  /** Native coin symbol and decimals as shown to the user. */
  native: { symbol: string; decimals: number };
  /** Spoke asset manager (deposits and approvals). Absent on Sonic (the hub). */
  assetManager?: `0x${string}`;
  /** msg.value = amount × this for a native deposit (Hedera's EVM value is in weibars, its token amounts in tinybars). */
  nativeValueScale: bigint;
  /** Highest maxFeePerGas / gasPrice the wallet signs on this network, in wei (Hedera: weibars). A request above it is
   * refused, not shown: a compromised parent can't make the user burn a large fee by skimming. */
  maxFeePerGas: bigint;
};

export const SONIC_KEY = "sonic";
/** SODAX intents contract on Sonic. Spender on Sonic, and the target of the hub createIntent call everywhere. */
export const INTENTS_CONTRACT = "0x6382D6ccD780758C5e8A6123c33ee8F4472F96ef" as const;
export const SONIC_WALLET_ROUTER = "0xC67C3e55c665E78b25dc9829B3Aa5af47d914733" as const;
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as const;

const GWEI = 10n ** 9n;
const chain = (key: string, name: string, chainId: number, relayId: bigint, native: [string, number], maxFeeGwei: bigint, assetManager?: `0x${string}`, nativeValueScale = 1n): EvmChain =>
  ({ key, name, chainId, relayId, native: { symbol: native[0], decimals: native[1] }, ...(assetManager ? { assetManager } : {}), nativeValueScale, maxFeePerGas: maxFeeGwei * GWEI });

/** Networks the embedded wallet signs on (EVM family). Everything else: "Use a browser wallet for this network".
 *
 * Fee caps (set 2026-10, in gwei): far above each network's normal price so a busy hour still signs, low enough that
 * MAX_GAS at the cap stays a small amount of the coin. Ethereum 500; the ETH rollups (Base, Arbitrum, Optimism,
 * Robinhood, LightLink) and BNB Chain 10; Avalanche and HyperEVM 100; Kaia 750 (its protocol's own upper bound on the
 * base fee); Sonic 1,000; Polygon, Redbelly and Hedera keep the old global 10,000 (cheap coins, spiky fees on Polygon,
 * and Hedera's fixed USD gas price is thousands of "gwei" in weibars when HBAR is cheap). Redbelly's normal fee hasn't
 * been checked against the live network yet. */
export const EVM_CHAINS: Readonly<Record<string, EvmChain>> = Object.freeze({
  sonic: chain("sonic", "Sonic", 146, 146n, ["S", 18], 1_000n),
  ethereum: chain("ethereum", "Ethereum", 1, 2n, ["ETH", 18], 500n, "0x39E77f86C1B1f3fbAb362A82b49D2E86C09659B4"),
  "0x2105.base": chain("0x2105.base", "Base", 8453, 30n, ["ETH", 18], 10n, "0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3"),
  "0xa4b1.arbitrum": chain("0xa4b1.arbitrum", "Arbitrum", 42161, 23n, ["ETH", 18], 10n, "0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3"),
  "0xa.optimism": chain("0xa.optimism", "Optimism", 10, 24n, ["ETH", 18], 10n, "0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3"),
  "0x89.polygon": chain("0x89.polygon", "Polygon", 137, 5n, ["POL", 18], 10_000n, "0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3"),
  "0x38.bsc": chain("0x38.bsc", "BNB Chain", 56, 4n, ["BNB", 18], 10n, "0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3"),
  "0xa86a.avax": chain("0xa86a.avax", "Avalanche", 43114, 6n, ["AVAX", 18], 100n, "0x5bDD1E1C5173F4c912cC919742FB94A55ECfaf86"),
  hyper: chain("hyper", "HyperEVM", 999, 26745n, ["HYPE", 18], 100n, "0xAfd6A6e4287A511D3BAAd013093815268846FBb7"),
  lightlink: chain("lightlink", "LightLink", 1890, 27756n, ["ETH", 18], 10n, "0x4A1C82744cDDeE675A255fB289Cb0917A482e7C7"),
  "0x2019.kaia": chain("0x2019.kaia", "Kaia", 8217, 27489n, ["KAIA", 18], 750n, "0x6D2126DB97dd88AfA85127253807D04A066b6746"),
  redbelly: chain("redbelly", "Redbelly", 151, 726564n, ["RBNT", 18], 10_000n, "0x39E77f86C1B1f3fbAb362A82b49D2E86C09659B4"),
  hedera: chain("hedera", "Hedera", 295, 18501n, ["HBAR", 8], 10_000n, "0x0df73542cC68bDC01b361d231c60F726B0e0bC05", 10n ** 10n),
  robinhood: chain("robinhood", "Robinhood Chain", 4663, 21071n, ["ETH", 18], 10n, "0x0df73542cC68bDC01b361d231c60F726B0e0bC05"),
});

/** Where a swap may deliver: the wallet's own address there. Stellar is left out on purpose (receiving a non-native
 * asset needs a trustline, which only a Stellar signature can add; the embedded wallet doesn't sign Stellar in v1). */
export type DestinationFamily = "evm" | "solana" | "sui";
export const NON_EVM_DESTINATIONS: Readonly<Record<string, { name: string; relayId: bigint; family: Exclude<DestinationFamily, "evm"> }>> = Object.freeze({
  solana: { name: "Solana", relayId: 1n, family: "solana" },
  sui: { name: "Sui", relayId: 21n, family: "sui" },
});

export function evmChain(key: string): EvmChain | null {
  return Object.hasOwn(EVM_CHAINS, key) ? EVM_CHAINS[key]! : null;
}

export function destination(key: string): { name: string; relayId: bigint; family: DestinationFamily } | null {
  const evm = evmChain(key);
  if (evm) return { name: evm.name, relayId: evm.relayId, family: "evm" };
  return Object.hasOwn(NON_EVM_DESTINATIONS, key) ? NON_EVM_DESTINATIONS[key]! : null;
}

/** Highest partner fee the wallet accepts in an intent, in basis points of the amount paid (@exclip/config
 * PARTNER_FEE_MAX_BPS, 1 %). */
export const MAX_PARTNER_FEE_BPS = 100n;
