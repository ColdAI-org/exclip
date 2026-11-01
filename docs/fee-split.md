# Fee split

This page is about paying two parties from one SODAX partner fee: the
platform and the operator of each DEX. It starts with how SODAX pays a
partner fee today, which decides how a split can work.

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
points from 0 to 100 (`packages/config/src/index.ts:122` and `:302`), and
the server pins `{ address, percentage }` on every route that carries a fee
(`packages/config/src/index.ts:351`,
`apps/server/src/services/sodaxProxy.ts:97-101` and `:187`).

### Where the fee goes, and in which token

- **On Sonic.** The receiver is an EVM address on Sonic, SODAX's hub
  chain: "`address` is the EVM hub fee receiver"
  (`backend/backendApiV2.d.ts:12`). SODAX's own example names it
  `partnerReceiverOnSonic` (`swaps-api:41`).
- **In the token sold.** The fee is in the intent's input token. For a swap
  from another chain, that is the token's hub asset: the ERC-20 that stands
  for it on Sonic (`sdk:25197`). For a swap from Sonic, it is the Sonic
  token itself, and native S is `0x0000…0000` (`sdk:25658-25701`). ExClip's
  wallet checks the same thing (`apps/wallet/src/sodax/policy.ts:225`).
  The amounts are in the same smallest units as the token sold: the wallet
  checks that the intent's amount plus the fee equals the amount the user
  pays (`policy.ts:229`).
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
(`policy.ts:252` and `:271-273`). How the intents contract then passes the
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
