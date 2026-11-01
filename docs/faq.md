# FAQ

Short answers, each with a link to the page that has the long one. Where an
answer says "ExClip", a copy someone else runs uses its own name.

## Using ExClip

### Does ExClip hold my funds?

No. Your funds stay in your wallet until a SODAX solver fills your swap.
The server never gets a private key and can't sign for you
([concepts](concepts.md#what-exclip-is-and-isnt)).

### What does a swap cost?

The network's gas, SODAX's fee, which is included in the rate, and the
operator's fee if the operator set one. ExClip's default is no fee. The
review shows each cost before you confirm
([fees](fees.md#what-a-swap-costs)).

### Which wallets can I use?

A browser wallet from any of nine families: EVM, Solana, Sui, Bitcoin,
Stellar, NEAR, Injective, Stacks and ICON. Or the passkey wallet built into
ExClip, on 14 EVM networks, where the site offers it. Clip Wallet is listed
first when it's installed.

### Which networks and assets can I trade?

The ones SODAX supports and the site lists. ExClip's catalogue names 36
assets and 22 networks, and SODAX's token list says where each asset trades
([networks and assets](concepts.md#networks-and-assets)).

### Are the swaps real?

Yes. ExClip trades on live networks only, with real funds. It has no test
network mode. ExClip is a preview, so start with small amounts
([security](security.md)).

### Why does the passkey wallet open its own window?

It runs on its own web address, so a problem on the app's page can't reach
its keys. The window checks every request itself and shows its own review
before you approve
([why it has its own web address](wallet.md#why-it-has-its-own-web-address)).

### Why did the passkey wallet refuse my swap?

It signs only a swap that matches what you asked for. It also refuses a fee
to an address it doesn't list and, between two dollar stablecoins, a
minimum below 97 % of what you pay. For other pairs, a minimum more than
5 % under its own SODAX quote brings up a full-screen warning
([what happens when you sign](wallet.md#what-happens-when-you-sign)).

### I lost my phone. Can I get my passkey wallet back?

If your passkey syncs, sign in on the new device. If you saved the recovery
phrase, import it into Clip Wallet. If you lost every passkey and the
phrase, nobody can recover the funds
([get back in](wallet.md#get-back-in)).

### Can the operator see my recovery phrase or move my funds?

The operator's server can't. It stores only encrypted backups that your
passkey opens, and never gets your phrase or a key
([what the server can and can't see](wallet.md#what-the-server-can-and-cant-see)).
The wallet window's code comes from the operator's wallet host, though, so
you trust the operator to serve the reviewed build
([trust model](security.md#trust-model)).

### Can I place limit orders?

Yes, with a browser wallet, from a pair's page such as `/trade/BTC-USDC`.
You choose how long an order lasts: 1 hour, 1 day, 7 days, 30 days, or
until it fills or you cancel it. The passkey wallet can't place them yet
([market swaps and limit orders](concepts.md#market-swaps-and-limit-orders)).

### Where is my trade history kept?

In your browser, for that site only. ExClip's server doesn't keep it. You
can export it as a CSV file. Another browser or device doesn't see it.

### Why can't I find tokenised stocks?

They're off unless the site's operator has switched them on. Where they're
on, a Stocks screen lists them. Even then, they're refused in some
countries, and you confirm a few statements before your first trade
([tokenised stocks](tokenised-stocks.md#what-users-see)).

## Running ExClip

### Do I need ColdAI's permission to run it?

No. The Apache-2.0 licence lets you run, change and share it. It doesn't
cover the "ExClip" name or logo, so a copy you run for other people needs
your own name and logo. Rebrand freely; keep the "Powered by ExClip"
credit, the only use of the ExClip name your copy needs, which ColdAI LLC
permits ([branding](branding.md)).

### Do I need a SODAX API key?

For quotes and trading, yes: get one from [SODAX](https://sodax.com).
Without one, the app loads and shows prices, and quotes answer "Trading
isn't connected". Only the server holds the key
([architecture](architecture.md)).

### What do I need to host it?

Two `https` origins, one for the app and one for the wallet, a Node 24
process, and Postgres. Redis is optional. The server needs no build step,
and the app and the wallet are static files
([self-hosting](self-hosting.md)).

### Can I run it without the passkey wallet?

Yes. Set `features.embeddedWallet: false`. The app then offers browser
wallets only, the wallet's server routes are off, and you needn't serve the
wallet's build. Redis or Postgres is then enough for storage
([configuration](configuration.md#features)).

### Can I charge a fee?

Yes, up to 1 % of each swap. You set the fee in `exclip.config.ts`, add the
receiver to `apps/wallet/fee-receivers.json` in a reviewed commit, and
check what charging a fee means where you operate
([turn a fee on](fees.md#turn-a-fee-on)).

### Can I offer tokenised stocks?

They're off by default, and ExClip can't tell you whether you may offer
them: take legal advice first. Switching them on needs a reverse proxy that
reports each visitor's country, two secrets, and a wallet rebuild. ExClip
then refuses them in a baseline of countries, and in any you add, and asks
each user to confirm a few statements
([tokenised stocks](tokenised-stocks.md)).

### Can I use my own name, logo and colours?

Yes, without forking: they're settings in `exclip.config.ts`. Rebrand
freely; keep the "Powered by ExClip" credit at the end of the footer, and
keep each colour readable against the canvas
([branding](branding.md)).

### Can I remove the "Powered by ExClip" credit?

Keep it: rebrand freely, but keep the credit. No setting removes it, and
[NOTICE](../NOTICE) makes it ExClip's attribution notice
([the credit](branding.md#the-credit)).

### Can I change the domains later?

The app's, yes: set `origins.app` and rebuild both apps. Keep the wallet's
host. Passkeys belong to it, and moving it locks people out of their wallet
in your app ([for operators](wallet.md#for-operators)).

### What happens to people's funds if my server goes down?

Your server never holds funds, so none are at risk. People can't trade
through your app while it's down. Passkey wallet users who saved their
recovery phrase can still reach their funds in Clip Wallet
([get back in](wallet.md#get-back-in)).

### Has ExClip been audited?

Not yet. No independent firm has audited it. The tests prove the rules
listed under
[invariants](security.md#invariants-and-how-they-are-tested), and
[known limitations](security.md#known-limitations) lists what isn't covered.

### How do I update?

Read the changelog, rebuild, apply new migrations, restart the server, and
deploy the app and the wallet together
([updating](self-hosting.md#updating)).

### Who do I tell about a security problem?

Report it privately, as [SECURITY.md](../SECURITY.md) explains. For a copy
someone else runs, tell its operator too.
