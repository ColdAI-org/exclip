# Configuration

ExClip reads one file, `exclip.config.ts`, at the repository root. Start
from the example:

```sh
cp exclip.config.example.ts exclip.config.ts
```

The copy is git-ignored, so your keys stay out of commits. Every setting is
optional, and one you leave out takes the default shown below. The types and
the validation are in `packages/config/src/index.ts`.

The file is checked when the server starts and when the app and the wallet
are built. An unknown setting (a typo) or an invalid value stops the start or
the build, with a list of every problem. ExClip does not run with a fee, an
origin or a switch that nobody asked for.

Node 24 loads the file as it is. Keep to plain values and type annotations:
no enums or namespaces.

## Who reads what

| Part | When | What it gets |
|---|---|---|
| `apps/server` | at start | everything, including the credentials |
| `apps/web` | at build, and in `pnpm dev` | the brand, the app origin and the wallet origin |
| `apps/wallet` | at build, and in `pnpm dev` | the app origin it answers, its own origin, the brand name, the operator, the deposit limit and whether tokenised stocks are on |

A browser bundle never gets a credential. The builds take a projection of the
public settings (`webBuildConfig` and `walletBuildConfig`), picked field by
field, and a test checks that no secret can reach them. After you change the
brand, the origins, `wallet.unbackedLimitUsd` or `stocks.enabled`, rebuild.
The fee rate, the feature switches, the backup limits and the other stock
settings need only a server restart. A new fee receiver also needs a change
to `apps/wallet/fee-receivers.json` and a wallet rebuild (see
[`fees`](#fees)).

## `sodax`

| Setting | Default | Meaning |
|---|---|---|
| `sodax.apiKey` | none | Your SODAX API key. Only the server reads it, and it never sends it to a browser. Without a key the app loads, but quotes answer "Trading isn't connected". `SODAX_API_KEY` overrides it. |

## `fees`

| Setting | Default | Meaning |
|---|---|---|
| `fees.partnerFeeBps` | `0` | Partner fee in basis points, a whole number from 0 to 100 (100 = 1 %, the maximum). SODAX takes it from each swap and pays it to the receiver. |
| `fees.receiver` | `null` | The EVM address that receives the fee. It is required when `partnerFeeBps` is above 0. |

ExClip charges no fee unless you set one. The server pins the configured fee
on every quote and intent it forwards, and drops any fee the browser sends.

To charge a fee, you need all three of these:

1. Set `fees.partnerFeeBps` and `fees.receiver`.
2. Add the receiver to `apps/wallet/fee-receivers.json`, in a reviewed
   commit, and rebuild the wallet. The passkey wallet signs a swap that
   carries a fee only when the receiver is on that list. The list ships empty,
   so the wallet refuses every swap with a fee: it fails closed.

   ```json
   {
     "$comment": "…",
     "receivers": ["0xYourReceiverAddress"]
   }
   ```

3. Check what charging a fee means where you operate. Taking a fee on swaps
   can make you a provider of a financial service, and that is your
   responsibility as the operator.

## `origins`

| Setting | Default | Meaning |
|---|---|---|
| `origins.app` | `https://exclip.example.com` | Where the app is served. |
| `origins.wallet` | `https://wallet.example.com` | Where the passkey wallet popup is served. |

Each value is an exact origin: `https://` and a lower-case host, with no
path, no trailing slash and no default port.

The wallet needs a host of its own. Passkeys belong to the wallet host, so a
page on that host or below it could use them. The config refuses an app
origin on the wallet's host or on a subdomain of it. The wallet may be a
subdomain of the app's domain (`https://example.org` with
`https://wallet.example.org` is fine), and two sibling hosts work too.

`pnpm dev` ignores these values and always uses `http://localhost:5173` for
the app and `http://localhost:5311` for the wallet.

The defaults are reserved example domains that nobody can serve. A build
left on them offers the passkey wallet nowhere, so set real origins before you
deploy.

## `brand`

| Setting | Default | Meaning |
|---|---|---|
| `brand.name` | `"ExClip"` | Product name in the app, the wallet window and passkey prompts. Plain text, at most 40 characters. |
| `brand.operator` | `""` | Who runs this deployment, shown in the footer. Plain text, at most 80 characters. |
| `brand.logo` | `"/logo.svg"` | A file in `apps/web/public`, written as a path like `/my-logo.svg`, or an `https://` URL. |
| `brand.colors.accent` | `#00B4F0` | Buttons (with dark text on them), focus rings and links on the dark canvas. |
| `brand.colors.accentHover` | `#38C8FF` | Hover and pressed states. |
| `brand.colors.accentInk` | `#0077B6` | Small text, links and focus rings on light surfaces. |
| `brand.termsUrl` | `null` | Your terms of use (`https://`), linked from the footer. |
| `brand.privacyUrl` | `null` | Your privacy notice (`https://`), linked from the footer. |

Rebrand freely; keep the "Powered by ExClip" credit. "ExClip" and its logo
are trademarks of ColdAI LLC, and the licence does not cover them (see
[NOTICE](../NOTICE)). If you run ExClip for other people, set your own
`brand.name` and `brand.logo`. The footer of the app and of the wallet
window ends with the credit whatever the brand, and no setting removes it
([the credit](branding.md#the-credit)).

Colours are `#RRGGBB`, and the config checks only that format. The canvas
is near-black (`#07080A`) and buttons put dark text (`#03141C`) on the
accent, so check contrast when you change them:

- `accent` and `accentHover` need a contrast ratio of at least 4.5:1 against
  `#07080A` and against `#03141C`. Pick a light, saturated colour.
- `accentInk` needs at least 4.5:1 against white and against the light
  canvas, `#F6F7F9`.

[The contrast rule](branding.md#the-contrast-rule) gives the defaults'
ratios, and `pnpm run contrast` checks yours.

Icons follow the logo:

- **The app's tab icon** is `brand.logo`.
- **Home-screen icons.** With ExClip's own name and logo (`brand.name`
  `"ExClip"` and `brand.logo` `"/logo.svg"`), the build lists ExClip's PNG
  icons in the web app manifest (`/manifest.webmanifest`) and adds an Apple
  touch icon. With any other name or logo, the manifest lists your logo as its
  only icon, and the page names no ExClip icon. A square logo works best.
- **The wallet window's tab icon** is `brand.logo` too, inlined into the
  wallet page as a `data:` URL, because the wallet's CSP loads images only
  from itself. That works for a `.svg`, `.png`, `.ico` or `.webp` file in
  `apps/web/public`. If the logo is such a file and it doesn't exist, the
  wallet build stops. An `https://` logo, or another file type, leaves the
  wallet window with the browser's default icon.

The [branding guide](branding.md) walks through a full rebrand.

## `features`

| Setting | Default | Meaning |
|---|---|---|
| `features.trading` | `true` | Build trades. When it is off, prices, quotes and order status keep working, and every route that builds a transaction is refused. |
| `features.embeddedWallet` | `true` | Offer the passkey wallet and serve its backup API. When it is off, the app shows only browser wallets, and the wallet's server routes are switched off. |

The server reads both switches at start, so turning one off needs a restart
but no rebuild. `EXCLIP_DISABLE_TRADING` and `EXCLIP_DISABLE_EMBEDDED_WALLET`
can switch them off without editing the file.

## `wallet`

| Setting | Default | Range | Meaning |
|---|---|---|---|
| `wallet.unbackedLimitUsd` | `100` | 0–1,000,000 | Deposit limit, in US dollars, for a passkey wallet that isn't backed up yet. Backed up means the recovery phrase was saved and checked, or the passkey has a server backup and the user confirmed that it syncs, or two passkeys each have one. The app's Receive sheet and the popup state the limit, and the popup hides the deposit address when the app reports holdings at or above it. The wallet build bakes in its own copy, so rebuild after you change it. |
| `wallet.maxBackupVersions` | `50` | 1–1,000 | Encrypted backup versions kept per passkey. Appends past it are refused, and nothing is deleted to make room. |
| `wallet.dailyNewPasskeys` | `2000` | 1–1,000,000 | New passkeys accepted per UTC day across all users. After that, sign-ups pause until the next day. |

## `server`

| Setting | Default | Meaning |
|---|---|---|
| `server.port` | `8080` | Port the server listens on. `PORT` overrides it. |
| `server.databaseUrl` | `null` | Postgres for the wallet's encrypted backups, and for rate-limit counters and one-time challenges when there is no Redis. Apply `apps/server/migrations` first. `DATABASE_URL` overrides it. |
| `server.redisUrl` | `null` | Redis for rate-limit counters and one-time challenges. `REDIS_URL` overrides it. |
| `server.allowMemoryStore` | `false` | `pnpm start` refuses to run on in-memory storage, where backups would vanish on restart, unless this is `true`. `pnpm dev` always allows memory, and uses it for whatever has no database or Redis. |
| `server.trustProxy` | `0` | Behind a reverse proxy or load balancer, the number of proxy hops to trust for the client address, from 0 to 10. Rate limits count per address, so set this correctly. |
| `server.serveStatic` | `false` | Serve the built app and wallet from this server, choosing by the request's host name. See [self-hosting](self-hosting.md). |
| `server.coingeckoApiKey` | `null` | A CoinGecko Pro key for market data. Without one, the public API is used. `COINGECKO_API_KEY` overrides it. |

## `stocks`

Tokenised stocks, off unless you switch them on. Before you do, read
[tokenised stocks](tokenised-stocks.md) and take legal advice: they are
restricted, or banned, in many countries, and offering them is your
decision and your responsibility.

| Setting | Default | Meaning |
|---|---|---|
| `stocks.enabled` | `false` | Offer the tokenised stocks SODAX lists. When it is on, the server won't start without `EXCLIP_EDGE_SECRET`, and an `EXCLIP_ATTESTATION_SECRET` of at least 32 characters. |
| `stocks.countryHeader` | `null` | The header your reverse proxy sets to the visitor's country code, such as `cf-ipcountry`: letters, digits and single hyphens. It is required when stocks are on, and it counts only on a request that also carries the edge secret. |
| `stocks.blockedCountries` | `[]` | Countries to refuse on top of [ExClip's baseline](tokenised-stocks.md#exclips-baseline), as ISO 3166-1 alpha-2 codes such as `"GB"`. Nothing removes a country from the baseline. |
| `stocks.termsVersion` | `"1"` | The version of what users confirm: 1 to 32 letters, digits, dots, hyphens or underscores. Change it, and everyone confirms again. |

The server reads these at start. The app needs no rebuild, because it
learns whether stocks are on from `/api/exclip/config`. The passkey wallet
reads `stocks.enabled` when it is built, so rebuild it after you switch
stocks on or off. `EXCLIP_DISABLE_STOCKS` switches them off without editing
the file.

## Environment variables

Environment variables override the file for credentials and the port. They
also hold the two secrets that tokenised stocks need, which the file has no
setting for. Three of them switch features off. They can never switch
anything on, so they work as an emergency brake that needs no code change.
Empty values are ignored.

| Variable | Overrides | Notes |
|---|---|---|
| `SODAX_API_KEY` | `sodax.apiKey` | Prefer this in production, so the key never sits in a file. |
| `COINGECKO_API_KEY` | `server.coingeckoApiKey` | |
| `DATABASE_URL` | `server.databaseUrl` | |
| `REDIS_URL` | `server.redisUrl` | |
| `PORT` | `server.port` | |
| `EXCLIP_DISABLE_TRADING` | `features.trading` | `1`, `true`, `on` or `yes` switches trading off. |
| `EXCLIP_DISABLE_EMBEDDED_WALLET` | `features.embeddedWallet` | `1`, `true`, `on` or `yes` switches the wallet off. |
| `EXCLIP_DISABLE_STOCKS` | `stocks.enabled` | `1`, `true`, `on` or `yes` switches tokenised stocks off. The passkey wallet reads it when it is built. |
| `EXCLIP_EDGE_SECRET` | | Required when stocks are on: what your reverse proxy sends in `x-exclip-edge-secret`, so that its country header can be trusted. |
| `EXCLIP_ATTESTATION_SECRET` | | Required when stocks are on, at least 32 characters: the key that signs users' self-certifications. Only the server needs it. |
| `EXCLIP_CONFIG` | | Path of a config file to read instead of `exclip.config.ts`, relative to the repository root. The server refuses to start if that file doesn't exist. |
