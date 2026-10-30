/** Build-time stand-in for "hash-wasm" (vite.config.ts resolve.alias). The vendored vault imports it for its default
 * Argon2id; the wallet always passes password.ts argon2id instead, and its CSP doesn't allow WebAssembly. Aliasing
 * keeps the WebAssembly loader out of the bundle and makes any accidental use of the default fail loudly. */
export function argon2id(): never {
  throw new Error("hash-wasm is not available in the ExClip wallet; pass an argon2id implementation");
}
