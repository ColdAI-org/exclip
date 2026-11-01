# Contributing to ExClip

Thanks for helping. This file covers how to set up, what we check, and the
few rules that exist because ExClip handles money.

Report security problems privately, through a GitHub security advisory or by
email, never in a public issue. See [SECURITY.md](SECURITY.md).

## Setting up

You need Node 24 and pnpm 12.6.0. The repository pins pnpm in
`package.json`, so `corepack enable` gives you the right version.

```sh
pnpm install
pnpm dev        # app on :5173, wallet popup on :5311, server on :8080
```

Copy `exclip.config.example.ts` to `exclip.config.ts` if you want to change a
setting. The copy is git-ignored, and your SODAX key belongs there, never in
a commit.

## Before you open a pull request

Run what CI runs:

```sh
pnpm typecheck
pnpm lint
pnpm run docs:links
pnpm test
pnpm build
```

Add or update tests with your change, and add a line under
`## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) if users or operators will
notice it.

Keep pull requests small and on one topic. Commit messages follow the
`type(scope): summary` pattern, for example `fix(wallet): …`,
`feat(web): …`, `docs: …` or `chore: …`.

## Sign your commits off (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a contributor licence agreement. Every commit in a pull request
needs a `Signed-off-by` line with your real name and an email address you
can be reached at:

```text
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you. To sign off commits you have already made,
use `git rebase --signoff main` and force-push your branch.

By signing off, you certify the following:

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

Contributions are accepted under the Apache License 2.0, the licence of
this repository.

## Changes that get extra review

Some files decide where money can go or what the wallet will sign. A pull
request that touches them needs a maintainer who checks the change line by
line, and it should say in its description why the change is needed.

- **`apps/wallet/fee-receivers.json`** lists the only addresses that may
  receive a partner fee. An empty list means the popup refuses every swap
  that carries a fee. That is the default, and it fails closed. Change it only
  through a reviewed commit, never at deploy time. Say who controls each
  address you add. The reviewer confirms the address through a channel other
  than the pull request.
- **`apps/wallet/src/`**: the popup, its signing policy and price checks.
  Changes must keep the protections described in
  [docs/embedded-wallet.md](docs/embedded-wallet.md). Tightening a limit
  needs no discussion. Loosening one needs an issue and agreement first.
- **The message protocol.** `apps/wallet/src/protocol.ts` and
  `apps/web/src/lib/wallet-protocol.ts` must stay byte-for-byte identical.
  A test fails if they differ. Change both in the same commit.
- **Security headers** in `packages/config/src/headers.ts`.
- **The configuration rules** in `packages/config/src/index.ts`. A default
  that charges a fee, that switches tokenised stocks on, or that relaxes
  origin isolation, will not be accepted.
- **The tokenised-stock rules:** the baseline countries and the texts users
  read and confirm, in `packages/config/src/stocks.ts`, and the stock check,
  in `apps/server/src/services/stocks.ts`. Adding a country or tightening
  the check needs no discussion. Taking a country off the baseline, or
  letting through a request that was refused, needs an issue and agreement
  first.

## Vendored code

`packages/clip-wallet-core` and `packages/clip-wallet-vault` are copies of
Clip Wallet packages. Don't change them here. Send the fix to the Clip Wallet
project, then copy the new release in and update the package's `UPSTREAM`
file in the same commit.

## Code of conduct

Everyone taking part is expected to follow the
[code of conduct](CODE_OF_CONDUCT.md).
