/** Tokenised stocks (docs/tokenised-stocks.md): the fixed parts the server, the app and the wallet window share, so the
 * rules, the header names and the wording exist once. Off unless exclip.config.ts switches them on (`stocks`).
 *
 * Erasable TypeScript only and no imports: the browser bundles take this module as it is. */

/** The ISO 3166-1 alpha-2 codes officially assigned. Anything else (XX, T1, EU, user-assigned codes such as XK) is not a
 * country here: a request that carries one counts as a request from an unknown country. */
export const ISO_COUNTRY_CODES: ReadonlySet<string> = new Set(
  ("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT " +
    "JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY " +
    "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM " +
    "PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
    "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW").split(" "),
);

/** ExClip's conservative default: the countries where tokenised stocks are refused whatever the configuration says.
 * The United States and its territories (American Samoa, Guam, the Northern Mariana Islands, Puerto Rico, the US Minor
 * Outlying Islands and the US Virgin Islands), and Belarus, Cuba, Iran, North Korea, Russia and Syria.
 * stocks.blockedCountries adds to it; nothing removes from it. A floor, not a list of where stocks are allowed. */
export const STOCKS_BASELINE_COUNTRIES: readonly string[] = Object.freeze([
  "AS", "BY", "CU", "GU", "IR", "KP", "MP", "PR", "RU", "SY", "UM", "US", "VI",
]);

/** The header your reverse proxy sends EXCLIP_EDGE_SECRET in. A country header on a request without it counts for
 * nothing, so a visitor who reaches the server another way can't name their own country. */
export const STOCKS_EDGE_SECRET_HEADER = "x-exclip-edge-secret";
/** The header the app sends the signed self-certification back in. */
export const STOCKS_ATTESTATION_HEADER = "x-exclip-stocks-attestation";
/** How long a self-certification lasts. */
export const STOCKS_ATTESTATION_DAYS = 30;

/** The label next to every tokenised stock, in the app and in the wallet window. */
export const STOCK_BADGE = "Tokenised stock";

export type StockRefusal = "STOCKS_DISABLED" | "COUNTRY_UNKNOWN" | "COUNTRY_RESTRICTED" | "SELF_CERT_REQUIRED";

/** Why a request with a tokenised stock in it was refused (HTTP 451), in the words the user reads. */
export const STOCK_REFUSALS: Readonly<Record<StockRefusal, string>> = Object.freeze({
  STOCKS_DISABLED: "Tokenised stocks are not available here.",
  COUNTRY_UNKNOWN: "Your country couldn't be determined, and tokenised stocks are only offered when it can be. If you use a VPN or proxy, turn it off and try again.",
  COUNTRY_RESTRICTED: "Tokenised stocks are not available in your country.",
  SELF_CERT_REQUIRED: "Read the disclosures and confirm the statements before you trade tokenised stocks.",
});

/** What the user confirms before trading tokenised stocks: all four, every STOCKS_ATTESTATION_DAYS, and again whenever
 * stocks.termsVersion changes or they're in another country. The server checks the ids; the app shows the text. */
export const STOCK_STATEMENTS = [
  { id: "not-us-person", text: "I'm not a US person (for example a citizen or resident of the United States), and I'm not acting for one." },
  { id: "permitted", text: "I may buy and hold tokenised stocks where I live, and I'm not hiding where I am (for example with a VPN)." },
  { id: "risks", text: "I understand that a tokenised stock may not give me a shareholder's rights, and that I can lose all I put in." },
  { id: "own-decision", text: "I'm trading for myself, on my own judgement, and I don't take anything here as investment advice." },
] as const;

export type StockStatementId = (typeof STOCK_STATEMENTS)[number]["id"];

/** The disclaimer on the Stocks screen and in the review of any trade with a stock in it, in the app and in the wallet
 * window. `name`: who runs the deployment (brand.operator, else brand.name). */
export function stocksDisclaimer(name: string): string {
  return `Tokenised stocks are tokens meant to track the price of a company's shares. ${name} doesn't issue them, and ` +
    "holding one may not give you a shareholder's rights: what each token gives you is set by its issuer's terms. " +
    "They may be restricted where you live. Prices can move sharply, and you can lose all you put in. " +
    "Nothing here is investment advice.";
}

/** What the eligibility sheet tells the user before the statements. */
export function stocksDisclosures(name: string): string[] {
  return [
    "A tokenised stock is a token meant to track the price of a company's shares. Holding one may not give you a " +
      "shareholder's rights, such as a vote or dividends: what it gives you, and what happens if its issuer fails, is set " +
      "by the issuer's terms.",
    `${name} doesn't issue these tokens, hold them for you or advise you on them. Swaps settle through SODAX, from and ` +
      "into your own wallet.",
    "Prices can move sharply, and you may not be able to sell when you want or at the price you want. You can lose all " +
      "you put in.",
    `Tokenised stocks are restricted in many countries. ${name} refuses them where it can tell you're in one of the ` +
      "countries it excludes, but you're responsible for knowing whether you may buy them where you live.",
  ];
}
