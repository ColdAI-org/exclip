# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- ExClip as a standalone, self-hostable project:
  - `apps/web`, the swap app;
  - `apps/wallet`, the passkey wallet popup on its own origin;
  - `apps/server`, a small server with the SODAX proxy, public config,
    market data, encrypted wallet backups and rate limits.
- One configuration file, `exclip.config.ts`, with a typed loader and
  validation (`packages/config`). There is no partner fee by default, and
  the SODAX key stays on the server.
- Storage for the server: memory for development. In production, Postgres
  holds the passkey wallet's backups, and Redis or Postgres the rate limits
  and passkey challenges.
- Vendored copies of Clip Wallet's `@clip-wallet/core` and
  `@clip-wallet/vault`, under its Apache-2.0 licence and credited in
  `NOTICE`.
- CI that typechecks, lints, checks the Markdown's links, tests and builds
  every change, with actions pinned by commit SHA.
- A brand kit in `brand/`: the mark, a small mark for 16 to 32 px, the
  glyph, the wordmark and two lockups as SVG, with the colours, contrast
  ratios and rules for use in `brand/README.md`. `pnpm run brand` checks the
  SVGs and renders the preview and the app icons; `pnpm run brand:outline`
  outlines the wordmark from Inter Bold.
- The app's logo, `apps/web/public/logo.svg`, redrawn as the brand kit's
  small mark, and PNG icons for home screens: 180 px for iOS, 192 and
  512 px, and a 512 px maskable icon.
- A web app manifest, `/manifest.webmanifest`. It lists ExClip's PNG icons
  only while the site keeps ExClip's name and logo; any other brand gets its
  own logo as the only icon.
- A tab icon for the wallet window: `brand.logo`, inlined into the page,
  when it's an image file in `apps/web/public`.
- Documentation in `docs/`: an index, concepts, architecture, branding, the
  passkey wallet, fees, security, the API, development, troubleshooting and
  a FAQ.
- `pnpm run docs:links`, which checks that every relative link, heading
  anchor and image in the Markdown resolves.
- `pnpm run screenshots`, which captures the README's screenshots into
  `docs/media` from fixtures, with every network request answered locally.
- A "Powered by ExClip" credit at the end of the footer of the app and of
  the wallet window, linked to the repository ("ExClip is open source" under
  ExClip's own name). `NOTICE` makes it ExClip's attribution notice, and no
  setting removes it.
- `pnpm run contrast`, which checks `brand.colors` in your config against
  the contrast rule and fails when a pairing is below 4.5:1.
- `pnpm run screenshots --brand`, which takes the same screenshots under
  the brand, fee and origins in your config and saves them to the
  git-ignored `screenshots/`.
- `AGENTS.md`, instructions for coding agents with a recipe for making
  ExClip your own DEX (`CLAUDE.md` points to it), and `docs/agents.md`,
  which shows people how to ask for that and check the result.
- Tokenised stocks, as an operator opt-in that ships off
  ([tokenised stocks](docs/tokenised-stocks.md)):
  - a `stocks` block in `exclip.config.ts` (`enabled`, `countryHeader`,
    `blockedCountries` and `termsVersion`), and the environment variables
    `EXCLIP_EDGE_SECRET`, `EXCLIP_ATTESTATION_SECRET` and
    `EXCLIP_DISABLE_STOCKS`. With stocks on, the server won't start without
    both secrets;
  - a stock check in the SODAX proxy. A request with a stock in it gets a
    451 unless stocks are on, the visitor's country came from the reverse
    proxy with the edge secret, the country is in neither ExClip's baseline
    nor `stocks.blockedCountries`, and the visitor confirmed the statements
    in the last 30 days;
  - `GET /api/exclip/stocks/eligibility`, and `POST /api/exclip/stocks/attest`,
    which signs a self-certification and keeps no record of it;
  - `stocksEnabled` and `stocksTermsVersion` in `/api/exclip/config`;
  - in the app, a Stocks screen, stocks in the trade sheet with a "Tokenised
    stock" badge and a disclaimer, and an eligibility sheet with the
    disclosures and four statements to confirm;
  - in a passkey wallet built with stocks on, swaps and sends of the stocks
    in `apps/wallet/src/sodax/stock-tokens.ts`, a table that
    `pnpm --filter @exclip/wallet run gen:stock-tokens <file>` writes from
    SODAX's token list.

### Changed

- The SODAX proxy's stock check refused every tokenised stock with
  `451 STOCKS_DISABLED`. It still does while stocks are off. With stocks on,
  a refusal says why: `COUNTRY_UNKNOWN`, `COUNTRY_RESTRICTED` or
  `SELF_CERT_REQUIRED`.

- The README, rewritten: what ExClip is, screenshots, a quick start, every
  setting with its default, self-hosting, rebranding, how it works, fees,
  security, the operator's responsibility, status and a roadmap.
- `docs/self-hosting.md` adds a systemd unit, a starting-point Dockerfile,
  an nginx example and database backups.
- `docs/configuration.md` gives the full contrast rule for the colours and
  says where each icon comes from.
- `SECURITY.md` and the self-hosting guide no longer mention test networks:
  ExClip trades on live networks only.

### Fixed

- The server stops with exit code 1 and says why when it can't listen on its
  port, such as one another process holds. It used to print its start-up
  lines as if it were running.
- In the light theme, input focus borders are drawn in `accentInk`, like the
  focus ring. ExClip's cyan accent was 2.39:1 against white, below the 3:1
  a focus indicator needs; the ink is 4.87:1. The dark theme is unchanged.
