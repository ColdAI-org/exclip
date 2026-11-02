# Fees

ExClip charges no fee unless the operator sets one. The repository's
defaults, and the example config, have a partner fee of zero, no receiver
and no fee split.

This page explains the three costs a swap can carry, how an operator's fee
works when there is one, as a plain fee, in basis points or as a rate, or
as a fee split, and why every part of the system refuses a fee that nobody
configured.

## What a swap costs

| Cost | Set by | Paid to | What the review shows |
|---|---|---|---|
| Network fee | The source network | The network | "Paid in gas on the source network; your wallet shows it before you sign" |
| SODAX fee | SODAX | SODAX | "Included in the rate" |
| Partner fee | The operator, in `exclip.config.ts` | The operator's receiver address. With a [fee split](#a-fee-split), the operator's splitter, which shares it between the platform and the operator | "ExClip fee: None", or the rate, the amount in the token you pay, and its dollar value. A split has one such row for each party |

The review names who gets a plain fee: `fees.receiverName`, or
`brand.name` when that isn't set. A rebranded copy shows its own name
there, or the name of whoever receives the fee. A split's rows name each
party: the platform by its name in the fee allow-list, and the operator by
`brand.operator`, or `brand.name` when that is empty. Nothing else is
added: the rate on the review is SODAX's quote for what remains after the
partner fee.

## With no fee (the default)

- `fees.partnerFeeBps` and `fees.rate` are `0`, `fees.receiver` is `null`,
  and `fees.split` is not set.
- `GET /api/exclip/config` answers `"partnerFeeBps": 0`,
  `"feeReceiver": null`, `"feeRate": null`, `"feeReceiverName": null` and
  `"feeSplit": null` ([API](api.md#get-config)).
- The app passes no partner fee with a swap, and gives the SODAX SDK no fee
  of its own, so the SDK builds intents with empty `data`.
- The server removes any `partnerFee` (and any `hook`) that the browser
  puts in a quote or intent, before SODAX sees it.
- The passkey wallet's fee allow-list, `apps/wallet/fee-receivers.json`,
  lists no receiver, no factory and no split, so the wallet refuses any
  swap that carries a fee.

## How a fee works

When an operator sets `fees.partnerFeeBps` above 0 and a `fees.receiver`:

1. **At start**, the server checks the fee: whole basis points from 0 to
   100 (1 % at most), and a receiver whenever the rate is above 0. A
   half-set or out-of-range fee stops the server with an error. It never
   runs with a fee nobody asked for.
2. **`/config`** publishes the rate, the receiver and the receiver's name,
   so the app can show them.
3. **The app** works the fee out on the amount you pay:
   `amount × partnerFeeBps ÷ 10,000`, rounded down. It asks for a quote on
   the whole amount, and the server pins the fee on that quote too. SODAX's
   SDK and API documentation say that SODAX then quotes what remains after
   the fee ([the quote](fee-split.md#the-quote)). The review shows the fee
   as its own line, and the app passes the same fee with the swap.
4. **The server pins the fee.** On each of the five routes that carry it
   (quote, allowance check, approval, intent and limit order), it removes
   whatever fee the browser sent and puts in the configured one. A browser
   can't add, raise, lower or redirect the fee.
5. **SODAX** takes the fee from the swap and pays it to the receiver.
6. **The passkey wallet** signs a swap with a fee only when the fee is at
   most 1 % and goes to an address under `receivers` in
   `apps/wallet/fee-receivers.json`. That list is part of the wallet's
   build, not of the server's settings.

Limit orders carry the fee the same way as market swaps. A fee rate and a
fee split follow the same steps, with the differences in
[a fee rate](#a-fee-rate) and [a fee split](#a-fee-split).

## Why it fails closed

A fee has to pass three independent checks, and a mistake in any of them
means no fee rather than a wrong one:

- **The config** refuses a fee without a receiver, a fee above 1 %, a
  fractional rate, or a fee given both in basis points and as a rate. A
  receiver without a rate charges nothing. It refuses a split whose factory
  the fee allow-list doesn't list, a split its factory would refuse, and a
  split set together with a plain fee.
- **The server** sends SODAX only the configured fee, whatever the browser
  asks for.
- **The passkey wallet** refuses any fee whose receiver isn't on its
  committed list: a plain receiver, or the splitter of a listed split,
  which the wallet works out itself. A fee rate's fee must be exactly the
  rate the wallet was built with, and a split's fee exactly the split's
  rates. If the server's fee and the wallet's list disagree,
  passkey-wallet users can't trade until they agree, and the wallet build
  warns about it.

Browser wallets don't check the receiver. For them, the server's pinning is
the control, which is one reason to protect the server's config like code
([security](security.md)).

## Turn a fee on

These steps set a plain fee. For a split, see
[turn a split on](#turn-a-split-on).

1. **Check what it means where you operate.** Taking a fee on swaps can make
   you a provider of a financial service. That is your responsibility as the
   operator ([operator responsibility](../README.md#operator-responsibility)).
2. **Set the fee** in `exclip.config.ts`, in basis points:

   ```ts
   fees: {
     partnerFeeBps: 25, // 0.25 %
     receiver: "0xYourReceiverAddress",
   },
   ```

   Or as a rate per 100,000 of the amount sold, with its own fee on swaps
   with a tokenised stock ([a fee rate](#a-fee-rate)):

   ```ts
   fees: {
     rate: 875, // 0.875 %
     stockFeeBps: 0, // no fee on swaps with a tokenised stock
     receiver: "0xYourReceiverAddress",
     receiverName: "Example Ltd", // who the review names; brand.name if left out
   },
   ```

   `receiverName` works with either form.

3. **Add the receiver to the wallet's list**, in a reviewed commit:

   ```json
   {
     "$comment": "…",
     "receivers": ["0xYourReceiverAddress"],
     "factories": [],
     "splits": []
   }
   ```

   The same commit updates the test that expects the list to be empty, "the
   repository ships an empty fee allowlist, …" in
   `apps/wallet/test/build-config.test.ts`, so that it expects your
   receiver under `receivers`, in lower case.

4. **Rebuild the wallet and restart the server.** A new `partnerFeeBps`
   alone needs only a restart. A new receiver needs a wallet build, and so
   does a new `rate`, `stockFeeBps` or `receiverName`: the wallet builds
   them in. The app needs no rebuild: it reads the fee from `/config`.
5. **Check it.** `GET /api/exclip/config` shows the fee: `partnerFeeBps`,
   or `feeRate` for a rate, with `feeReceiver` and `feeReceiverName`. The
   trade review shows the fee line. The wallet build printed no warning
   about the fee receiver.

The `25` and `875` above are examples, not recommendations.

## Turn a fee off

Set `fees.partnerFeeBps` or `fees.rate` to `0`, or remove the `fees`
section, and restart the server. No rebuild is needed. You can leave the
receiver on the wallet's list, or remove it in a reviewed commit and
rebuild the wallet.

## A fee rate

A plain fee can be given as a rate per 100,000 of the amount sold,
`fees.rate`, instead of in basis points. `875` is 0.875 %, which no whole
number of basis points gives. It goes to one receiver, like
`partnerFeeBps`, and a config sets one or the other, never both.

What changes from a fee in basis points:

- **The rate moves in steps of 0.001 %.** It is a whole number from 0 to
  1,000 (1 %).
- **The fee is an amount.** The server works it out from the amount sold,
  rounded down, and pins `{ address: receiver, amount }`. It pins nothing
  when that rounds down to 0, and answers `400 BAD_AMOUNT` to a request
  whose amount sold it can't read, as for a split.
- **Tokenised stocks.** A swap with a stock on either side never pays the
  rate. It pays `fees.stockFeeBps`, in basis points to the same receiver,
  or none, the default. A fee in basis points is charged on every swap,
  stocks included.
- **The passkey wallet** takes the rate from its build. It signs a fee to a
  listed receiver only when the fee is exactly the rate of the amount sold,
  rounded down: one unit more or less is refused. With a stock on either
  side, it signs exactly the fee on stock swaps, or no fee.
- **The start-up line** names the rate, the receiver and its name, and the
  fee on stock swaps.

## A fee split

A fee split charges one fee and shares it between two parties: a platform
and the operator. The fee goes to the operator's splitter, a contract on
Sonic that pays each party its share. [Fee split](fee-split.md) explains
the contracts, and how ExClip uses them. A copy of ExClip sets a plain fee
or a split, never both.

What changes from a fee in basis points:

- **The rates are per 100,000 of the amount sold.** The platform's rate is
  fixed by the factory that creates the splitters. The operator adds its
  own, from 0 to 1,000 (1 %). The total may reach the factory's cap: for a
  platform rate of 875 (0.875 %), a cap of 1,875 leaves the operator up to
  1 %.
- **The fee is an amount.** The server works it out from the amount sold,
  rounded down, and pins `{ address: splitter, amount }`.
- **The receiver is worked out, never typed.** The splitter's address
  follows from the factory, the operator's address and its rate.
- **The passkey wallet** signs a split's fee only when it is exactly the
  split's rates of the amount sold, to a splitter it works out itself from
  its allow-list. It names each party on its review.
- **Tokenised stocks.** A swap with a stock on either side never pays the
  splitter. It pays the operator's own plain fee, `stockFeeBps`, or none.

### Turn a split on

1. **Check what it means where you operate**, as for a plain fee.
2. **List the factory and your split** in `apps/wallet/fee-receivers.json`,
   in a reviewed commit. The factory's entry holds values a reviewer reads
   from the chain ([the fee allow-list](fee-split.md#the-fee-allow-list)),
   even when the platform supplies it. Your split's entry is the factory,
   your operator address and your rate:

   ```json
   "splits": [
     { "factory": "0xFactoryAddress", "operator": "0xYourOperatorAddress", "operatorRate": 100 }
   ]
   ```

   With `stockFeeBps` above 0 and stocks on, list your operator address
   under `receivers` too. The same commit updates "the repository ships an
   empty fee allowlist, …" in `apps/wallet/test/build-config.test.ts`, so
   that it expects what `parseFeeAllowList` returns for the file: receivers
   in lower case, the factories' and splits' addresses in EIP-55 mixed
   case, and each split with its `splitter`.

3. **Set the split** in `exclip.config.ts`:

   ```ts
   fees: {
     split: {
       factory: "0xFactoryAddress",
       operator: "0xYourOperatorAddress",
       operatorRate: 100, // 0.1 %, on top of the platform's rate
       stockFeeBps: 0, // your own fee on swaps with a tokenised stock
     },
   },
   ```

   Keep `partnerFeeBps` at `0` and `receiver` at `null`, or leave them
   out: the config check refuses a split with a plain fee.

4. **Rebuild the wallet and restart the server.** The app needs no
   rebuild: it reads the fee from `/config`.
5. **Check it.** The server's start-up line names the split, its splitter
   and both rates. `GET /api/exclip/config` shows them under `feeSplit`.
   The trade review shows a row for each party. The wallet build printed no
   warning about the split.

The `100` above is an example, not a recommendation.

### Turn a split off

Remove `fees.split`, or set it to `null`, and restart the server. No
rebuild is needed. You can leave the split in the wallet's list, or remove
it in a reviewed commit and rebuild the wallet.

## The tests behind this

| Rule | Test |
|---|---|
| No fee by default, in the config and the example | `packages/config/test/config.test.ts`: "defaults: no partner fee, nothing pinned, no key, the ExClip brand and the placeholder origins", "the shipped exclip.config.example.ts is valid, sets every section, charges no fee and has no key" |
| Whole basis points, at most 1 %, only with a receiver | `packages/config/test/config.test.ts`: "partner fee: whole basis points up to 1 %, and only with a receiver", "a receiver without a rate pins nothing" |
| A bad fee stops the server | `apps/server/test/exclip.test.ts`: "a half-set or out-of-range fee stops the server at start instead of running with a fee nobody asked for" |
| The server pins the configured fee and drops the browser's | `apps/server/test/exclip.test.ts`: "the configured partner fee is pinned and a client-supplied fee is stripped", "with no fee configured the field is omitted, even when the client sends one" |
| The passkey wallet's list ships empty and comes from the repository | `apps/wallet/test/build-config.test.ts`: "the repository ships an empty fee allowlist, so the wallet signs only fee-free intents", "fee receivers come from the committed fee-receivers.json, never from the environment" |
| The passkey wallet refuses other receivers and fees above 1 % | `apps/wallet/test/policy.test.ts`: "a partner fee up to 1% to the allowlisted receiver passes; above the cap or to anyone else is refused" |
| A fee rate is whole, at most 1 %, only with a receiver, and never with basis points | `packages/config/test/config.test.ts`: "fee rate: a whole number per 100,000 of the amount sold up to 1 %, only with a receiver, never with partnerFeeBps", "fee rate: its own fee on stock swaps, in basis points to the same receiver, and only with a rate", "the example's commented fee rate is valid once uncommented, with a receiver set"; `apps/server/test/exclip.test.ts`: "a fee rate without a receiver, out of range or beside partnerFeeBps stops the server at start" |
| The review names the receiver | `packages/config/test/config.test.ts`: "the fee's receiver name: brand.name by default, plain text like a platform's name, with either plain fee"; `apps/wallet/test/build-config.test.ts`: "the wallet gets a plain fee's rate and the name its review gives the receiver from exclip.config.ts" |
| The server pins a fee rate's amount, from the amount sold | `apps/server/test/exclip.test.ts`: "a fee rate pins an amount to the receiver on the quote and the four intent routes, from the amount sold, rounded down", "a fee rate pins nothing while the fee rounds down to 0, and 1 unit from the first amount that reaches it", "a fee rate refuses a fee route whose amount sold it can't read (400 BAD_AMOUNT) before SODAX sees it", "/config publishes a fee rate: the receiver and its name, the rate per 100,000 and the fee on stock swaps" |
| The app passes the fee rate's amount its review shows | `apps/web/test/fees.test.ts`: "a fee rate: one amount to the receiver, the rate of the amount sold, rounded down, named after the receiver", "a fee rate that rounds down to nothing sends no fee, and 1 unit from the first amount that reaches it" |
| A swap with a stock on either side never pays the rate | `apps/server/test/exclip.test.ts`: "stocks on with a fee rate: a stock on either side pays only the fee on stock swaps, or none, never the rate"; `apps/web/test/fees.test.ts`: "a fee rate with a stock on either side: only its fee on stock swaps, in basis points, or none"; `apps/wallet/test/fee-rate.test.ts`: "with a tokenised stock on either side, only exactly the fee on stock swaps is signed, or no fee, never the rate" |
| The passkey wallet signs exactly the build's rate, to a listed receiver | `apps/wallet/test/fee-rate.test.ts`: "a fee of exactly the build's rate to a listed receiver passes, and the review names the receiver with the rate", "a fee one unit more or less than the build's rate, or at any other rate, is refused", "a fee to a receiver the build doesn't list is refused, even at exactly the build's rate", "a fee rate is held to the wallet's cap: 1 %, the most fees.rate allows" |
| A split needs a listed factory, and whatever the factory refuses is refused | `packages/config/test/config.test.ts`: "fee split: the factory's values from the allow-list, the operator's from the config, and the splitter they give", "fee split: refused unless the allow-list lists the factory, and wherever the factory would refuse it" |
| The splitter's address is the one the contracts give | `packages/config/test/fee-split.test.ts`: "each splitter is where its factory predicted and created it, with the factory's salt", "each refusal is the factory's, in the factory's order, and predictSplitter throws for it" |
| The allow-list takes only the factories and splits it can vouch for | `packages/config/test/fee-split.test.ts`: "the allow-list refuses a factory entry with a value no FeeSplitterFactory there has", "the allow-list refuses a split entry it can't vouch for"; `apps/wallet/test/build-config.test.ts`: "the build stops on a fee-split factory or split the allow-list can't vouch for" |
| The server pins a split's amount, from the amount sold | `apps/server/test/exclip.test.ts`: "a split pins an amount to the splitter on the quote and the four intent routes, from the amount sold, rounded down", "a split refuses a fee route whose amount sold it can't read (400 BAD_AMOUNT) before SODAX sees it" |
| The app passes the fee its review shows | `apps/web/test/fees.test.ts`: "a split: one amount to the splitter, the platform's and the operator's rates of the amount sold, rounded down"; `apps/web/test/exclip-embedded.test.ts`: "the SDK has no fee of its own; each swap's fee is lib/fees.ts's, and the SDK writes exactly that fee" |
| A swap with a stock on either side never pays the splitter | `apps/server/test/exclip.test.ts`: "stocks on with a split: a stock on either side never pays the splitter, only the operator's own fee or none"; `apps/web/test/fees.test.ts`: "a split with a stock on either side: never the splitter, only the operator's own fee, or none"; `apps/wallet/test/fee-split.test.ts`: "a split on a swap with a tokenised stock on either side is refused; the operator's own plain fee there is not" |
| The passkey wallet signs exactly the split's rates, to a splitter it works out | `apps/wallet/test/fee-split.test.ts`: "a fee of exactly the split's rates to the splitter the wallet works out passes, and the review says who gets what", "a fee one unit more or less than the split's rates, or at any other rate, is refused", "a fee to any splitter the build doesn't list is refused: another factory's, another operator's or rate's, or none at all" |
