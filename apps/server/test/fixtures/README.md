Real api.sodax.com/v1 responses, captured 2026-10-16. `swaps_tokens_hedera_subset.json` is four Hedera entries of
`GET /swaps/tokens`, unchanged (two crypto tokens, two `isRwa` tokenised-stock tokens). `quote_N_req.json` /
`quote_N.json` are `POST /swaps/quote` bodies and answers, `swaps_deadline.json` a `GET /swaps/deadline` answer and
`swaps_fees_partner_400.json` SODAX's 400 for a partner-fee request without an amount. No API key appears in any file.

`web/` and `wallet/` stand in for the built apps (`apps/web/dist`, `apps/wallet/dist`) in the static-serving tests.
`stocks.config.ts` is a configuration with tokenised stocks switched on, for the start-up tests.
