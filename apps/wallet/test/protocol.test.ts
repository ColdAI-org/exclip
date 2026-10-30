import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAX_TXS, ProtocolError, newRequestId, parseRequest, parseResponse, ready, resultFits,
  type ResultMessage, type SignRequest, type WalletRequest,
} from "../src/protocol.ts";

const here = (p: string) => resolve(import.meta.dirname, p);

test("the app's copy of the protocol (apps/web) is byte-identical", () => {
  assert.equal(
    readFileSync(here("../../web/src/lib/wallet-protocol.ts"), "utf8"),
    readFileSync(here("../src/protocol.ts"), "utf8"),
  );
});

const id = "req_0123456789abcdef";
const env = { v: 1, kind: "exclip-wallet", id } as const;
const utx = { to: "0x" + "a".repeat(40), data: "0x", value: "0", nonce: "0", gas: "21000", fee: { type: "eip1559", maxFeePerGas: "1", maxPriorityFeePerGas: "1" } };
const sign: SignRequest = {
  ...env, type: "sign", chainKey: "0x2105.base", from: "0x" + "b".repeat(40),
  plan: { kind: "transfer", token: "0x" + "c".repeat(40), amount: "1", to: "0x" + "d".repeat(40) }, txs: [utx as SignRequest["txs"][0]],
};
const rejects = (v: unknown) => assert.throws(() => parseRequest(v), ProtocolError);

test("valid requests pass", () => {
  assert.deepEqual(parseRequest({ ...env, type: "connect", intent: "create" }), { ...env, type: "connect", intent: "create" });
  assert.ok(parseRequest(sign));
  assert.ok(parseRequest({ ...env, type: "manage", action: "save-phrase" }));
  assert.ok(parseRequest({ ...env, type: "manage", action: "receive" }));
  assert.ok(parseRequest({ ...env, type: "manage", action: "receive", heldUsd: 0 }));
  assert.ok(parseRequest({ ...env, type: "manage", action: "receive", heldUsd: 250 }));
  assert.ok(parseRequest({ ...sign, txs: [utx, utx, utx] }));
});

test("anything else is refused", () => {
  rejects(null);
  rejects("{}");
  rejects([]);
  rejects({ ...env, v: 2, type: "connect", intent: "create" });
  rejects({ ...env, kind: "other", type: "connect", intent: "create" });
  rejects({ ...env, id: "short", type: "connect", intent: "create" });
  rejects({ ...env, type: "connect", intent: "create", extra: 1 });
  rejects({ ...env, type: "connect", intent: "import" });
  rejects({ ...env, type: "connect" });
  rejects({ ...env, type: "personal_sign", message: "0x00" });
  rejects({ ...env, type: "signTypedData", typedData: {} });
  rejects({ ...env, type: "manage", action: "export-key" });
  for (const heldUsd of [-1, 1.5, "100", NaN, Infinity, 2 ** 53, null]) rejects({ ...env, type: "manage", action: "receive", heldUsd });
  rejects({ ...env, type: "__proto__" });
  rejects(Object.assign(Object.create({ evil: true }), { ...env, type: "connect", intent: "create" }));
  rejects({ ...sign, txs: [] });
  rejects({ ...sign, txs: Array(MAX_TXS + 1).fill(utx) });
  rejects({ ...sign, txs: [{ ...utx, value: "-1" }] });
  rejects({ ...sign, txs: [{ ...utx, value: "01" }] });
  rejects({ ...sign, txs: [{ ...utx, value: 1 }] });
  rejects({ ...sign, txs: [{ ...utx, data: "0xabc" }] });
  rejects({ ...sign, txs: [{ ...utx, to: "0x" + "g".repeat(40) }] });
  rejects({ ...sign, txs: [{ ...utx, from: sign.from }] });
  rejects({ ...sign, txs: [{ ...utx, fee: { type: "eip1559", maxFeePerGas: "1" } }] });
  rejects({ ...sign, chainKey: "Base Mainnet" });
  rejects({ ...sign, plan: { ...sign.plan, kind: "bridge" } });
  rejects({ ...sign, plan: { kind: "swap", dstChainKey: "sonic", inputToken: "x", outputToken: "y", inputAmount: "1", minOutputAmount: "1", deadline: "1", dstAddress: "a b" } });
  // Over the size cap even though every field is individually in range.
  rejects({ ...sign, txs: [{ ...utx, data: "0x" + "00".repeat(24 * 1024) }, { ...utx, data: "0x" + "00".repeat(24 * 1024) }] });
});

test("responses: ready, results, errors; and results must fit their request", () => {
  assert.deepEqual(parseResponse(ready()), ready());
  const accounts = { evm: "0x" + "1".repeat(40), solana: "So1ana", sui: "0x" + "2".repeat(64), stellar: "G" + "A".repeat(55) };
  const connected = parseResponse({ ...env, type: "result", ok: true, result: { accounts, backedUp: false } }) as ResultMessage;
  const signed = parseResponse({ ...env, type: "result", ok: true, result: { signed: ["0x02"], hashes: ["0x" + "e".repeat(64)] } }) as ResultMessage;
  const failed = parseResponse({ ...env, type: "result", ok: false, error: { code: "REFUSED", message: "no" } }) as ResultMessage;
  assert.throws(() => parseResponse({ ...env, type: "result", ok: false, error: { code: "PWNED", message: "no" } }), ProtocolError);
  assert.throws(() => parseResponse({ ...env, type: "result", ok: true, result: { accounts, backedUp: false, phrase: "x" } }), ProtocolError);
  assert.throws(() => parseResponse({ ...env, type: "result", ok: true, result: { signed: ["0x02"], hashes: ["0xE".padEnd(66, "E")] } }), ProtocolError);

  const connect: WalletRequest = { ...env, type: "connect", intent: "signin" };
  assert.equal(resultFits(connect, connected), true);
  assert.equal(resultFits(connect, signed), false);
  assert.equal(resultFits(sign, signed), true);
  assert.equal(resultFits({ ...sign, txs: [...sign.txs, ...sign.txs] }, signed), false, "one signature per transaction");
  assert.equal(resultFits({ ...sign, id: "req_another_id_00000" }, signed), false);
  assert.equal(resultFits(sign, failed), true);
});

test("request ids: 128 bits, valid ids, never repeated", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
  assert.equal(ids.size, 200);
  for (const i of ids) assert.match(i, /^[A-Za-z0-9_-]{22}$/);
});
