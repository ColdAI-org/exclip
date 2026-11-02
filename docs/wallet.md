# The passkey wallet

ExClip can give people a wallet without a browser extension or a seed
phrase to start with. A passkey unlocks it: the same fingerprint, face or
device PIN that signs you in to other sites, or a password manager that
holds passkeys. It opens in a small window of its own, on its own web
address.

It is self-custodial. The keys are made in your browser and stay there,
encrypted. Nobody else can move your funds or recover the wallet for you:
not the operator, and not ExClip.

This page explains the wallet in plain terms, for the people who use it and
the operators who offer it. The design, the signing rules and the full
threat model are in [the embedded wallet](embedded-wallet.md).

## What it can do

| In this release | Not yet |
|---|---|
| Market swaps between its 14 EVM networks, paid out to itself | Limit orders and cancelling orders: use a browser wallet |
| Sending a token to an address on the same network | Swapping straight to someone else's address: swap first, then send |
| Receiving on any of its networks, with the address shown in the wallet window | Bitcoin, Solana, Sui and the other non-EVM networks |
| Showing the 12-word recovery phrase, and moving to Clip Wallet | Signing messages, typed data or arbitrary transactions: there's no way to ask it to |

Its networks are Sonic, Ethereum, Base, Arbitrum, Optimism, Polygon, BNB
Chain, Avalanche, HyperEVM, LightLink, Kaia, Redbelly, Hedera and Robinhood
Chain. One address works on all of them.

The wallet needs a browser that supports the passkey PRF extension, which
turns a passkey into an encryption key. Without it, the wallet window says
"Your browser can't secure an embedded wallet. Use Chrome, Safari 18+, Edge,
or the Clip Wallet extension."

Operators can switch the wallet off with `features.embeddedWallet: false`.
The app then offers browser wallets only
([configuration](configuration.md#features)).

## Why it has its own web address

The app runs on one origin, for example `https://exclip.example.com`, and
the wallet on another, for example `https://wallet.exclip.example.com`. A
browser keeps the storage of two origins apart. So even if something went
wrong on the app page (a bug, a bad dependency, an injected script), it
couldn't read the wallet's keys. All it could do is ask the wallet to sign,
and the wallet checks every request itself, as the next section explains.

Passkeys belong to the wallet's host name, so a look-alike site can't use
them. The wallet also refuses to talk to any page other than the app it was
built for. [Architecture](architecture.md#two-origins) compares the two
origins' rules.

## What happens when you sign

1. The app builds the transactions and opens the wallet window.
2. The window decodes every byte and checks it against what you asked for:
   the tokens, the amounts, the networks, the deadline, and that the money
   comes back to this wallet. Anything else is refused.
3. It checks the minimum you would receive against prices of its own. Below
   97 % of the input between two dollar stablecoins, it refuses. For other
   pairs, a minimum more than 5 % under its own SODAX quote brings up a
   full-screen warning.
4. It shows its own review, built from what it decoded: the network, what
   you pay, what you receive at least, the receiving address, the fees and
   the nonce. When a fee is split, the review says who gets what, such as
   `9.75 USDC · 0.875% to Platform · 0.1% to Acme Ltd`.
5. You approve with your passkey. The window unlocks the keys, signs, locks
   again, wipes what it unlocked and closes.
6. The app sends the signed transactions to the network, one at a time.

A smaller price shave than those limits can get through, with the minimum
shown on the review. Read it before you approve
([embedded wallet: price checks](embedded-wallet.md#price-checks)).

## Back it up

When you create the wallet, it asks how you want to get back in, and you can
always come back to it later. The wallet counts as backed up when one of
these is true:

- **You saved the recovery phrase.** The wallet shows 12 words, after a
  fresh passkey prompt, and asks for three of them back. Write them on
  paper. Anyone with the words can take everything in the wallet.
- **Your passkey syncs.** Your passkey is in a password manager that syncs
  across devices (iCloud Keychain, Google Password Manager, 1Password and
  others), its encrypted backup reached the server, and you confirmed that
  it syncs.
- **You have two passkeys.** Each has its own encrypted backup, so either
  one can restore the wallet.

Until then, the app shows a "Back up your wallet" banner, and it asks you to
keep less than the operator's deposit limit in the wallet: $100 unless the
operator changed `wallet.unbackedLimitUsd`. Once the app reports holdings
at or above the limit, the wallet window shows "Save recovery phrase"
instead of the deposit address. The limit is a reminder, not a lock:
anyone can still send funds to the address.

## Get back in

| What happened | What to do |
|---|---|
| A new phone or computer, and your passkey syncs | Open the app and choose "Sign in with passkey". The wallet restores itself from its encrypted backup |
| You lost one passkey, and you have another | Sign in with the other one |
| You lost your passkeys, and you saved the phrase | Install the Clip Wallet extension, choose "Import a recovery phrase" and type the 12 words. The same addresses appear there |
| You lost every passkey and the phrase | The funds can't be recovered, by anyone |

"Move to Clip Wallet" in the wallet does the same move on purpose: it shows
the phrase so you can import it. The passkey wallet keeps working, because
both hold the same keys.

## What the server can and can't see

| The server stores or sees | The server never gets |
|---|---|
| Each passkey's public key, ID, sign count and transports | The passkey's private key, or the encryption key it unlocks |
| Encrypted backups of up to 16 KB, which only your passkey opens | Your recovery phrase, the vault's password or the seed |
| The time each passkey was created and last used | Which wallet address a passkey or backup belongs to |
| Your IP address, to count rate limits (for IPv6, only its first half). No log records it | Your balances: the app reads them from the networks directly |
| In the swaps you make: your addresses, tokens and amounts, which it passes to SODAX without logging | A way to sign, or to point the app at another wallet |

Backups are append-only: a stored version is never rewritten. Reading a
backup, adding a version or retiring a passkey needs a fresh passkey
signature, which the server checks against the stored public key.

## For operators

- **Give the wallet a host of its own**, and keep it. Passkeys are bound to
  that host. If you move it, people can no longer open their wallet in your
  app, though their phrase or Clip Wallet still reaches the funds.
- **Treat a wallet deploy like a key ceremony.** Code served from the wallet
  host can use every passkey that signs in there. Build it in CI from a
  reviewed commit, and check that what you serve matches the build
  ([release controls](embedded-wallet.md#release-controls)).
- **Back up the database.** A new device restores only from the server
  backup. Losing the database strands everyone who has no saved phrase
  ([self-hosting](self-hosting.md#3-prepare-the-database)).
- **Set the limits.** `wallet.unbackedLimitUsd`, `wallet.maxBackupVersions`
  and `wallet.dailyNewPasskeys` are in [configuration](configuration.md#wallet).
- **Fees fail closed.** The wallet signs a swap with a partner fee only when
  `apps/wallet/fee-receivers.json` lets it: a plain fee to a listed
  receiver, or a [fee split](fee-split.md#the-wallet)'s exact fee to the
  splitter of a listed split, which the wallet works out itself
  ([fees](fees.md)).
