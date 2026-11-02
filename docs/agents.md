# Make your own DEX with a coding agent

ExClip runs under your name, logo, colours and fee, all set in one file. A
coding agent can make those changes for you from one plain-English request,
and check them. It works with coding agents such as Claude Code and Codex.
The instructions are in [AGENTS.md](../AGENTS.md) at the root of the
repository: Codex reads that file, and Claude Code reads it through
`CLAUDE.md`, which points to it.

The agent rebrands your copy and checks it. It doesn't deploy it: your
domains, the server, the SODAX key and your legal pages stay with you.

## Before you start

- A clone of the repository, with Node 24 and pnpm, and `pnpm install` run
  once ([set up](development.md#set-up)).
- Your logo as a file in `apps/web/public`, the folder the app serves,
  ideally a square SVG or PNG ([the logo](branding.md#the-logo)). If you
  leave it somewhere else, the agent moves or copies it there.
- If you'll charge a fee: the EVM address that receives it. Taking a fee on
  swaps can make you a provider of a financial service, so check what it
  means where you operate ([fees](fees.md#turn-a-fee-on)).

## The prompt

Start your agent at the root of the repository and paste:

```text
Make this my own DEX: call it Acme Swap, operator Acme Ltd, use acme.svg as the logo, a teal accent, and a 0.1% fee paid to 0xYourFeeReceiverAddress.
```

Put in your own name, operator, logo file, colour and address. Leave out
the fee to charge none. If you already have them, add your two domains (for
example "the app at https://swap.acme.example and the wallet at
https://wallet.acme.example") and the links to your terms and privacy
notice. Without them, the agent leaves those settings for you.

A fee that isn't a whole number of basis points, such as 0.875 %, becomes
a [fee rate](fees.md#a-fee-rate), per 100,000 of the amount sold. So does
one with a different fee, or none, on swaps with a tokenised stock. The
trade review names your brand as getting the fee, unless you name someone
else in the request.

To share one fee with a platform instead, through a
[fee split](fee-split.md), ask for it and name the factory, for example
"a 0.1% fee on top of the platform's, with the factory 0xFactoryAddress,
paid to 0xYourOperatorAddress". The factory must already be listed in
`apps/wallet/fee-receivers.json`, with values a reviewer read from the
chain. The agent never writes that entry: if it's missing, the agent asks
for it.

## What the agent changes

| What | Where |
|---|---|
| Name, operator, colours, logo path and fee | `exclip.config.ts`, a copy of `exclip.config.example.ts`. Git ignores it |
| Your logo | In `apps/web/public`, for example `apps/web/public/acme.svg` |
| The fee receiver, or your split | Added to `apps/wallet/fee-receivers.json`, the passkey wallet's list of where a fee may go |
| The test that expects that list to be empty | `apps/wallet/test/build-config.test.ts`, changed to expect your receiver or split |

It changes no other code. It keeps the "Powered by ExClip" credit at the end
of the footer: it is ExClip's attribution notice, and every copy shows it
([the credit](branding.md#the-credit)).

## What the agent runs

- `pnpm run contrast`, which measures your colours against
  [the contrast rule](branding.md#the-contrast-rule). The agent picks the
  three shades of your colour and adjusts them until all six pairings pass.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm run docs:links`.
- The build, `NODE_OPTIONS=--max-old-space-size=6144 pnpm build`. Without
  domains, the wallet build warns that the origins are still the examples:
  that's expected until you set yours. So are the notices about libraries
  around it ([the build fails or warns](troubleshooting.md#the-build-fails-or-warns)).
- `pnpm run screenshots --brand`, which saves 28 screenshots of your
  rebrand to `screenshots/`, in both themes, at desktop and phone size.
  They show your name, logo and colour, but not your operator or your fee:
  you check those yourself (below).

It ends with a summary of what it changed, the contrast ratios, the
results, and what's left for you.

## What you still do

The agent can't do these, or shouldn't:

- **The SODAX key.** Set it as `SODAX_API_KEY` in the server's
  environment, which is better than `sodax.apiKey` in production
  ([environment variables](configuration.md#environment-variables)). Never
  put it in a commit or a chat.
- **Domains, DNS and TLS.** Pick two hosts, the wallet on one of its own,
  and set them in `origins`. The wallet's host is for good: passkeys are
  bound to it ([for operators](wallet.md#for-operators)).
- **Serving it.** The server, Postgres and its backups, and the proxy or CDN
  in front, which must send each origin's headers
  ([self-hosting](self-hosting.md)).
- **Legal pages and review.** Your terms of use and privacy notice, and
  what offering swaps and charging a fee mean where you operate
  ([operator responsibility](../README.md#operator-responsibility)).
- **The fee receiver.** Confirm that you control the address. The list it
  goes on changes only in a reviewed commit
  ([contributing](../CONTRIBUTING.md#changes-that-get-extra-review)).
- **The release.** Build the wallet in CI from a reviewed commit, and deploy
  exactly that build
  ([release controls](embedded-wallet.md#release-controls)).
- **Going live.** Open in stages
  ([open in stages](self-hosting.md#6-open-in-stages)).

## Review the changes before you build

1. Run `git status`. Expect `apps/wallet/fee-receivers.json` and
   `apps/wallet/test/build-config.test.ts` changed, and your logo untracked
   under `apps/web/public`. Anything else needs a reason.
2. Run `git diff`. The address in `fee-receivers.json` must be yours,
   character for character, and the test must expect the same address in
   lower case. For a split, check the operator's address and rate under
   `splits`, and that the agent didn't add or change a factory.
3. Open `exclip.config.ts` yourself. Git ignores it, so `git diff` doesn't
   show it. Check:
   - `brand`: your name, operator and logo path, with no "ExClip" in them;
   - `fees.partnerFeeBps`: the fee in basis points, where `100` is 1 % and
     `10` is 0.1 %;
   - or `fees.rate`: the fee per 100,000 of the amount sold, where `875` is
     0.875 %, with `partnerFeeBps` at `0`, and `fees.stockFeeBps`, the fee
     on swaps with a tokenised stock, if you asked for one;
   - `fees.receiver`: your address again, and `fees.receiverName`, if you
     named who gets the fee;
   - or, for a split, `fees.split`: the factory, your address and your rate
     per 100,000, where `100` is 0.1 %, with `partnerFeeBps` at `0` and
     `receiver` at `null`;
   - `origins`: your domains, or the examples if you gave none;
   - `sodax.apiKey`: empty. The agent never handles your key.
4. Look through the screenshots in `screenshots/`: your name, logo and
   colour in both themes, and "Powered by ExClip" at the end of the wallet
   window's footer in the approval screenshots.
5. Run `pnpm dev` and open `http://localhost:5173`. The footer at the
   bottom of the page names your operator, for example "Acme Swap is run by
   Acme Ltd.", and ends with "Powered by ExClip".
   `http://localhost:5173/api/exclip/config` shows your fee:
   `"partnerFeeBps": 10` for 0.1 %, and your address as `feeReceiver`. A
   rate shows as `feeRate`, `{ "rate": 875, "stockFeeBps": 0 }` for
   0.875 %, with your address as `feeReceiver` and its name as
   `feeReceiverName`. A split shows as `feeSplit`, with the splitter, each
   party's name and its rate ([`GET /config`](api.md#get-config)).

## Check before you go live

Agents make mistakes, and they sound just as sure when they're wrong. Check
these three yourself before real users arrive:

- **Contrast.** Run `pnpm run contrast`: all six pairings `ok`. Then follow
  [check your rebrand](branding.md#check-your-rebrand) in a browser, both
  themes included.
- **The fee.** The receiver in `exclip.config.ts` and in
  `fee-receivers.json` is an address you control, and the rate is what you
  meant. Once the server runs, `/api/exclip/config` shows both
  ([smoke checks](self-hosting.md#smoke-checks)). With a split, the
  factory's entry in `fee-receivers.json` matches what the chain says
  ([deploy to Sonic](../contracts/fee-split/README.md#deploy-to-sonic)).
  Make a first trade with a small amount.
- **The origins.** Each is an exact `https://` origin, the wallet on a host
  of its own, and each host sends its headers. The smoke checks compare
  them with what `pnpm --filter @exclip/config run headers` prints.
