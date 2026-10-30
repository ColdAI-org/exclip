# ExClip

ExClip is a front end for cross-chain swaps on [SODAX](https://sodax.com),
with a built-in passkey wallet. People swap between networks with the
browser wallet they already have. They can also create a self-custodial
wallet in one step, unlocked with a passkey, with no extension or seed
phrase to type.

ColdAI LLC built ExClip and publishes it here under the Apache License 2.0,
so anyone can run their own copy. ExClip charges no fee unless you configure
one.

> **Try test networks first.** Before you put real funds through it, try every
> flow you plan to offer on test networks or with small amounts.

## What's here

```text
apps/web        the swap app (Vite + React)
apps/wallet     the passkey wallet popup, served from its own origin
apps/server     a small Node server: SODAX proxy, config, market data,
                encrypted wallet backups, rate limits
packages/config         exclip.config.ts: types, defaults, validation, security headers
packages/clip-wallet-*  vendored Clip Wallet code (the vault and its shared core)
docs/           configuration, self-hosting, the embedded wallet's design
```

```text
              browser
 ┌──────────────────────────┐ postMessage ┌──────────────────────────┐
 │ app origin     apps/web  │ ⇄ ───────── │ wallet origin apps/wallet│
 └────────────┬─────────────┘             └─────────────┬────────────┘
              │ /api/exclip/*                           │ backup API
              ▼                                         ▼
 ┌───────────────────────────── apps/server ──────────────────────────┐
 │ SODAX proxy (holds the key, sets the fee) · config · market data   │
 │ encrypted passkey backups (WebAuthn) · rate limits                  │
 └────────────┬──────────────────────────────────────┬────────────────┘
              ▼                                      ▼
          SODAX API                      Postgres (Redis optional)
```

The SODAX key never leaves the server. The app gets public settings only.
The wallet popup runs on its own origin, under a strict content security
policy. It decodes and checks every transaction before the user approves it
with a passkey. [docs/embedded-wallet.md](docs/embedded-wallet.md) describes
the design and the threat model.

## Quick start

You need Node 24 and pnpm 12.6.0. `corepack enable` picks up the version
pinned in `package.json`.

```sh
git clone <this repository> exclip
cd exclip
pnpm install
cp exclip.config.example.ts exclip.config.ts   # then set sodax.apiKey
pnpm dev
```

Then open <http://localhost:5173>.

- The app runs on `:5173`, the wallet popup on `:5311` and the server on
  `:8080`.
- In development, without a database, the server keeps everything in
  memory.
- Without a SODAX key, the app still loads, but quotes answer "Trading isn't
  connected".
- The passkey wallet needs a browser with the WebAuthn PRF extension, such as
  current Chrome, Edge or Safari 18 and later.

## Configuration

Everything lives in one file, `exclip.config.ts`, which is git-ignored:

| Setting | Default | |
|---|---|---|
| `sodax.apiKey` | none | Your SODAX key. Server-side only. `SODAX_API_KEY` overrides it. |
| `fees.partnerFeeBps` / `fees.receiver` | `0` / `null` | Optional partner fee, at most 100 bps (1 %). The wallet also requires the receiver in `apps/wallet/fee-receivers.json`. |
| `origins.app` / `origins.wallet` | example domains | Your two production origins. The wallet needs a host of its own. |
| `brand` | ExClip | Name, operator, logo, colours, and links to your terms and privacy notice. |
| `features.trading` / `features.embeddedWallet` | on / on | Switches. `EXCLIP_DISABLE_TRADING=1` and `EXCLIP_DISABLE_EMBEDDED_WALLET=1` turn them off. |
| `server.*` | | Port, Postgres, Redis, proxy hops, static serving. |

[docs/configuration.md](docs/configuration.md) explains every setting and
the environment variables.

## Self-hosting

A deployment is two static builds on two origins, plus one Node process.
Postgres holds the encrypted wallet backups, and Redis is optional.

```sh
pnpm install --frozen-lockfile
pnpm build    # bakes your origins and brand into apps/web/dist and apps/wallet/dist
pnpm start    # the server, in production mode
```

[docs/self-hosting.md](docs/self-hosting.md) covers the rest: the database,
the headers each origin must send, the reverse proxy, rolling out in stages,
smoke checks and rollback.

## You are the operator

If you deploy ExClip, you provide your own front end, and you answer for it.
That includes:

- your own licensing, terms of use and privacy notice;
- legal review in every place you offer it, including whether you may offer
  swaps there and what charging a fee means;
- running it safely: keeping it up to date, protecting the wallet origin, and
  telling your users who you are (`brand.operator`).

ColdAI LLC does not operate your deployment, is not a party to anything
between you and your users, and gives no warranty (see [LICENSE](LICENSE)).

## Not included

This repository is version 1 of ExClip: swaps only. It does not include:

- tokenised stocks, or the eligibility and attestation checks that go with
  them. The server refuses any quote or swap with a tokenised-stock token on
  either side;
- privacy mode;
- the Earn page;
- ColdAI's accounts, site shell and hosting setup.

## Development

```sh
pnpm dev         # app, wallet and server, with reload
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules on commits (DCO
sign-off) and the files that get extra review.

## Security

Report vulnerabilities privately through GitHub's security advisories, as
described in [SECURITY.md](SECURITY.md). Please don't open a public issue.

The protections you should keep in place when you change or deploy ExClip:

- **No fee by default.** The server sets the fee on every quote and intent,
  and ignores any fee the browser asks for.
- **Fee receivers fail closed.** `apps/wallet/fee-receivers.json` is empty, so
  the wallet refuses every swap that carries a fee until a reviewed commit adds
  a receiver.
- **The wallet is isolated.** It has its own origin, its own passkeys, a
  strict CSP with Trusted Types, and no third-party scripts at run time.
- **No blind signing.** The wallet decodes every transaction and matches it to
  what the user asked for. It refuses anything else and shows its own review.

## Licence and trademarks

ExClip is licensed under the [Apache License 2.0](LICENSE), copyright 2026
ColdAI LLC. The vendored Clip Wallet packages keep their own licence. See
[NOTICE](NOTICE) for both.

"ExClip", "Clip Wallet" and the ExClip logo are trademarks of ColdAI LLC,
and the licence does not cover them. You may say that your service is built
on ExClip. If you run a copy for other people, give it your own name and logo
(`brand.name` and `brand.logo`).
