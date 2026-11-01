# Development

This page covers the repository's layout, the scripts, the tests, and the
two changes people make most: adding a network and adding an asset.
[Contributing](../CONTRIBUTING.md) has the rules for pull requests,
including the files that need a second reviewer.

## Set up

You need Node 24 (the version in `.nvmrc`) and pnpm 12.6.0. The repository
pins pnpm in `package.json`, so `corepack enable` gives you the right one.

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts three processes:

| Process | Address | Notes |
|---|---|---|
| The app | `http://localhost:5173` | Vite. Passes `/api` to the server |
| The passkey wallet | `http://localhost:5311` | Vite. Passes `/api` to the server |
| The server | port 8080 | `node --watch`, restarted when its files change. With `--dev` it may keep everything in memory, and it ignores `server.serveStatic` |

Without a config file, the defaults apply. The app loads and shows markets,
and quotes answer "Trading isn't connected" until the server has a SODAX
key. Put one in `exclip.config.ts` (copied from `exclip.config.example.ts`)
or in `SODAX_API_KEY`. Restart `pnpm dev` after you change the config:
each process reads it when it starts.

Development always uses the localhost origins above, whatever
`origins` says ([configuration](configuration.md#origins)). The dev servers
send the production security headers, except the CSP, because Vite's dev
client needs inline code. To check the CSP, build and run `preview`
([scripts](#scripts)).

To try the passkey wallet without sending anything, set
`localStorage["exclip.dev.signOnly"] = "1"` on `http://localhost:5173`. The
wallet then signs as usual, and the app stops before it broadcasts. This
works only in a development build.

## The repository

| Path | What it holds |
|---|---|
| `apps/web` | The app: React and Vite. `src/pages` and `src/components` are the screens; `src/lib` is the logic (the catalogue, the trade flow, the wallet runtime, formatting) |
| `apps/wallet` | The passkey wallet popup: plain TypeScript and Vite. `src/sodax` holds its signing policy, price checks and the networks and tokens it knows. `fee-receivers.json` is its fee allow-list |
| `apps/server` | The server: Express 5. `src/routes` for the API, `src/services` for the SODAX proxy, market data and wallet backups, `migrations` for Postgres |
| `packages/config` | `exclip.config.ts`: its types, defaults and checks, what each build may see, and both origins' security headers |
| `packages/clip-wallet-core`, `packages/clip-wallet-vault` | Clip Wallet's packages, vendored under the same Apache-2.0 licence. Fix them upstream, not here |
| `brand` | The brand kit: hand-written SVGs and the review sheet ([brand kit](../brand/README.md)) |
| `tools` | The scripts behind `pnpm run brand`, `pnpm run screenshots` and `pnpm run docs:links` |
| `docs` | These pages |

Node 24 runs the server's TypeScript directly, without a build step. It
won't strip types from files under `node_modules`. pnpm links the
workspace packages there, and Node follows each link to the package's own
folder, so their TypeScript runs. Keep that layout when you deploy
([self-hosting](self-hosting.md)).

## Scripts

From the repository root:

| Command | What it does |
|---|---|
| `pnpm dev` | Starts the three development processes |
| `pnpm build` | Builds the app into `apps/web/dist` and the wallet into `apps/wallet/dist` |
| `pnpm start` | Starts the production server |
| `pnpm typecheck` | Runs `tsc` in every package |
| `pnpm lint` | Runs ESLint over the repository |
| `pnpm test` | Runs every package's tests |
| `pnpm run brand` | Checks the brand kit's SVGs, then renders the review sheet, the app's logo and its icons |
| `pnpm run brand:outline` | Outlines the wordmark again from Inter Bold |
| `pnpm run screenshots` | Takes the README's screenshots against a stand-in for SODAX ([screenshots](#screenshots)). With `--brand`, under your own brand |
| `pnpm run contrast` | Checks `brand.colors` in your config against [the contrast rule](branding.md#the-contrast-rule) |
| `pnpm run docs:links` | Checks every relative link, anchor and image in the Markdown files |

For one package:

| Command | What it does |
|---|---|
| `pnpm --filter @exclip/web run preview` | Serves the app's build with the production headers, CSP included |
| `pnpm --filter @exclip/wallet run preview` | The same for the wallet |
| `pnpm --filter @exclip/config run headers` | Prints both origins' security headers, for a web server or CDN in front |
| `pnpm --filter @exclip/wallet run gen:tokens <file>` | Writes the wallet's token table again ([add a network](#add-a-network)) |
| `pnpm --filter <package> test` | Runs one package's tests |

CI runs `pnpm install --frozen-lockfile`, then typecheck, lint, the link
check, test and build, on every push to `main` and every pull request.

## Tests

| Package | Runner | What the tests cover |
|---|---|---|
| `packages/config` | `tsx --test` | Defaults, every check, the environment overrides, what each build may see |
| `apps/server` | `node --test` | The SODAX proxy and the key's redaction, fee pinning, rate limits, storage and migrations, the wallet's backup API, serving the builds, a start on a port that's taken |
| `apps/web` | `tsx --test` | The build config, the catalogue, formatting, the passkey wallet's trade flow on the app's side, the page's CSP check |
| `apps/wallet` | `tsx --test` | The signing policy, price checks, the hub account, the message protocol, storage, passkeys, the build config |

The tests need no network, database or Redis. The server's tests run it on
a local port, with memory stores and a stubbed upstream that answers with
real SODAX responses captured from the live API
([`apps/server/test/fixtures`](../apps/server/test/fixtures/README.md)).
The wallet's tests build swap payloads the way SODAX's SDK does
(`apps/wallet/test/sodax-fixtures.ts`), so its policy is tested against
the shapes it will really see.

Many tests are named for the rule they prove, and the documentation quotes
those names: [security](security.md#invariants-and-how-they-are-tested) and
[fees](fees.md#the-tests-behind-this) list them. When you change a rule,
change its test and those pages in the same pull request.

## Add a network

Which networks the app offers comes from SODAX: its token list says which
assets trade where, and the SODAX SDK knows how to reach each network and
which wallet family signs for it. A network the SDK supports appears
without a code change. Two things improve it, and one is needed for the
passkey wallet.

### In the app

Add a `net(...)` line to `NETWORKS` in
[`apps/web/src/lib/catalog.ts`](../apps/web/src/lib/catalog.ts):

```ts
net("0x2105.base", "Base", "Base", "B", 220, "https://basescan.org/tx/", 10),
```

The fields are SODAX's chain key, the full and short names, a one- or
two-letter badge, the badge's hue, the explorer's transaction URL (or
`null`) and a typical confirmation time in seconds, used for the estimated
time. Without a line, the app shows the chain key as the name, a badge made
from it, no explorer link and a 30-second estimate.

A network from a new wallet family, one that isn't EVM, Solana, Sui,
Bitcoin, Stellar, NEAR, Injective, Stacks or ICON, also needs that family
in `apps/web/src/lib/wallet-runtime.tsx` and support in SODAX's wallet SDK.

### In the passkey wallet

The passkey wallet signs only on the networks it lists, so a new one needs
three changes, reviewed by a second person:

1. **The network.** Add a `chain(...)` line to `EVM_CHAINS` in
   [`apps/wallet/src/sodax/chains.ts`](../apps/wallet/src/sodax/chains.ts):
   the chain ID, SODAX's relay ID, the native coin, a fee cap, and SODAX's
   asset manager on that network. Copy each value from `@sodax/types`, at
   the paths the file's header lists, and set the fee cap as its comment
   explains.
2. **The app's copy of the list.** Add the same key to `EMBEDDED_CHAINS` in
   [`apps/web/src/lib/embedded-tx.ts`](../apps/web/src/lib/embedded-tx.ts).
   The test "the embedded network list matches what the popup signs on"
   fails until both lists agree.
3. **The tokens.** Save SODAX's token list (`GET /swaps/tokens`) as JSON,
   then write the wallet's table again:

   ```sh
   pnpm --filter @exclip/wallet run gen:tokens <path-to-swaps_tokens.json>
   ```

   The script keeps the networks the wallet knows, drops tokenised stocks,
   checks every address, and writes `apps/wallet/src/sodax/tokens.ts`. Read
   the diff before you commit it.

Then update the network lists in [the passkey wallet](wallet.md),
[concepts](concepts.md#networks-and-assets) and the
[embedded wallet design](embedded-wallet.md#networks).

## Add an asset

An asset is something people can search for, open and trade, such as ETH.
SODAX lists tokens, which can be several forms of one asset (ETH, WETH and
WETH.e are all ETH). The app shows only assets in its catalogue.

1. **Add it to the catalogue.** Add a line to `ASSETS` in
   [`apps/web/src/lib/catalog.ts`](../apps/web/src/lib/catalog.ts):
   `crypto(...)` for most assets, `stable(...)` for a dollar stablecoin.

   ```ts
   crypto("ETH", "Ethereum", 230, "The native asset of Ethereum and …", { aliases: ["ETH", "WETH", "WETH.e", "UETH"] }),
   ```

   The fields are the symbol, the name, the hue of its generated icon, a
   sentence for its page, and options. `aliases` lists every SODAX token
   symbol that counts as this asset; without it, only the symbol itself
   does. `isNew: true` puts it in the home page's "New" card.
2. **Give it a price.** Add its CoinGecko ID to `COINGECKO_IDS` in
   [`apps/server/src/services/markets.ts`](../apps/server/src/services/markets.ts).
   The server asks CoinGecko only for the IDs in that list. Without one,
   the asset trades but has no market price, chart or stats.

No test checks that the two lists match yet, so check both in review.

Where the asset trades, its contract addresses and its decimals all come
from SODAX, so there is nothing else to add. Tokenised stocks stay out
whatever the catalogue says: the app hides them, and the server refuses
them.

## Change the wallet's rules

The passkey wallet's signing policy, price checks and fee allow-list
decide what people can sign. [Contributing](../CONTRIBUTING.md#changes-that-get-extra-review)
lists the files and the review they need, and
[the embedded wallet design](embedded-wallet.md) explains each protection.
Two rules catch people out:

- `apps/wallet/src/protocol.ts` and `apps/web/src/lib/wallet-protocol.ts`
  must stay byte-for-byte identical. A test fails if they differ.
- A tighter limit needs no discussion. A looser one needs an issue and
  agreement first.

## Upgrade the SODAX SDK

The three SODAX packages are pinned to one exact version in
`apps/web/package.json`, and the wallet's contract addresses and chain
constants were copied from that version's `@sodax/types`. To upgrade:

1. Move all three packages to the new version together.
2. Compare the constants in `apps/wallet/src/sodax/chains.ts` and
   `apps/wallet/src/sodax/hub.ts` with the new version's, at the paths
   their headers list. Update the version in those headers.
3. Compare `apps/wallet/test/sodax-fixtures.ts`, which builds payloads
   the way the old version does, with what the new one builds. Then run
   the tests.

## Screenshots

`pnpm run screenshots` takes the README's screenshots: five screens, in
light and dark, at desktop and phone size, saved to `docs/media`. Run it
after a visible change to the UI, and commit the PNGs.

It starts the app's and the wallet's development servers on ports 5173 and
5311, so stop `pnpm dev` first. It builds nothing, and it needs no server,
no SODAX key and no network:

- The browser resolves no host but `localhost`. It stops every request
  that isn't for one of the two development servers, and the run lists
  them at the end.
- The script answers the app's calls to `/api/exclip` itself, from
  `tools/screenshots/fixtures`: the public config, made-up prices and
  charts, part of SODAX's token list, and quotes at those prices. The
  browser's clock is fixed at the snapshot's time.
- The connected wallet is a made-up account, put straight into the app's
  wallet state, so no wallet extension or SDK loads.
- The passkey wallet's review is `tools/screenshots/approval.ts`: the
  wallet's own screens and signing policy on a canned swap, which nothing
  can sign.
- The run uses `tools/screenshots/screenshots.config.ts`, which sets
  nothing, so the screenshots show ExClip's own name, logo and colours
  whatever your `exclip.config.ts` says.

`pnpm run screenshots --brand` takes the same screenshots under your
`exclip.config.ts` (or the file `EXCLIP_CONFIG` names): your name, operator,
logo, colours, fee and origins. They go to `screenshots/` at the root, which
Git ignores, so `docs/media` keeps ExClip's.

It drives Chromium through Playwright. Install it once with
`pnpm exec playwright install chromium`. If it won't start, the script
tries Google Chrome. The app uses the system's font, so screenshots taken
on another operating system look a little different.

## Documentation

These pages are plain Markdown. Write short sentences, check each claim
against the code, and take every number (tests, networks, tokens) from the
code or a test run. `pnpm run docs:links` checks that every relative link,
heading anchor and image in the repository's Markdown resolves.
