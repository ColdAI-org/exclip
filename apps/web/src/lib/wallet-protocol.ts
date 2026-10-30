/** ExClip ↔ wallet popup message protocol, v1 (docs/embedded-wallet.md, "Messaging").
 *
 * This file exists twice, byte for byte: apps/wallet/src/protocol.ts (the popup) and
 * apps/web/src/lib/wallet-protocol.ts (the app). A test fails if they differ. It imports nothing.
 *
 * Rules both sides follow:
 *  - postMessage always names the exact target origin; a receiver checks event.origin against its own build-time
 *    allowlist AND event.source against the window it opened / was opened by.
 *  - Every message is a plain object with exactly the listed keys: unknown keys, wrong types, unbounded strings,
 *    another version or another `kind` are refused before anything else looks at it.
 *  - One request per popup. Each request has an id; the result echoes it. Both sides time out.
 *  - The popup never sends secrets: only addresses, signed transactions, hashes, booleans and counts. */

export const PROTOCOL_VERSION = 1;
/** On-wire name of the protocol: a message with any other `kind` is not for us. */
export const PROTOCOL_KIND = "exclip-wallet";
/** Hard cap on one serialized message (a 3-transaction trade is ~8 KB). */
export const MAX_MESSAGE_CHARS = 64 * 1024;
/** Transactions in one sign request. */
export const MAX_TXS = 3;
/** How long ExClip waits for each kind of request (the user may need to find a phone or a security key). */
export const REQUEST_TIMEOUT_MS = { connect: 5 * 60_000, sign: 5 * 60_000, manage: 10 * 60_000 } as const;
/** How long the popup waits for its one request after announcing `ready`. */
export const READY_TIMEOUT_MS = 60_000;

export type Hex = `0x${string}`;

export type ConnectIntent = "create" | "signin";
/** "receive": the popup shows the deposit address and its QR code itself, never ExClip alone. */
export type ManageAction = "save-phrase" | "add-passkey" | "move-to-clip" | "receive";

export type Eip1559Fee = { type: "eip1559"; maxFeePerGas: string; maxPriorityFeePerGas: string };
export type LegacyFee = { type: "legacy"; gasPrice: string };

/** An unsigned EVM transaction. All numbers are decimal strings (wei / units); `from` is in the request. */
export type UnsignedTx = { to: string; data: string; value: string; nonce: string; gas: string; fee: Eip1559Fee | LegacyFee };

/** What the user asked ExClip for. The popup checks every payload against it and shows its own decoding. */
export type SwapPlan = {
  kind: "swap";
  dstChainKey: string;
  /** Token addresses as SODAX lists them on each chain (EVM hex, Solana base58, Sui coin type, Stellar contract). */
  inputToken: string;
  outputToken: string;
  /** Gross amount the user pays, in the input token's smallest unit (fee included). */
  inputAmount: string;
  minOutputAmount: string;
  /** Unix seconds. */
  deadline: string;
  /** Where the output goes: must be this wallet's own address on the destination network. */
  dstAddress: string;
};
export type TransferPlan = { kind: "transfer"; token: string; amount: string; to: string };

export type ConnectRequest = { v: 1; kind: typeof PROTOCOL_KIND; id: string; type: "connect"; intent: ConnectIntent };
export type SignRequest = {
  v: 1; kind: typeof PROTOCOL_KIND; id: string; type: "sign";
  chainKey: string; from: string; plan: SwapPlan | TransferPlan; txs: UnsignedTx[];
};
/** `heldUsd` (receive only): what ExClip believes the wallet holds, in whole US dollars. A hint that can only make the
 * popup stricter (it hides the address of a wallet that isn't backed up at or above its own limit), never looser. */
export type ManageRequest = { v: 1; kind: typeof PROTOCOL_KIND; id: string; type: "manage"; action: ManageAction; heldUsd?: number };
export type WalletRequest = ConnectRequest | SignRequest | ManageRequest;

export type PublicAccounts = { evm: string; solana: string; sui: string; stellar: string };
export type ConnectResult = { accounts: PublicAccounts; backedUp: boolean };
export type SignResult = { signed: Hex[]; hashes: Hex[] };
export type ManageResult = { backedUp: boolean; passkeys: number };

export type ErrorCode =
  | "BAD_REQUEST" | "CANCELLED" | "TIMEOUT" | "UNSUPPORTED_BROWSER" | "NO_WALLET" | "WALLET_EXISTS"
  | "WRONG_ACCOUNT" | "REFUSED" | "UNSUPPORTED_NETWORK" | "SERVICE" | "FAILED";
export const ERROR_CODES: readonly ErrorCode[] = [
  "BAD_REQUEST", "CANCELLED", "TIMEOUT", "UNSUPPORTED_BROWSER", "NO_WALLET", "WALLET_EXISTS",
  "WRONG_ACCOUNT", "REFUSED", "UNSUPPORTED_NETWORK", "SERVICE", "FAILED",
];

export type ReadyMessage = { v: 1; kind: typeof PROTOCOL_KIND; type: "ready" };
export type ResultMessage =
  | { v: 1; kind: typeof PROTOCOL_KIND; id: string; type: "result"; ok: true; result: ConnectResult | SignResult | ManageResult }
  | { v: 1; kind: typeof PROTOCOL_KIND; id: string; type: "result"; ok: false; error: { code: ErrorCode; message: string } };
export type WalletResponse = ReadyMessage | ResultMessage;

/* ------------------------------------------------------------------ validation */

export class ProtocolError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`invalid message at ${path}`);
    this.name = "ProtocolError";
    this.path = path;
  }
}

type Check = (v: unknown, path: string) => void;

const fail = (path: string): never => {
  throw new ProtocolError(path);
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const str = (max: number, re?: RegExp): Check => (v, p) => {
  if (typeof v !== "string" || v.length === 0 || v.length > max || (re && !re.test(v))) fail(p);
};
const oneOf = (...values: readonly (string | number | boolean)[]): Check => (v, p) => {
  if (!values.includes(v as string)) fail(p);
};
const bool: Check = (v, p) => {
  if (typeof v !== "boolean") fail(p);
};
const count: Check = (v, p) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1000) fail(p);
};
const usdAmount: Check = (v, p) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(p);
};
const arr = (item: Check, min: number, max: number): Check => (v, p) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail(p);
  (v as unknown[]).forEach((x, i) => item(x, `${p}[${i}]`));
};
/** Exactly these keys (optional ones may be absent). Keys are checked before any value. */
const obj = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => (v, p) => {
  if (!isPlainObject(v)) return fail(p);
  for (const k of Object.keys(v)) if (!(k in required) && !(k in optional)) fail(`${p}.${k}`);
  for (const [k, check] of Object.entries(required)) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) fail(`${p}.${k}`);
    check(v[k], `${p}.${k}`);
  }
  for (const [k, check] of Object.entries(optional)) if (Object.prototype.hasOwnProperty.call(v, k)) check(v[k], `${p}.${k}`);
};
/** Picks the schema by a discriminant key, then checks the whole object against it. */
const union = (key: string, cases: Record<string, Check>): Check => (v, p) => {
  if (!isPlainObject(v)) return fail(p);
  const tag = v[key];
  if (typeof tag !== "string" || !Object.prototype.hasOwnProperty.call(cases, tag)) return fail(`${p}.${key}`);
  cases[tag]!(v, p);
};

export const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const UINT_RE = /^(?:0|[1-9][0-9]{0,77})$/;
export const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const CHAIN_KEY_RE = /^[a-z0-9][a-z0-9.-]{1,31}$/;
/** EVM hex, base58, Sui coin types (0x…::m::T), Stellar contract ids: printable ASCII without spaces. */
const TOKEN_RE = /^[\x21-\x7e]{1,160}$/;
const ADDRESS_ANY_RE = /^[A-Za-z0-9:_.-]{1,128}$/;

const uint = str(78, UINT_RE);
const evmAddress = str(42, EVM_ADDRESS_RE);
const envelope = { v: oneOf(PROTOCOL_VERSION), kind: oneOf(PROTOCOL_KIND), id: str(64, ID_RE) };

const feeCheck = union("type", {
  eip1559: obj({ type: oneOf("eip1559"), maxFeePerGas: uint, maxPriorityFeePerGas: uint }),
  legacy: obj({ type: oneOf("legacy"), gasPrice: uint }),
});
const unsignedTx = obj({ to: evmAddress, data: str(48 * 1024, HEX_BYTES_RE), value: uint, nonce: uint, gas: uint, fee: feeCheck });
const plan = union("kind", {
  swap: obj({
    kind: oneOf("swap"), dstChainKey: str(32, CHAIN_KEY_RE), inputToken: str(160, TOKEN_RE), outputToken: str(160, TOKEN_RE),
    inputAmount: uint, minOutputAmount: uint, deadline: uint, dstAddress: str(128, ADDRESS_ANY_RE),
  }),
  transfer: obj({ kind: oneOf("transfer"), token: evmAddress, amount: uint, to: evmAddress }),
});

const request = union("type", {
  connect: obj({ ...envelope, type: oneOf("connect"), intent: oneOf("create", "signin") }),
  // Up to 3: [allowance reset to 0, exact approve, swap] for tokens that refuse to change a nonzero allowance.
  sign: obj({ ...envelope, type: oneOf("sign"), chainKey: str(32, CHAIN_KEY_RE), from: evmAddress, plan, txs: arr(unsignedTx, 1, MAX_TXS) }),
  manage: obj(
    { ...envelope, type: oneOf("manage"), action: oneOf("save-phrase", "add-passkey", "move-to-clip", "receive") },
    { heldUsd: usdAmount },
  ),
});

const accounts = obj({ evm: evmAddress, solana: str(64, ADDRESS_ANY_RE), sui: str(66, ADDRESS_ANY_RE), stellar: str(56, ADDRESS_ANY_RE) });
const signedHex = str(128 * 1024, HEX_BYTES_RE);
const resultBody = (v: unknown, p: string) => {
  if (!isPlainObject(v)) return fail(p);
  if ("accounts" in v) return obj({ accounts, backedUp: bool })(v, p);
  if ("signed" in v) return obj({ signed: arr(signedHex, 1, MAX_TXS), hashes: arr(str(66, /^0x[0-9a-f]{64}$/), 1, MAX_TXS) })(v, p);
  return obj({ backedUp: bool, passkeys: count })(v, p);
};
const response = union("type", {
  ready: obj({ v: envelope.v, kind: envelope.kind, type: oneOf("ready") }),
  result: (v, p) => {
    if (!isPlainObject(v)) return fail(p);
    if (v.ok === true) return obj({ ...envelope, type: oneOf("result"), ok: oneOf(true), result: resultBody })(v, p);
    return obj({
      ...envelope, type: oneOf("result"), ok: oneOf(false),
      error: obj({ code: oneOf(...ERROR_CODES), message: str(300) }),
    })(v, p);
  },
});

function sized(data: unknown): void {
  let text: string;
  try {
    text = JSON.stringify(data);
  } catch {
    return fail("$");
  }
  if (typeof text !== "string" || text.length > MAX_MESSAGE_CHARS) fail("$");
}

/** Returns the request or throws ProtocolError. Never partially trusts a message. */
export function parseRequest(data: unknown): WalletRequest {
  request(data, "$");
  sized(data);
  return data as WalletRequest;
}

export function parseResponse(data: unknown): WalletResponse {
  response(data, "$");
  sized(data);
  return data as WalletResponse;
}

/** True when the request and the result belong together (same id, a result shape that fits the request type). */
export function resultFits(req: WalletRequest, res: ResultMessage): boolean {
  if (res.id !== req.id) return false;
  if (!res.ok) return true;
  const r = res.result as Record<string, unknown>;
  if (req.type === "connect") return "accounts" in r;
  if (req.type === "sign") return "signed" in r && (r.signed as unknown[]).length === req.txs.length;
  return "passkeys" in r;
}

/** Request ids: 128 random bits, base64url. */
export function newRequestId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(16);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const ready = (): ReadyMessage => ({ v: PROTOCOL_VERSION, kind: PROTOCOL_KIND, type: "ready" });
