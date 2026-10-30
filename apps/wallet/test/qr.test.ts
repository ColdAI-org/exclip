// The popup's own QR encoder (src/qr.ts), checked module for module against the `qrcode` package (a devDependency
// here; the bundle never includes it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { encodeQr } from "../src/qr.ts";

type Reference = {
  create(segments: { data: string; mode: "byte" }[], opts: { errorCorrectionLevel: "M"; version?: number; maskPattern?: number }): {
    version: number; maskPattern: number; modules: { size: number; get(row: number, col: number): number };
  };
};

const ref = createRequire(import.meta.url)("qrcode/lib/core/qrcode.js") as Reference;

const SAMPLES = [
  "0x52908400098527886E0F7030069857D2E4169EE7", // EIP-55 test vector (checksummed EVM address)
  "0xde709f2102306220921060314715629080e2fb77",
  "hi",
  "x".repeat(14),
  "y".repeat(26),
  "z".repeat(62),
  "ethereum:0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359?value=1",
  "w".repeat(106),
];

test("QR: every version and mask matches the reference encoder bit for bit", () => {
  for (const text of SAMPLES) {
    for (let mask = 0; mask < 8; mask++) {
      const ours = encodeQr(text, mask);
      const theirs = ref.create([{ data: text, mode: "byte" }], { errorCorrectionLevel: "M", maskPattern: mask });
      assert.equal(ours.version, theirs.version, `${text} version`);
      assert.equal(ours.size, theirs.modules.size);
      for (let y = 0; y < ours.size; y++) {
        for (let x = 0; x < ours.size; x++) {
          assert.equal(ours.dark(x, y), theirs.modules.get(y, x) === 1, `${text} mask ${mask} at (${x},${y})`);
        }
      }
    }
    // The automatic mask uses the same penalty rules, so it picks the same one.
    assert.equal(encodeQr(text).mask, ref.create([{ data: text, mode: "byte" }], { errorCorrectionLevel: "M" }).maskPattern, text);
  }
});

test("QR: an EVM address is version 3 (29×29); too-long input is refused", () => {
  const q = encodeQr("0x52908400098527886E0F7030069857D2E4169EE7");
  assert.equal(q.version, 3);
  assert.equal(q.size, 29);
  // Finder pattern corners and the dark module.
  assert.equal(q.dark(0, 0), true);
  assert.equal(q.dark(7, 7), false);
  assert.equal(q.dark(8, q.size - 8), true);
  assert.throws(() => encodeQr("w".repeat(107)), /too long/);
});
