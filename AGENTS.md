# Instructions for coding agents

This file is for coding agents working in this repository. People start
with the [README](README.md), and [docs/agents.md](docs/agents.md) shows
them how to ask an agent for a rebrand.

## What ExClip is

ExClip is an open-source, self-hostable front end for SODAX cross-chain swaps.
It has three parts: a React app, a passkey wallet popup on an origin of its own, and a small Node server that holds the SODAX key.
Operators run it under their own name, logo, colours and fee, set in one file, `exclip.config.ts`, without changing code.

## Repository map

| Path | What it holds |
|---|---|
| `exclip.config.example.ts` | The template for `exclip.config.ts`, the only config file. The copy is git-ignored |
| `apps/web` | The app: React and Vite, dev port 5173. `public/` holds the logo |
| `apps/wallet` | The passkey wallet popup: plain TypeScript and Vite, dev port 5311. `fee-receivers.json` is its fee allow-list |
| `apps/server` | Express 5 on Node 24, port 8080: `/api/exclip/*`, the SODAX proxy, wallet backups. `migrations/` for Postgres |
| `packages/config` | The config's types, defaults and checks, what each build may see, both origins' security headers, the contrast check |
| `packages/clip-wallet-core`, `packages/clip-wallet-vault` | Vendored from Clip Wallet. Never edit them here |
| `brand/` | ExClip's own brand kit. Not for rebrands |
| `tools/` | The scripts behind `brand`, `screenshots` and `docs:links` |
| `docs/` | The documentation. [docs/README.md](docs/README.md) is the index |

[Development](docs/development.md#the-repository) has more on each.

## Commands

Node 24 (`.nvmrc`) and pnpm 12.6.0 (`corepack enable`). Run everything from
the repository root.

| Task | Command |
|---|---|
| Install | `pnpm install` (`pnpm install --frozen-lockfile` in CI and on servers) |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Test | `pnpm test` |
| Build | `NODE_OPTIONS=--max-old-space-size=6144 pnpm build` |
| Check the Markdown's links | `pnpm run docs:links` |
| Check the brand colours | `pnpm run contrast` |
| Screenshots | `pnpm run screenshots` (ExClip's, into `docs/media`), or `pnpm run screenshots --brand` (the config's brand, into `screenshots/`) |
| Print the security headers | `pnpm --filter @exclip/config run headers` |
| Run it locally | `pnpm dev` |

- **The build's heap.** The app's build needs about 2.6 GB of heap, more
  than Node allows by default on a machine with less than 16 GB of memory.
  CI gives it 6 GB, as above. With less memory free, 4096 is enough
  ([troubleshooting](docs/troubleshooting.md#the-build-fails-or-warns)).
  If you can't set `NODE_OPTIONS` before a command, run `pnpm build`: on a
  machine with 16 GB of memory or more, Node's default is enough.
- **The build's notices.** The builds print notices about their
  dependencies, such as modules "externalized for browser compatibility",
  `/*#__PURE__*/` comments that Rollup removes, and chunks larger than
  500 kB. They're expected: change nothing for them
  ([troubleshooting](docs/troubleshooting.md#the-build-fails-or-warns)).
- **Screenshots** start their own dev servers on ports 5173 and 5311, so
  stop `pnpm dev` first. They need a browser: run
  `pnpm exec playwright install chromium` once, or the script tries Google
  Chrome ([screenshots](docs/development.md#screenshots)).
- **`pnpm dev`** reads the config only when it starts, so restart it after
  a change. It always uses the localhost origins.
- CI runs install, typecheck, lint, docs:links, test and build. Run the same
  before you call a change done. A change to `contracts/fee-split` also
  runs the contracts' job. Its checks need Foundry and Slither to run
  locally ([CONTRIBUTING](CONTRIBUTING.md#before-you-open-a-pull-request)).

## Conventions

- **Commits:** `type(scope): summary`, for example `feat(web): …`,
  `fix(wallet): …`, `docs: …` or `chore: …`, then a body in plain prose.
  Sign off every commit for the DCO with `git commit -s`
  ([CONTRIBUTING](CONTRIBUTING.md#sign-your-commits-off-dco)). Commit only
  when you're asked to.
- **No secrets in the config file**, or in any commit. The SODAX key goes in
  the server's environment as `SODAX_API_KEY`, and so do `DATABASE_URL`,
  `REDIS_URL` and `COINGECKO_API_KEY`
  ([environment variables](docs/configuration.md#environment-variables)).
  Never ask for a key in chat.
- **The contrast rule:** `accent` and `accentHover` need at least 4.5:1
  against `#07080A` and `#03141C`; `accentInk` needs at least 4.5:1 against
  `#FFFFFF` and `#F6F7F9`. Leave some room above 4.5:1. `pnpm run contrast`
  measures all six ([the contrast rule](docs/branding.md#the-contrast-rule)).
- **The credit stays.** "Powered by ExClip" ends the footer of the app and
  of the wallet window. It is ExClip's attribution notice
  ([NOTICE](NOTICE)), and no setting removes it.
- **Files that get extra review:** `apps/wallet/fee-receivers.json`,
  `apps/wallet/src/`, the message protocol, the security headers and the
  config rules
  ([CONTRIBUTING](CONTRIBUTING.md#changes-that-get-extra-review)). Change
  them only when the task needs it, and say so.
- **Documentation:** plain Markdown and short sentences. Check every claim
  against the code, add a line under `## [Unreleased]` in `CHANGELOG.md` for
  a change users or operators will notice, and run `pnpm run docs:links`.

## Task: "Make this my own DEX"

A request such as: *Make this my own DEX: call it Acme Swap, operator Acme
Ltd, use acme.svg as the logo, a teal accent, and a 0.1% fee paid to 0x….*

A rebrand changes settings, not code: `exclip.config.ts`, a logo file and,
for a fee, the wallet's fee allow-list and the test that pins it. Change
nothing else. Follow the steps in order, and end with step 9.

### 1. Start the config

If `exclip.config.ts` doesn't exist at the root, copy
`exclip.config.example.ts` to it. If `EXCLIP_CONFIG` is set, edit the file
it names instead. `pnpm run contrast` starts by naming the file it reads,
so it shows which one is in use. Keep the `satisfies ExclipConfigInput`
line, and write plain values: Node loads the file as it is, so no enums or
namespaces ([configuration](docs/configuration.md)). Leave `sodax.apiKey`
empty: the key belongs in the server's environment (step 9). Git ignores
the file, so `git diff` won't show your changes to it.

### 2. Set the brand

In `brand` ([reference](docs/configuration.md#brand)):

- `name`: the product name, plain text, at most 40 characters, no `<` or
  `>`.
- `operator`: the company or person that runs the site, at most 80
  characters. It shows in the footer and the wallet window.
- `colors`: three `#RRGGBB` values from the colour asked for. `accent` is a
  light, saturated shade, because buttons put dark text on it; `accentHover`
  a lighter one; `accentInk` a darker shade of the same hue, for links and
  focus rings on white. Run `pnpm run contrast` and adjust until all six
  pairings say `ok`, with room to spare.
- `termsUrl` and `privacyUrl`: the operator's own `https://` pages. Set them
  only to URLs you were given. Otherwise leave them `null` and hand them
  back.

The name and logo must be the operator's own. A copy run for other people
must not present itself as ExClip or use the ExClip logo
([licence and trademarks](README.md#licence-and-trademarks)). The wallet
window keeps its own palette, whatever the colours
([what doesn't change](docs/branding.md#what-doesnt-change)).

### 3. Add the logo

The logo goes in `apps/web/public` under its own name, for example
`apps/web/public/acme.svg`, and `brand.logo` is then `"/acme.svg"`. If the
file is already there, use it as it is. If it's elsewhere in the
repository, such as the root, move it there, so that `git status` lists one
copy, not two. If it's outside the repository, copy it. Move or copy it
with the shell (`mv`, `cp`) rather than writing it out again: a retyped SVG
can lose a character, and only the screenshots would show it. If you can't
find the file, ask for it. Don't draw one unless asked.

- A square `.svg`, `.png`, `.ico` or `.webp` works best. The wallet build
  inlines it into the wallet page and stops if it's missing
  ([the logo](docs/branding.md#the-logo)).
- Leave ExClip's `apps/web/public/logo.svg` and `icons/` alone, and never run
  `pnpm run brand`: it rewrites them from ExClip's brand kit.

### 4. Set the origins, if you were given domains

`origins.app` and `origins.wallet` are where the app and the wallet popup
will be served ([origins](docs/configuration.md#origins)):

- each is an exact origin: `https://`, a lower-case host, no path, no
  trailing slash;
- the wallet needs a host of its own. The app can't be on the wallet's host
  or below it, but the wallet may be a subdomain of the app's domain
  (`https://swap.acme.example` and `https://wallet.acme.example`).

Use only domains you were given. Without them, leave the examples: the
build then warns that the origins are still the examples, which is expected
until the person picks domains. The wallet's host is for good: passkeys are
bound to it, so it must never change once people use it
([for operators](docs/wallet.md#for-operators)).

### 5. Note the headers each origin must send

Nothing in the repository changes for this, but the person needs to know.
Every response from each host must carry that origin's security headers
([serve the two origins](docs/self-hosting.md#5-serve-the-two-origins)):

- **Option A**, `server.serveStatic: true`: the server serves both builds
  and sends the headers itself. The proxy in front passes `Host`, sets
  `X-Forwarded-Host`, and adds no headers of its own; `server.trustProxy`
  counts the proxies
  ([option A](docs/self-hosting.md#option-a-the-server-serves-both-builds)).
- **Option B**, their own web server or CDN: it sends exactly what
  `pnpm --filter @exclip/config run headers` prints
  ([option B](docs/self-hosting.md#option-b-your-own-web-server-or-cdn)).
  The app host sends its CSP and `cross-origin-opener-policy:
  same-origin-allow-popups`. The wallet host sends a CSP that starts
  `default-src 'none'`, `cross-origin-opener-policy: unsafe-none` and
  `cache-control: no-store`, on every response including `/assets/`, and
  never sets cookies or CORS headers or adds scripts.
- Both hosts send HSTS with `includeSubDomains`, and pass the browser's
  `Origin` header to the server unchanged.

### 6. Set the fee, if one was asked for

Turn the percentage into basis points: 1 % is `100`, the most allowed, so
0.1 % is `10`. Only whole numbers work; if the rate isn't a whole number of
basis points, or is above 1 %, ask. Then follow
[turn a fee on](docs/fees.md#turn-a-fee-on):

1. In `exclip.config.ts`, set `fees.partnerFeeBps` (`10`) and
   `fees.receiver` to the address exactly as given: `0x` and 40 hex digits.
2. Add the same address to `receivers` in `apps/wallet/fee-receivers.json`.
   Keep the `$comment`. Without this the wallet refuses every swap that
   carries a fee ([why it fails closed](docs/fees.md#why-it-fails-closed)).
3. In the same change, update the test that pins that list: in
   `apps/wallet/test/build-config.test.ts`, "the repository ships an empty
   fee allowlist, …" expects `[]`. Make it expect the receiver in lower
   case, which is how `parseFeeReceivers` returns it, and rename it to say
   what it now checks.
4. Tell the person that the allow-list decides where the wallet lets fees
   go: it changes only in a reviewed commit, and someone must confirm who
   controls the address through a channel other than the pull request
   ([CONTRIBUTING](CONTRIBUTING.md#changes-that-get-extra-review)).

### 7. Keep the credit

The footer of the app and of the wallet window ends with "Powered by
ExClip", a link to ExClip's repository. It is ExClip's attribution notice
under section 4(d) of the Apache License ([NOTICE](NOTICE)), no setting
removes it, and tests check it ([the credit](docs/branding.md#the-credit)).
Don't remove, hide, restyle or reword it, and don't edit `NOTICE` or
`LICENSE`. If you're asked to remove it, say why you won't.

### 8. Check your work

Run each of these, and fix what fails:

1. `pnpm run contrast`: all six pairings `ok`.
2. `pnpm typecheck` (it typechecks a root `exclip.config.ts` too),
   `pnpm lint`, `pnpm test` and `pnpm run docs:links`.
3. `NODE_OPTIONS=--max-old-space-size=6144 pnpm build`, or `pnpm build`
   ([the build's heap](#commands)). The build checks the config first and
   stops on a bad value. Then read the wallet build's warnings, the lines
   that start `exclip.config.ts:`
   ([what they mean](docs/troubleshooting.md#the-build-fails-or-warns)):
   one about example origins is expected while there are no domains; one
   about the fee receiver means step 6 isn't done. The dependency notices
   around them are expected too.
4. In the build, `apps/web/dist/manifest.webmanifest` has the new name and
   logo.
5. `pnpm run screenshots --brand`, then look at the PNGs in `screenshots/`:
   the name, logo and accent in both themes, and "Powered by ExClip" at the
   end of the wallet window's footer in the approval shots. They don't
   show the operator or the fee: the app's footer is below the fold, the
   trade shot is the quote before the review, and the approval's swap
   carries no fee. Say so when you hand back.

Don't commit unless you're asked to. When you are, commit the allow-list
and its test together, signed off, plus the logo if the person wants it in
their copy of the repository. `exclip.config.ts` stays out of Git.

### 9. Hand back

End with a short summary: what you changed, including `exclip.config.ts`
(which `git diff` doesn't show), the six contrast ratios, and the result of
each check. Say where to see what the screenshots leave out: with
`pnpm dev` running, the footer at the bottom of `http://localhost:5173`
names the operator, and `http://localhost:5173/api/exclip/config` shows the
fee as `partnerFeeBps` and `feeReceiver`. Then list what the person still
has to do. You can't, or shouldn't, do these yourself:

- **The SODAX API key.** They set it as `SODAX_API_KEY` in the server's
  environment, which the docs prefer to `sodax.apiKey` in production
  ([environment variables](docs/configuration.md#environment-variables)).
  It never goes in a commit. Without it, quotes answer "Trading isn't
  connected".
- **Domains.** Two hosts, the wallet on one of its own. Then `origins` and a
  rebuild of both apps. The wallet's host is for good.
- **DNS and TLS** for both hosts, and the proxy or CDN in front, sending the
  headers from step 5, with `server.trustProxy` set
  ([proxies](docs/self-hosting.md#proxies-and-client-addresses)).
- **The server.** A Node 24 host or a container, Postgres with the
  migrations applied and backed up, and Redis if they want it
  ([self-hosting](docs/self-hosting.md)).
- **Legal pages and review.** Terms of use and a privacy notice for
  `brand.termsUrl` and `brand.privacyUrl`, and a check of what offering
  swaps and charging a fee mean where they operate
  ([operator responsibility](README.md#operator-responsibility)).
- **The fee receiver.** Confirming who controls the address, and reviewing
  the allow-list commit.
- **The release.** Building the wallet in CI from a reviewed commit and
  deploying exactly that build
  ([release controls](docs/embedded-wallet.md#release-controls)).
- **Going live.** Opening in stages, with the smoke checks after each step
  ([open in stages](docs/self-hosting.md#6-open-in-stages)).
