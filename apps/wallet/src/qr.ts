/** QR code encoder for the receive screen (the popup draws the deposit QR itself, so the page can't swap it). Byte
 * mode, error correction level M, versions 1–6 (up to 106 bytes; an EVM address needs version 3). No dependency: the
 * popup ships no QR library, and this is small enough to read in one sitting.
 *
 * Follows ISO/IEC 18004 as summarised by Project Nayuki's reference encoder: data bits → Reed–Solomon blocks →
 * interleave → zig-zag placement → the mask with the lowest penalty. test/qr.test.ts checks every mask bit for bit
 * against the `qrcode` package (a devDependency, used by that test only). */

/** [total codewords, EC codewords per block, blocks] for level M. Every block has the same length up to version 6. */
const M_BLOCKS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [26, 10, 1],
  [44, 16, 1],
  [70, 26, 1],
  [100, 18, 2],
  [134, 24, 2],
  [172, 16, 4],
];
export const MAX_QR_VERSION = 6;
/** Format-information bits for level M. */
const ECL_M = 0;

export type QrMatrix = { size: number; version: number; mask: number; dark: (x: number, y: number) => boolean };

export function dataCodewords(version: number): number {
  const [total, ec, blocks] = M_BLOCKS[version]!;
  return total - ec * blocks;
}

/** Encodes `text` (UTF-8) as a QR code. `mask` forces a mask pattern (tests); otherwise the lowest penalty wins. */
export function encodeQr(text: string, mask?: number): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= MAX_QR_VERSION && 4 + 8 + bytes.length * 8 > dataCodewords(version) * 8) version++;
  if (version > MAX_QR_VERSION) throw new Error("too long for a QR code here");

  // Mode indicator (byte), 8-bit length, the bytes, terminator, byte padding, pad codewords.
  const bits: number[] = [];
  const put = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  const codewords = withErrorCorrection(data, version);
  const q = new Grid(version);
  q.drawFunctionPatterns();
  q.drawCodewords(codewords);

  let best = mask ?? -1;
  if (best < 0) {
    let lowest = Infinity;
    for (let m = 0; m < 8; m++) {
      q.applyMask(m);
      q.drawFormatBits(m);
      const score = q.penalty();
      if (score < lowest) {
        lowest = score;
        best = m;
      }
      q.applyMask(m); // undo (XOR)
    }
  }
  if (!Number.isInteger(best) || best < 0 || best > 7) throw new Error("bad mask");
  q.applyMask(best);
  q.drawFormatBits(best);
  const { size, modules } = q;
  return { size, version, mask: best, dark: (x, y) => modules[y]![x]! };
}

/* ------------------------------------------------------------------ Reed–Solomon over GF(2^8), x^8+x^4+x^3+x^2+1 */

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i]! ^= gfMul(coef, factor)));
  }
  return result;
}

/** Splits the data into blocks, adds each block's EC codewords, interleaves data then EC. */
function withErrorCorrection(data: readonly number[], version: number): number[] {
  const [, ec, blocks] = M_BLOCKS[version]!;
  const per = data.length / blocks;
  const divisor = rsDivisor(ec);
  const dataBlocks: number[][] = [], ecBlocks: number[][] = [];
  for (let b = 0; b < blocks; b++) {
    const block = data.slice(b * per, (b + 1) * per);
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, divisor));
  }
  const out: number[] = [];
  for (let i = 0; i < per; i++) for (const block of dataBlocks) out.push(block[i]!);
  for (let i = 0; i < ec; i++) for (const block of ecBlocks) out.push(block[i]!);
  return out;
}

/* ------------------------------------------------------------------ the module grid */

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.reserved[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [x, y] of [[3, 3], [n - 4, 3], [3, n - 4]] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          if (x + dx >= 0 && x + dx < n && y + dy >= 0 && y + dy < n) this.set(x + dx, y + dy, d !== 2 && d !== 4);
        }
      }
    }
    // Versions 2–6 have one alignment pattern, at (size-7, size-7).
    if (this.version >= 2) {
      const c = n - 7;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    this.drawFormatBits(0); // reserves the format areas (redrawn with the real mask)
  }

  drawFormatBits(mask: number): void {
    const data = (ECL_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, true); // the dark module
  }

  drawCodewords(codewords: readonly number[]): void {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (!this.reserved[y]![x] && i < codewords.length * 8) {
            this.modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    const n = this.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (this.reserved[y]![x]) continue;
        let flip: boolean;
        switch (mask) {
          case 0: flip = (x + y) % 2 === 0; break;
          case 1: flip = y % 2 === 0; break;
          case 2: flip = x % 3 === 0; break;
          case 3: flip = (x + y) % 3 === 0; break;
          case 4: flip = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: flip = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: flip = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: flip = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (flip) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  /** The standard mask penalty: runs of five or more, 2×2 blocks, finder-like 1:1:3:1:1 patterns, dark balance. */
  penalty(): number {
    const n = this.size, m = this.modules;
    const at = (row: number, col: number, byRow: boolean) => (byRow ? m[row]![col]! : m[col]![row]!);
    let score = 0;
    for (const byRow of [true, false]) {
      for (let row = 0; row < n; row++) {
        let run = 0, last: boolean | null = null, window = 0;
        for (let col = 0; col < n; col++) {
          const v = at(row, col, byRow);
          if (v === last) run++;
          else {
            if (run >= 5) score += 3 + (run - 5);
            last = v;
            run = 1;
          }
          window = ((window << 1) & 0x7ff) | (v ? 1 : 0);
          if (col >= 10 && (window === 0x5d0 || window === 0x05d)) score += 40;
        }
        if (run >= 5) score += 3 + (run - 5);
      }
    }
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (const row of m) for (const v of row) if (v) dark++;
    score += Math.abs(Math.ceil((dark * 100) / (n * n) / 5) - 10) * 10;
    return score;
  }
}
