/** Build-time constants (vite.config.ts `define`, from exclip.config.ts through walletBuildConfig and from
 * fee-receivers.json). Read them only through config.ts, which guards each with `typeof`: under tsx (tests) none is
 * defined. */
declare const __EXCLIP_PARENT_ORIGINS__: readonly string[];
declare const __EXCLIP_FEE_RECEIVERS__: readonly string[];
declare const __EXCLIP_DEV__: boolean;
declare const __EXCLIP_WALLET_ORIGIN__: string;
declare const __EXCLIP_BRAND_NAME__: string;
declare const __EXCLIP_OPERATOR__: string;
declare const __EXCLIP_UNBACKED_LIMIT_USD__: number;
