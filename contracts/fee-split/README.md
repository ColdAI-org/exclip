# Fee split contracts

Two Solidity contracts that split one SODAX partner fee between two payees: the platform, and the operator of a
DEX. SODAX pays a partner fee on Sonic (chain id 146), as a plain balance of the fee's receiver, in the token sold.
`FeeSplitterFactory` creates one `FeeSplitter` per operator and operator rate, at an address known before it
exists. That address is the receiver. Anyone can then pay each payee its share.

[docs/fee-split.md](../../docs/fee-split.md) explains how SODAX pays a partner fee and how ExClip would use these
contracts.

**Not audited.** No outside party has reviewed these contracts. The tests and the static analysis below are the
only checks so far.

**Not deployed.** This repository holds no keys. The steps below are for whoever deploys, with their own key.

## Layout

| Path | What it holds |
|---|---|
| `src/FeeSplitter.sol` | The splitter: the shares, `release` and the views. Every splitter delegates to one copy of it, the implementation |
| `src/FeeSplitterFactory.sol` | The factory: `predict`, `deploy`, and the platform's address and rate |
| `src/SplitterProxy.sol` | The code of each splitter, a 91-byte proxy |
| `test/` | Unit, fuzz and invariant tests. `test/utils/` holds the cheatcode declarations, a fixture, and mock tokens and payees |
| `script/Deploy.s.sol` | Deploys a factory |
| `foundry.toml` | solc 0.8.28, EVM version `paris`, the optimizer at 10,000 runs |
| `package.json` | The commands below, as pnpm scripts. It isn't part of the pnpm workspace |

## What the contracts enforce

| | |
|---|---|
| Payees | Two per splitter, fixed for good: the platform and one operator. The platform's address and rate are set when the factory is deployed, and are the same in all its splitters. The operator and its rate are set when a splitter is created. Nothing can change them. |
| Rates | In parts per 100,000 of the amount sold: 875 is 0.875 %, 100 is 0.1 %. Each factory caps the platform's rate plus the operator's at `maxTotalRate`, which is at most 100,000. |
| Shares | For each token, a splitter has received what it holds plus what it has paid out. A payee's share is that total times its rate, divided by the sum of both rates, rounded down. Rounding leaves at most one smallest unit of each token that neither payee can take. |
| Collecting | `release(token, payee)` pays the payee all it is owed in one token. Anyone may call it, and only the payee is paid. `token` is `0x0000000000000000000000000000000000000000` for native S. |
| Native S | The proxy answers a call with no calldata itself: it logs `NativeReceived` and stops, in about 1,040 gas. So native S sent with Solidity's `transfer` or `send`, which pass on 2,300 gas, arrives. A call with calldata and a value is refused. |
| Early fees | A splitter's address depends only on the factory, the operator and the operator's rate. Fees sent there before the splitter exists stay there, and are paid out once it does. |
| Creation | `deploy(operator, operatorRate)` creates the splitter and sets its operator in one transaction. Anyone may call it. Calling it again returns the same address and changes nothing. It refuses the zero address, the platform as operator, a rate above the cap, and two rates of zero. `predict` refuses the same, so it never names an address where no splitter can be created. |
| No admin | No owner, admin, upgrade, pause or `selfdestruct`, and no `delegatecall` in the Solidity. Each splitter is a proxy that delegates to one implementation, whose address is part of its code. |
| Reentrancy | `release` writes its records before it sends, and a lock covers the send: while a payment is out, `release`, `releasable` and `received` revert with `Reentered`. |
| Tokens | A token's `transfer` must return `true` (a first word of 1), or nothing at all. Anything else fails the release with `TransferFailed` and changes nothing: `false`, a revert, a short or odd answer, or no answer from an address that has no code. A token that keeps a cut of each transfer is shared as it arrives, and each payee receives less than the amount its `Released` event shows. |

What they don't do:

- **Change a payee.** If a payee loses access to its address, its share stays in the splitter for good. Use
  addresses you control for good, such as a multisig.
- **Pay a payee that refuses native S.** A contract that rejects it can't be paid in native S, and that share stays
  in the splitter. The other payee is paid as usual.
- **Handle balances that shrink on their own**, as some rebasing tokens do. A splitter never pays out more than it
  holds, but the shortfall can fall on one payee.
- **Pay out by themselves.** Each release is one transaction, for one token and one payee, and whoever sends it
  pays the gas.

## Interface

```solidity
// FeeSplitterFactory
constructor(address platform, uint256 platformRate, uint256 maxTotalRate);
function predict(address operator, uint256 operatorRate) view returns (address);
function deploy(address operator, uint256 operatorRate) returns (address splitter);  // anyone; idempotent
function salt(address operator, uint256 operatorRate) pure returns (bytes32);         // keccak256(abi.encode(…))
function platform() view returns (address);
function platformRate() view returns (uint256);
function maxTotalRate() view returns (uint256);
function implementation() view returns (address);
function initCodeHash() view returns (bytes32);
function RATE_SCALE() view returns (uint256);                                         // 100,000
event SplitterDeployed(address indexed splitter, address indexed operator, uint256 operatorRate);

// FeeSplitter, at each splitter's address
function release(address token, address payee) returns (uint256 amount);              // anyone; pays only payee
function releasable(address token, address payee) view returns (uint256);
function received(address token) view returns (uint256);
function released(address token, address payee) view returns (uint256);
function totalReleased(address token) view returns (uint256);
function platform() view returns (address);
function platformRate() view returns (uint256);
function operator() view returns (address);
function operatorRate() view returns (uint256);
function factory() view returns (address);
function NATIVE() view returns (address);                                             // 0x0000…0000, native S
function initialize(address operator, uint32 operatorRate);                          // the factory only, once
event Released(address indexed token, address indexed payee, uint256 amount);
event NativeReceived(uint256 amount);
```

## The proxy

Each splitter's code is 91 bytes, written out in `src/SplitterProxy.sol`:

| Bytes | What they do |
|---|---|
| `36 602d 57` | If there is calldata, jump to the last part |
| `34 3d 52 7f <topic> 6020 3d a1 00` | Otherwise, log `NativeReceived(msg.value)` and stop |
| `5b 363d3d373d3d3d363d73 <implementation> 5af43d82803e903d91605957fd5bf3` | Delegate the call to the implementation, as an EIP-1167 minimal proxy does |

`<topic>` is `keccak256("NativeReceived(uint256)")`. The creation code is `3d605b80600a3d3981f3` followed by the
91 bytes.

A plain EIP-1167 clone would delegate every call. A `DELEGATECALL` to an address the transaction hasn't touched yet
costs 2,600 gas (EIP-2929), more than the 2,300 that `transfer` and `send` pass on. `PlainProxyTest` shows a plain
clone refusing such a payment.

A splitter's address:

```text
salt         = keccak256(abi.encode(operator, operatorRate))
initCodeHash = keccak256(creation code)                    // also factory.initCodeHash()
splitter     = the last 20 bytes of keccak256(0xff ‖ factory ‖ salt ‖ initCodeHash)
```

The implementation is the factory's first creation: the CREATE address of the factory with nonce 1. So every
splitter's address follows from the factory's address, the operator and the operator's rate, and can be worked out
without reading the chain.

## Test

Run these from `contracts/fee-split`, with Foundry 1.5.1:

```sh
pnpm run forge:test          # or: forge test
pnpm run forge:coverage      # coverage of src/
pnpm run forge:fmt:check
pnpm run slither             # Slither 0.11.6
```

There are no git submodules and no forge-std. The cheatcodes the tests use are declared in `test/utils/Test.sol`.
CI doesn't run these tests yet.

All 57 tests pass:

| Suite | Tests | What they cover |
|---|---|---|
| `FeeSplitterFactoryTest` | 17 | The factory's checks, `predict` against the CREATE2 formula, the proxy's exact code, deploying twice, anyone deploying, a creation that runs out of gas |
| `FeeSplitterTest` | 30 | The worked example, rounding, fees sent early, native S (by `transfer`, `send` and call), payees that refuse or reenter, and tokens that reenter, return nothing, return `false` or odd data, revert, lose their code or keep a cut |
| `PlainProxyTest` | 1 | A plain EIP-1167 clone refuses a payment that passes on 2,300 gas |
| `FeeSplitterFuzzTest` | 6, 1,024 runs each | Shares of any amount up to 2^256 − 1 at any rates, checked against an independent formula; payments and releases in any order; native S; `predict` against `deploy` from any caller; the rate checks |
| `FeeSplitterInvariantTest` | 3, 256 runs of 100 calls each | Payments (some before deployment), deployments and releases at random, across four splitters, in native S, a plain token, a token that returns nothing and one that keeps a cut |

The invariants: no splitter pays out more than it has received; what it holds plus what it has paid out is what
reached it; and what each payee has been paid plus what it can release is exactly its share, rounded down, with at
most one unit left over. At the end of each run, every splitter is deployed and every share released, and each
payee must have been paid exactly its share. The handler's calls never revert.

Coverage of `src/` is 100 %: lines 92/92, statements 111/111, branches 21/21, functions 19/19.

## Static analysis

`pnpm run slither` finds nothing. Before the comments that answer them were added, it found 13 results from 9
detectors. None is a defect. Each is now silenced by a `slither-disable` comment, under a comment that gives the
reason:

| Detector | Where | Why it isn't a problem |
|---|---|---|
| `arbitrary-send-eth` | `FeeSplitter._send` | The payee is the platform or the operator: `_rates` reverts for anyone else before anything is sent |
| `reentrancy-eth`, `write-after-write` | `FeeSplitter.release` | The records are written before the payment, and the lock makes `release`, `releasable` and `received` revert during it. Setting the state back after the payment is the lock opening, not a lost write |
| `divide-before-multiply` | `FeeSplitter.releasable` | `(t ÷ T) × r + ((t mod T) × r) ÷ T` is exact: the remainder carries into the second term. The fuzz tests check it against an independent formula |
| `incorrect-equality` (3) | `FeeSplitter.release` and `_send` | `amount == 0`: sending the splitter more can only raise `amount`. The other two read a token's answer, not a balance |
| `events-maths` | `FeeSplitter.initialize` | The factory's `SplitterDeployed` event records the operator's rate in the same transaction |
| `missing-zero-check` (3) | The constructors of both contracts, and `FeeSplitter.initialize` | The factory refuses the zero address before the splitter's code runs, and `new` never returns it |
| `assembly` | `FeeSplitterFactory.deploy` | Creating raw bytecode with CREATE2 needs assembly: Solidity's `new` creates only Solidity contracts |
| `low-level-calls` | `FeeSplitter._send` | Needed to accept tokens that return nothing, and to give a payee that is a contract all the gas it needs for native S |

`forge build` also runs Foundry's linter. `foundry.toml` turns two of its notes off and says why, and four lines
carry a `forge-lint` comment with the reason.

## Try it locally

```sh
pnpm run anvil              # one terminal: a local chain on port 8545
pnpm run dry-run:example    # another: simulates the deployment there
```

`dry-run:example` sets `PLATFORM_RECEIVER` to `0x1111…1111` and `SAMPLE_OPERATOR` to `0x2222…2222`, placeholders.
Neither script can send anything: `dry-run` points at `127.0.0.1:8545` and has no `--broadcast`. On a fresh anvil
its return values are:

```text
== Return ==
factory: contract FeeSplitterFactory 0x5b73C5498c1E3b4dbA84de0F1833c4a029d90519
platform: address 0x1111111111111111111111111111111111111111
platformRate: uint256 875
maxTotalRate: uint256 1875
implementation: address 0xC7f2Cf4845C6db0e1a1e91ED41Bcd0FcC1b0E141
initCodeHash: bytes32 0xd458769130779d2ca04e9b6d0ca72e6bd108ce48b867f5b7d759c75bff63beb6
sampleSplitter: address 0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe
```

`sampleSplitter` is the splitter for the sample operator at 100, 0.1 %. Without `PLATFORM_RECEIVER`, the script
stops: "PLATFORM_RECEIVER is not set, or is the zero address".

## Deploy to Sonic

One factory serves every operator, so it's deployed once. Its platform address and rates can't change. Another
address or rate needs a new factory, which gives every operator a new splitter address.

The script reads its settings from the environment:

| Variable | Meaning | Default |
|---|---|---|
| `PLATFORM_RECEIVER` | The platform's address on Sonic | none: required, and never the zero address |
| `PLATFORM_RATE` | The platform's rate, per 100,000 | 875 (0.875 %) |
| `MAX_TOTAL_RATE` | The cap on the platform's rate plus an operator's | 1875 (1.875 %: the platform's 0.875 % and up to 1 % for an operator) |
| `SAMPLE_OPERATOR`, `SAMPLE_OPERATOR_RATE` | An operator and rate whose splitter address to print | none, and 100 |

viem 2.57.7's entry for Sonic lists the RPC endpoint `https://rpc.soniclabs.com` and the explorer
`https://sonicscan.org`. The code targets `paris`, which
[the hub's EVM version](../../docs/fee-split.md#the-hubs-evm-version) explains.

1. Choose the platform's address on Sonic. Nothing can change it later, so use one the platform controls for good,
   such as a multisig. It must accept native S.
2. Import the deployer's key into Foundry's encrypted keystore. The key never goes in a file in this repository:
   ```sh
   cast wallet import fee-split-deployer --interactive
   ```
   With a Ledger, use `--ledger` in place of `--account fee-split-deployer` below.
3. Simulate. Nothing is sent without `--broadcast`:
   ```sh
   cd contracts/fee-split
   export SONIC_RPC_URL=https://rpc.soniclabs.com
   export PLATFORM_RECEIVER=0x…    # the platform's address on Sonic
   forge script script/Deploy.s.sol:Deploy --rpc-url sonic --sender 0x…
   ```
   `--sender` is the deployer's address. The factory's address depends on it and on its nonce, so the address
   printed is the one the deployment will use, as long as the account sends nothing else first. Check every
   return value. The local dry run estimates 1,757,013 gas, which includes forge's default margin of 30 %.
4. Deploy:
   ```sh
   forge script script/Deploy.s.sol:Deploy --rpc-url sonic --account fee-split-deployer --sender 0x… --broadcast
   ```
   The script reads no key. The signer comes from `--account` or `--ledger`.
5. Verify the source of the factory and of the implementation on the explorer, with the settings in
   `foundry.toml`. The implementation's constructor arguments are the platform's address and rate.
6. Check the factory on-chain:
   ```sh
   cast call <factory> "platform()(address)" --rpc-url sonic
   cast call <factory> "platformRate()(uint256)" --rpc-url sonic
   cast call <factory> "maxTotalRate()(uint256)" --rpc-url sonic
   ```

## Use a splitter

For each operator and rate:

```sh
# Its address, to use as the partner fee's receiver. It reverts for anything deploy would refuse.
cast call <factory> "predict(address,uint256)(address)" <operator> <operatorRate> --rpc-url sonic
# Create it, from any account, at any time. Fees that arrived earlier are kept.
cast send <factory> "deploy(address,uint256)" <operator> <operatorRate> --rpc-url sonic --account <name>
# What a payee can collect in one token, then collect it. Any account can send the release.
cast call <splitter> "releasable(address,address)(uint256)" <token> <payee> --rpc-url sonic
cast send <splitter> "release(address,address)" <token> <payee> --rpc-url sonic --account <name>
```

`release` reverts with `NothingDue` when nothing is owed. For native S, `<token>` is
`0x0000000000000000000000000000000000000000`.
