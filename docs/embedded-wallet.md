# The embedded passkey wallet

ExClip can give people a wallet without a browser extension. It is a
self-custodial vault that a passkey unlocks, running in a popup window on an
origin of its own. This page explains how it is built and what protects it.
It also lists what you must keep in place when you deploy or change it.

The popup is `apps/wallet`. The app's side is in `apps/web/src/lib/`
(`embedded*.ts`). The vault itself is Clip Wallet code, vendored in
`packages/clip-wallet-vault` and `packages/clip-wallet-core`.

## How it fits together

```text
App origin: apps/web                            Wallet origin: apps/wallet (popup)
  Connect / Trade / Transfer sheets               channel   ready → one request → one result
  embedded.ts         connect, back up            screens   create · sign in · recovery · review
  embedded-client.ts  WalletPopup  ⇄ postMessage ⇄ wallet   vault flows (lock and wipe in finally)
  embedded-tx.ts      SODAX transactions, nonce,  policy    decode, match the plan, allowlists
                      gas, broadcast, relay       Clip Wallet vault + IndexedDB
        │                                               │  backup API (same origin as the popup)
        ▼                                               ▼
  SODAX SDK + EVM RPCs                            apps/server: encrypted backups, checked
                                                  with WebAuthn; single-use challenges
```

The app never holds a key. It builds transactions, asks the popup to sign
them, and broadcasts what comes back. The popup unlocks the keys for one
request at a time, after a fresh passkey prompt, and checks every byte it is
asked to sign.

## Two origins

- **The wallet has a host of its own.** Set `origins.wallet` to a host that
  serves nothing else, for example `https://wallet.example.org`. Passkeys are
  created with the wallet host as their relying-party ID, so no other site can
  use them. The config refuses an app origin on the wallet's host or below it,
  because a page there could use the same passkeys.
- **Strict headers.** Every wallet response carries the headers from
  `walletSecurityHeaders` in `packages/config/src/headers.ts`. The CSP starts
  from `default-src 'none'`, allows only the wallet's own scripts and styles,
  enforces Trusted Types and forbids framing. `connect-src` allows exactly
  three destinations:
  - the wallet's own origin, for its backup API;
  - SODAX's quote endpoint, `https://api.sodax.com/v1/intent/quote`;
  - Sonic's public RPC, `https://rpc.soniclabs.com`.

  A Permissions-Policy allows WebAuthn on the wallet itself and nothing else.
- **No injected markup, no WebAssembly.** The popup builds its interface with
  DOM calls only, never `innerHTML`, which Trusted Types would block anyway. A
  build check fails the build if the built page has inline script, inline
  style or an external URL. The vault's `hash-wasm` import is replaced by a
  stub that throws, and Argon2id runs in pure JavaScript.
- **Origins are fixed at build time.** Each build bakes in, from
  `exclip.config.ts`, the wallet origin and the one app origin the wallet
  answers. The app trusts only the wallet origin in its own build. The
  server's `/config` answer can switch the wallet off, but it can't point the
  app at another wallet.

## Messages between the app and the popup

The protocol is defined in `apps/wallet/src/protocol.ts`. An identical copy
lives in `apps/web/src/lib/wallet-protocol.ts`, and a test fails if the two
differ.

- Messages are versioned and carry `kind: "exclip-wallet"`. Each message type
  has an exact set of keys, strings have length limits, a message is at most
  64 KB, and request ids are 128-bit random values.
- The app posts only to the exact wallet origin. It accepts messages only from
  the window it opened, at that origin.
- The popup accepts only its `window.opener`, at the app origin in its build.
  It takes one request, sends one answer and closes. Both sides time out.
- Answers carry public data only: addresses, signed transactions, hashes,
  booleans and counts.
- The app opens the popup synchronously in the click handler, before any
  `await`, so mobile browsers don't block it. Quotes and RPC calls happen while
  the popup waits for its request.
- There is no message type for `personal_sign`, typed data or arbitrary
  transactions, so nobody can ask the popup for them.

## The vault

- **A passkey with PRF.** Creating a wallet registers a discoverable,
  user-verified passkey (ES256 or EdDSA, no attestation) with the WebAuthn
  **PRF** extension. A browser without PRF can't have an embedded wallet. The
  popup says so and points to a browser that has it, or to the Clip Wallet
  extension.
- **A password nobody sees.** Clip Wallet's vault encrypts under a password.
  The popup derives that password from the passkey that created or restored
  the wallet on this device:
  `HKDF-SHA256(PRF output, salt = credential id, info = "exclip/embedded-wallet/vault-password/v1")`
  (`apps/wallet/src/password.ts`). It is never shown or sent. One copy is
  kept in IndexedDB, sealed under the seed, so that any passkey enrolled in
  the vault can reach it once it has unlocked the vault. Opening that copy
  takes the seed, so it gives nothing away.
- **Storage.** The encrypted vault and public facts live in IndexedDB on the
  wallet origin. Every unlock takes a fresh user-verified passkey prompt, and
  the flow locks the vault and wipes the PRF output in a `finally` block.
  Showing the deposit address needs no unlock, because it comes from the
  saved public facts. A signing review is built from the request and those
  facts, before the prompt.
- **The status record** holds the backed-up state, known recipients and pinned
  hub accounts. One popup at a time writes it (`navigator.locks`), and it
  carries an HMAC-SHA256 under a random per-wallet key that is sealed with the
  seed. Every unlock checks it. A record that fails the check is reset to safe
  defaults, and a signature whose unlock found the failure is refused.

## Encrypted backups

- The popup makes a backup with Clip Wallet's `createPasskeyBackup`. Only the
  passkey's PRF output opens it, so the server stores ciphertext it can't read.
- The server keeps numbered backup versions per passkey and never rewrites
  one: a database trigger refuses updates. Registering a passkey checks its
  WebAuthn registration. Every later read, append or retire needs a fresh
  assertion, which the server verifies against the stored public key, with
  the wallet origin and the wallet host as the expected origin and
  relying-party ID. The PRF output never leaves the browser:
  `clientExtensionResults` is always sent empty.
- The API can retire a passkey, with a fresh assertion from that passkey.
  Once it has been retired for 30 days, the server deletes it and its
  backups, at the next new registration. The popup in this release writes one
  version per passkey, when it registers the passkey, and never retires one.
- "Sign in with passkey" on a new device restores from the backup. The server
  returns every stored version, newest first, and the popup uses the first one
  that decrypts. A bad append can't hide a good older version.
- A backup is uploaded only after the popup has decrypted it, under the same
  PRF output, back to the vault's own phrase.
- If an upload fails, the popup keeps the registration locally and offers
  "Retry server backup". The retry uploads it as a late registration, checked
  against that registration's public key. If the first upload had landed
  after all, the retry counts as done.
- Registration is open to anyone, so two limits bound storage:
  - `wallet.maxBackupVersions` (default 50) per passkey. Appends past it are
    refused, and nothing is deleted to make room.
  - `wallet.dailyNewPasskeys` (default 2,000) new passkeys per UTC day
    across all users. Past it, new sign-ups pause until the next day.
- Each challenge is single-use and short-lived. It is issued for one
  operation (register, fetch, append or retire), and the others refuse it. An
  assertion made to read a backup can't append or retire one.

## Signing

The app sends a **plan** and up to three unsigned transactions. The plan is
what the user asked for, built from their input and not from SODAX's answer.
The popup's policy (`apps/wallet/src/sodax/policy.ts`) decodes every byte and
checks that the encoding is canonical. It then accepts only these shapes, on
networks it knows:

- an exact token approval (or a reset to 0, then an exact approval) to this
  trade's SODAX spender;
- then the SODAX deposit that carries the hub calls, or, on Sonic, the
  intent itself.

The intent must match the plan in every field:

- the tokens, the gross amount, the minimum received and the networks;
- a deadline at most 24 hours away;
- no partial fill and no solver;
- the creator: this wallet's SODAX hub account;
- the destination: **this wallet's own address**.

Further rules:

- **Fees.** A partner fee goes only where `apps/wallet/fee-receivers.json`
  lets it. That file is committed and reviewed. Its lists are empty by
  default, which means the popup refuses every swap that carries a fee.
  - A plain fee is at most 1 %, to an address under `receivers`.
  - A [fee split](fee-split.md#the-wallet)'s fee goes to the splitter that
    the popup works out itself, from a split under `splits` and its
    factory's entry, never from the request. It must be exactly the split's
    total rate of the amount sold, rounded down: one unit more or less is
    refused. The operator's rate is at most 1 %, and the total may reach
    the factory's listed cap.
  - A split's fee on a swap with a tokenised stock on either side is
    refused. The popup tells stocks from its own table.
- **Gas.** Nonces must be consecutive, and gas is at most 5 million per
  transaction. The fee per gas is capped per network: 500 gwei on Ethereum,
  10 gwei on the Ethereum rollups and BNB Chain, and never above 10,000 gwei.
- **Sends** move a listed token to a full address. A mixed-case address must
  pass its EIP-55 checksum, and the review shows the checksummed form. The
  address can never be a token or SODAX contract.
- **Tokenised stocks.** A build with `stocks.enabled` off lists none, so the
  popup refuses to swap or send a stock. A build with it on also lists the
  stocks in `apps/wallet/src/sodax/stock-tokens.ts`, and checks each like
  any other token. The review shows a "Tokenised stock" badge after the
  stock's amount, and the disclaimer. A stock has no price band, so without
  the popup's own quote its price shows as unchecked. The popup knows
  nothing of the visitor's country or confirmation: the app and the server
  check those ([tokenised stocks](tokenised-stocks.md#what-users-see)).
- **The hub account.** The popup looks up this wallet's SODAX hub account
  itself, on Sonic's public RPC, with the same call the SODAX SDK makes. Once
  the user signs a payload that agrees with the answer, the popup pins it for
  that network and refuses any later different answer. The review shows it as
  "Your SODAX account on Sonic".
- **The review** is built only from what the policy decoded:
  - the network;
  - you pay, and you receive (at least);
  - the receiving address and the hub account;
  - the spender, the fees and the fee receiver. For a split, the fees name
    each party and its rate, and the receiver is named as the fee splitter;
  - the nonce;
  - the wallet host the user is signing from.

  For sends, it warns about first-time recipients and look-alike addresses
  (the same first and last four characters). For swaps and sends, it warns
  when the network fee could be more than 5 % of the amount that moves. That
  check is exact when the network's own coin moves. For a token, it runs only
  when both the coin and the token have a price band, and warns only when the
  fee is above 5 % even at the most generous band prices. Other token moves
  show the fee without a warning.
- **Approve with passkey** runs a fresh passkey prompt. After unlocking, the
  popup derives every saved address again and compares them. It then runs the
  policy again with those addresses, and signs only if that gives exactly the
  reviewed transactions. Then it locks, wipes and closes.
- **Broadcast.** The app broadcasts the signed transactions in order, each
  only after the previous one succeeded on chain. It stops if a node returns a
  hash that differs from the popup's.

## Price checks

The minimum received is the one economic field the page controls. The popup
therefore checks it against references of its own
(`apps/wallet/src/sodax/price.ts`):

- **USD stablecoin to USD stablecoin:** refused when the minimum is below 97 %
  of the input, fee included. A plain fee (at most 1 %) plus the largest
  slippage setting (1 %) stays above that line. A split's fee may reach its
  factory's cap: 1.875 % with the deploy script's defaults. With that fee
  and 1 % slippage, even a swap at par comes within a fraction of a percent
  of the line, so a pair quoted a little below par is refused
  ([known limitations](fee-split.md#known-limitations)).
- **Other pairs:** the popup asks SODAX for a quote itself, with the same call
  the SDK makes. The request carries no address, cookies or referrer. A
  minimum more than 5 % below that quote opens a full-screen warning, with
  Reject focused.
- **No quote** (offline, an error, or no answer within 5 seconds): a built-in
  table of price bands stands in. The bands are:
  - USD stablecoins, $0.95–1.05;
  - the ETH family, $300–50,000;
  - the BTC family, $5,000–1,000,000.

  The popup raises the same warning when the minimum is under 95 % of the
  input even at the most generous prices. Pairs with no band get a plain
  "couldn't check this price" warning.
- A quote never lifts the stablecoin refusal. For other pairs, a quote that
  arrives replaces the band check, so a wrong quote from SODAX could hide a
  warning the bands would have raised. A missing quote falls back to the
  bands.

SODAX's quote endpoint has to answer the wallet origin's CORS preflight.
Check that from your wallet host. Until it answers, only the band table
protects non-stable pairs.

## Receiving, and the limit before a backup

- **The deposit address is shown only in the popup.** "Show my address" in
  the app opens the wallet window. The popup shows the checksummed address in
  groups of four, with a QR code from its own encoder. It also offers "Check
  the address with my passkey". The app shows only a shortened form on its
  wallet button, never the full address or a QR code. The address people copy
  therefore comes from the popup, and a script on the app page can't swap it.
- **The recovery step.** Creating a wallet ends with it. The user picks one
  of:
  - "Save recovery phrase", followed by a three-word check;
  - "My passkey is saved in a synced password manager", offered only when the
    passkey syncs and its server backup was saved;
  - "Not now", which skips the step.

  The phrase is shown only in the popup, after a fresh prompt. It is hidden
  when the popup is hidden (minimised, for example), and never put on the
  clipboard.
- **Backed up** means one of these:
  - the recovery phrase was shown and the three-word check passed;
  - the passkey has a server backup, and the user confirmed that it syncs;
  - two passkeys each have a server backup.
- **The banner and the limit.** Until the wallet is backed up, the app shows a
  "Back up your wallet" banner. The deposit limit, `wallet.unbackedLimitUsd`
  (default $100), is stated in the app's Receive sheet and in the popup.
- **The popup has its own copy of the limit.** It is baked into the wallet
  build, so the page can't raise it. The popup has no balance source of its
  own, though. It hides the address behind "Save recovery phrase" only when
  the app reports holdings at or above the limit. An app that under-reports,
  or reports nothing, gets the address shown, with the warning.
- The limit is a nudge, not a guarantee: anyone can send to the address on
  chain.
- Users can add another passkey (each gets its own backup), show the recovery
  phrase, or move the wallet to Clip Wallet.

## Networks

Version 1 signs two kinds of transaction. The first is market swaps between
14 EVM networks:

- Sonic, Ethereum, Base, Arbitrum and Optimism;
- Polygon, BNB Chain, Avalanche and HyperEVM;
- LightLink, Kaia, Redbelly, Hedera and Robinhood Chain.

The second is sends within a single network. Anything else shows "Use a
browser wallet for this network". Limit orders and cancels need a browser
wallet or Clip Wallet.

## Threat model

| Threat | What protects against it | What remains |
|---|---|---|
| XSS or a malicious script on the app page | The app runs on its own origin with `script-src 'self'` and no inline script, and the wallet answers only that origin. The page can't reach keys, phrases, PRF outputs or the popup's storage, and it receives public data only. It can ask for a signature, but the popup decodes the request, checks it against the plan and its rules, shows its own review and needs a passkey prompt. | It can ask for a swap that pays back to the wallet at a bad minimum. Between USD stablecoins that is refused below 97 %. Elsewhere, more than 5 % under the popup's quote (or grossly under the bands) triggers a full-screen warning. A smaller shave gets through, with the decoded minimum on screen. It can ask for a same-network send to an address it chooses, but the user sees the full address and amount. It can show false balances or prices in the app. It can under-report holdings so that the popup shows the address of a wallet with no backup, though the warning stays. It can't change the deposit address the popup shows. |
| A tampered plan or payload ("swap 10 USDC" with a payload for 10,000; extra calls; unlimited approvals) | There is no message type for messages, typed data or arbitrary transactions. The policy accepts only SODAX shapes on allowlisted contracts, decodes every byte and requires canonical encoding. It matches amounts, tokens, networks, deadline, creator and destination to the plan. Approvals are exact and go only to this trade's spender. | A bug in the policy. Review every change to `apps/wallet/src/sodax/` with care. |
| Funds routed to an attacker (destination, hub account, fee receiver) | The destination must be the wallet's own address. The deposit target and the intent creator must be the wallet's hub account. The popup reads that account itself over Sonic's RPC, pins it on first use and shows it. A fee goes only where the committed allow-list lets it: at most 1 % to a listed receiver, or exactly a listed split's rates to the splitter the popup works out itself. | The first hub-account lookup trusts Sonic's RPC and TLS. A factory's entry in the allow-list is as good as its review: the build checks its `initCodeHash` against its address, but nothing reads the platform's address, rate or cap from the chain. |
| A compromised server or database | Backups are ciphertext under the passkey's PRF output. The backup API never receives PRF outputs, phrases or passwords, and stores nothing that ties a backup to a wallet address. Every read and write needs a fresh assertion, verified against the stored public key. Stored versions are never rewritten. The server can't choose the wallet, because the app trusts only the wallet origin in its own build. | An attacker could delete backups or refuse service. A new device restores only from the server backup, so anyone without a saved phrase who then loses their device would lose the wallet. That includes users counted as backed up through a synced or a second passkey. Back up the database ([self-hosting](self-hosting.md#3-prepare-the-database)), and encourage users to save the phrase. |
| A setting that points the app at another "wallet" | The wallet origin is fixed in each build from `exclip.config.ts`, and the server's answers can only switch the wallet off. The server verifies WebAuthn against the configured wallet origin and host. | Changing the origin takes a config change and a rebuild. Review both like code. |
| A compromised deploy of the wallet origin (malicious JavaScript served there) | Build the wallet in CI from a reviewed commit. Require code-owner review for the wallet, its libraries and the lockfile. Serve only the built files, with no CDN or third-party scripts (the CSP has `script-src 'self'`). Compare what the host serves with the build. | **Total.** Code on the wallet origin can use the passkey's PRF and drain every user who signs in. This is the trust anchor, and the release controls below exist to protect it. |
| Phishing and look-alike domains | Passkeys are bound to the wallet host, so a look-alike domain can't use them. The popup answers only its opener, at the configured app origin. | A phishing page can imitate the popup and ask for the recovery phrase. The wallet's text tells users that nobody should ever ask for it. |
| Clickjacking or framing the popup | `frame-ancestors 'none'` and `X-Frame-Options: DENY`. WebAuthn runs only in the top-level popup. | None known. |
| XSS inside the popup | A strict CSP with Trusted Types, no inline code, DOM-only rendering, no WebAssembly, and a build-time check against inline script or style. | Browser bugs. |
| A lost device | A synced passkey plus the encrypted server backup. "Sign in with passkey" restores on a new device. | Users with a passkey that doesn't sync and no saved phrase. The banner and the limit reduce the exposure. |
| A lost passkey | A second passkey, which has its own backup, or the recovery phrase. "Move to Clip Wallet" exports the wallet. | Losing every passkey and the phrase means losing the funds. This is self-custody, and the wallet says so. |
| A stolen device | Unlocking and every signature need user verification (biometrics or a PIN). Nothing stays unlocked between requests. | A thief who knows the device PIN. |
| The supply chain (npm dependencies) | Locked versions, with frozen-lockfile installs in CI. The popup has few dependencies, `hash-wasm` is stubbed out, and nothing loads at run time from another origin. | A malicious release of a pinned dependency could arrive in a lockfile update. Read lockfile changes that touch the wallet. |
| Replay or CSRF on the backup API | Challenges are single-use, short-lived and issued for one operation. Every write needs a fresh assertion. | A challenge isn't bound to the request body. Binding it would cost a second passkey prompt. |
| The wrong network or chain id | The chain id comes from the popup's own list, never from the request. Unsupported networks are refused. | None known. |
| A malicious RPC (wrong hash, fake receipt) | The app stops if the node's hash differs from the popup's, and sends the next step only after a successful receipt. | A lying RPC can stall a trade, for example after the approval but before the swap. The funds stay in the wallet. |

## Release controls

The wallet origin is the trust anchor, so treat a change to it like a key
ceremony.

- **Decide who can ship it.** Protect `main`, name your reviewers in
  `.github/CODEOWNERS` (this repository doesn't ship one), and require a code
  owner's review for:
  - `apps/wallet/**` (including `fee-receivers.json`);
  - `apps/web/src/lib/wallet-protocol.ts`;
  - `packages/clip-wallet-*/**` and `packages/config/**`;
  - `.github/**` and `pnpm-lock.yaml`.
- **Build in CI, from `main`.** Build the wallet on a hosted runner from a
  commit with a green CI run. Record the hash of the output, and deploy
  exactly that output.
- **Check what is served.** After each deploy, compare the files the wallet
  origin serves with the build.
- **Keep the host.** Passkeys are bound to the wallet host. If you move the
  wallet to another host, existing users can no longer open their wallet in
  your app. Their funds stay safe, and the recovery phrase or Clip Wallet
  still reaches them. Keep the old host up.
- **Add no third-party code.** No analytics, CDN scripts or remote fonts on
  the wallet origin. The CSP blocks them, so don't loosen it.
- **Switches.** `features.embeddedWallet: false`, or
  `EXCLIP_DISABLE_EMBEDDED_WALLET=1` at the server, turns the wallet off. The
  app stops offering it and the server stops answering its routes.
  `features.trading: false` (`EXCLIP_DISABLE_TRADING=1`) keeps trades and
  sends off. See [self-hosting.md](self-hosting.md#rollback).
