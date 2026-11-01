/** What the server takes from exclip.config.ts, flattened once at start: the switches, the wallet limits, the origin
 * in force and the credentials. Values are never logged; only `publicConfig` reaches a browser. */
import { STOCKS_BASELINE_COUNTRIES, originsFor, type ExclipConfig, type ExclipSecrets } from "@exclip/config";

export const SODAX_DEFAULT_BASE = "https://api.sodax.com/v1";
export const COINGECKO_PUBLIC_BASE = "https://api.coingecko.com/api/v3";
export const COINGECKO_PRO_BASE = "https://pro-api.coingecko.com/api/v3";

export type PartnerFee = { address: string; percentage: number };

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
  /** What is pinned on every quote and intent: null unless a receiver is set and the rate is above 0. */
  partnerFee: PartnerFee | null;
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
 * version users confirm for tokenised stocks; never a key or a secret. */
export function publicConfig(config: ServerConfig) {
  return {
    tradingEnabled: config.tradingEnabled,
    sodaxConfigured: config.sodaxApiKey !== null,
    partnerFeeBps: config.partnerFee?.percentage ?? 0,
    feeReceiver: config.partnerFee?.address ?? null,
    embeddedWallet: config.embeddedWallet,
    walletOrigin: config.embeddedWallet ? config.walletOrigin : null,
    unbackedLimitUsd: config.unbackedLimitUsd,
    stocksEnabled: config.stocks.enabled,
    stocksTermsVersion: config.stocks.enabled ? config.stocks.termsVersion : null,
  };
}
