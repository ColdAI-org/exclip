# Security policy

ExClip prepares swaps that a passkey wallet signs, so a bug here can cost
people money. We would rather hear about a problem twice than not at all.

## Reporting a vulnerability

Report security problems privately through GitHub. Open the repository's
**Security** tab and choose **Report a vulnerability**, which opens a private
security advisory. Do not use a public issue, pull request or discussion.

A useful report says:

- which part is affected: the app (`apps/web`), the wallet popup
  (`apps/wallet`), the server (`apps/server`), the configuration
  (`packages/config`) or the vendored Clip Wallet packages;
- which commit or release you tested;
- how to reproduce it, and what an attacker gains;
- whether funds, keys, passkeys or backups are at risk.

A proof of concept is welcome. Test against your own deployment and your own
wallets, preferably on test networks.

## What happens next

- We aim to acknowledge a report within three working days. We will tell
  you whether we can reproduce it, and keep you posted until it is fixed.
- We fix the problem, publish the fix and then the advisory. Please give us
  reasonable time to do that before you disclose anything.
- We credit you in the advisory unless you ask us not to.

We will not pursue legal action over good-faith research that follows this
policy. That means you do not touch other people's funds or data, you do not
degrade a service someone else runs, and you stop and tell us if you come
across someone else's data.

## Scope

In scope: the code in this repository. That covers the wallet popup and its
signing policy, the message protocol between the app and the popup, the
fee-receiver allowlist, the server's handling of the SODAX key, backups and
rate limits, the security headers, and the build-time checks.

Report these elsewhere:

- **A copy of ExClip that someone else runs.** Each deployment is operated by
  its own operator. Contact them, and tell us as well if the flaw is in the
  code.
- **SODAX contracts or the SODAX API.** Report to SODAX.
- **Clip Wallet itself.** `packages/clip-wallet-core` and
  `packages/clip-wallet-vault` are copies of Clip Wallet code. Report to the
  Clip Wallet project, and tell us too if ExClip is affected.
- **A dependency.** Report to its maintainers. Tell us if ExClip can be
  exploited through it.

## Supported versions

Security fixes go to the latest commit on `main`. Once there are tagged
releases, they also go to the latest release.

## If you run ExClip

- Watch this repository's security advisories (**Watch → Custom → Security
  alerts**) and update promptly.
- Know how to switch trading and the embedded wallet off quickly. See
  [Rollback](docs/self-hosting.md#rollback).
- Treat a deploy of the wallet origin like a key ceremony. Whoever can change
  what that origin serves can sign with your users' wallets. See
  [docs/embedded-wallet.md](docs/embedded-wallet.md).
