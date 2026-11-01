# Server API

The server, `apps/server`, answers under `/api/exclip`. This page lists
every route, what it takes, what it returns and how it is rate limited. The
code is in `apps/server/src/routes/` and `apps/server/src/services/`.

There are no accounts. A wallet is the account, and nothing here needs a
login. The app calls these routes on its own origin. The passkey wallet calls
the backup routes on the wallet origin. Anything else under `/api` answers
404.

## Conventions

- **JSON in, JSON out.** Request bodies are limited to 32 KB. A larger body
  answers `413 BODY_TOO_LARGE`, and a body that isn't JSON answers
  `400 BAD_JSON`. Neither echoes the body back.
- **One error shape.** Every refusal is
  `{ "error": { "code": "…", "message": "…" } }`. The message is written for
  a person and never carries request data or an upstream error.
- **Headers.** When the server runs the API alone, every `/api` answer
  carries `Content-Security-Policy: default-src 'none'; frame-ancestors
  'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy:
  no-referrer`. With `server.serveStatic`, the app's or the wallet's security
  headers apply instead, chosen by host name (see
  [self-hosting](self-hosting.md#5-serve-the-two-origins)).
- **No upstream headers.** The SODAX proxy returns SODAX's status and body,
  never its headers.

## Rate limits

Each client gets one budget per bucket, counted over any 60 seconds. A
client is one IPv4 address or one IPv6 `/64`, so rotating addresses inside
one allocation doesn't multiply the budget. An address the server can't read
shares a single "unknown" budget.

| Bucket | Routes | Per minute | When the shared store is down |
|---|---|---|---|
| `exclip-read` | `GET /config`, `GET /markets`, `GET /markets/:symbol/chart` | 240 | admitted (fail open) |
| `exclip-sodax` | everything under `/sodax/` | 120 | admitted (fail open) |
| `exclip-stocks` | `GET /stocks/eligibility`, `POST /stocks/attest` | 60 | admitted (fail open) |
| `exclip-wallet-challenge` | `POST /wallet/challenge` | 30 | refused (fail closed) |
| `exclip-wallet-write` | the other four `/wallet/` routes | 20 | refused (fail closed) |

Two layers count. Each server process first keeps an in-memory token bucket
that refuses bursts. Then a 60-second sliding window in the shared store
(Redis, or Postgres when there is no Redis) holds one budget per client
across all processes.

- Over the limit: `429 RATE_LIMITED`, with `Retry-After: 60` and
  `"retryable": true` in the error.
- Shared store down, fail open: the request goes through, still limited by
  the process's own bucket. Market data and quotes stay up during a store
  outage.
- Shared store down, fail closed: `503 RATE_LIMIT_UNAVAILABLE`, with
  `Retry-After: 30`. The wallet's routes guard backups and never run
  unmetered.

The server logs a store outage at most once a minute per bucket, without the
client's address. Rate limits count per address, so behind a proxy set
`server.trustProxy` (see
[self-hosting](self-hosting.md#proxies-and-client-addresses)).

## Routes at a glance

| Method | Path | Limit | What it does |
|---|---|---|---|
| `GET` | [`/api/exclip/config`](#get-config) | read | The switches and settings the app needs at runtime |
| `GET` | [`/api/exclip/markets`](#get-markets) | read | Reference prices for every listed asset |
| `GET` | [`/api/exclip/markets/:symbol/chart`](#get-marketssymbolchart) | read | A price chart for one asset |
| `GET`, `POST` | [`/api/exclip/sodax/*`](#sodax) | sodax | The SODAX API, through an allow-list, with the key added |
| `GET` | [`/api/exclip/stocks/eligibility`](#get-stockseligibility) | stocks | Whether this visitor may trade tokenised stocks, and if not, why |
| `POST` | [`/api/exclip/stocks/attest`](#post-stocksattest) | stocks | Confirm the statements, for a signed self-certification |
| `POST` | [`/api/exclip/wallet/challenge`](#post-walletchallenge) | challenge | A one-time WebAuthn challenge |
| `POST` | [`/api/exclip/wallet/credentials`](#post-walletcredentials) | write | Register a passkey and store its first backup |
| `POST` | [`/api/exclip/wallet/backup/fetch`](#post-walletbackupfetch) | write | Read a passkey's backups |
| `POST` | [`/api/exclip/wallet/backup`](#post-walletbackup) | write | Add a backup version |
| `POST` | [`/api/exclip/wallet/credentials/retire`](#post-walletcredentialsretire) | write | Retire a passkey |

## `GET /config`

What the app reads when it starts. It never carries a key.

```json
{
  "tradingEnabled": true,
  "sodaxConfigured": true,
  "partnerFeeBps": 0,
  "feeReceiver": null,
  "embeddedWallet": true,
  "walletOrigin": "https://wallet.example.org",
  "unbackedLimitUsd": 100,
  "stocksEnabled": false,
  "stocksTermsVersion": null
}
```

| Field | Meaning |
|---|---|
| `tradingEnabled` | `features.trading`. When false, the app shows a "Trading is paused" banner; prices, charts and quotes stay live. |
| `sodaxConfigured` | Whether the server has a SODAX key. It says so, and nothing more. |
| `partnerFeeBps` | The fee the server pins, in basis points. `0` when no fee is set. |
| `feeReceiver` | The fee's receiver, or `null`. |
| `embeddedWallet` | `features.embeddedWallet`. |
| `walletOrigin` | The wallet origin, or `null` when the wallet is off. The app only uses it as an on/off switch: the origin it trusts is fixed in its build. |
| `unbackedLimitUsd` | `wallet.unbackedLimitUsd`. |
| `stocksEnabled` | `stocks.enabled`, after `EXCLIP_DISABLE_STOCKS`. When false, the app names and offers no tokenised stock. |
| `stocksTermsVersion` | `stocks.termsVersion`, the terms users confirm before trading stocks, or `null` while stocks are off. |

`Cache-Control: public, max-age=30`.

## `GET /markets`

Reference prices from CoinGecko for the 36 assets the server knows
(`COINGECKO_IDS` in `apps/server/src/services/markets.ts`). Clients can't
name other assets: the server only ever asks CoinGecko for these.

This is the answer the server's own test gets from its CoinGecko fixture:

```json
{
  "status": "ok",
  "asOf": 1792152000000,
  "rows": [
    {
      "symbol": "HBAR",
      "price": 0.1834,
      "change24h": -2.4,
      "change1h": null,
      "change7d": null,
      "marketCap": 7700000000,
      "volume24h": 120000000,
      "circulatingSupply": 42000000000,
      "totalSupply": null,
      "maxSupply": null,
      "high24h": null,
      "low24h": null,
      "rank": null,
      "sparkline": [0.18, 0.19, 0.1834]
    }
  ]
}
```

- `asOf` is a Unix time in milliseconds. Changes are percentages. Any
  number CoinGecko didn't send is `null`, never a guess.
- `sparkline` is the last seven days, thinned to at most 42 points.
- When CoinGecko fails, the server keeps answering with the last good list
  for up to 15 minutes. After that the answer is
  `{ "status": "unavailable", "asOf": null, "rows": [] }`, and the app shows
  an empty state.
- A good list is cached for 60 seconds in the process, and sent with
  `Cache-Control: public, max-age=30`. An unavailable one is cached for 15
  seconds and sent with `no-store`.

These prices are for lists and charts only. The price a trade gets always
comes from a SODAX quote.

## `GET /markets/:symbol/chart`

`?range=` is one of `1H`, `1D`, `1W`, `1M`, `1Y` or `ALL`, and defaults to
`1D`. The same test's chart, whose fixture uses tiny timestamps:

```json
{ "status": "ok", "symbol": "HBAR", "range": "1W", "points": [[1, 100], [2, 101], [3, 99.5]] }
```

- `points` are `[time in ms, price in USD]`, thinned to at most 240.
- Cached per symbol and range: 1 minute for `1H`, 2 minutes for `1D`, 10
  minutes for `1W`, 30 minutes for `1M`, and an hour for `1Y` and `ALL`.
  When CoinGecko fails, a cached chart is served if there is one; otherwise
  the answer is `"status": "unavailable"` with no points.
- `400 BAD_RANGE` for another range. `404 UNKNOWN_ASSET` for a symbol the
  server doesn't know.
- `Cache-Control: public, max-age=60` when the status is `ok`, `no-store`
  otherwise.

## SODAX

`/api/exclip/sodax/<path>` forwards to `https://api.sodax.com/v1/<path>`
with the server's key in the `x-api-key` header. It is an allow-list, not a
pass-through: only these routes exist.

| Method | Path | Query kept | Notes |
|---|---|---|---|
| `GET` | `swaps/tokens` | | cached 5 min |
| `GET` | `swaps/tokens/{chainKey}` | | cached 5 min |
| `POST` | `swaps/quote` | `includeTxData` | fee pinned; stock check |
| `GET` | `swaps/deadline` | `offsetSeconds` | cached 30 s |
| `GET` | `swaps/fees/partner` | `amount` | |
| `GET` | `swaps/fees/solver` | `amount` | |
| `POST` | `swaps/allowance/check` | | fee pinned; stock check |
| `POST` | `swaps/approve` | | builds; fee pinned; stock check |
| `POST` | `swaps/intents` | | builds; fee pinned; stock check |
| `POST` | `swaps/limit-orders` | | builds; fee pinned; stock check |
| `POST` | `swaps/intents/submit` | | |
| `POST` | `swaps/intents/status` | | |
| `POST` | `swaps/intents/cancel` | | |
| `GET` | `swaps/intents/{hash}` | | |
| `GET` | `swaps/intents/{hash}/fill` | | |
| `POST` | `swaps/submit-tx` | | |
| `GET` | `swaps/submit-tx/status` | `txHash`, `srcChainKey` | |
| `GET` | `bridge/tokens` | | cached 5 min |
| `GET` | `be/config/all` | | cached 5 min |

A `{chainKey}` is 1 to 40 letters, digits, dots and dashes. A `{hash}` is 16
to 128 letters and digits. There are no money-market routes in this
version.

What the server does with each request, in order:

1. **Path.** A path longer than 300 characters, or one with `..`, `//`, a
   backslash or an encoded slash, is refused. So is any path not in the
   table: `404 NOT_ALLOWED`. Nothing refused reaches SODAX.
2. **Key.** No key set: `503 SODAX_NOT_CONFIGURED`. The app shows "Trading
   isn't connected".
3. **Query.** Only the parameters in the table are kept, each up to 200
   characters. Everything else is dropped.
4. **Trading switch.** With `features.trading` off, the routes marked
   "builds", and a quote with `includeTxData=true`, answer
   `403 TRADING_DISABLED`. Status, submit and cancel stay open, so an order
   that was already signed can always be followed or cancelled.
5. **Body.** A `POST` body must be a JSON object (`400 BAD_BODY`). On the
   routes marked "fee pinned", the server removes any `partnerFee` and
   `hook` the browser sent, then adds the configured fee, if there is one.
   See [fees](fees.md).
6. **Tokenised stocks.** On the routes marked "stock check", the server
   looks up both tokens in SODAX's token list, which it reads at most every
   5 minutes. When either is a token SODAX flags as a real-world asset
   (`isRwa`), the request goes on only if the stock check lets this visitor
   trade tokenised stocks. Otherwise it answers `451` with the check's
   reason ([tokenised stocks](#tokenised-stocks)). If the list can't be
   read, any request with a token in it is refused with
   `503 TOKEN_LIST_UNAVAILABLE` rather than let through.
7. **Upstream.** The request goes to SODAX with a 15-second timeout. Up to
   four attempts in all, with backoff: a `429` and SODAX's "API key
   verification is temporarily unavailable" `503` are always retried; a
   `5xx`, a timeout or a network error only on routes that are safe to repeat
   (all the reads, the quote, the allowance check and the status lookup).
   Identical requests to a cached route that arrive together share one
   upstream call.
8. **Answer.** SODAX's status and JSON body go back with the key removed
   wherever it appears. Cached routes carry `Cache-Control: public,
   max-age=30` and `X-Cache: hit` or `miss`; every other answer is
   `no-store`.

Errors the proxy adds:

| Status | Code | When |
|---|---|---|
| 400 | `BAD_BODY` | A `POST` body that isn't a JSON object |
| 403 | `TRADING_DISABLED` | Building a transaction while trading is off |
| 404 | `NOT_ALLOWED` | A path or method not in the allow-list |
| 429 | `SODAX_RATE_LIMITED` | SODAX kept answering 429 (`Retry-After: 5`) |
| 451 | `STOCKS_DISABLED` | A leg is a tokenised stock, and stocks are off |
| 451 | `COUNTRY_UNKNOWN` | A leg is a tokenised stock, and there's no country the server can trust |
| 451 | `COUNTRY_RESTRICTED` | A leg is a tokenised stock, and the visitor's country is refused |
| 451 | `SELF_CERT_REQUIRED` | A leg is a tokenised stock, and there's no valid self-certification |
| 502 | `SODAX_UNREACHABLE` | SODAX couldn't be reached |
| 502 | `SODAX_BAD_RESPONSE` | SODAX answered with something that isn't JSON |
| 502 | `SODAX_UPSTREAM` | SODAX answered 5xx after the retries, or the proxy failed |
| 503 | `SODAX_NOT_CONFIGURED` | No SODAX key on the server |
| 503 | `TOKEN_LIST_UNAVAILABLE` | The token list for the stock check couldn't be read |
| 504 | `SODAX_TIMEOUT` | SODAX didn't answer in time |

A SODAX `4xx`, such as a quote it can't fill, comes back with SODAX's own
status and body.

## Tokenised stocks

These two routes serve the stock check, which decides whether a visitor may
trade tokenised stocks. [Tokenised stocks](tokenised-stocks.md) explains the
rules; this section is the wire format. Both routes answer with
`Cache-Control: no-store`.

The check reads three request headers:

| Header | Set by | Meaning |
|---|---|---|
| `stocks.countryHeader`, such as `cf-ipcountry` | your reverse proxy | The visitor's country, as an ISO 3166-1 alpha-2 code |
| `x-exclip-edge-secret` | your reverse proxy | `EXCLIP_EDGE_SECRET`. Without it, the country header counts for nothing. |
| `x-exclip-stocks-attestation` | the app | The self-certification from `POST /stocks/attest`, up to 512 characters |

The app sends the attestation on these two routes and on `/sodax/*`, and
nowhere else. The proxy never forwards any of the three headers to SODAX.

### `GET /stocks/eligibility`

Whether this request may trade a tokenised stock. It always answers `200`:

```json
{
  "eligible": false,
  "code": "SELF_CERT_REQUIRED",
  "message": "Read the disclosures and confirm the statements before you trade tokenised stocks.",
  "country": "DE",
  "termsVersion": "2026-11-01",
  "expiresAt": null
}
```

| Field | Meaning |
|---|---|
| `eligible` | Whether a quote or intent with a stock leg would go through. |
| `code`, `message` | When it wouldn't, the `451` code and message the proxy would answer with ([refusals](tokenised-stocks.md#refusals)). Otherwise `null`. |
| `country` | The country the server trusts for this request, or `null`. |
| `termsVersion` | `stocks.termsVersion`, or `null` while stocks are off. |
| `expiresAt` | When `eligible` is true, the time the attestation expires (ISO 8601). Otherwise `null`. |

### `POST /stocks/attest`

The user confirms the statements:

```json
{ "termsVersion": "2026-11-01", "statements": ["not-us-person", "permitted", "risks", "own-decision"] }
```

`termsVersion` must be the current one. `statements` must hold the four
ids, each once, and the body no other key. The answer:

```json
{
  "attestation": "<payload>.<signature>",
  "country": "DE",
  "termsVersion": "2026-11-01",
  "expiresAt": "2026-12-02T09:30:00.000Z"
}
```

The payload is base64url JSON: a format version (`1`), the terms version,
the country and the time of issue in Unix seconds. The signature is
base64url HMAC-SHA256 under `EXCLIP_ATTESTATION_SECRET`, over the payload and
a digest of the statements' wording. The attestation counts for 30 days,
for that country and those terms, on any server with the same secret. The
server keeps no copy.

The country checks come first, then the body:

| Status | Code | When |
|---|---|---|
| 400 | `BAD_BODY` | The body isn't a JSON object with a string `termsVersion`, or it has another key |
| 400 | `STATEMENTS_REQUIRED` | `statements` isn't exactly the four ids |
| 409 | `TERMS_CHANGED` | `termsVersion` isn't the current one. The app fetches the new terms. |
| 451 | `STOCKS_DISABLED`, `COUNTRY_UNKNOWN` or `COUNTRY_RESTRICTED` | As in the check |

## The passkey wallet's routes

These routes store and return the passkey wallet's encrypted backups. Every
read and write is authorised by WebAuthn against the stored public key. The
design is in [the embedded wallet](embedded-wallet.md); this section is the
wire format.

Before any route runs:

- With `features.embeddedWallet` off, every route answers `404 NOT_FOUND`.
- A request whose `Origin` isn't the wallet origin answers
  `403 FORBIDDEN`. So does a `POST` with no `Origin` at all. Browsers always
  send it on a `POST`, so only scripts and other sites are refused.
- Every answer carries `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`.
- Bodies must have exactly the keys listed below. An unknown key is
  `400 BAD_REQUEST`. WebAuthn fields are checked for shape and length before
  the WebAuthn library sees them.

`<registration>` and `<assertion>` below are the JSON forms of a WebAuthn
registration and assertion (`RegistrationResponseJSON` and
`AuthenticationResponseJSON`). `<backup>` is the encrypted vault backup in
base64url: 77 bytes to 16 KB once decoded, starting with `CLPB` and format
version 1.

### `POST /wallet/challenge`

```json
{ "purpose": "register" }
```

`purpose` is `register`, `fetch`, `append` or `retire`. The answer:

```json
{ "challenge": "<43 base64url characters>", "rpId": "wallet.example.org", "timeoutMs": 120000 }
```

A challenge is 32 random bytes. It works once, for two minutes, and only for
the purpose it was issued for.

### `POST /wallet/credentials`

Registers a passkey and stores its first backup.

```json
{ "response": "<registration>", "backup": "<backup>" }
```

The server checks the registration against the wallet origin and its host
as the relying-party ID, requires user verification, and accepts only ES256
and EdDSA keys. `201`:

```json
{ "version": 1, "backedUp": true, "deviceType": "multiDevice" }
```

`backedUp` and `deviceType` are what the authenticator reported: whether the
passkey syncs to other devices. When it doesn't, the wallet warns that the
passkey lives only on this device.

When the first upload failed, the wallet can retry later with the original
registration and a fresh assertion by the same passkey, made on a new
`register` challenge:

```json
{ "response": "<registration>", "backup": "<backup>", "assertion": "<assertion>" }
```

New passkeys count against `wallet.dailyNewPasskeys`, per UTC day across all
users. Past it, registrations answer `429 SIGNUPS_PAUSED` until the next
day.

### `POST /wallet/backup/fetch`

```json
{ "response": "<assertion>" }
```

The assertion must be made on a `fetch` challenge. The answer holds every
stored version, newest first, up to `wallet.maxBackupVersions`:

```json
{ "backups": [{ "version": 3, "backup": "<backup>" }, { "version": 2, "backup": "<backup>" }] }
```

The wallet tries them in that order and keeps the first one that opens.

### `POST /wallet/backup`

```json
{ "response": "<assertion>", "backup": "<backup>" }
```

The assertion must be made on an `append` challenge. Adds a new version and
answers `201` with `{ "version": 4 }`. Versions are only ever added: nothing
is overwritten, and nothing is deleted to make room. A passkey that already
has `wallet.maxBackupVersions` versions answers `409 BACKUP_FULL`.

### `POST /wallet/credentials/retire`

```json
{ "response": "<assertion>" }
```

The assertion must be made on a `retire` challenge. The passkey stops
working for every route at once. Its rows are kept for 30 days, then deleted
the next time a new passkey registers:

```json
{ "retired": true, "purgeAfterDays": 30 }
```

### Wallet errors

| Status | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Wrong keys, a malformed field or an unknown purpose |
| 401 | `NOT_VERIFIED` | The passkey, challenge, origin, relying-party ID, user verification or sign count didn't check out |
| 403 | `FORBIDDEN` | Wrong or missing `Origin` |
| 409 | `CONFLICT` | The passkey already exists, or two requests raced |
| 409 | `BACKUP_FULL` | No room for another backup version |
| 413 | `BACKUP_INVALID` | A backup that is too large or not a wallet backup |
| 429 | `SIGNUPS_PAUSED` | Today's new-passkey allowance is used up |
| 503 | `UNAVAILABLE` | The database or the shared store couldn't answer |

The messages are generic on purpose. A refusal never says which check
failed, and the server logs nothing about the request: no body, no
credential ID, no address.

## Anything else

A path under `/api` that matches no route answers
`404 { "error": { "code": "NOT_FOUND", "message": "API route not found." } }`.
An error that escapes a route answers with one of these, and never with its
own message:

| Status | Code |
|---|---|
| 400 | `INVALID_REQUEST` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 429 | `RATE_LIMITED` |
| other 4xx | `REQUEST_FAILED` |
| 5xx | `INTERNAL_ERROR` |

A `5xx` is logged with its stack, with the SODAX key cut out of it.
