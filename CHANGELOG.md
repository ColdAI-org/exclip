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
