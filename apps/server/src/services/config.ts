/** What the server takes from exclip.config.ts, flattened once at start: the switches, the wallet limits, the origin
 * in force and the credentials. Values are never logged; only `publicConfig` reaches a browser. */
import { STOCKS_BASELINE_COUNTRIES, originsFor, type ExclipConfig, type ExclipSecrets, type RateFee } from "@exclip/config";

export const SODAX_DEFAULT_BASE = "https://api.sodax.com/v1";
export const COINGECKO_PUBLIC_BASE = "https://api.coingecko.com/api/v3";
export const COINGECKO_PRO_BASE = "https://pro-api.coingecko.com/api/v3";

export type PartnerFee = { address: string; percentage: number };

/** fees.split (docs/fee-split.md), as the proxy pins it and /config publishes it. */
export type ServerFeeSplit = {
  /** Where the fee on a swap without a tokenised stock goes: the operator's splitter. */
  splitter: string;
  /** The platform's rate and the operator's together, per 100,000 of the amount sold. */
  totalRate: number;
  /** The platform's name comes from its factory's entry in the allow-list, never from code. */
  platformName: string;
  platformRate: number;
  /** brand.operator, or brand.name when that is empty: the name the wallet window shows (apps/wallet/src/config.ts). */
  operatorName: string;
  operatorRate: number;
  /** What is pinned on a swap with a tokenised stock on either side, which never goes to the splitter: the operator's
   * own plain fee, or null for none. */
  stockFee: PartnerFee | null;
};

export type ServerConfig = {
  /** features.trading: off → every route that builds a transaction answers 403; quotes and status still work. */
  tradingEnabled: boolean;
  /** features.embeddedWallet: the passkey wallet's routes. Off → they answer 404. */
  embeddedWallet: boolean;
  /** Where the wallet popup lives (the expected WebAuthn origin): origins.wallet in production, DEV_ORIGINS.wallet in
   * development. Only exclip.config.ts sets it; no environment variable can move it. */
  walletOrigin: string;
  /** The wallet origin's host: the only WebAuthn rpId the API accepts. */
  walletRpId: string;
  /** wallet.unbackedLimitUsd: until a passkey wallet is backed up, the app warns at this amount and the wallet stops
   * showing its deposit address. */
  unbackedLimitUsd: number;
  /** wallet.maxBackupVersions: backup versions one passkey may store; appends beyond it are refused (nothing is
   * deleted to make room, so garbage appends can't push out a good version). */
  walletMaxVersions: number;
  /** wallet.dailyNewPasskeys: new passkeys accepted per UTC day across all users; then registration pauses. */
  walletDailyCredentials: number;
  /** Server-side only. Never serialised to a client, a log line or an error. */
  sodaxApiKey: string | null;
  sodaxBase: string;
  /** What is pinned on every quote and intent: null unless a receiver is set and partnerFeeBps is above 0. */
  partnerFee: PartnerFee | null;
  /** fees.rate: an amount to the receiver is pinned instead, worked out from each request (services/sodaxProxy.ts). */
  rateFee: RateFee | null;
  /** Who the review names as getting a plain fee: fees.receiverName, or brand.name. */
  feeReceiverName: string;
  /** fees.split: an amount to the splitter is pinned instead, worked out from each request (services/sodaxProxy.ts).
   * The config check lets only one of partnerFee, rateFee and feeSplit be set. */
  feeSplit: ServerFeeSplit | null;
  coingeckoBase: string;
  coingeckoKey: string | null;
  /** stocks: tokenised stocks (services/stocks.ts). Off: any request with a stock leg answers 451 STOCKS_DISABLED. */
  stocks: {
    enabled: boolean;
    /** The header the reverse proxy sets to the visitor's country code, in lower case. */
    countryHeader: string | null;
    /** ExClip's baseline and stocks.blockedCountries together. */
    blockedCountries: readonly string[];
    termsVersion: string;
    /** Server-side only, like the SODAX key: never serialised to a client, a log line or an error. */
    edgeSecret: string | null;
    attestationSecret: string | null;
  };
};

export function serverConfig(config: ExclipConfig, secrets: ExclipSecrets, dev: boolean): ServerConfig {
  const walletOrigin = originsFor(config, dev).wallet;
  const split = config.fees.split;
  const rate = config.fees.rateFee;
  return {
    tradingEnabled: config.features.trading,
    embeddedWallet: config.features.embeddedWallet,
    walletOrigin,
    walletRpId: new URL(walletOrigin).hostname,
    unbackedLimitUsd: config.wallet.unbackedLimitUsd,
    walletMaxVersions: config.wallet.maxBackupVersions,
    walletDailyCredentials: config.wallet.dailyNewPasskeys,
    sodaxApiKey: secrets.sodaxApiKey,
    sodaxBase: SODAX_DEFAULT_BASE,
    partnerFee: config.fees.partnerFee ? { ...config.fees.partnerFee } : null,
    rateFee: rate ? { ...rate, stockFee: rate.stockFee ? { ...rate.stockFee } : null } : null,
    feeReceiverName: config.fees.receiverName,
    feeSplit: split
      ? {
        splitter: split.splitter,
        totalRate: split.totalRate,
        platformName: split.platformName,
        platformRate: split.platformRate,
        operatorName: config.brand.operator || config.brand.name,
        operatorRate: split.operatorRate,
        stockFee: split.stockFee ? { ...split.stockFee } : null,
      }
      : null,
    coingeckoBase: secrets.coingeckoApiKey ? COINGECKO_PRO_BASE : COINGECKO_PUBLIC_BASE,
    coingeckoKey: secrets.coingeckoApiKey,
    stocks: {
      enabled: config.stocks.enabled,
      countryHeader: config.stocks.countryHeader,
      blockedCountries: [...new Set([...STOCKS_BASELINE_COUNTRIES, ...config.stocks.blockedCountries])].sort(),
      termsVersion: config.stocks.termsVersion,
      edgeSecret: secrets.edgeSecret,
      attestationSecret: secrets.attestationSecret,
    },
  };
}

/** What the browser may know: switches, the fee rate and receiver it will be shown, the wallet origin and the terms
 * version users confirm for tokenised stocks; never a key or a secret. A plain fee has feeReceiver and
 * feeReceiverName, and partnerFeeBps or else feeRate: its rate per 100,000 and its fee in basis points on stock swaps.
 * With a split, partnerFeeBps is 0, the other three are null, and feeSplit has the receiver, each party's name and
 * rate per 100,000, and the fee on stock swaps. */
export function publicConfig(config: ServerConfig) {
  const split = config.feeSplit;
  const rate = config.rateFee;
  const plain = config.partnerFee ?? rate;
  return {
    tradingEnabled: config.tradingEnabled,
    sodaxConfigured: config.sodaxApiKey !== null,
    partnerFeeBps: config.partnerFee?.percentage ?? 0,
    feeReceiver: plain?.address ?? null,
    feeRate: rate ? { rate: rate.rate, stockFeeBps: rate.stockFee?.percentage ?? 0 } : null,
    feeReceiverName: plain ? config.feeReceiverName : null,
    feeSplit: split
      ? {
        receiver: split.splitter,
        totalRate: split.totalRate,
        platform: { name: split.platformName, rate: split.platformRate },
        operator: { name: split.operatorName, rate: split.operatorRate },
        stockFee: split.stockFee ? { receiver: split.stockFee.address, bps: split.stockFee.percentage } : null,
      }
      : null,
    embeddedWallet: config.embeddedWallet,
    walletOrigin: config.embeddedWallet ? config.walletOrigin : null,
    unbackedLimitUsd: config.unbackedLimitUsd,
    stocksEnabled: config.stocks.enabled,
    stocksTermsVersion: config.stocks.enabled ? config.stocks.termsVersion : null,
  };
}
