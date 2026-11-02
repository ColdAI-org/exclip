/** Build-time constants (vite.config.ts `define`, from exclip.config.ts through walletBuildConfig and from
 * fee-receivers.json). Read them only through config.ts, which guards each with `typeof`: under tsx (tests) none is
 * defined. */
declare const __EXCLIP_PARENT_ORIGINS__: readonly string[];
declare const __EXCLIP_FEE_RECEIVERS__: readonly string[];
/** config.ts FeeSplitTerms. */
declare const __EXCLIP_FEE_SPLITS__: readonly {
  factory: string; platform: string; platformName: string; platformRate: number; maxTotalRate: number; operator: string; operatorRate: number;
}[];
/** config.ts FeeRateTerms, or null without a fee rate. */
declare const __EXCLIP_FEE_RATE__: { rate: number; stockFeeBps: number } | null;
declare const __EXCLIP_DEV__: boolean;
declare const __EXCLIP_WALLET_ORIGIN__: string;
declare const __EXCLIP_BRAND_NAME__: string;
declare const __EXCLIP_OPERATOR__: string;
declare const __EXCLIP_FEE_RECEIVER_NAME__: string;
declare const __EXCLIP_UNBACKED_LIMIT_USD__: number;
declare const __EXCLIP_STOCKS__: boolean;
