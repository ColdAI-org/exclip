# Security

> [!WARNING]
> ExClip is a preview, and no independent firm has audited it. The swaps it
> sends are real: SODAX settles them on live networks with real funds. Try
> every flow you plan to offer with small amounts first.

ExClip prepares swaps that people sign with their own wallets, so a bug here
can cost them money. This page covers four things:

- what each part is trusted with;
- the rules the code keeps, and the test that proves each one;
- what isn't covered yet;
- how to report a problem.

The passkey wallet has a longer threat model of its own, in
[the embedded wallet](embedded-wallet.md#threat-model).

## Trust model

| Part | Holds | Trusted to | Can't |
|---|---|---|---|
| The user's wallet: a browser wallet, or the passkey wallet on its own origin | The keys | Sign only what the user approves | |
| The app, `apps/web`, on the app origin | No keys. The trade history and the theme, in the browser's local storage | Build trades, show prices and balances, ask the wallet to sign | Sign, read the passkey wallet's storage, or change the deposit address the passkey wallet shows |
| The server, `apps/server` | The SODAX key, the fee setting, encrypted wallet backups, rate-limit counters. With tokenised stocks on, the edge and attestation secrets | Forward allow-listed SODAX calls, pin the fee, store backups, decide who may trade tokenised stocks | Read a backup, sign, learn a wallet address from the backup API, or point the app at another wallet |
| Your reverse proxy, with tokenised stocks on | The edge secret | Tell the server each visitor's country, and replace any country or secret a client sent | Confirm the statements for a user: only the server signs a self-certification |
| SODAX | Quotes, transaction building, the relayer and the solvers | Build what the user asked for, and settle it | Get a different trade past the passkey wallet, which checks every byte against the user's own plan |
| Chain RPCs | Balances, nonces, gas prices, broadcast | Report the chain honestly | Get a wrong transaction signed. A lying RPC can stall a trade. |
| CoinGecko | Reference prices | Prices for lists and charts | Set a trade's price. That always comes from a SODAX quote. |

Two consequences follow:

- **Browser wallets bring their own review.** ExClip's signing policy runs
  in the passkey wallet only. With a browser wallet, that wallet's own review
  is what stands between a compromised app page and a bad signature, as on
  any other site.
- **The wallet origin is the trust anchor.** Code served from the wallet's
  host can use every passkey that signs in there. Treat a deploy of it like a
  key ceremony: see
  [release controls](embedded-wallet.md#release-controls).

## What the server sees

- **The SODAX calls the app makes.** Building an intent sends the user's
  addresses, tokens and amounts through the proxy. The server forwards them
  and logs none of them.
- **Encrypted backups** that only the user's passkey opens, with the
  passkey's public key, sign count and transports. No address, name, email or
  IP address is stored with them.
- **Client addresses**, to count rate limits: an IPv4 address, or the first
  64 bits of an IPv6 address. A shared entry expires 65 seconds after the
  client's last counted request, and Postgres deletes expired rows at a
  later sweep. Each process also keeps its 50,000 most recent clients in
  memory, to refuse bursts. The server never logs an address.
- **With tokenised stocks on, the visitor's country**, which your proxy
  adds to every request. The server reads it only on the stock routes and
  on SODAX requests with a stock in them, and keeps and logs none of it. A
  user's self-certification is kept in their browser, not on the server.

The server writes no request log. It logs its settings at start (never a
credential), operational alerts as codes, storage outages, and the stack of
an unexpected `5xx` with the SODAX key cut out. See
[self-hosting](self-hosting.md#monitoring).

## Invariants and how they are tested

Each rule below has a test that fails if the rule breaks. Test names are
quoted exactly, so `git grep` finds them; "SODAX key 1/4" to "4/4" are the
four tests whose names start that way.

| # | Invariant | Tested by |
|---|---|---|
| 1 | The SODAX key never reaches a browser, a log line or a URL. It goes to SODAX only, in `x-api-key`. | `apps/server/test/app.test.ts`: "SODAX key 1/4" to "SODAX key 4/4". `packages/config/test/config.test.ts`: "what a build bakes in never carries a secret". `apps/web/test/build-config.test.ts`: "the bundle gets \_\_EXCLIP\_\_ and nothing else: the brand and the two origins, never a key". |
| 2 | No fee by default. The server pins the configured fee on every quote and intent, and drops any fee or hook the browser sends. | `apps/server/test/app.test.ts`: "defaults: no fee in /config, and a client's partnerFee (and hook) is stripped before SODAX sees the quote". `apps/server/test/exclip.test.ts`: "the configured partner fee is pinned and a client-supplied fee is stripped", "with no fee configured the field is omitted, even when the client sends one". |
| 3 | A plain fee is whole basis points up to 1 % and needs a receiver. A half-set fee stops the server at start. | `packages/config/test/config.test.ts`: "partner fee: whole basis points up to 1 %, and only with a receiver". `apps/server/test/exclip.test.ts`: "a half-set or out-of-range fee stops the server at start instead of running with a fee nobody asked for". |
| 4 | The passkey wallet signs a fee only where the committed `fee-receivers.json` lets it, and its three lists ship empty. | `apps/wallet/test/build-config.test.ts`: "the repository ships an empty fee allowlist, so the wallet signs only fee-free intents", "fee receivers come from the committed fee-receivers.json, never from the environment". `apps/wallet/test/policy.test.ts`: "a partner fee up to 1% to the allowlisted receiver passes; above the cap or to anyone else is refused". |
| 5 | Only allow-listed SODAX routes and query parameters reach SODAX. | `apps/server/test/exclip.test.ts`: "the allow-list admits the documented SODAX swap paths and nothing else (no money-market routes in v1)", "a path outside the allow-list is refused with 404 and never reaches SODAX", "only the route's own query parameters are forwarded". |
| 6 | Tokenised stocks are off by default: a stock is refused before SODAX sees the request. A swap without a stock never meets the stock check, and an unreadable token list refuses every request with a token in it. | `packages/config/test/config.test.ts`: "tokenised stocks: off by default; on, they need the proxy's country header, and the lists are checked". `apps/server/test/exclip.test.ts`: "tokenised stocks off (the default): any quote or intent with a stock leg is refused (451) before SODAX sees it", "stocks off: a stock leg is refused (451 STOCKS_DISABLED) whatever the request carries, and nothing is signed", "stocks in every state: a crypto-only swap is untouched, and the stock check isn't even asked", "a token list that can't be read refuses a request with token legs (fail closed)", "stocks on: a token list that can't be read refuses stock and crypto legs alike (503), even when confirmed". |
| 7 | With trading off, nothing new is built, but status and cancel stay open. | `apps/server/test/exclip.test.ts`: "with trading off, building a transaction is refused but status and cancel stay open". |
| 8 | Settings are checked, never passed through. The environment can switch features off but never on. | `packages/config/test/config.test.ts`: "a misspelt setting is an error, not silently ignored", "the environment supplies credentials and the port, and can switch features off but never on". |
| 9 | The wallet has a host of its own, and the app can't share its passkeys. | `packages/config/test/config.test.ts`: "origins: exact https origins, and the wallet on a host of its own". `apps/wallet/test/build-config.test.ts`: "production build guard: an app origin that shares the wallet's rpId is refused; distinct hosts pass". `apps/wallet/test/webauthn.test.ts`: "rpId is always the page's own host". |
| 10 | The app trusts only the wallet origin in its build. The server can switch the wallet off, not move it. | `apps/web/test/exclip-embedded.test.ts`: "wallet origin is fixed at build time; the runtime config is only an on/off switch", "production builds offer the embedded wallet only on the app origin they were built for". |
| 11 | The wallet runs only its own code, can't be framed, and talks to exactly two outside URLs. | `packages/config/test/config.test.ts`: "security headers: the wallet runs only its own code and can't be framed". `apps/wallet/test/build-config.test.ts`: "the CSP guard refuses an index.html with inline script or style, or an external URL". `apps/wallet/test/price.test.ts`: "the popup's CSP allows exactly two cross-origin URLs (the quote endpoint, Sonic's RPC), wherever the wallet is served". |
| 12 | The app's page has no inline script, so its CSP holds. | `apps/web/test/exclip-page.test.ts`: "anything the CSP (script-src 'self') would block fails the build". |
| 13 | Served from one server, the app and the wallet never share a response. | `apps/server/test/app.test.ts`: "serveStatic, wallet host: the wallet page, its hashed assets and its backup API, nothing else, with the wallet's headers", "serveStatic: the host name decides (any port, any case); X-Forwarded-Host counts only behind a trusted proxy; --dev serves nothing". |
| 14 | The app and the popup talk only to each other, by exact origin. | `apps/wallet/test/channel.test.ts`: "announces ready to each allowed parent by exact origin, never '\*'", "only the opener, from an allowed origin, with a valid message, is accepted; the first one wins". `apps/web/test/exclip-embedded.test.ts`: "popup: waits for ready, posts to the exact origin, accepts only the matching result from that window". |
| 15 | The popup signs only SODAX shapes that match the user's plan, on its own networks, with capped gas fees. It has no way to sign a message or typed data. | `apps/wallet/test/policy.test.ts`: "every intent field must match the plan and this wallet", "approvals: unlimited, too large, wrong spender or wrong token are refused", "chain must be allowlisted; the request must be for this wallet; nonces consecutive; fees sane", "the fee is capped per network, at most MAX_FEE_PER_GAS anywhere", "anything that isn't a sign/connect/manage request never reaches the policy (no personal_sign, no typed data)". |
| 16 | The popup checks the minimum received against its own references. | `apps/wallet/test/policy.test.ts`: "USD stable ↔ USD stable: a minimum below 97% of the gross input is refused". `apps/wallet/test/price.test.ts`: "quote reference: more than 5% below it is 'low', with the shortfall; the quote can't excuse anything else", "band table fallback (no quote): catches gross mispricing only, never a fair price". |
| 17 | Keys stay locked between requests, and secrets are wiped after use. | `apps/wallet/test/wallet.test.ts`: "create → server backup → sign in on a new device → same addresses → sign; locked after every step". `apps/wallet/test/hardening.test.ts`: "every PRF output the backup functions saw is zero once the flow ends (create, restore, add passkey)". |
| 18 | Every backup read and write needs a fresh, user-verified passkey assertion on a single-use challenge issued for that operation. | `apps/server/test/wallet.test.ts`: "challenges are single use: a replayed registration or assertion is refused", "challenges expire after two minutes and are bound to their purpose", "an assertion authorises only the operation its challenge was issued for", "wrong origin or wrong rpId (the parent domain) in the ceremony is refused", "user verification is required at registration and at every assertion", "a sign count that doesn't move forward is refused (cloned authenticator)". |
| 19 | Backups are only ever added, never rewritten, in the code and in the database. | `apps/server/test/wallet.test.ts`: "backups are append-only versions; fetch returns them all newest first; nothing is overwritten". `apps/server/test/migrations.test.ts`: "backups are append-only in the database as well as in the store". |
| 20 | The server stores and logs no personal data, and never learns a wallet address from the backup API. | `apps/server/test/migrations.test.ts`: "no column holds personal data". `apps/server/test/wallet.test.ts`: "no secret or personal data in responses, storage or logs", "no hub-wallet route: the wallet reads the SODAX factory itself; no wallet address reaches this server". |
| 21 | The wallet's routes never run unmetered, and production never runs on storage that forgets. | `apps/server/test/rateLimit.test.ts`: "store down, fail closed (the wallet): 503 RATE_LIMIT_UNAVAILABLE with Retry-After 30 and no-store". `apps/server/test/wallet.test.ts`: "the default wallet limits fail closed when the shared store is down". `apps/server/test/storage.test.ts`: "production refuses memory storage unless server.allowMemoryStore is set". |
| 22 | The app broadcasts signed transactions in order, and stops on a mismatch or a revert. | `apps/web/test/exclip-embedded.test.ts`: "broadcast: in order, each confirmed before the next; hash mismatch or revert stops it". |
| 23 | With tokenised stocks on, a country counts only on a request that carries the proxy's edge secret. A country header a client sets itself counts for nothing. | `apps/server/test/exclip.test.ts`: "stocks on: a country counts only with the edge secret; none, a forged one or an unassigned code is COUNTRY_UNKNOWN". |
| 24 | ExClip's baseline countries are always refused, and the operator's list only adds to them. | `packages/config/test/config.test.ts`: "the baseline is exported, made of real country codes, and always holds the United States". `apps/server/test/exclip.test.ts`: "stocks on: the baseline and the operator's own list are COUNTRY_RESTRICTED, and nothing is signed there". |
| 25 | A stock leg passes only with a self-certification this server signed for the current terms and the visitor's country, less than 30 days old. The server signs one only when every statement is confirmed. | `apps/server/test/exclip.test.ts`: "stocks on: a missing, altered, expired, foreign, future or old-terms attestation is SELF_CERT_REQUIRED", "stocks on: a valid attestation lets a stock leg through to SODAX, and nothing of the check travels upstream", "stocks: the confirmation needs every statement, for the current terms, and nothing else". |
| 26 | Tokenised stocks never run without both secrets. The environment can switch them off but never on. | `packages/config/test/config.test.ts`: "stocks: the environment switches them off but never on, and supplies their two secrets", "start-up: stocks on without the edge secret or a 32-character attestation secret stop the server, not a build". `apps/server/test/index.test.ts`: "tokenised stocks on without EXCLIP_EDGE_SECRET or a 32-character EXCLIP_ATTESTATION_SECRET: the server won't start". `apps/server/test/exclip.test.ts`: "stocks on without the two secrets can't be built, even by a caller that skipped the loader". |
| 27 | The app offers no stock while stocks are off, and sends the self-certification only to the SODAX proxy and the stock routes. | `apps/web/test/stocks.test.ts`: "off: no stock among the trade sheet's assets, no Stocks screen and no link to one", "the self-certification goes to SODAX's routes and the stock check's own, nowhere else, and not once expired". |
| 28 | The passkey wallet signs a tokenised stock only in a build with stocks on, and then under the same checks as any other token. | `apps/wallet/test/build-config.test.ts`: "the wallet signs tokenised stocks only in a build with stocks.enabled, and EXCLIP_DISABLE_STOCKS there switches them off". `apps/wallet/test/stocks.test.ts`: "stocks off: a tokenised stock isn't a listed token, to swap or to send, and every coin is as it was", "stocks on: a swap with a stock leg is checked like any other, and its review shows the badge and the disclaimer". `apps/wallet/test/wallet.test.ts`: "tokenised stocks: refused unless the build switched them on; then reviewed with the badge and the disclaimer, and signed exactly as built". |
| 29 | A [fee split](fee-split.md) uses only a factory that the reviewed allow-list lists, with values a factory there can have, and only a split its factory would accept. A config sets a plain fee or a split, never both. | `packages/config/test/fee-split.test.ts`: "the allow-list refuses a factory entry with a value no FeeSplitterFactory there has", "the allow-list refuses a split its factory would refuse, by the factory's error name", "the allow-list refuses a split entry it can't vouch for". `packages/config/test/config.test.ts`: "fee split: refused unless the allow-list lists the factory, and wherever the factory would refuse it". `apps/wallet/test/build-config.test.ts`: "the build stops on a fee-split factory or split the allow-list can't vouch for". |
| 30 | ExClip's splitter address is the one the factory gives. | `packages/config/test/fee-split.test.ts`: "each splitter is where its factory predicted and created it, with the factory's salt", "each factory's implementation, its splitters' creation code and initCodeHash are what the factory worked out", "each refusal is the factory's, in the factory's order, and predictSplitter throws for it". `apps/wallet/test/fee-split.test.ts`: "the dry run's vector: the wallet's splitter for the README's split is the one the real factory gave". |
| 31 | With a split, the server pins the split's amount to the splitter on every fee route, from the amount sold, rounded down, whatever the browser sent. A request whose amount sold it can't read never reaches SODAX. | `apps/server/test/exclip.test.ts`: "a split pins an amount to the splitter on the quote and the four intent routes, from the amount sold, rounded down", "a split pins nothing while the fee rounds down to 0, and 1 unit from the first amount that reaches it", "a split refuses a fee route whose amount sold it can't read (400 BAD_AMOUNT) before SODAX sees it". |
| 32 | A swap with a tokenised stock on either side never pays the splitter. | `apps/server/test/exclip.test.ts`: "stocks on with a split: a stock on either side never pays the splitter, only the operator's own fee or none". `apps/web/test/fees.test.ts`: "a split with a stock on either side: never the splitter, only the operator's own fee, or none". `apps/wallet/test/fee-split.test.ts`: "a split on a swap with a tokenised stock on either side is refused; the operator's own plain fee there is not". |
| 33 | The passkey wallet signs a split's fee only to the splitter it works out itself from a listed split, and only at exactly the split's rates of the amount sold. The operator's rate is held to 1 %. | `apps/wallet/test/fee-split.test.ts`: "a fee of exactly the split's rates to the splitter the wallet works out passes, and the review says who gets what", "a fee one unit more or less than the split's rates, or at any other rate, is refused", "a fee to any splitter the build doesn't list is refused: another factory's, another operator's or rate's, or none at all", "the operator's rate is held to the wallet's cap, while the split's total may reach the factory's". `apps/wallet/test/wallet.test.ts`: "a fee split: signed, exactly as built, only by a build that lists the split; the review and the re-check both use it". |

CI runs every one of these on each pull request and each push to `main`
(`pnpm test`). Its second job checks that the vectors behind 30, and the
splitter's code, still match the contracts
([development](development.md#scripts)).

## Known limitations

- **No audit yet.** Nobody outside ColdAI has reviewed the code. That
  includes the fee-split contracts.
- **Only the passkey wallet checks a fee.** A browser wallet signs whatever
  fee the server pins, and the passkey wallet also signs an intent with no
  fee. A fee split's platform fee holds only where the server pins it
  ([decisions for the owner](fee-split.md#decisions-for-the-owner)).
- **The proxy is public.** The API has no login, so anyone can call the
  allow-listed SODAX routes through your server, with your key, within the
  per-address rate limits. Watch your SODAX usage.
- **Small price shaves get through.** A script on the app page can ask the
  passkey wallet for a swap whose minimum is up to 5 % under the popup's own
  quote. The decoded minimum is on screen, but there is no warning. See
  [price checks](embedded-wallet.md#price-checks).
- **The deposit limit is a nudge.** The popup has no balance source of its
  own, so an app that under-reports holdings gets the address shown. Anyone
  can send to the address on chain anyway.
- **The first hub-account lookup trusts Sonic's RPC and TLS.** After that,
  the popup pins the answer.
- **Backups depend on the server.** A compromised database can delete
  backups. Users who never saved their recovery phrase then rely on their
  passkey device alone. Back the database up.
- **A challenge isn't bound to the request body.** Binding it would cost a
  second passkey prompt.
- **Rate limits are per address.** An attacker with many addresses gets many
  budgets. `wallet.dailyNewPasskeys` bounds how fast backup storage can grow.
- **The trade history lives in the app's local storage.** It holds no keys,
  but any script on the app origin can read it.
- **Release controls are yours to set up.** The repository ships no
  `CODEOWNERS` file. See
  [release controls](embedded-wallet.md#release-controls).
- **The stock check is only as good as its inputs.** With tokenised stocks
  on, the country comes from your reverse proxy, and ExClip's proxy
  examples are untested. A VPN hides a country, and the self-certification
  is the user's own word. For swaps from the app, the quote is the
  checkpoint, so a modified client that skips it gets past the proxy. See
  [tokenised stocks](tokenised-stocks.md#limitations).

## Reporting

Report vulnerabilities privately, through a GitHub security advisory or by
email, never in a public issue. [SECURITY.md](../SECURITY.md) covers where to
send a report, what to include, what is in scope and what happens next.
