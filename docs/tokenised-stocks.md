# Tokenised stocks

ExClip can offer the tokenised stocks SODAX lists, next to its coins. It
ships with them off. This page is for operators. It covers:

- what tokenised stocks are;
- what switching them on involves, the reverse proxy included;
- how ExClip decides who may trade them;
- what users see and read;
- what the checks can't do.

> [!WARNING]
> **Not legal advice.** Tokenised stocks are regulated, or banned, in many
> countries, and the rules change. ExClip's country checks and
> self-certification are a conservative default, not a compliance programme
> and not legal advice. If you switch them on, you decide where and to whom
> you offer them, and you're responsible for that decision: take advice from
> a lawyer who knows the countries your users are in.

## What they are

A tokenised stock is a token meant to track the price of a company's
shares. It lives on a blockchain like any other token, so it can be swapped
through SODAX and held in an ordinary wallet. SODAX's token list flags these
tokens as real-world assets (`isRwa`), and that flag is how ExClip tells
them from coins.

A tokenised stock isn't a share. Its issuer's terms set what it gives its
holder, and what happens if the issuer fails. Holding one may not give a
shareholder's rights, such as a vote or dividends. ExClip doesn't issue
these tokens, and these pages don't describe any issuer or its terms: read
those where the issuer publishes them.

Many countries restrict who may be offered tokenised stocks, and some ban
them. That is why they are off unless you switch them on.

## Off by default

With `stocks.enabled` left `false`, as it ships:

- the app has no Stocks screen, and lists no stock to trade;
- the server refuses any quote, and any request that builds a transaction,
  with a stock in it: `451 STOCKS_DISABLED`, before SODAX sees it;
- the passkey wallet refuses to sign a swap or a send of a stock, because
  it doesn't list stocks among its tokens;
- `/api/exclip/config` answers `"stocksEnabled": false`.

## Switching them on

Work through these steps in order. If a setting or a secret is missing, the
server refuses to start.

1. **Decide where you'll offer them**, with a lawyer. ExClip refuses them in
   the countries of [its baseline](#exclips-baseline) whatever you set. Add
   every other country you exclude to `stocks.blockedCountries`.
2. **Set up your reverse proxy.** It must send the visitor's country and the
   edge secret with every request, and replace any copy of either that a
   client sent. See [the reverse proxy](#the-reverse-proxy).
3. **Make two secrets**, for example with `openssl rand -hex 32` each time.
   Put them in the server's environment:

   | Variable | What it is |
   |---|---|
   | `EXCLIP_EDGE_SECRET` | What your proxy sends in `x-exclip-edge-secret`. The server trusts the country header only on a request that carries it. |
   | `EXCLIP_ATTESTATION_SECRET` | The key the server signs users' self-certifications with: at least 32 characters. Only the server needs it: never give it to the proxy or the app. |

   `exclip.config.ts` has no setting for either: they live in the
   environment only.
4. **Switch them on** in `exclip.config.ts`:

   ```ts
   stocks: {
     enabled: true,
     countryHeader: "cf-ipcountry",
     blockedCountries: ["CA", "GB"],
     termsVersion: "2026-11-01",
   },
   ```

   The header and the countries are examples, not advice.
   [Configuration](configuration.md#stocks) explains each setting.
5. **Give the passkey wallet its stock list, and rebuild it.** The wallet
   reads `stocks.enabled` when it is built, and signs only the stocks in
   `apps/wallet/src/sodax/stock-tokens.ts`. The committed table holds two
   stocks on Hedera, from the capture in the server's test fixtures.
   Write it again from a current copy of SODAX's token list, which your own
   server can fetch:

   ```sh
   curl -s https://swap.example.org/api/exclip/sodax/swaps/tokens -o swaps_tokens.json
   pnpm --filter @exclip/wallet run gen:stock-tokens "$PWD/swaps_tokens.json"
   git diff apps/wallet/src/sodax/stock-tokens.ts
   ```

   The script keeps the networks the passkey wallet signs on. It leaves
   out, with a warning, a stock whose symbol is also a coin's. It stops if a
   stock sits at an address `tokens.ts` lists as a coin: then write both
   tables from the same file (`gen:tokens`, then `gen:stock-tokens`) and
   review both diffs. Commit the result, and build and deploy the wallet as
   a release ([release controls](embedded-wallet.md#release-controls)).
6. **Restart the server.** The app needs no rebuild: it reads
   `stocksEnabled` from `/api/exclip/config`. The server's start-up notes
   say `tokenised stocks: on; country from cf-ipcountry with the edge
   secret; terms version 2026-11-01`.
7. **Check the proxy** from outside, as in
   [check the proxy](#check-the-proxy).

## The reverse proxy

The server can't tell where a visitor is. It takes the country from a header
your reverse proxy sets (`stocks.countryHeader`). It trusts that header only
on a request that also carries `EXCLIP_EDGE_SECRET` in
`x-exclip-edge-secret`. Anyone can send a country header, but only your
proxy knows the secret.

A request counts as coming from an unknown country when either header is
missing, the secret is wrong, or either header is sent twice. So does a
code that isn't an assigned ISO 3166-1 alpha-2 country, such as `XX` or
`T1`.

Your proxy must:

- set the country header to the visitor's two-letter code, such as `DE`,
  from its own geolocation;
- set `x-exclip-edge-secret` to `EXCLIP_EDGE_SECRET`;
- replace, not add to, any copy of either header that the client sent.

The proxy that sets the country must set the secret too. If there are
several proxies, the ones after it pass both headers on unchanged.

Keep the secret out of version control. If it leaks, change it on the proxy
and the server together. While the two differ, every visitor's country is
unknown, and nobody can trade stocks.

The two examples below are untested sketches. Adapt them, then
[check the result](#check-the-proxy) before you rely on it.

### Cloudflare (untested)

Cloudflare can work out each visitor's country. One request header
Transform Rule can send the country with the secret:

1. Create a rule that modifies request headers, for requests to your app's
   host name.
2. Add two headers, each with a **Set** operation (not Add), so that a
   copy the client sent is replaced:
   - Set static: `x-exclip-edge-secret`, with the value of
     `EXCLIP_EDGE_SECRET`;
   - Set dynamic: `x-visitor-country`, with the expression
     `ip.src.country`.
3. In `exclip.config.ts`, set `countryHeader: "x-visitor-country"`.

Cloudflare reports `T1` for Tor and `XX` when it can't place a visitor.
ExClip treats both as an unknown country.

With IP geolocation on, Cloudflare also adds its own `CF-IPCountry` header.
`countryHeader: "cf-ipcountry"` then works with only the static secret
header. Either way, check that a client's own copy of the country header
never reaches the server.

### nginx (untested)

nginx needs a country database for this. For example, use the GeoIP2
module (`ngx_http_geoip2_module`) with a country database that you keep up
to date. Add the lookup to the `http` block, and the two headers to the
`location` that proxies to the server, as in
[self-hosting](self-hosting.md#option-a-the-server-serves-both-builds):

```nginx
# In the http block. The database path is an example.
geoip2 /var/lib/GeoIP/GeoLite2-Country.mmdb {
  $visitor_country country iso_code;
}

server {
  # … listen, server_name and the certificates, as in self-hosting.md

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Tokenised stocks: the visitor's country and the edge secret.
    proxy_set_header X-Visitor-Country $visitor_country;
    include /etc/nginx/exclip-edge-secret.conf;
  }
}
```

`/etc/nginx/exclip-edge-secret.conf` holds one line, and only root can read
it:

```nginx
proxy_set_header X-ExClip-Edge-Secret "the value of EXCLIP_EDGE_SECRET";
```

Then set `countryHeader: "x-visitor-country"`.

How the example works:

- `proxy_set_header` replaces a header of the same name from the client.
  When its value is empty, it sends no header at all, so a visitor the
  database can't place arrives with no country. Give the lookup no default.
- nginx drops the `proxy_set_header` lines of an outer block from any block
  that sets its own, so keep all of them in one block.
- Behind a CDN or a load balancer, nginx sees that hop's address, not the
  visitor's. Look the country up from the client address the hop reports,
  or set both headers at the hop in front.

### Check the proxy

From outside, through your proxy:

```sh
curl -s https://swap.example.org/api/exclip/stocks/eligibility
```

From a country you allow, before you've confirmed the statements, the
answer looks like this:

```json
{"eligible":false,"code":"SELF_CERT_REQUIRED","message":"Read the disclosures and confirm the statements before you trade tokenised stocks.","country":"DE","termsVersion":"2026-11-01","expiresAt":null}
```

- `country` must be where you are. `COUNTRY_UNKNOWN` means the server isn't
  getting the country header, or the secrets don't match.
- Send a country and a secret of your own, under the header names you
  configured, for example
  `-H 'x-visitor-country: CH' -H 'x-exclip-edge-secret: guess'`. The
  answer must still name the country your proxy found, never `CH`.
- If the server can be reached without the proxy, at its own address and
  port, the same request there must answer `COUNTRY_UNKNOWN`.

## Who may trade them

For a request with a stock in it, the server asks four questions, in this
order. The first "no" decides the refusal.

1. **Are stocks on?** That is `stocks.enabled`, unless
   `EXCLIP_DISABLE_STOCKS` is set. If not: `STOCKS_DISABLED`.
2. **Is the country known?** The server reads it from
   `stocks.countryHeader`, on a request that carries the edge secret, as
   [the reverse proxy](#the-reverse-proxy) describes. If not:
   `COUNTRY_UNKNOWN`.
3. **Is the country allowed?** It must be in neither ExClip's baseline nor
   `stocks.blockedCountries`. If it is: `COUNTRY_RESTRICTED`.
4. **Has the visitor confirmed the statements?** The request must carry a
   self-certification this server signed, for the current terms and the
   same country, less than 30 days ago. If not: `SELF_CERT_REQUIRED`.

These requests have a stock in them, when either token is one that SODAX's
token list flags `isRwa`:

- a quote (`swaps/quote`);
- an allowance check (`swaps/allowance/check`);
- a request that builds a transaction (`swaps/approve`, `swaps/intents`,
  `swaps/limit-orders`).

The server reads the token list at most every five minutes. If it can't
read the list, it refuses every one of those requests that names a token,
stock or not, with `503 TOKEN_LIST_UNAVAILABLE`: it fails closed.

The stock check never asks about a request without a stock in it. It never
looks at the routes that follow or recover a trade already signed either,
such as `swaps/intents/submit`, `swaps/submit-tx`, status and cancel, so a
signed trade can always be followed.

### ExClip's baseline

Whatever the configuration says, tokenised stocks are refused to visitors
in these countries:

| Code | Country |
|---|---|
| `US` | United States |
| `AS` | American Samoa |
| `GU` | Guam |
| `MP` | Northern Mariana Islands |
| `PR` | Puerto Rico |
| `UM` | United States Minor Outlying Islands |
| `VI` | United States Virgin Islands |
| `BY` | Belarus |
| `CU` | Cuba |
| `IR` | Iran |
| `KP` | North Korea |
| `RU` | Russia |
| `SY` | Syria |

This list is ExClip's conservative default:

- It is a floor. `stocks.blockedCountries` adds to it, and nothing removes
  a country from it.
- It isn't a list of the places where stocks are allowed, and it isn't a
  legal analysis of any country.
- Sanctions and securities rules change, and the list doesn't follow them
  for you. Check it against the rules that apply to you, and add to it.

The list is `STOCKS_BASELINE_COUNTRIES` in `packages/config/src/stocks.ts`.

### The self-certification

When the visitor's country is allowed, the app shows the disclosures and
four statements, each with its own checkbox. Confirming sends the terms
version shown and the ids of the ticked statements to
`POST /api/exclip/stocks/attest`.

The server answers only when all four are ticked, the terms version is the
current one, and the country checks pass. It then signs an attestation of
the terms version, the country and the time. The signature uses
HMAC-SHA256 with `EXCLIP_ATTESTATION_SECRET`, and it also covers the exact
wording of the statements.

The app keeps the attestation in the browser's local storage. It sends it
back in `x-exclip-stocks-attestation`, only to the SODAX proxy and the stock
routes. The server keeps no copy: it checks the signature each time.

The visitor must confirm again:

- after 30 days;
- when you change `stocks.termsVersion`;
- in another country;
- when a release changes the wording of the statements;
- when you change `EXCLIP_ATTESTATION_SECRET`, which affects everyone at
  once;
- in another browser, or after the browser's storage is cleared.

## Refusals

The SODAX proxy refuses with HTTP 451 (Unavailable For Legal Reasons) and
one of these codes, in the usual error shape. The app shows the message.

| Code | When | Message |
|---|---|---|
| `STOCKS_DISABLED` | Stocks are off. | Tokenised stocks are not available here. |
| `COUNTRY_UNKNOWN` | There's no country the server can trust. | Your country couldn't be determined, and tokenised stocks are only offered when it can be. If you use a VPN or proxy, turn it off and try again. |
| `COUNTRY_RESTRICTED` | The country is in the baseline or in `stocks.blockedCountries`. | Tokenised stocks are not available in your country. |
| `SELF_CERT_REQUIRED` | There's no valid self-certification. | Read the disclosures and confirm the statements before you trade tokenised stocks. |

`GET /api/exclip/stocks/eligibility` asks the same question without
trading. It always answers 200, with the code and message when the answer
is no. The [API reference](api.md#tokenised-stocks) covers both stock
routes, and the other errors the confirmation can give.

## What users see

With stocks off, users see nothing of them. With stocks on, these places
change:

- **The Stocks screen**, at `/stocks`, linked from the navigation. It shows
  the disclaimer, where the visitor stands ("Your access"), and SODAX's
  listing. Each stock appears under SODAX's own symbol and name, with the
  networks it's on and a "Tokenised stock" badge. There are no company
  logos and no prices: ExClip's market data covers crypto only.
- **The trade sheet** lists stocks next to coins, with the badge. A trade
  with a stock in it gets no quote until the server lets the visitor trade
  stocks. Until then, the sheet says what's missing. When the only thing
  missing is the confirmation, it offers the way to confirm. A stock's
  amount is typed in the stock, not in dollars. The review shows the badge
  and the disclaimer.
- **The eligibility sheet**, "Before you trade tokenised stocks". It shows
  the disclosures, the four statements with an unticked checkbox each, and
  a Confirm button.
- **The passkey wallet** in a build with stocks on. It signs swaps and sends
  of the stocks in its table, under the same checks as any other token.
  Its review shows the badge after the stock's amount, and the disclaimer.
  It has no price band for a stock, so without its own SODAX quote it
  reports the price as unchecked. It knows nothing of the visitor's country
  or confirmation: the app and the server check those.

## The texts users read

The texts live in `packages/config/src/stocks.ts`, and the app, the wallet
window and the server all use them. Below, [operator] stands for
`brand.operator`, or `brand.name` when that is empty. Show these texts to
your lawyer before you switch stocks on.

**The disclaimer.** It appears on the Stocks screen, and in the review of
any trade with a stock in it, in the app and in the wallet window:

> Tokenised stocks are tokens meant to track the price of a company's
> shares. [operator] doesn't issue them, and holding one may not give you a
> shareholder's rights: what each token gives you is set by its issuer's
> terms. They may be restricted where you live. Prices can move sharply, and
> you can lose all you put in. Nothing here is investment advice.

**The disclosures**, at the top of the eligibility sheet:

> A tokenised stock is a token meant to track the price of a company's
> shares. Holding one may not give you a shareholder's rights, such as a
> vote or dividends: what it gives you, and what happens if its issuer
> fails, is set by the issuer's terms.
>
> [operator] doesn't issue these tokens, hold them for you or advise you on
> them. Swaps settle through SODAX, from and into your own wallet.
>
> Prices can move sharply, and you may not be able to sell when you want or
> at the price you want. You can lose all you put in.
>
> Tokenised stocks are restricted in many countries. [operator] refuses them
> where it can tell you're in one of the countries it excludes, but you're
> responsible for knowing whether you may buy them where you live.

**The statements.** Each has its own checkbox:

1. I'm not a US person (for example a citizen or resident of the United
   States), and I'm not acting for one.
2. I may buy and hold tokenised stocks where I live, and I'm not hiding
   where I am (for example with a VPN).
3. I understand that a tokenised stock may not give me a shareholder's
   rights, and that I can lose all I put in.
4. I'm trading for myself, on my own judgement, and I don't take anything
   here as investment advice.

Under them: "Your confirmation is kept in this browser for 30 days, for the
country you're in now. Terms version [stocks.termsVersion]."

**The badge**, next to every stock: "Tokenised stock".

The sheet doesn't show your own terms of use. The footer links to them
(`brand.termsUrl`). When what users agree to changes, change
`stocks.termsVersion`, and everyone confirms again.

## Switching them off

- **At once:** set `EXCLIP_DISABLE_STOCKS=1` and restart the server. Every
  request with a stock in it then answers `451 STOCKS_DISABLED`. The app
  hides the Stocks screen and every stock when it next reads
  `/api/exclip/config`, which browsers cache for 30 seconds. Nothing needs
  a rebuild.
- **For good:** set `stocks.enabled: false`, and rebuild the passkey wallet
  too. Until you do, the wallet would still sign a stock if the app asked
  for one, but the app doesn't while stocks are off.

People keep the stocks they hold: they're in their own wallets. While stocks
are off, or for a visitor in a refused country, your app can't swap them,
and that includes selling. A browser wallet can still send them. A passkey
wallet built with stocks off refuses to send them too. Its users can then
reach their stocks only with their recovery phrase, in another wallet. Tell
your users before you switch stocks off.

## Limitations

- **The check covers your deployment, not the token.** It decides what your
  app and your server do. Anyone can hold, send and swap these tokens with
  another app or wallet, and can reach SODAX without your server.
- **For swaps from the app, the quote is the checkpoint.** The app builds a
  swap's transactions in the browser, with SODAX's SDK, from the quote your
  server checked. The user's wallet broadcasts them, and the SDK then tells
  SODAX through a route the stock check doesn't look at. A modified app that
  skips the quote gets past the proxy. The passkey wallet adds its own
  refusal only in a build with stocks off.
- **The country comes from an IP address.** A VPN or a proxy can hide or
  change it. Cloudflare reports Tor as `T1`, which ExClip treats as unknown,
  but other proxies may not.
- **Whole countries only.** You can't block a region, a state or a
  province, and nothing applies per person.
- **The self-certification is the visitor's own word.** Nothing checks it.
  It is kept per browser, and the server keeps no record of who confirmed
  what. If you need such records, ExClip doesn't make them.
- **The passkey wallet knows nothing of countries or confirmations.** In a
  build with stocks on, it signs a stock trade whenever the app asks for
  one. The app asks only after the server has said yes.
- **The wallet's stock list is fixed when the wallet is built.** It refuses
  a stock that SODAX lists later, until you write `stock-tokens.ts` again
  and rebuild.
- **No prices for stocks.** The market data covers crypto only, so the app
  shows no dollar value for a stock. The passkey wallet can check a stock's
  price only against SODAX's quote.
- **The proxy examples are untested.** Check your own setup as
  [above](#check-the-proxy).
- **Development needs the headers by hand.** `pnpm dev` has no reverse
  proxy. With stocks on, it needs the two secrets in its environment, as in
  production. Send the country header and the edge secret yourself, with
  curl or a browser extension that sets request headers.

The tests behind these rules are listed under
[security](security.md#invariants-and-how-they-are-tested).
