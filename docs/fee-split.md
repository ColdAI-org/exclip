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

**Not audited.** No outside party has reviewed the contracts, or the code
in ExClip that uses them. Their tests and static analysis are the only
checks so far.

**Built, and off by default.** The config, the server, the app and the
passkey wallet all handle a split
([the split in ExClip](#the-split-in-exclip)). The repository's default
charges no fee, and its fee allow-list lists no factory and no split. This
repository deploys no contract.

This page starts with how SODAX pays a partner fee, which decides how a
split can work. Then it covers how the split works, an example, what the
contracts guarantee, how a payee collects, deploying the factory, how
ExClip uses the split, the owner's decisions, and the questions still
open.

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

ExClip uses both. A plain fee is a percentage: the config allows whole
basis points from 0 to 100 (`packages/config/src/index.ts:192` and
`:384`), and the server pins `{ address, percentage }` on every route that
carries a fee (`packages/config/src/index.ts:512`,
`apps/server/src/services/sodaxProxy.ts:114` and `:122-126`). A split is
an amount, worked out for each swap ([the server](#the-server)).

### Where the fee goes, and in which token

- **On Sonic.** The receiver is an EVM address on Sonic, SODAX's hub
  chain: "`address` is the EVM hub fee receiver"
  (`backend/backendApiV2.d.ts:12`). SODAX's own example names it
  `partnerReceiverOnSonic` (`swaps-api:41`).
- **In the token sold.** The fee is in the intent's input token. For a swap
  from another chain, that is the token's hub asset: the ERC-20 that stands
  for it on Sonic (`sdk:25197`). For a swap from Sonic, it is the Sonic
  token itself, and native S is `0x0000…0000` (`sdk:25658-25701`). ExClip's
  wallet checks the same thing (`apps/wallet/src/sodax/policy.ts:283`).
  The amounts are in the same smallest units as the token sold: the wallet
  checks that the intent's amount plus the fee equals the amount the user
  pays (`policy.ts:287`).
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
(`policy.ts:319` and `:338-340`). How the intents contract then passes the
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
  ([the split in ExClip](#the-split-in-exclip)).
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
   default), which leaves an operator up to 1 %. The owner
   [decided](#the-owners-decisions) these values.
3. **Simulate** with `forge script` without `--broadcast`, and check every
   value it returns.
4. **Deploy**, signing with an encrypted keystore or a Ledger. The script
   reads no key.
5. **Verify** the source on the explorer, and read the factory's
   `platform`, `platformRate`, `maxTotalRate` and `initCodeHash` back from
   the chain. A copy of ExClip lists those values under `factories` in its
   fee allow-list ([the fee allow-list](#the-fee-allow-list)).

The platform's address, its rate and the cap can't change. Changing any of
them means a new factory, and a new splitter address for every operator.

An operator's splitter needs nothing deployed before its first fee: its
address is the factory's `predict(operator, operatorRate)`. Anyone can
create it later with `deploy(operator, operatorRate)`.

## The split in ExClip

A copy of ExClip charges a plain fee, a split, or no fee, which is the
default. The code that decides where a fee goes, which is the config
rules, the fee allow-list, the splitter's address and the wallet's signing
policy, gets extra review
([CONTRIBUTING](../CONTRIBUTING.md#changes-that-get-extra-review)).
[Fees](fees.md#a-fee-split) says how to turn a split on.

| | A plain fee | A split |
|---|---|---|
| Set by | `fees.partnerFeeBps` and `fees.receiver` | `fees.split`: a listed factory, the operator's address and its rate |
| The rate | The operator's, in whole basis points, 0 to 100 | The platform's plus the operator's, per 100,000; the operator's 0 to 1,000 |
| What SODAX is sent | `{ address, percentage }` | `{ address, amount }` |
| The receiver | `fees.receiver`, typed in the config | The operator's splitter, worked out, never typed |
| What the passkey wallet signs | A fee of at most 1 % to an address on its list | A fee of exactly the total rate, to a splitter it works out itself |
| The wallet's review | `Acme Ltd fee 3 USDC` | `9.75 USDC · 0.875% to ColdAI · 0.1% to Acme Ltd` |
| A swap with a tokenised stock | The same fee | The operator's own plain fee, or none |

In the reviews above, "Acme Ltd" is the build's `brand.operator`, or
`brand.name` when that is empty. "ColdAI" is the `platformName` of the
factory's entry in the allow-list: no code names the platform.

### The config

A split is set under `fees.split`
(`packages/config/src/index.ts:52-64`). The repository's default sets none.

| Setting | Meaning |
|---|---|
| `factory` | The factory's address on Sonic. The fee allow-list must list it ([below](#the-fee-allow-list)) |
| `operator` | The operator's address on Sonic, where its share is paid |
| `operatorRate` | The operator's rate per 100,000 of the amount sold, a whole number from 0 to 1,000: `100` is 0.1 %, and `0` charges only the platform's fee |
| `stockFeeBps` | The operator's own fee on a swap with a tokenised stock, in basis points from 0 to 100, paid to `operator`. Default `0` ([tokenised stocks](#tokenised-stocks)) |

The platform's address, its rate and the cap are not settings. The factory
fixes them, and the allow-list records them beside the factory's address.
The config check takes them from there (`index.ts:406-412`), so a config
can't misstate them.

The config check refuses (`index.ts:396-415`):

- a factory that the allow-list doesn't list;
- an `operatorRate` that isn't a whole number from 0 to 1,000
  (`OPERATOR_RATE_MAX`, `packages/config/src/fee-rates.ts:11`);
- a split in a config that also sets a plain fee: `fees.partnerFeeBps`
  above 0, or a `fees.receiver`;
- whatever the factory would refuse, checked in the factory's order
  (`packages/config/src/fee-split.ts:76-82`, as
  `contracts/fee-split/src/FeeSplitterFactory.sol:83-88`): the zero
  address as the operator, the platform as the operator, an operator's
  rate above the cap minus the platform's rate, and two rates of zero.

These checks matter. The CREATE2 formula gives an address for any input,
so without them a config could name an address where no splitter can ever
be created, and a fee sent there would be stuck for good.

What passes is resolved once, with the splitter's address
(`index.ts:417-427`). `PARTNER_FEE_MAX_BPS` (`index.ts:192`) still limits
a plain fee and `stockFeeBps` to 1 %. A split's total may reach the listed
cap.

The config check reads the allow-list from the repository root whenever it
reads the config (`packages/config/src/node.ts:52-60` and `:67`): when the
server starts, and when either app builds. A broken allow-list stops all
three.

**The fee is sent as an amount.** The total rate is finer than a basis
point: 0.975 % is 97.5 basis points, and the percentage form takes whole
basis points only ([the two forms](#the-two-forms-of-a-partner-fee)). So
the fee is worked out for each swap, and sent as `{ address, amount }`:

```text
fee = amount sold × (platform's rate + operator's rate) ÷ 100,000, rounded down
```

That is `splitFee` (`packages/config/src/fee-rates.ts:22-24`), the one
copy of the arithmetic that the server, the app and the wallet use.

### The splitter's address

The receiver is the operator's splitter: the address that the factory's
`predict(operator, operatorRate)` returns. ExClip works it out without
reading the chain, in one module, `packages/config/src/fee-split.ts`. The
config check, the server and the wallet window use it. The app takes the
splitter from `/config` and bundles only `fee-rates.ts`, which has no
hashing in it.

`predictSplitter` (`fee-split.ts:136-144`) does what the factory does:

1. It refuses a factory that can't exist, as the factory's constructor
   would (`fee-split.ts:61-72`, as `FeeSplitterFactory.sol:37-39`), and
   whatever `predict` would refuse (`fee-split.ts:76-82`).
2. The implementation is the factory's first creation: its CREATE address
   at nonce 1 (`fee-split.ts:104-107`).
3. The creation code is the proxy's, with the implementation's address in
   it (`fee-split.ts:17-23` and `:110-113`).
4. The salt is `keccak256(abi.encode(operator, operatorRate))`
   (`fee-split.ts:121-125`), and the address is the one CREATE2 gives the
   factory (`fee-split.ts:128-131`).

Two checks tie the module to the contracts:

- **The vectors.** `contracts/fee-split/script/Vectors.s.sol` deploys real
  factories on a fresh anvil, and records what they predict, deploy and
  refuse in `contracts/fee-split/test/vectors/splitters.json`.
  `packages/config/test/fee-split.test.ts` checks the module against every
  vector. One is the local dry run's: the factory `0x5b73…0519`, the
  operator `0x2222…2222` and the rate 100 give the splitter `0x92F0…57Fe`
  ([the vectors](../contracts/fee-split/README.md#the-vectors-exclip-is-tested-against)).
- **The splitter's code.** `pnpm run splitter-code` compares the module's
  creation code with the compiled factory's.

CI's `contracts: forge, slither` job runs both. It writes the vectors again
and fails if they differ from the committed file, and it fails if the
splitter's code has drifted ([development](development.md#scripts)).

The splitter doesn't have to exist when the first fee arrives. It has to
exist before the first release, and anyone can create it.

### The fee allow-list

`apps/wallet/fee-receivers.json` says where the passkey wallet lets a fee
go. It has three lists, and the repository ships all three empty:

- **`receivers`**: the addresses a plain fee may go to, as before.
- **`factories`**: each factory's address, the platform's name, the
  platform's address and rate, the cap, and what the factory's
  `initCodeHash()` returns. A reviewer reads each value from the chain
  once
  ([deploy to Sonic](../contracts/fee-split/README.md#deploy-to-sonic)),
  and checks the verified source. Reviews show `platformName`.
- **`splits`**: each operator's split under a listed factory: the
  factory, the operator's address and its rate.

An example, with the local dry run's factory and placeholder addresses.
None of it is a real deployment:

```json
{
  "$comment": "…",
  "receivers": [],
  "factories": [
    {
      "address": "0x5b73C5498c1E3b4dbA84de0F1833c4a029d90519",
      "platformName": "Platform",
      "platform": "0x1111111111111111111111111111111111111111",
      "platformRate": 875,
      "maxTotalRate": 1875,
      "initCodeHash": "0xd458769130779d2ca04e9b6d0ca72e6bd108ce48b867f5b7d759c75bff63beb6"
    }
  ],
  "splits": [
    {
      "factory": "0x5b73C5498c1E3b4dbA84de0F1833c4a029d90519",
      "operator": "0x2222222222222222222222222222222222222222",
      "operatorRate": 100
    }
  ]
}
```

The splitter isn't listed: whatever needs it works it out. This split's is
`0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe`. `parseFeeAllowList`
(`fee-split.ts:210-270`) checks the file, and refuses:

- a factory whose values no `FeeSplitterFactory` can have, or whose
  `initCodeHash` isn't the one worked out from its address
  (`fee-split.ts:236-242`), so a mistyped factory can't be listed;
- a platform name that isn't plain text of 1 to 40 characters;
- a split under a factory the file doesn't list, with a rate outside 0 to
  1,000, or that its factory would refuse;
- a factory or a split listed twice;
- a split whose splitter is also under `receivers`, where it could be
  paid as a plain fee;
- an unknown key, anywhere in the file.

Three things read the file, all through that function: the wallet's build
(`apps/wallet/vite.config.ts:79`), the config check (`node.ts:52-60`) and
so the server, which runs the config check when it starts. Each stops on
an error.

**Why this file.** It was already the reviewed list of where a fee may go,
and the wallet build already read it. Keeping the factories and splits
there means that one file holds every address a fee may go to, and one
reviewed commit changes it. A second file, in `packages/config`, would
need the same review, and could drift from this one.

A DEX launched through ColdAI's launch plugin gets the platform's factory
and its own split from the plugin, in its own copy. This repository lists
neither ([the owner's decisions](#the-owners-decisions)).

### The server

On the five routes that carry a fee, which are the quote,
`allowance/check`, `approve`, `intents` and `limit-orders`
(`apps/server/src/services/sodaxProxy.ts:38` and `:42-45`), the server
drops the browser's fee, as before (`:122-126`), and pins its own
(`feeFor`, `:112-120`):

- **A plain fee**: `{ address, percentage }`, as configured, on every
  swap.
- **A split**: `{ address: splitter, amount }`, with no percentage. The
  amount is `splitFee` of the amount sold, which is `amount` on the quote
  and `inputAmount` on the other four routes (`types`
  `backend/backendApiV2.d.ts:214-231`, `:254-270` and `:431`). Nothing is pinned
  when the fee rounds down to 0.
- **A split, on a swap with a tokenised stock on either side**: the
  operator's own plain fee, or none
  ([tokenised stocks](#tokenised-stocks)).

The fee is pinned after the stock check (`:215-239`), because a split's
fee depends on whether either side is a stock. A split's request whose
amount sold isn't a whole number written in digits is refused with 400
`BAD_AMOUNT` (`:106`, `:117` and `:234-237`) before it reaches SODAX,
rather than sent on without the fee.

`/config` publishes the split as `feeSplit`
(`apps/server/src/services/config.ts:118-126`): the receiver, which is the
splitter, the total rate, the platform's and the operator's names and
rates per 100,000, and the fee on stock swaps. `partnerFeeBps` and
`feeReceiver` stay, as `0` and `null` with a split
([`GET /config`](api.md#get-config)). The platform's name comes from the
factory's entry in the allow-list. The operator's is `brand.operator`, or
`brand.name` when that is empty, as in the wallet window (`config.ts:90`).

The start-up log shows the split (`apps/server/src/index.ts:32-41`). With
the example allow-list above and no fee on stock swaps:

```text
[exclip] trading on; fee split 0.975 % to splitter 0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe (Platform 0.875 %, operator 0.1 %); on stock swaps no fee
```

### The quote

The quote starts from the amount sold, as the fee and the intent do. The
app used to ask for a quote on the amount after the fee, while the server
pinned the fee on that quote too. The evidence says that SODAX takes a
pinned fee off a quote's `amount`, so the fee was counted twice, and the
quote and the minimum received came out about one fee low:

- The SDK's own `getQuote` takes the partner fee off the amount before it
  asks for a quote, so that "the returned `quoted_amount` reflects the net
  output the user actually receives", and expects the same fee as
  `createIntent` (`sdk:30603-30634`, with `adjustAmountByFee` at
  `sdk:6806`). Its `LeverageYieldService.getQuote` does the same
  (`sdk:44838-44857`).
- The backend's fee is the "wire mirror of the SDK `PartnerFee` union"
  (`types` `backend/backendApiV2.d.ts:10-22`). A quote's `amount` is the
  "input amount" (`:223-224`), and a quote with `includeTxData=true`
  builds the intent from the same request, "using the quoted amount as
  `minOutputAmount`" (`:232-236`). That only works if the quote takes the
  fee off the amount the intent sells.
- SODAX's swaps API says to send the same `partnerFee` on the quote and on
  the intent (`swaps-api:105-116`). Its React kit keys its quote cache on
  the fee, because "a partnerFee change alters the quote"
  (`dist/index.mjs:1623-1626` in `@sodax/dapp-kit` 2.2.0).

So the app quotes the amount sold, for a plain fee as for a split
(`apps/web/src/components/TradeSheet.tsx:119-122`). SODAX's backend isn't
public, so this is still a question for SODAX
([decisions for the owner](#decisions-for-the-owner)).

### The app

- **It passes the fee with each swap.** The SDK gets no fee of its own
  (`apps/web/src/lib/api.ts:140-142`). Each swap works its fee out with
  `swapFee` (`apps/web/src/lib/fees.ts:36-50`) and passes it to
  `createIntent` as `extras.partnerFee`
  (`apps/web/src/lib/wallet-runtime.tsx:125`, `:197`, `:204` and `:230`),
  which the SDK uses in place of its own (`sdk:31303-31305`). A split's
  fee is `{ address: splitter, amount }`, which the SDK uses as given
  (`sdk:25257-25258`). A plain fee is `{ address, percentage }`, as before.
- **It shows the split.** The same `swapFee` gives the review's rows, so
  the review shows the fee the intent carries. With a split, the review
  has one row for each party with a rate above 0, each with its amount
  (`apps/web/src/components/TradeSheet.tsx:280-282`), such as
  "ColdAI fee (0.875%)" and "Acme Ltd fee (0.10%)". The names come from
  `/config`. On a phone, a long row name wraps rather than being cut off
  (`apps/web/src/styles/exclip.css:356`).
- **A swap with a stock** shows only the operator's own fee, or "None"
  (`fees.ts:40`).

### The wallet

For passkey users, the wallet is where the split is checked. It trusts
nothing the app sends:

- **It works the splitter out itself.** Its build takes each listed
  split's terms from the allow-list: the factory's values, the platform's
  name, and the operator's address and rate
  (`apps/wallet/build-guards.ts:24-31`, `apps/wallet/src/config.ts:12-20`).
  Not the splitter's address: the wallet works that out with
  `predictSplitter` (`apps/wallet/src/sodax/policy.ts:245-252`), and
  matches the intent's receiver against it (`:263`). A splitter is looked
  for before the plain receivers, so its fee is always held to the split's
  rates.
- **It checks the fee exactly.** A fee to a splitter must be the total
  rate of the amount sold, rounded down (`policy.ts:294`): in the
  [worked example](#a-worked-example), exactly 9,750,000 units. One unit
  more or less is refused. So the rates on the review are the rates
  charged. A plain fee is still "at most 1 %" (`policy.ts:296`).
- **It holds the operator to 1 %.** The wallet's cap
  (`MAX_PARTNER_FEE_BPS`, `apps/wallet/src/sodax/chains.ts:89`) limits the
  operator's rate in a split (`policy.ts:293`), while the split's total
  may reach its factory's listed cap
  ([the owner's decisions](#the-owners-decisions)).
- **It shows who gets what.** The review's Fees line says, for example,
  `9.75 USDC · 0.875% to ColdAI · 0.1% to Acme Ltd · network …`, and the
  receiver line names the address as the fee splitter
  (`policy.ts:268-274` and `:377-378`). The platform's name comes from the
  allow-list. The operator's is the build's, as for a plain fee
  (`apps/wallet/src/config.ts:31`). A party whose rate is 0 is left out.
- **It refuses a split on a stock swap**, telling stocks from its own
  table, never from the request (`policy.ts:143` and `:292`)
  ([tokenised stocks](#tokenised-stocks)).

The build stops on an allow-list that `parseFeeAllowList` refuses
(`apps/wallet/vite.config.ts:79`). It warns when the config's split isn't
listed under `splits`, or when the operator's fee on stock swaps goes to an
address `receivers` doesn't list (`build-guards.ts:67-80`). The wallet then
refuses every swap that carries that fee.

Browser wallets check none of this. For them, the server's pinning is the
control ([why it fails closed](fees.md#why-it-fails-closed)).

### Tokenised stocks

Swaps of tokenised stocks, the tokens SODAX flags `isRwa`, carry no
platform fee. A swap counts as one when either side is a stock. On those
swaps the operator may still charge its own plain fee, `stockFeeBps`, paid
straight to its own address, or none. Both are the owner's choice of
2 November 2026 ([the owner's decisions](#the-owners-decisions)).

Stocks are an operator opt-in that ships off
([tokenised stocks](tokenised-stocks.md)). The server sends a request with
a stock on either side to SODAX only when its stock check passes it, and
refuses it with a 451 otherwise (`sodaxProxy.ts:215-228`). The app lists
stocks only when the server offers them (`TradeSheet.tsx:60-62`), and the
wallet signs them only in a build with stocks on, from its own table
(`apps/wallet/src/sodax/stock-tokens.ts`, `apps/wallet/src/config.ts:41`).
When a DEX offers stocks and also uses the split:

- **The server** tells which requests have a stock leg from SODAX's token
  list (`sodaxProxy.ts:64-72` and `:178-193`). For those it pins the
  operator's own fee, or none (`:115`). Never the splitter: a splitter
  gives the platform its share of whatever reaches it.
- **The wallet** tells stocks from its own reviewed table, never from the
  request, and refuses a split on a swap with a stock on either side
  (`policy.ts:292`). It signs the operator's own fee there only if the
  address is listed under `receivers`, by the plain fee's rules.
- **The app** shows only the operator's own fee on those swaps, or "None"
  (`fees.ts:40`).

### Where each rule is enforced

| Rule | Where |
|---|---|
| The platform's address and rate, and the cap, never change | `contracts/fee-split/src/FeeSplitterFactory.sol`: set once by its constructor (`:37-39` checks them) |
| A splitter exists only for an operator and rate the factory accepts | `FeeSplitterFactory.sol:83-88`; ExClip checks the same in `packages/config/src/fee-split.ts:76-82` |
| A factory is listed only with the values a factory there has | `parseFeeAllowList`, `fee-split.ts:226-251`, with the `initCodeHash` check at `:236-242` |
| A split is listed only if its factory is, and would accept it | `fee-split.ts:253-268` |
| A config's split uses a listed factory, and never comes with a plain fee | `packages/config/src/index.ts:396-415` |
| The operator's rate is at most 1 % | `fee-split.ts:174-175` (config and allow-list), `apps/wallet/src/sodax/policy.ts:293` (wallet) |
| The fee is the total rate of the amount sold, rounded down | `splitFee`, `packages/config/src/fee-rates.ts:22-24`, used by the server, the app and the wallet |
| The server pins the split's amount to the splitter, whatever the browser sent | `apps/server/src/services/sodaxProxy.ts:112-126` and `:230-239` |
| A swap with a stock on either side never pays the splitter | Server `sodaxProxy.ts:115`, app `apps/web/src/lib/fees.ts:40`, wallet `policy.ts:292` |
| The passkey wallet works the splitter out itself | `policy.ts:245-252` and `:263` |
| The passkey wallet signs exactly the split's rates | `policy.ts:294` |
| The platform's name comes from the allow-list | `fee-split.ts:234`, then `apps/server/src/services/config.ts:88` and `policy.ts:272` |
| The address maths matches the contracts | `packages/config/test/fee-split.test.ts` against the vectors, and `pnpm run splitter-code`, both in CI |

## The owner's decisions

The owner decided these, and the code follows them:

1. **The rates.** A DEX launched through ColdAI pays a platform fee of
   0.875 % of the amount sold (875 per 100,000), through the split. Its
   operator may take up to 1 % of its own (1,000) on the same swap. The
   total is at most 1.875 % (1,875), the factory's cap and the deploy
   script's default. Decided on 2 November 2026. A factory's cap can't
   change, which is why it had to be settled before the factory is
   deployed.
2. **Live once built, not audited.** The split may be used as soon as it
   is built. These pages and the contracts' README say that it is not
   audited.
3. **A neutral repository.** The default config charges no fee. The
   allow-list's `factories` and `splits` ship empty, and no file here names
   the platform's receiving address, its factory or a split of it. ColdAI's
   launch plugin adds those entries in its own repository. The platform's
   name on a review comes from the allow-list entry, never from code. Tests
   and examples use the local dry run's factory and placeholder addresses
   such as `0x1111…1111` and `0x2222…2222`.
4. **Tokenised stocks.** A swap with a stock on either side carries no
   platform fee and never goes to a splitter. On those swaps the operator
   may still charge its own plain fee, paid straight to its own listed
   address, or none ([tokenised stocks](#tokenised-stocks)). Decided on
   2 November 2026.
5. **The wallet's limit.** The wallet's `MAX_PARTNER_FEE_BPS`
   (`apps/wallet/src/sodax/chains.ts:89`) and the config's
   `PARTNER_FEE_MAX_BPS` (`packages/config/src/index.ts:192`) stay at 1 %.
   They still limit a plain fee. In a split they limit the operator's rate,
   and the split's total may reach its factory's listed cap. A change to
   the wallet's fee limit normally needs an issue and agreement first
   ([CONTRIBUTING](../CONTRIBUTING.md#changes-that-get-extra-review)). This
   one was decided by the owner on 2 November 2026 instead.

## Decisions for the owner

These are open. This page lists them without deciding them.

1. **What SODAX allows.** The repository can't answer these. SODAX can:
   - whether its backend caps a partner fee, and where. The type's comment
     says 100 basis points at most, while the SDK accepts up to 10,000
     ([the two forms](#the-two-forms-of-a-partner-fee)). A split's total
     may be up to 187.5 basis points;
   - whether every route ExClip uses takes the amount form, and whether a
     quote takes a pinned fee off its `amount`, as ExClip now assumes
     ([the quote](#the-quote));
   - how the intents contract pays a fee in native S
     ([where the fee goes](#where-the-fee-goes-and-in-which-token));
   - whether its terms let a partner share its fee with another party.
2. **The platform's address.** It is chosen outside this repository:
   every script and this page take it as a parameter, and no file here
   names it. It has to be an address ColdAI controls for good, that
   accepts native S on Sonic. Who deploys the factory is open too.
3. **How the platform fee holds.** Only the passkey wallet checks where a
   fee goes. On a DEX whose server someone else runs, browser-wallet swaps
   carry whatever fee that server pins
   ([why it fails closed](fees.md#why-it-fails-closed)). The passkey wallet
   also signs an intent that carries no fee at all, so a copy whose server
   pins none pays nobody. Whether the platform fee rests on who builds and
   runs each DEX, on an agreement, or on something else, is open.
4. **The wallet's stablecoin floor.** The passkey wallet refuses a swap
   between USD stablecoins whose minimum is below 97 % of the amount sold
   (`STABLE_FLOOR_BPS`, `apps/wallet/src/sodax/price.ts:17`). The floor
   was set for a fee of at most 1 % and slippage of at most 1 %. With a
   split at its cap, 1.875 %, and the app's 1 % slippage setting, even a
   swap at par comes within a fraction of a percent of the floor, so a
   pair quoted a little below par is refused. That fails closed: the user
   can pick a lower slippage. Lowering the floor would loosen a wallet
   limit, which needs an issue and agreement first
   ([CONTRIBUTING](../CONTRIBUTING.md#changes-that-get-extra-review)), and
   the decision of 2 November 2026 covered the fee limits only. This
   change leaves the floor as it was.
