# Self-hosting

This page takes you from a clone to a public deployment. It covers building,
the database, running the server, serving the two origins with the right
headers, opening in stages, and turning things off again.

Read [operator responsibility](../README.md#operator-responsibility) first.
ExClip trades on live networks only, so try every flow with small amounts
before real users arrive.

## What you run

| Part | Built from | Where |
|---|---|---|
| The app | `apps/web/dist` (static files) | `origins.app`, for example `https://swap.example.org` |
| The wallet popup | `apps/wallet/dist` (static files) | `origins.wallet`, a host that serves nothing else, for example `https://wallet.example.org` |
| The server | `apps/server` (Node 24, no build step) | behind both origins, answering `/api/exclip/*` |
| Postgres | `apps/server/migrations` | the passkey wallet's encrypted backups, and the server's shared state when there is no Redis |
| Redis (optional) | | rate-limit windows and one-time passkey challenges |

The server keeps two kinds of state:

- **Shared state:** rate-limit windows, one-time passkey challenges and the
  daily new-passkey counter. This lives in Redis if `REDIS_URL` is set,
  otherwise in Postgres if `DATABASE_URL` is set, otherwise in memory.
- **Wallet backups:** passkey public keys and encrypted backups. These live
  in Postgres, or in memory without a database.

Memory belongs to one process and is lost on restart. `pnpm start` therefore
refuses to run on memory, unless you set `server.allowMemoryStore: true` for
a single-process trial. A deployment with the passkey wallet needs Postgres.
Without the wallet (`features.embeddedWallet: false`), Redis or Postgres for
the shared state is enough.

## 1. Configure

```sh
cp exclip.config.example.ts exclip.config.ts
```

Then edit `exclip.config.ts`:

- `origins.app` and `origins.wallet`: your two `https` origins. The wallet
  needs a host of its own, and the config refuses an app origin on the
  wallet's host or below it.
- `brand`: your product name, who runs it (`operator`), your logo, and links
  to your terms and privacy notice. "ExClip" and its logo are not licensed
  for your deployment (see [NOTICE](../NOTICE)).
- `fees`: leave `partnerFeeBps` and `rate` at `0`, and `split` unset, for a
  first deployment.
- `server.trustProxy`: the number of proxies in front of the server (see
  [Proxies and client addresses](#proxies-and-client-addresses)).

Keep credentials out of the file and pass them as environment variables:
`SODAX_API_KEY`, `DATABASE_URL`, `REDIS_URL` and `COINGECKO_API_KEY`.
[configuration.md](configuration.md) lists every setting.

## 2. Build

```sh
pnpm install --frozen-lockfile
pnpm build
```

This writes `apps/web/dist` and `apps/wallet/dist`. Each build takes only
the public settings it needs from `exclip.config.ts`, and never a credential.

The app's build needs about 4 GB of memory, and more heap than Node allows
by default on a machine with less than 16 GB. There, build with
`NODE_OPTIONS=--max-old-space-size=4096 pnpm build`.

- A production wallet build stops if an origin isn't an exact `https`
  origin, or if the app origin shares the wallet's host.
- It warns while the origins are still the examples, and when a fee goes
  where `apps/wallet/fee-receivers.json` doesn't let it: a partner fee's
  receiver, or a fee split's split, that the file doesn't list.
- Both builds, and the server, stop if `fee-receivers.json` is broken.
- Rebuild both apps after you change `origins`, `brand` or
  `wallet.unbackedLimitUsd`. After a change to `fee-receivers.json`,
  rebuild the wallet, and restart the server, which checks a fee split
  against the file when it starts.

Build the wallet in CI from a reviewed commit, not on a laptop. Record the
hash of every file in `apps/wallet/dist`, and deploy exactly those files
([release controls](embedded-wallet.md#release-controls)).

## 3. Prepare the database

Apply the migrations in order, before the server starts:

```sh
psql "$DATABASE_URL" -f apps/server/migrations/0001_wallet.sql
psql "$DATABASE_URL" -f apps/server/migrations/0002_kv.sql
```

They create tables, indexes and, in `0001_wallet.sql`, a trigger that keeps
backup versions append-only. Both can be applied again safely. The server
never changes the schema itself. When you update ExClip, apply any new file
in `apps/server/migrations` before you start the new server.

`0002_kv.sql` is unused while Redis holds the shared state, but applying it
does no harm. The server's database role needs to read, write and delete rows
in these tables, and to use the backups table's id sequence. It doesn't need
to create or change tables.

The wallet tables hold no email addresses, IP addresses or wallet addresses.
The shared-state tables hold rate-limit rows, which contain a client's IPv4
address or IPv6 /64 prefix. A row stops counting after about a minute. It
stays in the table until that client is counted again or a periodic sweep
deletes it. In Redis, a client's entries expire about 65 seconds after its
last counted request.

**Back up the `exclip_wallet_*` tables.** For a user who hasn't saved the
recovery phrase, they are the only way back to the wallet after losing the
device. Back them up regularly and test a restore. The `exclip_kv*` tables
hold short-lived state and need no backup.

If your Postgres provider's backups don't cover this, give ExClip a
database of its own and dump it, leaving out the short-lived rows:

```sh
pg_dump "$DATABASE_URL" --format=custom --exclude-table-data='exclip_kv*' \
  --file="exclip-$(date -u +%F).dump"
```

To test a restore, load a dump into an empty scratch database and count
the backups:

```sh
pg_restore --no-owner --dbname="$SCRATCH_URL" exclip-2026-10-31.dump
psql "$SCRATCH_URL" -c 'SELECT count(*) FROM exclip_wallet_backups'
```

The dumps hold encrypted backups and passkey public keys, not keys or
phrases. Keep them as carefully as the database itself.

## 4. Run the server

```sh
SODAX_API_KEY=… DATABASE_URL=… pnpm start
```

`pnpm start` runs `apps/server` in production mode. At start the server:

1. reads and checks `exclip.config.ts` (or the file named by
   `EXCLIP_CONFIG`), and stops with a list of problems if it isn't valid,
   or if tokenised stocks are on without their two secrets;
2. chooses its storage, and stops if production would run on memory. It
   doesn't connect to Postgres or Redis, or check the migrations, before it
   listens (the [smoke checks](#smoke-checks) cover that);
3. listens on `server.port` (`PORT`), and stops if it can't, say because
   another process holds the port. Then it logs what it runs with: the
   storage, whether the SODAX key is set, trading on or off, the fee, and
   whether tokenised stocks are on.

Without a SODAX key the server still starts. It answers `/config` and market
data, and SODAX requests answer 503 until a key is set.

The server speaks plain HTTP. Put it behind a reverse proxy or load balancer
that terminates TLS. Run it under a process manager or as a container, and
stop it with `SIGTERM`: requests in flight get up to 10 seconds to finish.
Several processes can share one Postgres or Redis. Each process keeps its own
short cache of SODAX token lists and market data.

Whichever way you run it, keep the repository's layout. Node runs the
server's TypeScript and the workspace packages straight from their folders,
through the links `pnpm install` makes
([development](development.md#the-repository)). Don't copy the server out on
its own, and don't flatten `node_modules`.

### On a Linux host with systemd

Install Node 24 and pnpm, put the repository in a folder such as
`/srv/exclip` with your `exclip.config.ts`, and build there:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Then add a unit, `/etc/systemd/system/exclip.service`:

```ini
[Unit]
Description=ExClip server
After=network-online.target
Wants=network-online.target

[Service]
User=exclip
WorkingDirectory=/srv/exclip
EnvironmentFile=/etc/exclip/env
ExecStart=/usr/bin/node apps/server/src/index.ts
Restart=on-failure
TimeoutStopSec=15
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

- `exclip` is a user that can read `/srv/exclip` and nothing more. The
  server writes no files.
- `ExecStart` must point at Node 24. `command -v node` prints the path.
  `node apps/server/src/index.ts` is what `pnpm start` runs.
- `/etc/exclip/env` holds the credentials, one `NAME=value` per line
  (`SODAX_API_KEY`, `DATABASE_URL`, `REDIS_URL`, and with tokenised stocks
  on, `EXCLIP_EDGE_SECRET` and `EXCLIP_ATTESTATION_SECRET`). Make it
  readable by root only: systemd reads it before it switches to the
  `exclip` user.
- systemd stops the server with `SIGTERM`, and `TimeoutStopSec` leaves room
  for its 10-second drain.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now exclip
journalctl -u exclip -f
```

### In a container

The repository has no Dockerfile. This one is a starting point, not a file
we test:

```dockerfile
FROM node:24-slim
WORKDIR /app
RUN npm install --global pnpm@12.6.0
COPY . .
RUN pnpm install --frozen-lockfile && NODE_OPTIONS=--max-old-space-size=4096 pnpm build
USER node
EXPOSE 8080
CMD ["node", "apps/server/src/index.ts"]
```

Keep the pnpm version equal to `packageManager` in `package.json`. Add a
`.dockerignore`, so local installs and builds stay out of the image:

```text
.git
**/node_modules
**/dist
```

The image is built with your `exclip.config.ts`, because the build bakes
your origins and brand into the app and the wallet. Keep credentials out of
that file, and pass them when the container starts:

```sh
docker build -t exclip .
docker run -d --name exclip --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -e SODAX_API_KEY -e DATABASE_URL exclip
```

`-e NAME` with no value passes the variable on from your shell, so the key
stays out of your shell history. With tokenised stocks on, add
`-e EXCLIP_EDGE_SECRET -e EXCLIP_ATTESTATION_SECRET`. The image holds the
wallet's build, so build
it in CI from a reviewed commit, as you would the wallet
([release controls](embedded-wallet.md#release-controls)).

### Proxies and client addresses

Rate limits count requests per client address, so the server must see the
real one. Set `server.trustProxy` to the number of proxies between the
internet and the server, for example `1` for one load balancer, or `2` for a
CDN in front of a load balancer.

- Too low, and every user shares the proxy's address and its limit.
- Too high, and a client can choose its own address in `X-Forwarded-For`
  and dodge the limits.

## 5. Serve the two origins

The app reaches the server at `/api/exclip/*` on its own origin. The wallet
popup reaches its backup API at `/api/exclip/wallet/*` on the wallet origin.
Both hostnames must therefore lead to the server for those paths.

Pass the browser's `Origin` header through to the server unchanged. The
wallet API answers 403 to a request with any `Origin` other than
`origins.wallet`, and to a `POST` with no `Origin`.

You can let the server serve the builds, or use your own web server or CDN.

### Option A: the server serves both builds

Set `server.serveStatic: true`, run `pnpm build` on the server's machine (or
copy both `dist` folders there), and send both hostnames to the server. The
server picks the site by the request's host name:

- **The wallet host** gets the wallet page, its files under `/assets/` and
  `/api/exclip/wallet/*`, all with the wallet's headers. Everything else
  there answers 404. Cookies and CORS headers are removed from every response.
- **Any other host** gets the app, with `index.html` for its client-side
  routes, and the rest of `/api/exclip/*`, all with the app's headers. The
  wallet API answers 404 there.

Your proxy must pass the original `Host` header to the server. With nginx,
that is `proxy_set_header Host $host;`. When `server.trustProxy` is above 0,
the server takes the host from `X-Forwarded-Host` if the request has one, so
have your proxy set that header itself (`proxy_set_header X-Forwarded-Host
$host;`) rather than pass on one a client sent.

For example, nginx on the same machine as the server, with
`server.trustProxy: 1` and a certificate that covers both names:

```nginx
server {
  listen 443 ssl;
  server_name swap.example.org wallet.example.org;
  ssl_certificate     /etc/ssl/exclip/fullchain.pem;
  ssl_certificate_key /etc/ssl/exclip/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}

server {
  listen 80;
  server_name swap.example.org wallet.example.org;
  return 301 https://$host$request_uri;
}
```

nginx passes the `Origin` header on unchanged. The server sends each
origin's security headers itself, so add no `add_header` lines for the CSP,
CORS or caching.

### Option B: your own web server or CDN

Serve each build on its own host, and send the API paths to the server:

| Host | Serve | Send to the server |
|---|---|---|
| App | `apps/web/dist`. Page requests for paths that aren't files get `index.html`. | `/api/exclip/*`, except `/api/exclip/wallet/*` |
| Wallet | `index.html` and `/assets/*` from `apps/wallet/dist`, and nothing else | `/api/exclip/wallet/*` |

Every response from each host must carry that origin's headers, API answers
and error pages included. Print the exact list with:

```sh
pnpm --filter @exclip/config run headers
```

The values come from `packages/config/src/headers.ts`, the same definitions
the server uses.

On the wallet host:

- set no cookies and no CORS headers;
- add no analytics, tag manager or other script, and no "edge" HTML
  rewriting. The CSP blocks them, so don't loosen it;
- keep `Cache-Control: no-store` on every response, the files under
  `/assets/` included, as the printed headers say. The popup then downloads
  its code each time it opens, and never runs an older build.

Both origins send HSTS with `includeSubDomains`. If the app is on your apex
domain (`https://example.org`), every subdomain of it must serve `https`.

## 6. Open in stages

Switch features on one at a time, and run the checks after each step. The
environment variables can only switch features off, which makes them useful
brakes. Leave both switches on in `exclip.config.ts`, and start with:

```sh
EXCLIP_DISABLE_TRADING=1 EXCLIP_DISABLE_EMBEDDED_WALLET=1
```

1. **Prices only.** Deploy with both switches off, then run the
   [smoke checks](#smoke-checks). The app loads, and markets and quotes work.
   Every route that builds a transaction is refused, and the app offers
   browser wallets only.
2. **The passkey wallet.** Remove `EXCLIP_DISABLE_EMBEDDED_WALLET` and
   restart. `/api/exclip/config` now names your wallet origin. In a browser
   with the WebAuthn PRF extension, create a wallet and save the recovery
   phrase. Then sign in on a second browser profile or device, and check that
   "Show my address" gives the same address on both.

   Trading is still off, so the popup can't review a swap yet. Check from the
   command line that SODAX's quote endpoint answers the wallet origin's CORS
   preflight:

   ```sh
   curl -si -X OPTIONS https://api.sodax.com/v1/intent/quote \
     -H 'Origin: https://wallet.example.org' \
     -H 'Access-Control-Request-Method: POST' \
     -H 'Access-Control-Request-Headers: content-type'
   ```

   Do the same for `https://rpc.soniclabs.com`. Each answer must allow your
   wallet origin (or `*`) and the `content-type` header. Without the Sonic
   RPC the popup refuses every swap. Without the quote, only the built-in
   price bands check non-stable pairs.
3. **Trading.** Remove `EXCLIP_DISABLE_TRADING` and restart. Make a first
   small trade from a dedicated wallet, once with the passkey wallet and once
   with a browser wallet. During the passkey trade, keep the popup's
   developer tools open: the `POST` to
   `https://api.sodax.com/v1/intent/quote` and the call to
   `https://rpc.soniclabs.com` must both succeed. Check that:
   - the review shows the fee you configured (none by default), and with a
     fee split, a row for each party;
   - the popup's review lists only the network fee, or with a fee, the fee
     and who gets it;
   - the status reaches done and the funds arrive.
4. **Tokenised stocks, if you offer them.** If `stocks.enabled` is on, keep
   `EXCLIP_DISABLE_STOCKS=1` through the steps above. Once trading works,
   remove it, restart, and at once
   [check the proxy](tokenised-stocks.md#check-the-proxy). If a check
   fails, set the variable again and restart.

## Smoke checks

Run these after every deploy and every step above. Replace the example
hosts with yours.

```sh
curl -s https://swap.example.org/api/exclip/config
```

The answer holds public settings only:

```json
{"tradingEnabled":true,"sodaxConfigured":true,"partnerFeeBps":0,"feeReceiver":null,"feeRate":null,"feeReceiverName":null,"feeSplit":null,"embeddedWallet":true,"walletOrigin":"https://wallet.example.org","unbackedLimitUsd":100,"stocksEnabled":false,"stocksTermsVersion":null}
```

- `sodaxConfigured` must be `true`.
- `partnerFeeBps`, `feeReceiver`, `feeRate` and `feeReceiverName` must be
  what you configured: `0` and `null` unless you set a plain fee. A fee
  rate shows as `feeRate`, with `partnerFeeBps` at `0`. `feeSplit` is
  `null` unless you set a fee split. Then it names your splitter, the
  platform and you, with each rate ([`GET /config`](api.md#get-config)).
- `walletOrigin` must be your wallet origin, or `null` while the wallet is
  switched off.
- `stocksEnabled` must be `false` unless you switched tokenised stocks on.
  When they're on, `stocksTermsVersion` is your `stocks.termsVersion`, and
  [check the proxy](tokenised-stocks.md#check-the-proxy) too.
- The answer must never contain your SODAX key.

```sh
curl -sI https://wallet.example.org/
```

Compare the headers with `pnpm --filter @exclip/config run headers`. Check at
least these:

- `content-security-policy` starts with `default-src 'none'`;
- `x-frame-options: DENY` and `cross-origin-opener-policy: unsafe-none`;
- `cache-control: no-store` and `strict-transport-security`;
- no `set-cookie` and no `access-control-allow-origin`.

The server doesn't connect to Postgres or Redis before it listens, so these
checks don't show that storage works. With the passkey wallet on, sign in
once with a test wallet: that issues a challenge and reads a backup.

Finally, check that the wallet host serves exactly your build:

```sh
curl -s https://wallet.example.org/ | shasum -a 256
shasum -a 256 apps/wallet/dist/index.html
```

Do the same for each file under `/assets/`. Any difference means the wallet
origin isn't serving what you built: treat it as an incident (see
[Rollback](#rollback)).

## Rollback

Use the switches first, narrowest first. Each needs a restart of the server,
and no rebuild.

1. **Tokenised stocks off**, if you offer them. Set
   `EXCLIP_DISABLE_STOCKS=1` and restart. Every request with a stock in it
   answers `451 STOCKS_DISABLED`, and the app hides the Stocks screen.
   People keep the stocks they hold
   ([switching them off](tokenised-stocks.md#switching-them-off)).
2. **Trading off.** Set `EXCLIP_DISABLE_TRADING=1` and restart. Every route
   that builds a transaction answers 403. Quotes, status, submit and cancel
   keep working, so trades already signed can finish and be followed.
3. **The passkey wallet off.** Set `EXCLIP_DISABLE_EMBEDDED_WALLET=1` and
   restart. The app stops offering the passkey wallet, and its backup API
   answers 404. While it is off, people can't reach funds in their passkey
   wallet through your app; their recovery phrase still works in another
   wallet. Keep this step for a problem with the wallet, and switch trading
   off first.
4. **An earlier release.** Deploy the previous server and builds. Deploy a
   previous wallet build only if you know it is good, from its recorded
   hashes.

Pages that are already open pick up a switch when they next fetch
`/api/exclip/config`, which browsers cache for 30 seconds. The server
refuses switched-off routes at once.

**Keep the wallet host.** Passkeys are bound to the wallet's host name. If
the wallet moves to another host, or the host goes away, existing users can't
open their wallet in your app any more. Their funds are safe, and the
recovery phrase or Clip Wallet still reaches them, but keep the host up and
serving the wallet.

**If the wallet origin may be compromised** (it served files you didn't
build), switch trading and the passkey wallet off first. Then restore a
known-good build and find out what happened. Code on the wallet origin can use
every passkey that signs in there.

## Monitoring

The server writes one line per event to standard error, starting with
`[exclip]`. Alert on these codes:

| Code | Meaning |
|---|---|
| `EXCLIP_WALLET_SIGNUPS_80PCT` | 80 % of today's new-passkey allowance (`wallet.dailyNewPasskeys`) is used. |
| `EXCLIP_WALLET_SIGNUPS_PAUSED` | Today's allowance is used up. New wallets pause until 00:00 UTC. |
| `EXCLIP_WALLET_BACKUP_FULL` | A passkey reached `wallet.maxBackupVersions`. The popup writes one version per passkey, so another client is appending. |
| `EXCLIP_WALLET_KV` | Issuing a passkey challenge failed after the rate limiter had let the request through. |
| `EXCLIP_WALLET_STORE` | A passkey wallet request failed in storage. |
| `EXCLIP_WALLET_PURGE` | Removing retired passkeys failed. It is retried later. |
| `EXCLIP_PROXY_FAILED` | A SODAX proxy request failed unexpectedly. |

Alert as well on lines starting `[exclip] rate limits (`, logged at most once
a minute per limit. They mean the shared store (Redis, or Postgres without
Redis) didn't answer. The passkey wallet's challenge and write routes then
answer 503 `RATE_LIMIT_UNAVAILABLE` (fail closed). Other routes keep
answering under a per-process limit (fail open).

Lines starting `[exclip] database:` or `[exclip] redis:` report a lost
connection, at most once a minute, with the password in the connection URL
masked. A request that fails on the server logs its method, path and error,
never its body, with the SODAX key redacted.

## Updating

1. Read `CHANGELOG.md` and the diff. Take extra care with the files listed in
   [CONTRIBUTING.md](../CONTRIBUTING.md): `apps/wallet/fee-receivers.json`,
   `apps/wallet/src/`, the fee split's code, the message protocol and the
   security headers.
2. `pnpm install --frozen-lockfile` and `pnpm build`. With Docker, build a
   new image instead.
3. Apply new migrations, then restart the server (`systemctl restart
   exclip`), or replace the container.
4. Deploy the app and the wallet together. The two share a message protocol,
   so an app from one release and a wallet from another may not understand
   each other.
5. Run the [smoke checks](#smoke-checks).

Never change `origins.wallet` on a live deployment (see
[Keep the wallet host](#rollback)).
