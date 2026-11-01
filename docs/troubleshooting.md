# Troubleshooting

Find the message you see, then follow the fix. The server writes its
messages to standard error, each starting with `[exclip]`. The app and the
wallet window show theirs on screen. For anything else, open the browser's
developer tools and look at the console and the network requests.

Where a message below says "ExClip", yours says your `brand.name`.

## The server won't start

### The configuration can't be used

```text
[exclip] the configuration can't be used:
  - unknown setting fees.partnerFee
  - fees.receiver is required when fees.partnerFeeBps is above 0
```

The server checks `exclip.config.ts` before it does anything else, and
lists every problem at once. Each line names a setting. Fix them all, then
start again. `pnpm build` runs the same checks and stops on the same lines.

| Problem | What to do |
|---|---|
| `unknown setting …` | A typo, or a setting this version doesn't have. Compare your file with `exclip.config.example.ts`. |
| `origins.wallet needs a host of its own: …` | Put the wallet on a host that the app isn't on or under, such as `wallet.example.org` beside `example.org` ([origins](configuration.md#origins)). |
| `fees.receiver is required when fees.partnerFeeBps is above 0` | Set the receiver, or set the fee back to `0` ([turn a fee on](fees.md#turn-a-fee-on)). |
| `… must be a #RRGGBB colour`, `… must be an https URL or null` and the like | The message gives the format. [Configuration](configuration.md) lists each setting. |
| `stocks.countryHeader is required when stocks.enabled is true: …` | Set the header your reverse proxy puts the visitor's country in ([the reverse proxy](tokenised-stocks.md#the-reverse-proxy)), or set `stocks.enabled: false`. |
| `EXCLIP_EDGE_SECRET is required when stocks.enabled is true: …` or `EXCLIP_ATTESTATION_SECRET must be at least 32 characters …` | Put both secrets in the server's environment ([switching them on](tokenised-stocks.md#switching-them-on)), or set `stocks.enabled: false`. Only the server checks these; the build doesn't need them. |
| `EXCLIP_CONFIG names …, which does not exist` | The path is relative to the repository root, not to the folder you're in. |
| `… must \`export default\` the configuration` | Keep the example's `export default {` at the top of the settings. |

### Production needs shared storage

```text
[exclip] production needs shared storage, but passkey wallet backups would
be kept in this process's memory (lost on restart and not shared between
processes). …
```

`pnpm start` won't keep state in one process's memory. Give it storage:

- **With the passkey wallet**, the default: set `DATABASE_URL` and apply
  the migrations ([prepare the database](self-hosting.md#3-prepare-the-database)).
  Postgres then holds the backups, and the shared state too unless you also
  set `REDIS_URL`.
- **Without it** (`features.embeddedWallet: false`): `REDIS_URL` or
  `DATABASE_URL` is enough.
- **For a single-process trial only**, set `server.allowMemoryStore: true`.
  A restart loses everything, wallet backups included.

### The port can't be used

```text
[exclip] can't listen on port 8080: another process is using it. Stop that
process, or set PORT to a free port.
```

Another server, often an ExClip you started earlier, already listens on
that port. Find it with `lsof -i :8080`, then stop it, or start this one
with `PORT` set to a free port. If it says `permission denied` instead,
the port is probably below 1024, which usually needs extra privileges: use
a higher port, and let the reverse proxy take 80 and 443
([run the server](self-hosting.md#4-run-the-server)).

### A Node.js error

| Error | What to do |
|---|---|
| `ERR_UNKNOWN_FILE_EXTENSION` for a `.ts` file | Use Node 24 or later, the version in `.nvmrc`. The server runs its TypeScript files directly, and older versions may not. |
| `ERR_MODULE_NOT_FOUND`, such as `Cannot find package '@exclip/config'` | Run `pnpm install` at the repository root. |
| `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` | A workspace package was copied into `node_modules` instead of linked, and Node won't run TypeScript from there. Deploy the repository with pnpm's links in place ([self-hosting](self-hosting.md)). |

### It starts, but nothing answers

- **`[exclip] warning: server.serveStatic is on but … is missing: run pnpm build`.**
  The server answers the API but has no pages to serve. Run `pnpm build`
  on that machine, or copy both `dist` folders there.
- **`[exclip] warning: origins are still the example placeholders …`.**
  Set `origins` and rebuild both apps. A build made for the example origins
  offers the passkey wallet nowhere.

## The build fails or warns

`pnpm build` checks the configuration first
([above](#the-configuration-cant-be-used)), then each app's own rules:

| Message | What to do |
|---|---|
| `brand.logo is /acme.svg, but apps/web/public/acme.svg doesn't exist` | Put the file in `apps/web/public`, or fix the path ([the logo](branding.md#the-logo)). |
| `fee-receivers.json: not an address: …`, `"receivers" must be an array` or `duplicate receiver` | Fix `apps/wallet/fee-receivers.json`: an array of addresses, each `0x` and 40 hex digits, each listed once. |
| `inline <script> in index.html`, `inline style in index.html` or `external URL in index.html` | Someone edited `apps/wallet/index.html`. The wallet's CSP runs no inline code, and its page loads files only from its own origin, so put the code in `apps/wallet/src`. |
| `index.html has an inline <script>, which the CSP (script-src 'self') blocks`, and the app's other `index.html` checks | The same for `apps/web/index.html`. |
| `FATAL ERROR: Ineffective mark-compacts near heap limit` … `JavaScript heap out of memory` | The app's build needs about 2.6 GB of heap, and on a machine with less than 16 GB of memory Node allows about 2 GB by default. Run `NODE_OPTIONS=--max-old-space-size=4096 pnpm build`, with about 4 GB of memory free. |

The wallet build also warns about two settings it accepts but that won't
work as you meant:

- `exclip.config.ts: origins are still the examples (…), which nobody can
  serve: this build works nowhere.` Set `origins.app` and `origins.wallet`.
- `exclip.config.ts: the partner fee goes to 0x…, which
  apps/wallet/fee-receivers.json does not list: the wallet will refuse
  every swap that carries a fee.` Add the receiver in a reviewed commit
  and rebuild the wallet, or set the fee to `0`
  ([why it fails closed](fees.md#why-it-fails-closed)).

The builds also print notices about the libraries they bundle, such as
modules "externalized for browser compatibility", `/*#__PURE__*/` comments
that Rollup removes, and "Some chunks are larger than 500 kB". They come
from those libraries, not from your settings: a build with no config at
all prints them too. Leave them.

## Quotes and trading

The app turns the server's errors into short messages:

| The app says | Why | What to do |
|---|---|---|
| "Trading isn't connected on this server yet." | The server has no SODAX key, so every SODAX route answers 503 `SODAX_NOT_CONFIGURED`. The start-up log says `SODAX API key: not set`. | Set `SODAX_API_KEY` and restart. |
| "Trading is paused on this server. Quotes still work." | Trading is switched off, by `features.trading: false` or `EXCLIP_DISABLE_TRADING`. The trade button reads "Trading is paused". | Switch it back on and restart, if that wasn't meant. |
| "The exchange network is busy. Trying again in a few seconds usually works." | SODAX answered 429. | Wait. If it keeps happening, ask SODAX about your key's limits. |
| "Too many requests. Try again shortly." | ExClip's own rate limit for this client ([rate limits](api.md#rate-limits)). | If many people see it at once, check `server.trustProxy` ([behind a proxy](#behind-a-proxy-or-cdn)). |
| "The exchange network had a problem. Try again." | Any other `5xx`. Usually SODAX failed or didn't answer (502 `SODAX_UPSTREAM`). | Check the server's log ([monitoring](self-hosting.md#monitoring)). |
| "Something went wrong. Try again." | An answer that isn't the server's, such as an HTML error page. | Check that `/api/exclip/*` on the app's host reaches the server ([serve the two origins](self-hosting.md#5-serve-the-two-origins)). |
| "Your country couldn't be determined, and tokenised stocks are only offered when it can be. …" | A trade with a tokenised stock, and no country the server can trust: 451 `COUNTRY_UNKNOWN`. | If every visitor sees it, the server isn't getting the country header with the right edge secret ([check the proxy](tokenised-stocks.md#check-the-proxy)). |

With tokenised stocks on, the stock check has three other refusals, each
with its own message ([refusals](tokenised-stocks.md#refusals)).

When a trade with a browser wallet fails:

| The app says | What it means |
|---|---|
| "No route between these assets right now." | SODAX found no way to fill this swap. Try another amount or pair, or try again later. |
| "Your transaction is on chain but the relay is slow. Don't resend: we'll keep tracking it." | The transaction went through. Don't sign it again. |
| "You declined the request in your wallet." | The wallet reported a refusal. |
| "The wallet or network returned an error. Nothing was sent." | Any other error from the wallet or the network. |

## Prices and charts

- **"Prices are unavailable"** on the home page. The server couldn't get
  market data from CoinGecko. It keeps serving the last good list for 15
  minutes, then reports the data as unavailable, and asks again at most
  every 15 seconds. Trading still works, because quotes come from SODAX.
  The public CoinGecko API is rate-limited. A Pro key in
  `COINGECKO_API_KEY` gets higher limits.
- **"Chart unavailable right now."** on an asset's page. The chart request
  failed, or the asset has no CoinGecko ID
  ([add an asset](development.md#add-an-asset)).

## The passkey wallet

### The app doesn't offer it

The connect sheet shows only browser wallets, with no "Create wallet with
a passkey", when any of these is true:

- **The page isn't on the build's exact app origin.** A production build
  offers the passkey wallet only on `origins.app`: not on `www.` when you
  set the bare domain (or the other way round), not on another port and
  not on a preview address. Redirect the other names to `origins.app`.
- **The server has it switched off.** `/api/exclip/config` answers
  `"embeddedWallet":false`. Check `features.embeddedWallet` and
  `EXCLIP_DISABLE_EMBEDDED_WALLET`.
- **The server names another wallet.** `/api/exclip/config` gives a
  `walletOrigin` other than the one the app was built with, and the app
  trusts neither. Build and run with the same configuration, and the same
  `EXCLIP_CONFIG`.
- **`/api/exclip/config` doesn't reach the server.** It must answer JSON,
  as in the [smoke checks](self-hosting.md#smoke-checks).
- **The origins are still the examples.** Such a build offers the wallet
  nowhere.

When the wallet is offered but a trade says "Use a browser wallet for this
network", one side of the trade is on a network the passkey wallet doesn't
sign on. It signs on its 14 EVM networks only
([what it can do](wallet.md#what-it-can-do)).

### The wallet window doesn't open or closes early

| You see | Why | What to do |
|---|---|---|
| "Your browser blocked the wallet window. Allow pop-ups for this site and try again." | The browser's pop-up blocker. | Allow pop-ups for the app's site. |
| "You closed the wallet window." | The window closed before it answered. | Open it again from the app. |
| In the window: "Open the wallet from ExClip." | The window has no link back to the app. That's normal when you open the wallet's address yourself. When the app opened it, a proxy or CDN probably changed the `Cross-Origin-Opener-Policy` header, which cuts that link. | The wallet host must send `unsafe-none` and the app `same-origin-allow-popups`. Compare with `pnpm --filter @exclip/config run headers`. |
| In the window: "ExClip didn't send a request in time." | The window waited 60 seconds for a request from the app origin it was built for, and none came. Usually the app and the wallet were built from different configurations or releases. | Rebuild both from the same configuration, and deploy them together. |
| In the window: "Your browser can't secure an embedded wallet. Use Chrome, Safari 18+, Edge, or the Clip Wallet extension." | The browser, or the passkey's provider, doesn't support the PRF extension. | Use another browser or password manager, or a browser wallet. |
| In the window: "There's no ExClip wallet in this browser. Sign in first." | This browser holds no wallet yet. | Choose "Sign in with passkey". The wallet restores itself from its backup ([get back in](wallet.md#get-back-in)). |

### The wallet window shows a service error

The window has its own text for each answer from the server's wallet API.
It never shows the server's words.

| The window says | Why | What to do |
|---|---|---|
| "The wallet service isn't available." | The wallet API answered 404. The wallet is switched off on the server, or `/api/exclip/wallet/*` on the wallet host doesn't reach the server. | Check `/api/exclip/config`, then your routing ([option B](self-hosting.md#option-b-your-own-web-server-or-cdn)). |
| "The wallet service refused the request." | 403: the request's `Origin` header wasn't `origins.wallet`. | Pass `Origin` through to the server unchanged. |
| "The wallet service returned something unexpected." | The answer wasn't the API's, such as the wallet's `index.html` from a static host. | Send `/api/exclip/wallet/*` on the wallet host to the server. |
| "The wallet service couldn't be reached. Check your connection." | No answer at all, or none within 20 seconds. | Check the connection, then the server. |
| "That passkey couldn't be verified. Try again." | The server didn't accept the passkey's answer. The passkey may be unknown to it (after a database was lost or reset) or retired, or the server's `origins.wallet` isn't the address the window runs on. | If every sign-in fails, check that the server and the wallet build use the same `origins.wallet`. |
| "Too many attempts. Wait a minute and try again." | 429. A client may ask for 30 challenges and make 20 writes a minute. | If many people see it, check `server.trustProxy`. |
| "The wallet service returned an error. Try again." | Any other error. A 503 here usually means the shared store is down: the wallet's routes then refuse requests rather than run without limits. | Look in the log for `[exclip] rate limits (` and the `EXCLIP_WALLET_` codes. |
| "New wallets are paused for today. Try again tomorrow." | Today's allowance of new passkeys (`wallet.dailyNewPasskeys`) is used up. The log says `EXCLIP_WALLET_SIGNUPS_PAUSED`. | If the sign-ups are real, raise the allowance and restart. |
| "This passkey has no room for another backup. Add a new passkey in Manage." | The passkey has `wallet.maxBackupVersions` backups. The window writes one per passkey, so something else may be writing. The log says `EXCLIP_WALLET_BACKUP_FULL`. | Find out what before you raise the limit. |

## Behind a proxy or CDN

- **Everyone hits the rate limit at once.** The server sees the proxy's
  address for every user. Set `server.trustProxy` to the number of proxies
  in front of it
  ([proxies and client addresses](self-hosting.md#proxies-and-client-addresses)).
- **The wallet host shows the app**, with `server.serveStatic`. The server
  picks the site by host name, so the proxy must pass the original `Host`
  header ([option A](self-hosting.md#option-a-the-server-serves-both-builds)).
- **A blank page, and the console says the Content Security Policy refused
  a script.** Something added a script to the page, such as a CDN's script
  optimiser, email obfuscation, or an analytics or consent snippet. Both
  origins run scripts from themselves only. Turn the feature off for both
  hosts, and don't loosen the CSP.

## Read the server's log

The start-up lines say what the server runs with:

```text
[exclip] production on port 8080; configuration from /srv/exclip/exclip.config.ts
[exclip] storage: rate limits and challenges in Postgres; passkey wallet backups in Postgres
[exclip] SODAX API key: set
[exclip] trading on; partner fee none
[exclip] tokenised stocks: off
```

[Monitoring](self-hosting.md#monitoring) lists the alert codes the server
logs while it runs, and what each one means.

## Still stuck

Open an issue with the server's start-up lines, the message you see and the
steps that lead to it. Leave out keys and connection URLs. Report a security
problem privately, as [SECURITY.md](../SECURITY.md) explains.
