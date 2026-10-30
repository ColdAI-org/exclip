/**
 * Node globals the SODAX wallet SDKs expect in the browser: several chain libraries read `Buffer`, and the
 * readable-stream/create-hash chain reads `process.nextTick`/`process.env` at module load. Imported only right
 * before the lazy wallet runtime, so the polyfill never touches the first-load bundle.
 */
import { Buffer } from "buffer";

type ProcessShim = { env: Record<string, string | undefined>; browser: boolean; version: string; versions: Record<string, string>; nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => void };
const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: unknown; process?: ProcessShim };
g.Buffer ??= Buffer;
g.global ??= globalThis;
g.process ??= {
  env: {},
  browser: true,
  version: "",
  versions: {},
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
};
