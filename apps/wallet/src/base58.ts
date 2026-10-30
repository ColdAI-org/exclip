/** Base58 (Bitcoin alphabet) decoding, for checking a Solana destination against the wallet's own key. */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Decode(s: string): Uint8Array {
  if (s.length === 0 || s.length > 128) throw new Error("not base58");
  let n = 0n;
  for (const c of s) {
    const i = INDEX.get(c);
    if (i === undefined) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.push(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body.reverse()]);
}
