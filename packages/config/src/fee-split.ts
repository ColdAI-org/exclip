/** The fee split (docs/fee-split.md): where a FeeSplitterFactory puts the splitter for an operator and an operator
 * rate, worked out exactly as contracts/fee-split/src/FeeSplitterFactory.sol does, so the config check, the server and
 * the wallet window name the same receiver without asking the chain. test/fee-split.test.ts checks it against what real
 * factories work out (contracts/fee-split/test/vectors/splitters.json), and `pnpm run splitter-code` checks the proxy's
 * creation code against the factory's compiled code.
 *
 * Erasable TypeScript only and no Node imports: the wallet window bundles this module. */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** Rates are in parts per 100,000 of the amount sold: 875 is 0.875 %, 1,000 is 1 % (FeeSplitterFactory.RATE_SCALE). */
export const RATE_SCALE = 100_000;

/** The most an operator may take in a split, on top of the platform's rate: 1,000 per 100,000, the same 1 % as a plain
 * fee (PARTNER_FEE_MAX_BPS). The owner's decision of 2 November 2026 (docs/fee-split.md). */
export const OPERATOR_RATE_MAX = 1_000;

/** SplitterProxy.initCode's hex literals before the implementation's address, in order, and the one after it
 * (contracts/fee-split/src/SplitterProxy.sol). The third is NATIVE_RECEIVED, keccak256("NativeReceived(uint256)"). */
export const SPLITTER_CODE_BEFORE: readonly string[] = Object.freeze([
  "3d605b80600a3d3981f3",
  "36602d57343d527f",
  "9c94480424d42e2ce1ebaf924572bdac72c22ee882d282975ea62aef07c5e81f",
  "60203da1005b363d3d373d3d3d363d73",
]);
export const SPLITTER_CODE_AFTER: readonly string[] = Object.freeze(["5af43d82803e903d91605957fd5bf3"]);

/** A factory's fixed values: its address, and what its platform(), platformRate() and maxTotalRate() return. */
export type SplitFactory = {
  address: string;
  platform: string;
  platformRate: number;
  maxTotalRate: number;
};

/** What FeeSplitterFactory's predict and deploy refuse, by the factory's error names. */
export type SplitRefusal = "ZeroAddress" | "OperatorIsPlatform" | "RateTooHigh" | "ZeroRates";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A 0x-prefixed 20-byte address, in lower case or in mixed case with a valid EIP-55 checksum: a mistyped mixed-case
 * address fails its checksum, so it is refused rather than paid. */
export function isAddress(value: unknown): value is string {
  if (typeof value !== "string" || !ADDRESS.test(value)) return false;
  return value === value.toLowerCase() || checksumAddress(value) === value;
}

/** The address in EIP-55 mixed case. */
export function checksumAddress(address: string): string {
  if (!ADDRESS.test(address)) throw new Error(`not an address: ${address}`);
  const hex = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(utf8ToBytes(hex)));
  let out = "0x";
  for (let i = 0; i < hex.length; i++) {
    out += Number.parseInt(hash.charAt(i), 16) >= 8 ? hex.charAt(i).toUpperCase() : hex.charAt(i);
  }
  return out;
}

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A rate as a percentage without trailing zeros: 875 is "0.875", 1,000 is "1". */
export function formatRate(rate: number): string {
  const whole = Math.floor(rate / 1_000);
  const fraction = String(rate % 1_000).padStart(3, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** The fee a split takes on `amountSold`: amountSold × totalRate ÷ 100,000, rounded down. The server pins it, and the
 * wallet window signs a fee to a splitter only when it is exactly this. */
export function splitFee(amountSold: bigint, totalRate: number): bigint {
  return (amountSold * BigInt(totalRate)) / BigInt(RATE_SCALE);
}

/** What the splitter owes each party out of `fee`: fee × its rate ÷ the sum of both rates, rounded down
 * (FeeSplitter.releasable). Rounding leaves at most one smallest unit that neither can take. */
export function splitShares(fee: bigint, platformRate: number, operatorRate: number): { platform: bigint; operator: bigint } {
  const total = BigInt(platformRate + operatorRate);
  if (total === 0n) return { platform: 0n, operator: 0n };
  return { platform: (fee * BigInt(platformRate)) / total, operator: (fee * BigInt(operatorRate)) / total };
}

/** What FeeSplitterFactory's constructor refuses (FeeSplitterFactory.sol:37-39), or null. A factory with these values
 * can't exist, so nothing can be predicted for it. */
export function factoryProblem(factory: SplitFactory): string | null {
  if (!isAddress(factory.address)) return "address must be 0x and 40 hex digits, in lower case or with a valid checksum";
  if (!isAddress(factory.platform)) return "platform must be 0x and 40 hex digits, in lower case or with a valid checksum";
  if (BigInt(factory.platform) === 0n) return "platform is the zero address, which the factory refuses";
  const { platformRate, maxTotalRate } = factory;
  if (!Number.isSafeInteger(platformRate) || platformRate < 0) return "platformRate must be a whole number of at least 0";
  if (!Number.isSafeInteger(maxTotalRate) || maxTotalRate < 1 || maxTotalRate > RATE_SCALE) {
    return `maxTotalRate must be a whole number from 1 to ${RATE_SCALE}`;
  }
  if (platformRate > maxTotalRate) return `platformRate ${platformRate} is above maxTotalRate ${maxTotalRate}`;
  return null;
}

/** What predict and deploy would refuse for this operator and rate, checked in the factory's order
 * (FeeSplitterFactory.sol:83-88), or null when the factory creates the splitter. */
export function splitRefusal(factory: SplitFactory, operator: string, operatorRate: number): SplitRefusal | null {
  if (BigInt(operator) === 0n) return "ZeroAddress";
  if (sameAddress(operator, factory.platform)) return "OperatorIsPlatform";
  if (operatorRate > factory.maxTotalRate - factory.platformRate) return "RateTooHigh";
  if (operatorRate === 0 && factory.platformRate === 0) return "ZeroRates";
  return null;
}

/** A refusal in words, for an error message. */
export function describeSplitRefusal(refusal: SplitRefusal, factory: SplitFactory, operatorRate: number): string {
  switch (refusal) {
    case "ZeroAddress":
      return "the factory refuses the zero address as the operator (ZeroAddress)";
    case "OperatorIsPlatform":
      return "the operator is the factory's platform, which the factory refuses (OperatorIsPlatform)";
    case "RateTooHigh":
      return `operatorRate ${operatorRate} is above the ${factory.maxTotalRate - factory.platformRate} the factory leaves an operator (RateTooHigh)`;
    case "ZeroRates":
      return "the platform's rate and the operator's are both 0, which the factory refuses (ZeroRates)";
  }
}

const hash = (bytes: Uint8Array) => `0x${bytesToHex(keccak_256(bytes))}`;
const bytesOf = (hex: string) => hexToBytes(hex.slice(2));

/** Where the factory created its implementation, the FeeSplitter every splitter delegates to: its CREATE address at
 * nonce 1, keccak256(rlp([factory, 1])). A contract's nonce starts at 1 (EIP-161), and the factory's constructor creates
 * nothing before it. */
export function implementationOf(factory: string): string {
  const rlp = concatBytes(Uint8Array.of(0xd6, 0x94), bytesOf(checksumAddress(factory)), Uint8Array.of(0x01));
  return checksumAddress(`0x${bytesToHex(keccak_256(rlp).subarray(12))}`);
}

/** A splitter's creation code, SplitterProxy.initCode(implementation). */
export function splitterCreationCode(implementation: string): string {
  const impl = checksumAddress(implementation).slice(2).toLowerCase();
  return `0x${SPLITTER_CODE_BEFORE.join("")}${impl}${SPLITTER_CODE_AFTER.join("")}`;
}

/** keccak256 of the creation code of the factory's splitters: what its initCodeHash() returns. */
export function splitterInitCodeHash(factory: string): string {
  return hash(bytesOf(splitterCreationCode(implementationOf(factory))));
}

/** The CREATE2 salt for this operator and rate: keccak256(abi.encode(operator, operatorRate)), FeeSplitterFactory.salt. */
export function splitSalt(operator: string, operatorRate: number): string {
  if (!Number.isSafeInteger(operatorRate) || operatorRate < 0) throw new Error(`not a rate: ${operatorRate}`);
  const rate = hexToBytes(operatorRate.toString(16).padStart(64, "0"));
  return hash(concatBytes(new Uint8Array(12), bytesOf(checksumAddress(operator)), rate));
}

/** The address CREATE2 gives: the last 20 bytes of keccak256(0xff ‖ deployer ‖ salt ‖ initCodeHash). */
export function create2Address(deployer: string, salt: string, initCodeHash: string): string {
  const preimage = concatBytes(Uint8Array.of(0xff), bytesOf(checksumAddress(deployer)), bytesOf(salt), bytesOf(initCodeHash));
  return checksumAddress(`0x${bytesToHex(keccak_256(preimage).subarray(12))}`);
}

/** The address of the splitter the factory creates for this operator and rate, deployed or not, in EIP-55 mixed case:
 * FeeSplitterFactory.predict, worked out off-chain. Throws for a factory that can't exist and for anything predict
 * refuses, so a fee is never sent where no splitter can be deployed. */
export function predictSplitter(factory: SplitFactory, operator: string, operatorRate: number): string {
  const problem = factoryProblem(factory);
  if (problem) throw new Error(`factory ${factory.address}: ${problem}`);
  if (!isAddress(operator)) throw new Error(`operator ${operator}: not 0x and 40 hex digits, in lower case or with a valid checksum`);
  if (!Number.isSafeInteger(operatorRate) || operatorRate < 0) throw new Error(`operatorRate ${operatorRate}: not a whole number of at least 0`);
  const refusal = splitRefusal(factory, operator, operatorRate);
  if (refusal) throw new Error(`factory ${factory.address}: ${describeSplitRefusal(refusal, factory, operatorRate)}`);
  return create2Address(factory.address, splitSalt(operator, operatorRate), splitterInitCodeHash(factory.address));
}
