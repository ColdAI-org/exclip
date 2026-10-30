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
- Vendored copies of `@clip-wallet/core` and `@clip-wallet/vault`.
- CI that typechecks, lints, tests and builds every change, with actions
  pinned by commit SHA.
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

### Changed

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
