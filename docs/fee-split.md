# Fee split

One SODAX partner fee, paid to two parties: the platform and the operator
of a DEX. The platform fee is 0.875 % of the amount sold, paid to ColdAI
LLC, on every DEX launched through ColdAI. Swaps of tokenised stocks carry
none. An operator may add a fee of its own.

SODAX pays a partner fee to one address. For a split, that address is a
contract, a splitter, which holds the fee and pays each party its share. A
factory creates one splitter for each operator and rate, at an address
known before the splitter exists. The contracts are in
[`contracts/fee-split`](../contracts/fee-split/README.md).

**Not audited.** No outside party has reviewed the contracts. Their tests
and static analysis are the only checks so far.

**Not in use.** The contracts are not deployed, and nothing in the app, the
server or the wallet uses them yet. The
[integration design](#integration-design) says what would change.

This page starts with how SODAX pays a partner fee, which decides how a
split can work. Then it covers how the split works, an example, what the
contracts guarantee, how a payee collects, deploying the factory, the
integration design, and the decisions left to the owner.

## How SODAX pays a partner fee

What follows comes from the SODAX packages this repository installs, and
from ExClip's own code. SODAX's contracts are not in the repository, so what
happens on-chain is read from the SDK, and the text says so where that
matters.

Line numbers are for these versions:

| Short name | File |
|---|---|
| `sdk` | `dist/index.mjs` in `@sodax/sdk` 2.2.0 |
| `types` | `dist/` in `@sodax/types` 2.2.0 |
| `swaps-api` | `README.md` in `@sodax/swaps-api` 2.2.0 |

### The two forms of a partner fee

A partner fee is one of two shapes (`types` `common/common.d.ts:39-58`):

- **A percentage**: `{ address, percentage }`, in basis points
  (100 = 1 %). The SDK turns it into an amount:
  `amount × percentage ÷ 10,000`, rounded down
  (`FEE_PERCENTAGE_SCALE = 10000n`, `sdk:5254`, `sdk:6782-6784`). It
  accepts 0 to 10,000 (`sdk:25259-25264`), although the type's comment
  says 100 at most (`common/common.d.ts:46`). The SDK passes the percentage
  to `BigInt()` (`sdk:6783`), which throws on a fraction.
- **An amount**: `{ address, amount }`, a `bigint` in the smallest unit of
  the token sold (`common/common.d.ts:36-42`). Over the HTTP API it is a
  decimal string, and when both forms are present the backend uses the
  amount (`types` `backend/backendApiV2.d.ts:10-22`). The quote helper
  checks that the amount is between 0 and the amount sold
  (`sdk:6785-6796`). The intent builder takes it as given
  (`sdk:25257-25258`).

So 0.875 %, which is 87.5 basis points, can't be sent as a percentage.
It has to be sent as an amount.

Either way, the intent carries an amount, never a rate. The SDK works out
the fee, takes it off the amount sold
(`intent.inputAmount = inputAmount − fee`, `sdk:25217` and `sdk:25683`),
and writes `0x01 ‖ abi.encode(uint256 fee, address receiver)` into the
intent's `data` (`sdk:25251-25284`; the type numbers are at
`sdk:25006-25012`). "The intents contract reads this on-chain and routes
the fee to the partner address" (`sdk:25238`).

ExClip uses the percentage form today. The config allows whole basis
points from 0 to 100 (`packages/config/src/index.ts:148` and `:334`), and
the server pins `{ address, percentage }` on every route that carries a fee
(`packages/config/src/index.ts:422`,
`apps/server/src/services/sodaxProxy.ts:99-103` and `:191`).

### Where the fee goes, and in which token

- **On Sonic.** The receiver is an EVM address on Sonic, SODAX's hub
  chain: "`address` is the EVM hub fee receiver"
  (`backend/backendApiV2.d.ts:12`). SODAX's own example names it
  `partnerReceiverOnSonic` (`swaps-api:41`).
- **In the token sold.** The fee is in the intent's input token. For a swap
  from another chain, that is the token's hub asset: the ERC-20 that stands
  for it on Sonic (`sdk:25197`). For a swap from Sonic, it is the Sonic
  token itself, and native S is `0x0000…0000` (`sdk:25658-25701`). ExClip's
  wallet checks the same thing (`apps/wallet/src/sodax/policy.ts:252`).
  The amounts are in the same smallest units as the token sold: the wallet
  checks that the intent's amount plus the fee equals the amount the user
  pays (`policy.ts:256`).
- **As a plain balance.** The fee lands as an ordinary balance of the
  receiver's address. SODAX's fee tools read a partner's fees with ERC-20
  `balanceOf(partner)` over every hub asset (`sdk:43807-43843`), and tell a
  partner to "Withdraw the fee token directly (bridge/transfer)"
  (`sdk:44145`). Nothing is credited inside a SODAX contract.
- **When.** The SDK doesn't show whether the intents contract pays the fee
  when the intent is created or when it is filled. It doesn't matter for a
  split, which only needs the balance to arrive.

Native S needs care. For a swap that sells native S from Sonic, the SDK
sends the whole amount, fee included, as the transaction's value
(`sdk:25700`), and ExClip's wallet allows such swaps
(`policy.ts:279` and `:298-300`). How the intents contract then passes the
fee on in native S isn't visible here. The ABI in the SDK even lists
`createIntent` as `nonpayable` (`sdk:12065-12148`). A receiver that may get
native S should accept it however it is sent, including Solidity's
`transfer`, which forwards only 2,300 gas.

### How a partner collects

There is nothing to claim from SODAX: the fee is already the receiver's
balance. What SODAX offers is an optional conversion through its
ProtocolIntents contract on Sonic (`sdk:43775` onwards):

1. approve ProtocolIntents for the fee token, with the maximum allowance
   (`sdk:44059-44099`);
2. choose, once, an output token, a destination chain and a recipient
   there, with `setAutoSwapPreferences` (the SDK's `setSwapPreference`,
   `sdk:43939-43966`);
3. call `createIntentAutoSwap(partner, feeToken, amount, 0)`
   (`sdk:44126-44187`). A solver then swaps the fee, with no minimum
   output.

Each step is an ordinary Sonic transaction from the partner's own address:
the contract acts for `msg.sender`.

**Can a contract be the receiver?** Yes. A split contract never needs to
claim from SODAX. It holds the fee as a plain balance and pays each share
out with an ERC-20 `transfer`, or a plain call for native S. Each payee
then holds the same hub-asset tokens at its own address, and can withdraw
them or use the conversion above from there. The contract doesn't need a
function that claims for itself.

One limit to know: SODAX's balance tool only lists the hub assets in its
token lists (`sdk:43819-43832`). A split contract can pay out any token it
holds, listed or not.

### The hub's EVM version

Nothing in the repository states Sonic's EVM version. viem's entry for
Sonic gives the chain id (146), the native coin (S, 18 decimals) and
Multicall3, and nothing about the EVM (`chains/definitions/sonic.ts:3-28`
in viem 2.57.7). SODAX itself deploys contracts on Sonic at derived
addresses with CREATE3 (`sdk:25578-25590`), so CREATE2 works there.

So the split contracts compile for `paris`, the version before Shanghai.
Their bytecode has no `PUSH0` (Shanghai), and no `MCOPY` or transient
storage (Cancun). It calls no precompiles: `keccak256` is an opcode.
Bytecode for an older version runs on any newer one, so this choice doesn't
depend on Sonic's exact version.

## How the split works

- **The factory** is deployed once, on Sonic, with the platform's address,
  the platform's rate and a cap on the total rate. None of them can change.
- **A splitter** is created by the factory for each operator and operator
  rate. Its address follows from the factory, the operator's address and
  the operator's rate. So it can be worked out before the splitter exists,
  and be the fee's receiver from the first swap.
- **SODAX** pays the fee to the splitter as it would to any receiver: as a
  plain balance, in the token sold
  ([where the fee goes](#where-the-fee-goes-and-in-which-token)).
- **Each party's share** of what a splitter has received in one token is
  that total times the party's rate, divided by the sum of both rates. At
  0.875 % and 0.1 %, the platform gets 875/975 of every fee and the
  operator 100/975.
- **`release(token, payee)`** pays a party all it is owed in one token.
  Anyone may call it, and only that party is paid.

Rates are in parts per 100,000 of the amount sold, so that 0.875 % is a
whole number: 875. The operator's 0.1 % is 100.

## A worked example

Someone sells 1,000 USDC on Sonic, on a DEX whose operator charges 0.1 %.
USDC on Sonic has 6 decimals, so 1,000 USDC is 1,000,000,000 units
(`apps/wallet/src/sodax/tokens.ts:7`).

| | Units | USDC |
|---|---|---|
| Amount sold | 1,000,000,000 | 1,000 |
| Fee: 975 per 100,000 (0.875 % + 0.1 %), rounded down | 9,750,000 | 9.75 |
| Left for the swap, the intent's `inputAmount` | 990,250,000 | 990.25 |
| The platform's share: fee × 875 ÷ 975 | 8,750,000 | 8.75 |
| The operator's share: fee × 100 ÷ 975 | 1,000,000 | 1 |

SODAX pays the 9.75 USDC to the operator's splitter. Anyone can then
release either share, in either order, and nothing is left over.

Shares are rounded down. Had the fee been 9,750,001 units, the platform
would be owed 8,750,000 (8,750,000.9 before rounding), the operator
1,000,000 (1,000,000.1), and 1 unit would stay in the splitter. That is the
most rounding ever leaves: one smallest unit of each token, in each
splitter, however many fees it receives.

## What the contracts guarantee

- **Two payees, fixed for good.** The platform's address and rate are set
  when the factory is deployed, and are the same in every splitter it
  creates. The operator's address and rate are set when its splitter is
  created. There is no owner, admin, upgrade or pause, so nothing can
  change them.
- **Each payee gets its share, and only its share.** `release` pays a payee
  what it is owed, less what it has had already, and never more than the
  splitter holds.
- **Anyone can release, nobody can redirect.** Whoever calls
  `release(token, payee)`, the money goes to `payee`, which must be the
  platform or the operator.
- **Fees that arrive early are kept.** A fee sent to a splitter's address
  before the splitter exists waits there, and is shared once it does.
- **Any token, and native S.** A splitter pays out any token whose
  `transfer` returns `true` or nothing, and native S. Native S sent with
  Solidity's `transfer`, which passes on only 2,300 gas, still arrives.
- **A cap on the total rate.** A factory refuses a splitter whose two rates
  add up to more than its cap. `predict` refuses the same, so it never
  names an address where no splitter can be created.

What they don't do:

- **Check the fee.** A splitter shares whatever reaches it. It can't see
  what was sold, so it can't tell whether the fee was the right share of
  it. That check belongs to the server, the app and the wallet
  ([integration design](#integration-design)).
- **Change a payee.** A payee that loses access to its address loses its
  share. Use an address you control for good, such as a multisig.
- **Pay a payee that refuses native S.** That share stays in the splitter.
  The other payee is paid as usual.
- **Handle balances that shrink on their own**, as some rebasing tokens do.
- **Pay out by themselves.** Each release is one transaction, for one token
  and one payee, and whoever sends it pays the gas.

[`contracts/fee-split/README.md`](../contracts/fee-split/README.md#what-the-contracts-enforce)
has the full list, the tests behind it and the static analysis.

## How a payee collects

A payee collects from its splitter on Sonic, one token at a time:

1. **Create the splitter**, if nobody has yet, with the factory's
   `deploy(operator, operatorRate)`. Anyone may, and the fees already at its
   address are kept.
2. **See what is due** with `releasable(token, payee)`. `token` is the
   token's address on Sonic: the token sold, or its hub asset for a swap
   from another chain. Native S is
   `0x0000000000000000000000000000000000000000`.
3. **Collect it** with `release(token, payee)`. It pays `payee` everything
   due in that token, and reverts with `NothingDue` when nothing is.

Anyone may send the release, and the money still goes only to the payee.
So the platform can collect its share from every splitter, and an operator
its own, without asking each other. Each release costs gas on Sonic, so it
is worth waiting until a share is large enough.

To find which tokens a splitter holds, look its address up on a Sonic
explorer, or read each hub asset's `balanceOf` for it, as SODAX's fee tool
does for a partner (`sdk:43807-43843`).

Once released, the tokens are an ordinary balance of the payee's own
address. From there the payee can move or bridge them, or convert them
with SODAX's auto-swap, as any partner would
([how a partner collects](#how-a-partner-collects)).

The commands are in
[`contracts/fee-split/README.md`](../contracts/fee-split/README.md#use-a-splitter).

## Deploy the factory

One factory serves every DEX, so it is deployed once, on Sonic. The
commands are in
[`contracts/fee-split/README.md`](../contracts/fee-split/README.md#deploy-to-sonic).
In short:

1. **Choose the platform's address**: one the platform controls for good,
   such as a multisig, that accepts native S. The scripts and these pages
   name no address. It is a parameter, `PLATFORM_RECEIVER`.
2. **Choose the rates**: the platform's, `PLATFORM_RATE` (875 by default),
   and the cap on the total, `MAX_TOTAL_RATE` (1,875, or 1.875 %, by
   default), which leaves an operator up to 1 %. See the
   [decisions](#decisions-for-the-owner) about the cap.
3. **Simulate** with `forge script` without `--broadcast`, and check every
   value it returns.
4. **Deploy**, signing with an encrypted keystore or a Ledger. The script
   reads no key.
5. **Verify** the source on the explorer, and read the factory's
   `platform`, `platformRate` and `maxTotalRate` back from the chain.

The platform's address, its rate and the cap can't change. Changing any of
them means a new factory, and a new splitter address for every operator.

An operator's splitter needs nothing deployed before its first fee: its
address is the factory's `predict(operator, operatorRate)`. Anyone can
create it later with `deploy(operator, operatorRate)`.

## Integration design

This is a design. Nothing in it is built yet. The parts it touches that
decide where money goes, which are the config rules, the fee allow-list
and the wallet's signing policy, get extra review
([CONTRIBUTING](../CONTRIBUTING.md#changes-that-get-extra-review)).

| | Today | With the split |
|---|---|---|
| The rate | The operator's, in whole basis points, 0 to 100 | The platform's 875 plus the operator's, per 100,000 |
| What SODAX is sent | `{ address, percentage }` | `{ address, amount }` |
| The receiver | `fees.receiver`, typed in the config | The operator's splitter, worked out, never typed |
| What the passkey wallet signs | A fee of at most 1 % to an address on its list | A fee of exactly the total rate, to a splitter it works out itself |
| The wallet's review | "Acme Swap fee" and the amount | "9.75 USDC · 0.875 % to ColdAI · 0.1 % to Acme Swap" |

### The config

The repository's default stays at no fee: a default that charges one won't
be accepted ([CONTRIBUTING](../CONTRIBUTING.md#changes-that-get-extra-review)).
The split is set in the config of each DEX launched through ColdAI.

The operator sets three values, for example under `fees.split`:

| Setting | Meaning |
|---|---|
| `factory` | The factory's address on Sonic |
| `operator` | The operator's address on Sonic, where its share is paid |
| `operatorRate` | The operator's rate per 100,000, a whole number: `100` is 0.1 %, and `0` charges only the platform's fee |

The platform's address, its rate and the cap are not settings. The factory
fixes them, and they are recorded once, beside the factory's address, in
the reviewed fee allow-list ([below](#the-fee-allow-list)). The config
check, the server and the wallet build take them from there, so a config
can't misstate them.

The config check refuses a split that the factory would refuse
(`contracts/fee-split/src/FeeSplitterFactory.sol:83-88`):

- the operator is the zero address;
- the operator is the platform;
- the operator's rate is above the cap minus the platform's rate;
- both rates are zero.

It also refuses a factory that the allow-list doesn't name. These checks
matter. The CREATE2 formula gives an address for any input, so without
them a config could name an address where no splitter can ever be created,
and a fee sent there would be stuck for good.

`fees.partnerFeeBps` and `fees.receiver` stay, for a copy that charges a
plain fee. A config sets one kind of fee or the other, never both.

**The fee is sent as an amount.** The total rate is finer than a basis
point: 0.975 % is 97.5 basis points, and the percentage form takes whole
basis points only ([the two forms](#the-two-forms-of-a-partner-fee)). So
the fee is worked out for each swap, and sent as `{ address, amount }`:

```text
fee = amount sold × (platform's rate + operator's rate) ÷ 100,000, rounded down
```

### The receiver

The receiver is the operator's splitter: the address that the factory's
`predict(operator, operatorRate)` returns. It can be worked out without
reading the chain
([a splitter's address](../contracts/fee-split/README.md#the-proxy)). So
the config check works it out, the server pins it, and the wallet works it
out again for itself. Nobody types it.

The splitter doesn't have to exist when the first fee arrives. It has to
exist before the first release, and anyone can create it.

### The server

- **It pins the amount.** On the five routes that carry a fee
  (`apps/server/src/services/sodaxProxy.ts:36` and `:40-43`), it drops the
  browser's fee as it does today (`:99-103`), and pins
  `{ address: splitter, amount }`.
  It works the amount out from the request: `inputAmount` on the intent
  routes, `amount` on the quote (`types`
  `backend/backendApiV2.d.ts:214-231` and `:254-270`). It sends no
  percentage. When both forms are present, SODAX uses the amount (`:14`).
- **It quotes from the same number.** Today the app asks for a quote on the
  amount after the fee (`apps/web/src/components/TradeSheet.tsx:113-127`),
  and the server pins the fee on that quote as well. If SODAX takes a
  pinned fee off a quote's `amount`, as the SDK's own `getQuote` does
  (`sdk:30627-30633`), the quote counts the fee twice and comes out a
  little low. With the split, the app should quote the amount sold, so
  that the quote, the fee and the intent all start from the same number.
- **It publishes the split.** `/config` publishes `partnerFeeBps` and
  `feeReceiver` today (`apps/server/src/services/config.ts:82-83`). With
  the split, it publishes the receiver, each party's name and rate per
  100,000, and the fee on stock swaps.

### The app

- **It passes the fee with each swap.** Today it gives the SDK one
  percentage for every swap (`apps/web/src/lib/api.ts:122-126`). With the
  split, it passes `{ address: splitter, amount }` to each `createIntent`.
  The SDK takes a fee per call (`extras.partnerFee`, `sdk:31303-31305`),
  and uses an amount as given (`sdk:25257-25258`).
- **It shows the split.** Today the review has one fee row
  (`TradeSheet.tsx:274-276`), and works the fee out in basis points
  (`:113-115`). With the split, it works the fee out per 100,000, and shows
  two rows, such as "ColdAI fee (0.875 %)" and "Acme Swap fee (0.1 %)",
  each with its amount.

### The wallet

For passkey users, the wallet is where the split is checked. It trusts
nothing the app sends:

- **It works the splitter out itself**, from the reviewed allow-list: the
  factory, the operator's address and the operator's rate. It applies the
  factory's four checks, then computes the address as the factory does.
  The implementation is the factory's first creation: its CREATE address
  at nonce 1. The creation code is the proxy's, with the implementation's
  address in it. The salt is `keccak256(abi.encode(operator, operatorRate))`.
  The local dry run gives a test vector: the factory `0x5b73…0519`, the
  operator `0x2222…2222` and the rate 100 give the splitter `0x92F0…57Fe`
  ([try it locally](../contracts/fee-split/README.md#try-it-locally)).
- **It checks the fee exactly.** A fee to a splitter must be the total rate
  of the amount sold, rounded down: in the example above, exactly
  9,750,000 units. Today's check is "at most 1 %"
  (`apps/wallet/src/sodax/policy.ts:257`). An exact check means that the
  rates on the review are the rates charged. The wallet's own cap
  (`MAX_PARTNER_FEE_BPS`, `apps/wallet/src/sodax/chains.ts:87`) is 1 %
  today. With the split it limits the operator's rate, while the total of
  a split may reach the factory's cap, 1.875 %
  ([the cap](#decisions-for-the-owner)).
- **It shows who gets what.** Today the review names one fee, the
  operator's, and shows the receiver's address (`policy.ts:337-338`). With
  the split it says, for example,
  "9.75 USDC · 0.875 % to ColdAI · 0.1 % to Acme Swap", and names the
  receiver as the fee splitter. The platform's name comes from the
  reviewed allow-list. The operator's comes from the build, as today
  (`apps/wallet/src/config.ts:22`).
- **It refuses a split on a stock swap**
  ([tokenised stocks](#tokenised-stocks)).

Browser wallets check none of this. For them, as today, the server's
pinning is the control ([why it fails closed](fees.md#why-it-fails-closed)).

### The fee allow-list

Today `apps/wallet/fee-receivers.json` lists addresses, and only the
wallet build reads it (`apps/wallet/build-guards.ts:7-18`). With the split,
it holds two more kinds of entry:

- **Factories**: each factory's address, with the platform's name, address
  and rate, and the cap. None of these can change, so a reviewer reads them
  from the chain once, with the commands in
  [`contracts/fee-split/README.md`](../contracts/fee-split/README.md#deploy-to-sonic),
  and checks the verified source.
- **Splits**: for each operator, the factory, the operator's address and
  its rate. The wallet build works out each splitter's address, and stops
  if the factory would refuse the split. It warns when the config's split
  isn't listed, as it warns about a receiver today
  (`build-guards.ts:41-52`).

The config check and the server need the factory entries too. They can
read the same file, or the factory entries can move to a reviewed file in
`packages/config`, under the same rules.

Plain receivers stay: for a copy with a plain fee, and for an operator's
own fee on stock swaps.

### Tokenised stocks

Swaps of tokenised stocks, the tokens SODAX flags `isRwa`, carry no
platform fee. This design counts a swap as one when either side is a stock
([decisions](#decisions-for-the-owner)).

Stocks are an operator opt-in that ships off
([tokenised stocks](tokenised-stocks.md)). The server sends a request with
a stock on either side to SODAX only when its stock check passes it, and
refuses it with a 451 otherwise (`sodaxProxy.ts:194-204`). The app lists
stocks only when the server offers them (`TradeSheet.tsx:59-62`), and the
wallet signs them only in a build with stocks on, from its own table
(`apps/wallet/src/sodax/stock-tokens.ts`, `apps/wallet/src/config.ts:30-31`).
When a DEX offers stocks and also uses the split:

- **The server** already tells which requests have a stock leg, from
  SODAX's token list (`sodaxProxy.ts:62-70` and `:155-170`). For those it
  pins the operator's own fee, paid straight to the operator's address, or
  no fee at all. Never the splitter: a splitter gives the platform its
  share of whatever reaches it.
- **The wallet** tells stocks from its own reviewed table, never from the
  request: `stock-tokens.ts` already marks them. It refuses a split on a
  swap with a stock on either side.
- **The app** shows only the operator's fee on those swaps, or "None".

### Documents to change

When the split is built, these change with it:

- **`docs/fees.md`**: the table of costs, "How a fee works", "Why it fails
  closed", "Turn a fee on", "Turn a fee off" and the table of tests. Each
  needs the rates per 100,000, the amount form, the splitter as receiver,
  the two parties on the review, and stock swaps.
- **`README.md`**: the `fees` rows of the settings table, and the fees
  section, which says "up to 1 %", whole basis points and a plain receiver.
- **`AGENTS.md`**: step 6, "Set the fee", which turns a percentage into
  basis points and adds a plain receiver to the allow-list. And the fee's
  other mentions: the repository map, the recipe's opening, and steps 8
  and 9.
- **`CONTRIBUTING.md`**, "Changes that get extra review": the allow-list's
  new entries, and what a reviewer checks for each. For a factory, its
  values on the chain and its verified source. For a split, who controls
  the operator's address, confirmed through a channel other than the pull
  request, as today.
- **The other pages that describe the fee**: `docs/configuration.md` (the
  `fees` settings), `docs/api.md` (`GET /config`),
  `docs/embedded-wallet.md` (the signing policy), `docs/security.md`,
  `docs/wallet.md`, `docs/agents.md`, `docs/troubleshooting.md` (the
  build's fee warning), `docs/self-hosting.md`, and the shorter mentions in
  `docs/concepts.md`, `docs/architecture.md`, `docs/faq.md` and
  `docs/development.md`.

## Decisions for the owner

The first is decided. The rest are open, and this page lists them without
deciding them.

1. **The cap: decided.** On 2 November 2026 the owner decided that an
   operator may take up to 1 % of its own, on top of the platform's
   0.875 %. The total is at most 1.875 %, so the deploy script's default
   cap is 1,875 per 100,000. A factory's cap can't change, which is why it
   had to be settled before the factory is deployed. Two limits are still
   1 % on the whole fee: the config's (`PARTNER_FEE_MAX_BPS`,
   `packages/config/src/index.ts:148`) and the wallet's
   (`MAX_PARTNER_FEE_BPS`, `apps/wallet/src/sodax/chains.ts:87`). When the
   split is built, each limits the operator's rate instead, and a split's
   total may reach 1.875 %. Changing the wallet's limit needs an issue and
   agreement first
   ([CONTRIBUTING](../CONTRIBUTING.md#changes-that-get-extra-review)).
2. **What SODAX allows.** The repository can't answer these. SODAX can:
   - whether its backend caps a partner fee, and where. The type's comment
     says 100 basis points at most, while the SDK accepts up to 10,000
     ([the two forms](#the-two-forms-of-a-partner-fee));
   - whether every route ExClip uses takes the amount form, and whether a
     quote takes a pinned fee off its `amount`;
   - how the intents contract pays a fee in native S
     ([where the fee goes](#where-the-fee-goes-and-in-which-token));
   - whether its terms let a partner share its fee with another party.
3. **The platform's address.** It is chosen outside this repository:
   every script and this page take it as a parameter, and no file here
   names it. It has to be an address ColdAI controls for good, that
   accepts native S on Sonic. Who deploys the factory is open too.
4. **Stock swaps.** Whether "no platform fee" covers a swap with a stock on
   either side, as this design assumes. And whether an operator may still
   charge its own fee on those swaps.
5. **How the platform fee holds.** Only the passkey wallet checks where a
   fee goes. On a DEX whose server someone else runs, browser-wallet swaps
   carry whatever fee that server pins
   ([why it fails closed](fees.md#why-it-fails-closed)). Whether the
   platform fee rests on who builds and runs each DEX, on an agreement, or
   on something else, is open.
