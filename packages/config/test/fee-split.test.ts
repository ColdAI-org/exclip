import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  OPERATOR_RATE_MAX,
  RATE_SCALE,
  SPLITTER_CODE_AFTER,
  SPLITTER_CODE_BEFORE,
  checksumAddress,
  create2Address,
  factoryProblem,
  formatRate,
  implementationOf,
  isAddress,
  predictSplitter,
  splitFee,
  splitRefusal,
  splitSalt,
  splitShares,
  splitterCreationCode,
  splitterInitCodeHash,
  type SplitFactory,
} from "../src/fee-split.ts";
import { PARTNER_FEE_MAX_BPS } from "../src/index.ts";

type Vectors = {
  factories: (SplitFactory & { implementation: string; initCode: string; initCodeHash: string })[];
  splitters: { factory: string; operator: string; operatorRate: number; salt: string; splitter: string }[];
  refusals: { factory: string; operator: string; operatorRate: number; error: string }[];
};

/** What real factories worked out and created on anvil: contracts/fee-split/script/Vectors.s.sol wrote it. */
const vectors: Vectors = JSON.parse(
  readFileSync(new URL("../../../contracts/fee-split/test/vectors/splitters.json", import.meta.url), "utf8"),
);

function factoryAt(address: string): SplitFactory {
  const found = vectors.factories.find((f) => f.address === address);
  assert.ok(found, `no factory ${address} in the vectors`);
  return found;
}

const PLATFORM = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x2222222222222222222222222222222222222222";
/** The README's dry run (contracts/fee-split/README.md): forge's default sender's first contract on a fresh anvil. */
const README_FACTORY: SplitFactory = {
  address: "0x5b73C5498c1E3b4dbA84de0F1833c4a029d90519",
  platform: PLATFORM,
  platformRate: 875,
  maxTotalRate: 1_875,
};

test("the vectors hold the README's dry run: its factory, implementation, initCodeHash and sample splitter", () => {
  const factory = vectors.factories[0];
  assert.ok(factory);
  assert.deepEqual(
    { address: factory.address, platform: factory.platform, platformRate: factory.platformRate, maxTotalRate: factory.maxTotalRate },
    README_FACTORY,
  );
  assert.equal(factory.implementation, "0xC7f2Cf4845C6db0e1a1e91ED41Bcd0FcC1b0E141");
  assert.equal(factory.initCodeHash, "0xd458769130779d2ca04e9b6d0ca72e6bd108ce48b867f5b7d759c75bff63beb6");
  assert.ok(
    vectors.splitters.some(
      (s) => s.factory === README_FACTORY.address && s.operator === OPERATOR && s.operatorRate === 100 &&
        s.splitter === "0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe",
    ),
  );
  assert.equal(predictSplitter(README_FACTORY, OPERATOR, 100), "0x92F0B9beff17B0fa1BE01EC0b2FbC013554057Fe");
});

test("each factory's implementation, its splitters' creation code and initCodeHash are what the factory worked out", () => {
  assert.equal(vectors.factories.length, 4);
  for (const f of vectors.factories) {
    assert.equal(implementationOf(f.address), f.implementation, f.address);
    assert.equal(splitterCreationCode(f.implementation), f.initCode, f.address);
    assert.equal(splitterInitCodeHash(f.address), f.initCodeHash, f.address);
    assert.equal(factoryProblem(f), null, f.address);
  }
});

test("each splitter is where its factory predicted and created it, with the factory's salt", () => {
  assert.ok(vectors.splitters.length >= 10);
  for (const s of vectors.splitters) {
    const factory = factoryAt(s.factory);
    const at = `${s.factory} ${s.operator} ${s.operatorRate}`;
    assert.equal(splitSalt(s.operator, s.operatorRate), s.salt, at);
    assert.equal(splitRefusal(factory, s.operator, s.operatorRate), null, at);
    assert.equal(predictSplitter(factory, s.operator, s.operatorRate), s.splitter, at);
    assert.equal(create2Address(s.factory, s.salt, splitterInitCodeHash(s.factory)), s.splitter, at);
    // Lower case in, the same splitter out.
    assert.equal(predictSplitter({ ...factory, address: s.factory.toLowerCase() }, s.operator.toLowerCase(), s.operatorRate), s.splitter, at);
  }
});

test("each refusal is the factory's, in the factory's order, and predictSplitter throws for it", () => {
  const seen = new Set<string>();
  for (const r of vectors.refusals) {
    const factory = factoryAt(r.factory);
    const at = `${r.factory} ${r.operator} ${r.operatorRate}`;
    assert.equal(splitRefusal(factory, r.operator, r.operatorRate), r.error, at);
    assert.throws(() => predictSplitter(factory, r.operator, r.operatorRate), new RegExp(`\\(${r.error}\\)`), at);
    seen.add(r.error);
  }
  assert.deepEqual([...seen].sort(), ["OperatorIsPlatform", "RateTooHigh", "ZeroAddress", "ZeroRates"]);
});

test("the proxy: NativeReceived's topic, and 101 bytes of creation code that return the 91-byte runtime", () => {
  assert.equal(SPLITTER_CODE_BEFORE[2], bytesToHex(keccak_256(utf8ToBytes("NativeReceived(uint256)"))));
  const code = splitterCreationCode(implementationOf(README_FACTORY.address));
  assert.equal((code.length - 2) / 2, 101);
  // 3d 605b 80 600a 3d 39 81 f3: copy 0x5b (91) bytes from offset 0x0a (10) and return them.
  assert.ok(code.startsWith("0x3d605b80600a3d3981f3"));
  for (const piece of [...SPLITTER_CODE_BEFORE, ...SPLITTER_CODE_AFTER]) {
    assert.match(piece, /^([0-9a-f]{2}){1,32}$/);
    assert.ok(!piece.endsWith("00"), "the drift check finds each piece by its zero-padded PUSH32");
  }
});

test("addresses: EIP-55 checksums, lower case accepted, a wrong checksum refused", () => {
  // EIP-55's own examples.
  for (const a of [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ]) {
    assert.equal(checksumAddress(a.toLowerCase()), a);
    assert.ok(isAddress(a));
    assert.ok(isAddress(a.toLowerCase()));
  }
  assert.equal(isAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"), false, "one letter's case changed");
  assert.equal(isAddress("0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED"), false, "all capitals carry no checksum");
  for (const bad of [undefined, null, 1, "", "0x", "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", `0x${"1".repeat(39)}`, `0x${"1".repeat(41)}`, `0x${"g".repeat(40)}`]) {
    assert.equal(isAddress(bad), false, String(bad));
  }
  assert.throws(() => checksumAddress("0x123"), /not an address/);
});

test("predictSplitter refuses a factory that can't exist, a bad operator and a bad rate", () => {
  const bad: [Partial<SplitFactory>, RegExp][] = [
    [{ address: "0x5b73c5498c1e3b4dba84de0f1833c4a029d9051" }, /address must be/],
    [{ address: "0x5B73C5498c1E3b4dbA84de0F1833c4a029d90519" }, /address must be/],
    [{ platform: `0x${"0".repeat(40)}` }, /zero address/],
    [{ platform: "0x1111" }, /platform must be/],
    [{ platformRate: -1 }, /platformRate must be/],
    [{ platformRate: 0.5 }, /platformRate must be/],
    [{ maxTotalRate: 0 }, /maxTotalRate must be/],
    [{ maxTotalRate: RATE_SCALE + 1 }, /maxTotalRate must be/],
    [{ platformRate: 2_000 }, /platformRate 2000 is above maxTotalRate 1875/],
  ];
  for (const [change, message] of bad) {
    assert.throws(() => predictSplitter({ ...README_FACTORY, ...change }, OPERATOR, 100), message, JSON.stringify(change));
  }
  assert.throws(() => predictSplitter(README_FACTORY, "0x2222", 100), /operator 0x2222/);
  assert.throws(() => predictSplitter(README_FACTORY, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD", 100), /valid checksum/);
  for (const rate of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    assert.throws(() => predictSplitter(README_FACTORY, OPERATOR, rate), /operatorRate/, String(rate));
  }
});

test("the fee: the total rate of the amount sold, rounded down, and each party's share of it", () => {
  // The worked example: 1,000 USDC sold, 0.875 % to the platform and 0.1 % to the operator.
  assert.equal(splitFee(1_000_000_000n, 975), 9_750_000n);
  assert.deepEqual(splitShares(9_750_000n, 875, 100), { platform: 8_750_000n, operator: 1_000_000n });
  // Rounded down: 102 units at 975 is 0.9945 of a unit, 103 is 1.004.
  assert.equal(splitFee(102n, 975), 0n);
  assert.equal(splitFee(103n, 975), 1n);
  assert.equal(splitFee(0n, 1_875), 0n);
  // A share rounds down too, and what's left waits in the splitter: 8 + 1 of 10.
  assert.deepEqual(splitShares(10n, 875, 100), { platform: 8n, operator: 1n });
  assert.deepEqual(splitShares(5n, 875, 0), { platform: 5n, operator: 0n });
  assert.deepEqual(splitShares(5n, 0, 0), { platform: 0n, operator: 0n });
  // The splitter's own sum, (total / totalRate) * rate + ((total % totalRate) * rate) / totalRate, is the same number.
  for (const fee of [1n, 974n, 975n, 976n, 9_750_000n, 2n ** 200n + 12_345n]) {
    const viaContract = (fee / 975n) * 875n + ((fee % 975n) * 875n) / 975n;
    assert.equal(splitShares(fee, 875, 100).platform, viaContract, String(fee));
  }
});

test("rates read as percentages, and an operator's rate is capped at the plain fee's 1 %", () => {
  const cases: [number, string][] = [[0, "0"], [1, "0.001"], [10, "0.01"], [100, "0.1"], [875, "0.875"], [1_000, "1"], [1_050, "1.05"], [1_875, "1.875"], [100_000, "100"]];
  for (const [rate, text] of cases) assert.equal(formatRate(rate), text, String(rate));
  assert.equal(OPERATOR_RATE_MAX, (PARTNER_FEE_MAX_BPS * RATE_SCALE) / 10_000);
});
