/** Checks the splitter's creation code in src/fee-split.ts against the contracts' compiled code,
 * `forge inspect FeeSplitterFactory deployedBytecode`, where deploy() writes SplitterProxy.initCode into memory: each
 * hex literal is a PUSH32, left-aligned, followed by the PUSH1 of the offset it is stored at; the implementation is an
 * immutable, so a PUSH32 of zero in the compiled code, stored at its own offset; and the code's length comes last.
 * Those offsets and the length must be the ones SPLITTER_CODE_BEFORE, 20 bytes of address and SPLITTER_CODE_AFTER give,
 * so a piece that differs, moves or changes length fails. `pnpm run splitter-code`, with Foundry installed; CI runs it
 * in the contracts job, beside regenerating the vectors test/fee-split.test.ts checks. Exits with 1 when they differ. */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SPLITTER_CODE_AFTER, SPLITTER_CODE_BEFORE } from "../src/fee-split.ts";
import { findRepoRoot } from "../src/node.ts";

const contracts = join(findRepoRoot(), "contracts", "fee-split");
const output = execFileSync("forge", ["inspect", "FeeSplitterFactory", "deployedBytecode"], {
  cwd: contracts,
  encoding: "utf8",
});
const hex = output.split(/\s+/).find((word) => /^0x[0-9a-fA-F]+$/.test(word));
if (!hex) {
  console.error(`forge inspect printed no bytecode:\n${output}`);
  process.exit(1);
}
const code = Buffer.from(hex.slice(2), "hex");

/** Every PUSH1 to PUSH32 in the code, with what it pushes, skipping push data as the EVM does. */
const pushes: { pc: number; size: number; data: string }[] = [];
for (let pc = 0; pc < code.length; pc++) {
  const op = code[pc] ?? 0;
  if (op >= 0x60 && op <= 0x7f) {
    const size = op - 0x5f;
    pushes.push({ pc, size, data: code.subarray(pc + 1, pc + 1 + size).toString("hex") });
    pc += size;
  }
}

/** Memory offsets: abi.encodePacked writes its bytes after a 32-byte length word. */
const WORD = 0x20;
const ADDRESS_BYTES = 20;
const bytes = (piece: string) => piece.length / 2;
const isPush = (i: number, size: number, value: number | string) =>
  pushes[i]?.size === size &&
  (typeof value === "string" ? pushes[i]?.data === value : Number.parseInt(pushes[i]?.data ?? "", 16) === value);

const problems: string[] = [];
const found: number[] = [];
let offset = 0;
let from = 0;
for (const [k, piece] of [...SPLITTER_CODE_BEFORE, ...SPLITTER_CODE_AFTER].entries()) {
  if (k === SPLITTER_CODE_BEFORE.length) {
    // The implementation: a PUSH32 of zero, then the PUSH1 of its offset just before the next piece.
    const next = pushes.findIndex((_, i) => i >= from && isPush(i, 32, piece.padEnd(64, "0")));
    const zero = pushes.findIndex((_, i) => i >= from && i < next && isPush(i, 32, "0".repeat(64)));
    if (next < 0 || zero < 0 || !isPush(next - 1, 1, WORD + offset)) {
      problems.push(`the implementation's ${ADDRESS_BYTES} bytes are not at offset ${offset}, between the pieces`);
      break;
    }
    offset += ADDRESS_BYTES;
  }
  const i = pushes.findIndex((_, j) => j >= from && isPush(j, 32, piece.padEnd(64, "0")));
  if (i < 0) {
    problems.push(`no PUSH32 of ${piece}${k ? " after the pieces before it" : ""}`);
    break;
  }
  if (!isPush(i + 1, 1, WORD + offset)) {
    problems.push(`${piece} is not stored at offset ${offset}, where the pieces before it end`);
    break;
  }
  found.push(i);
  offset += bytes(piece);
  from = i + 2;
}
if (!problems.length && !isPush(from, 1, offset)) {
  problems.push(`the creation code's length is not ${offset} bytes`);
}
if (process.argv.includes("--verbose")) {
  for (const p of pushes.slice(Math.max(0, (found[0] ?? 0) - 2), from + 3)) console.log(`  pc ${p.pc}: PUSH${p.size} ${p.data}`);
}

if (problems.length) {
  console.error(`src/fee-split.ts and FeeSplitterFactory's compiled code differ: ${problems.join("; ")}.`);
  console.error(
    "Make SPLITTER_CODE_BEFORE and SPLITTER_CODE_AFTER SplitterProxy.initCode's hex literals, then regenerate the vectors (contracts/fee-split/README.md).",
  );
  process.exit(1);
}
console.log(
  `src/fee-split.ts has FeeSplitterFactory's splitter creation code: ${found.length} pieces and the implementation, ` +
    `${offset} bytes, laid out as deploy() writes them (PUSH32 at pc ${found.map((i) => pushes[i]?.pc).join(", ")}).`,
);
