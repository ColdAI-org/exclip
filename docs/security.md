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
| The server, `apps/server` | The SODAX key, the fee setting, encrypted wallet backups, rate-limit counters | Forward allow-listed SODAX calls, pin the fee, store backups | Read a backup, sign, learn a wallet address from the backup API, or point the app at another wallet |
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
| 3 | A fee is whole basis points up to 1 % and needs a receiver. A half-set fee stops the server at start. | `packages/config/test/config.test.ts`: "partner fee: whole basis points up to 1 %, and only with a receiver". `apps/server/test/exclip.test.ts`: "a half-set or out-of-range fee stops the server at start instead of running with a fee nobody asked for". |
| 4 | The passkey wallet signs a fee only to a receiver in the committed `fee-receivers.json`, which ships empty. | `apps/wallet/test/build-config.test.ts`: "the repository ships an empty fee allowlist, so the wallet signs only fee-free intents", "fee receivers come from the committed fee-receivers.json, never from the environment". `apps/wallet/test/policy.test.ts`: "a partner fee up to 1% to the allowlisted receiver passes; above the cap or to anyone else is refused". |
| 5 | Only allow-listed SODAX routes and query parameters reach SODAX. | `apps/server/test/exclip.test.ts`: "the allow-list admits the documented SODAX swap paths and nothing else (no money-market routes in v1)", "a path outside the allow-list is refused with 404 and never reaches SODAX", "only the route's own query parameters are forwarded". |
| 6 | Tokenised stocks are refused before SODAX sees the request, and an unreadable token list refuses too. | `apps/server/test/exclip.test.ts`: "tokenised stocks are not offered: any quote or intent with a stock leg is refused (451) before SODAX sees it", "a token list that can't be read refuses a request with token legs (fail closed)". |
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

CI runs every one of these on each pull request and each push to `main`
(`pnpm test`).

## Known limitations

- **No audit yet.** Nobody outside ColdAI has reviewed the code.
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

## Reporting

Report vulnerabilities privately, through a GitHub security advisory or by
email, never in a public issue. [SECURITY.md](../SECURITY.md) covers where to
send a report, what to include, what is in scope and what happens next.
