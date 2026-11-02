/** The fee split (docs/fee-split.md): where a FeeSplitterFactory puts the splitter for an operator and an operator
 * rate, worked out exactly as contracts/fee-split/src/FeeSplitterFactory.sol does, so the config check, the server and
 * the wallet window name the same receiver without asking the chain. test/fee-split.test.ts checks it against what real
 * factories work out (contracts/fee-split/test/vectors/splitters.json), and `pnpm run splitter-code` checks the proxy's
 * creation code against the factory's compiled code.
 *
 * Erasable TypeScript only and no Node imports: the wallet window bundles this module. */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { OPERATOR_RATE_MAX, RATE_SCALE } from "./fee-rates.ts";

// The rates and their arithmetic live in ./fee-rates.ts, which the app can bundle without keccak.
export { formatRate, OPERATOR_RATE_MAX, RATE_SCALE, splitFee, splitShares } from "./fee-rates.ts";

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

/* ------------------------------------------------------------------ the fee allow-list */

/** A factory in the fee allow-list, with every value in it read from the chain once by a reviewer
 * (contracts/fee-split/README.md), and the platform's name, which the wallet window's review shows. `initCodeHash` is
 * what the factory's initCodeHash() returns: it must equal the hash worked out from the address, so a factory whose
 * splitters this module would place anywhere else can't be listed. */
export type ListedFactory = SplitFactory & { platformName: string; initCodeHash: string };

/** A split in the fee allow-list: an operator's address and rate under a listed factory, and the splitter they give. */
export type ListedSplit = { factory: string; operator: string; operatorRate: number; splitter: string };

/** apps/wallet/fee-receivers.json, checked: where the passkey wallet lets a swap's partner fee go. */
export type FeeAllowList = {
  /** Where a plain fee may go, in lower case. */
  receivers: readonly string[];
  factories: readonly ListedFactory[];
  splits: readonly ListedSplit[];
};

export const EMPTY_FEE_ALLOW_LIST: FeeAllowList = Object.freeze({ receivers: [], factories: [], splits: [] });

/** How an address in the config or the allow-list must be written. */
export const ADDRESS_RULE = "0x and 40 hex digits, in lower case or with a valid checksum";
/** The longest name the review shows for who gets a fee: a factory's platformName, or a plain fee's receiverName. */
export const PLATFORM_NAME_MAX = 40;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A whole number from 0 to OPERATOR_RATE_MAX: an operator's rate in a split. */
export const isOperatorRate = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= OPERATOR_RATE_MAX;

/** A name for the review: 1 to `max` characters, no space at either end, no control character, no < or >. */
export function isPlainName(value: unknown, max: number): value is string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > max) return false;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || ch === "<" || ch === ">") return false;
  }
  return true;
}

function refuseList(message: string): never {
  throw new Error(`fee-receivers.json: ${message}`);
}

/** `value` as an object with exactly these keys, and maybe the optional ones. */
function entry(value: unknown, where: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value)) return refuseList(`${where} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optional.includes(key)) refuseList(`${where}: unknown key "${key}"`);
  for (const key of keys) if (!Object.hasOwn(value, key)) refuseList(`${where}: "${key}" is missing`);
  return value;
}

/** Parses and checks the fee allow-list, apps/wallet/fee-receivers.json. The wallet build, the config check and the
 * server all read it through this function, and each stops on an error, which starts "fee-receivers.json:".
 *
 * - `receivers`: where a plain fee may go, as before: addresses, no duplicates, returned in lower case.
 * - `factories`: { address, platformName, platform, platformRate, maxTotalRate, initCodeHash }. The values must be
 *   ones a FeeSplitterFactory can have, and initCodeHash must be the one worked out from the address.
 * - `splits`: { factory, operator, operatorRate }, under a listed factory, with operatorRate from 0 to
 *   OPERATOR_RATE_MAX. A split the factory would refuse stops here, and so does one whose splitter `receivers` lists.
 *
 * An unknown key is an error, not ignored. A file from before the split, without `factories` or `splits`, lists none.
 * The factories' and splits' addresses come back in EIP-55 mixed case. */
export function parseFeeAllowList(json: string): FeeAllowList {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (error) {
    return refuseList(`not JSON: ${(error as Error).message}`);
  }
  const top = entry(doc, "the file", [], ["$comment", "receivers", "factories", "splits"]);
  const list = (key: string, required = false): unknown[] => {
    const value = Object.hasOwn(top, key) || required ? top[key] : [];
    return Array.isArray(value) ? value : refuseList(`"${key}" must be an array`);
  };

  const receivers = list("receivers", true).map((a) => (typeof a === "string" && ADDRESS.test(a) ? a.toLowerCase() : refuseList(`not an address: ${String(a)}`)));
  if (new Set(receivers).size !== receivers.length) refuseList("duplicate receiver");

  const factories: ListedFactory[] = [];
  for (const [i, value] of list("factories").entries()) {
    const where = `factories[${i}]`;
    const f = entry(value, where, ["address", "platformName", "platform", "platformRate", "maxTotalRate", "initCodeHash"]);
    // factoryProblem checks each value's type before it uses it.
    const factory = { address: f.address, platform: f.platform, platformRate: f.platformRate, maxTotalRate: f.maxTotalRate } as SplitFactory;
    const problem = factoryProblem(factory);
    if (problem) refuseList(`${where}: ${problem}`);
    if (!isPlainName(f.platformName, PLATFORM_NAME_MAX)) refuseList(`${where}: platformName must be plain text of 1 to ${PLATFORM_NAME_MAX} characters`);
    if (factories.some((g) => sameAddress(g.address, factory.address))) refuseList(`${where}: factory ${factory.address} is listed twice`);
    const initCodeHash = splitterInitCodeHash(factory.address);
    if (typeof f.initCodeHash !== "string" || f.initCodeHash.toLowerCase() !== initCodeHash) {
      refuseList(
        `${where}: initCodeHash is ${String(f.initCodeHash)}, but a FeeSplitterFactory at ${factory.address} has ${initCodeHash}: ` +
          "check the address, and what its initCodeHash() returns",
      );
    }
    factories.push({
      address: checksumAddress(factory.address),
      platformName: f.platformName,
      platform: checksumAddress(factory.platform),
      platformRate: factory.platformRate,
      maxTotalRate: factory.maxTotalRate,
      initCodeHash,
    });
  }

  const splits: ListedSplit[] = [];
  for (const [i, value] of list("splits").entries()) {
    const where = `splits[${i}]`;
    const { factory: at, operator, operatorRate } = entry(value, where, ["factory", "operator", "operatorRate"]);
    if (!isAddress(at)) refuseList(`${where}: factory must be ${ADDRESS_RULE}`);
    const factory = factories.find((g) => sameAddress(g.address, at)) ?? refuseList(`${where}: factory ${at} is not in "factories"`);
    if (!isAddress(operator)) refuseList(`${where}: operator must be ${ADDRESS_RULE}`);
    if (!isOperatorRate(operatorRate)) refuseList(`${where}: operatorRate must be a whole number from 0 to ${OPERATOR_RATE_MAX}`);
    const refusal = splitRefusal(factory, operator, operatorRate);
    if (refusal) refuseList(`${where}: ${describeSplitRefusal(refusal, factory, operatorRate)}`);
    const splitter = predictSplitter(factory, operator, operatorRate);
    if (splits.some((t) => t.splitter === splitter)) refuseList(`${where}: listed twice`);
    // The wallet would sign a fee to it as a plain one: any amount up to the cap, not exactly the split's rates.
    if (receivers.includes(splitter.toLowerCase())) refuseList(`${where}: its splitter ${splitter} is in "receivers" too`);
    splits.push({ factory: factory.address, operator: checksumAddress(operator), operatorRate, splitter });
  }
  return { receivers, factories, splits };
}
