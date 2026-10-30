# Fees

ExClip charges no fee unless the operator sets one. The repository's
defaults, and the example config, have a partner fee of zero and no
receiver.

This page explains the three costs a swap can carry, how an operator's fee
works when there is one, and why every part of the system refuses a fee
that nobody configured.

## What a swap costs

| Cost | Set by | Paid to | What the review shows |
|---|---|---|---|
| Network fee | The source network | The network | "Paid in gas on the source network; your wallet shows it before you sign" |
| SODAX fee | SODAX | SODAX | "Included in the rate" |
| Partner fee | The operator, in `exclip.config.ts` | The operator's receiver address | "ExClip fee: None", or the rate, the amount in the token you pay, and its dollar value |

The review names the partner fee after the brand, so a rebranded copy shows
its own name there. Nothing else is added: the rate on the review is
SODAX's quote for what remains after the partner fee.

## With no fee (the default)

- `fees.partnerFeeBps` is `0` and `fees.receiver` is `null`.
- `GET /api/exclip/config` answers `"partnerFeeBps": 0` and
  `"feeReceiver": null` ([API](api.md#get-config)).
- The app sets no partner fee on the SODAX SDK, so the SDK builds intents
  with empty `data`.
- The server removes any `partnerFee` (and any `hook`) that the browser
  puts in a quote or intent, before SODAX sees it.
- The passkey wallet's list of allowed fee receivers,
  `apps/wallet/fee-receivers.json`, is empty, so it refuses any swap that
  carries a fee.

## How a fee works

When an operator sets `fees.partnerFeeBps` above 0 and a `fees.receiver`:

1. **At start**, the server checks the fee: whole basis points from 0 to
   100 (1 % at most), and a receiver whenever the rate is above 0. A
   half-set or out-of-range fee stops the server with an error. It never
   runs with a fee nobody asked for.
2. **`/config`** publishes the rate and the receiver, so the app can show
   them.
3. **The app** takes the fee off the top. On the amount you pay, the fee is
   `amount × partnerFeeBps ÷ 10,000`, and the app asks SODAX for a quote on
   the rest. The review shows the fee as its own line.
4. **The server pins the fee.** On each of the five routes that carry it
   (quote, allowance check, approval, intent and limit order), it removes
   whatever fee the browser sent and puts in the configured one. A browser
   can't add, raise, lower or redirect the fee.
5. **SODAX** takes the fee from the swap and pays it to the receiver.
6. **The passkey wallet** signs a swap with a fee only when the fee is at
   most 1 % and goes to an address in `apps/wallet/fee-receivers.json`. That
   list is part of the wallet's build, not of the server's settings.

Limit orders carry the fee the same way as market swaps.

## Why it fails closed

A fee has to pass three independent checks, and a mistake in any of them
means no fee rather than a wrong one:

- **The config** refuses a fee without a receiver, a fee above 1 %, or a
  fractional rate. A receiver without a rate charges nothing.
- **The server** sends SODAX only the configured fee, whatever the browser
  asks for.
- **The passkey wallet** refuses any fee whose receiver isn't on its
  committed list. If the server's receiver and the wallet's list disagree,
  passkey-wallet users can't trade until they agree, and the wallet build
  warns about it.

Browser wallets don't check the receiver. For them, the server's pinning is
the control, which is one reason to protect the server's config like code
([security](security.md)).

## Turn a fee on

1. **Check what it means where you operate.** Taking a fee on swaps can make
   you a provider of a financial service. That is your responsibility as the
   operator ([operator responsibility](../README.md#operator-responsibility)).
2. **Set the fee** in `exclip.config.ts`:

   ```ts
   fees: {
     partnerFeeBps: 25, // 0.25 %
     receiver: "0xYourReceiverAddress",
   },
   ```

3. **Add the receiver to the wallet's list**, in a reviewed commit:

   ```json
   {
     "$comment": "…",
     "receivers": ["0xYourReceiverAddress"]
   }
   ```

4. **Rebuild the wallet and restart the server.** The rate alone needs only
   a restart, but a new receiver needs a wallet build.
5. **Check it.** `GET /api/exclip/config` shows the rate and the receiver.
   The trade review shows the fee line. The wallet build printed no warning
   about the fee receiver.

The `25` above is an example, not a recommendation.

## Turn a fee off

Set `fees.partnerFeeBps` to `0`, or remove the `fees` section, and restart
the server. No rebuild is needed. You can leave the receiver on the
wallet's list, or remove it in a reviewed commit and rebuild the wallet.

## The tests behind this

| Rule | Test |
|---|---|
| No fee by default, in the config and the example | `packages/config/test/config.test.ts`: "defaults: no partner fee, nothing pinned, no key, the ExClip brand and the placeholder origins", "the shipped exclip.config.example.ts is valid, sets every section, charges no fee and has no key" |
| Whole basis points, at most 1 %, only with a receiver | `packages/config/test/config.test.ts`: "partner fee: whole basis points up to 1 %, and only with a receiver", "a receiver without a rate pins nothing" |
| A bad fee stops the server | `apps/server/test/exclip.test.ts`: "a half-set or out-of-range fee stops the server at start instead of running with a fee nobody asked for" |
| The server pins the configured fee and drops the browser's | `apps/server/test/exclip.test.ts`: "the configured partner fee is pinned and a client-supplied fee is stripped", "with no fee configured the field is omitted, even when the client sends one" |
| The passkey wallet's list ships empty and comes from the repository | `apps/wallet/test/build-config.test.ts`: "the repository ships an empty fee allowlist, so the wallet signs only fee-free intents", "fee receivers come from the committed fee-receivers.json, never from the environment" |
| The passkey wallet refuses other receivers and fees above 1 % | `apps/wallet/test/policy.test.ts`: "a partner fee up to 1% to the allowlisted receiver passes; above the cap or to anyone else is refused" |
