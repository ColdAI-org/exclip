import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EvmSolverService, IntentDataService, Sodax } from "@sodax/sdk";
import { sodaxOptions } from "../src/lib/api.ts";
import { EmbeddedWalletError, WalletPopup, validWalletOrigin, type PopupMessage } from "../src/lib/embedded-client.ts";
import {
  APPROVE_GAS, BROWSER_WALLET_MESSAGE, EMBEDDED_CHAINS, EmbeddedTradeError, MAX_FEE_PER_GAS, SIGN_ONLY_MESSAGE, SWAP_GAS_AFTER_APPROVAL,
  broadcast, embeddedSend, embeddedSwap, embeddedSwapProblem, erc20TransferData, fillTxs, sendTx, swapPlan,
  type EvmRpc, type RawTx, type Signer, type SodaxSwaps,
} from "../src/lib/embedded-tx.ts";
import { READY_TIMEOUT_MS, REQUEST_TIMEOUT_MS, type Hex, type SignRequest, type SignResult, type SwapPlan } from "../src/lib/wallet-protocol.ts";
import type { SwapInput } from "../src/lib/wallet.ts";
import { buildWalletOrigin, trustedWalletOrigin, walletOfferedOn } from "../src/lib/wallet-origin.ts";

const APP = "https://exclip.example.com";
const WALLET = "https://wallet.example.com";
const DEV_WALLET = "http://localhost:5311";
const OWN = "0x1111111111111111111111111111111111111111";
const ready = { v: 1, kind: "exclip-wallet", type: "ready" };
const ok = (id: string, result: object) => ({ v: 1, kind: "exclip-wallet", id, type: "result", ok: true, result });
const ACCOUNTS = { evm: OWN, solana: "So11111111111111111111111111111111111111112", sui: `0x${"2".repeat(64)}`, stellar: `G${"A".repeat(55)}` };
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const walletError = (code: string, message = /./) => (e: unknown) => e instanceof EmbeddedWalletError && e.code === code && message.test(e.message);
const tradeError = (sent: boolean, message: RegExp) => (e: unknown) => e instanceof EmbeddedTradeError && e.sent === sent && message.test(e.message);

/* ------------------------------------------------------------------ popup client */

/** What the page posted to the popup, loosely typed so a test can read any request's fields. */
type Posted = { v: number; kind: string; id: string; type: string; intent?: string; action?: string; heldUsd?: number };
type Timer = { fn: () => void; ms: number; repeat: boolean };

function fakeEnv({ blocked = false } = {}) {
  const timers = new Map<number, Timer>();
  let next = 1;
  const win = {
    posted: [] as { m: Posted; origin: string }[],
    closed: false,
    postMessage(m: unknown, origin: string) { win.posted.push({ m: m as Posted, origin }); },
    close() { win.closed = true; },
  };
  const opened: string[] = [];
  let listener: ((e: PopupMessage) => void) | null = null;
  return {
    win,
    opened,
    open(url: string) { opened.push(url); return blocked ? null : win; },
    listen(fn: (e: PopupMessage) => void) { listener = fn; return () => { listener = null; }; },
    listening: () => listener !== null,
    setTimeout(fn: () => void, ms: number) { const id = next++; timers.set(id, { fn, ms, repeat: false }); return id; },
    clearTimeout(id: unknown) { timers.delete(id as number); },
    setInterval(fn: () => void, ms: number) { const id = next++; timers.set(id, { fn, ms, repeat: true }); return id; },
    clearInterval(id: unknown) { timers.delete(id as number); },
    /** Runs every timer whose delay is `ms` (or every interval when ms is "interval"). */
    fire(ms: number | "interval") {
      for (const [id, t] of [...timers]) if ((ms === "interval" && t.repeat) || t.ms === ms) { if (!t.repeat) timers.delete(id); t.fn(); }
    },
    pending: () => timers.size,
    send(data: unknown, { origin = WALLET, source = win as unknown } = {}) { listener?.({ data, origin, source }); },
  };
}
const tick = () => new Promise<void>(r => setImmediate(r));

test("wallet origin: exact https only (http just for localhost in dev)", () => {
  assert.equal(validWalletOrigin(WALLET), true);
  for (const bad of [`${WALLET}/`, "http://wallet.example.com", `${WALLET}/x`, "wallet.example.com", "", null, DEV_WALLET]) {
    assert.equal(validWalletOrigin(bad), false, String(bad));
  }
  assert.equal(validWalletOrigin(DEV_WALLET, true), true);
  assert.equal(validWalletOrigin("http://evil.test:5311", true), false);
});

test("wallet origin is fixed at build time; the runtime config is only an on/off switch", () => {
  assert.equal(buildWalletOrigin(WALLET, false), WALLET);
  assert.equal(buildWalletOrigin(DEV_WALLET, true), DEV_WALLET);
  // A bad build value fails closed (no wallet), never falls back to a default.
  for (const bad of [undefined, null, "", DEV_WALLET, `${WALLET}/`, "wallet.example.com", 42]) assert.equal(buildWalletOrigin(bad, false), null, String(bad));

  const on = { embeddedWallet: true };
  assert.equal(trustedWalletOrigin(WALLET, on), WALLET);
  assert.equal(trustedWalletOrigin(WALLET, { ...on, walletOrigin: WALLET }), WALLET);
  // The server naming any other origin switches the wallet off instead of moving it.
  assert.equal(trustedWalletOrigin(WALLET, { ...on, walletOrigin: "https://wallet-exclip.example" }), null);
  assert.equal(trustedWalletOrigin(WALLET, { ...on, walletOrigin: `${WALLET}/` }), null);
  assert.equal(trustedWalletOrigin(WALLET, { ...on, embeddedWallet: false }), null);
  assert.equal(trustedWalletOrigin(WALLET, {}), null);
  assert.equal(trustedWalletOrigin(WALLET, null), null);
  assert.equal(trustedWalletOrigin(null, on), null);
  // embedded.ts reads the origin from the build, not from the config.
  const src = read("../src/lib/embedded.ts");
  assert.match(src, /buildWalletOrigin\(__EXCLIP__\.walletOrigin, DEV\)/);
  assert.doesNotMatch(src, /\? config\.walletOrigin/);
});

test("production builds offer the embedded wallet only on the app origin they were built for", () => {
  assert.equal(walletOfferedOn(APP, APP, false), true);
  for (const o of ["https://example.com", "https://www.exclip.example.com", `${APP}.evil.example`, "http://exclip.example.com", null, undefined]) {
    assert.equal(walletOfferedOn(o, APP, false), false, String(o));
  }
  assert.equal(walletOfferedOn(APP, null, false), false);
  assert.equal(walletOfferedOn(APP, "", false), false);
  assert.equal(walletOfferedOn("http://localhost:5173", APP, true), true);
  assert.match(read("../src/lib/embedded.ts"), /if \(!walletOfferedOn\(page, __EXCLIP__\.appOrigin, DEV\)\) return null;/);
});

test("popup: blocked window throws POPUP_BLOCKED synchronously", () => {
  const env = fakeEnv({ blocked: true });
  assert.throws(() => WalletPopup.open(WALLET, env), walletError("POPUP_BLOCKED"));
  assert.deepEqual(env.opened, [`${WALLET}/`]);
});

test("popup: waits for ready, posts to the exact origin, accepts only the matching result from that window", async () => {
  const env = fakeEnv();
  const popup = WalletPopup.open(WALLET, env);
  const result = popup.connect("create");
  await tick();
  assert.equal(env.win.posted.length, 0, "nothing posted before ready");
  env.send(ready, { origin: "https://evil.test" }); // wrong origin: ignored
  env.send(ready, { source: {} }); // wrong window: ignored
  await tick();
  assert.equal(env.win.posted.length, 0);
  env.send(ready);
  await tick();
  assert.equal(env.win.posted.length, 1);
  const { m: req, origin } = env.win.posted[0]!;
  assert.equal(origin, WALLET);
  assert.deepEqual({ v: req.v, kind: req.kind, type: req.type, intent: req.intent }, { v: 1, kind: "exclip-wallet", type: "connect", intent: "create" });

  env.send(ok("x".repeat(16), { accounts: ACCOUNTS, backedUp: false })); // other id
  env.send({ ...ok(req.id, { accounts: ACCOUNTS, backedUp: false }), extra: 1 }); // malformed
  env.send(ok(req.id, { accounts: ACCOUNTS, backedUp: true }), { origin: "https://evil.test" });
  env.send(ok(req.id, { backedUp: true, passkeys: 1 })); // shape of another request type
  env.send(ok(req.id, { accounts: ACCOUNTS, backedUp: false }));
  assert.deepEqual(await result, { accounts: ACCOUNTS, backedUp: false });
  assert.equal(env.pending(), 0, "all timers cleared");
  assert.equal(env.listening(), false, "listener removed");
  await assert.rejects(popup.manage("save-phrase"), /one request/);
});

test("receive: the popup shows the address; the page only sends its holdings hint", async () => {
  for (const [heldUsd, expected] of [[undefined, undefined], [0, 0], [250, 250]]) {
    const env = fakeEnv();
    const p = WalletPopup.open(WALLET, env).manage("receive", heldUsd);
    env.send(ready);
    await tick();
    const req = env.win.posted[0]!.m;
    assert.equal(req.action, "receive");
    assert.equal("heldUsd" in req, expected !== undefined, String(heldUsd));
    assert.equal(req.heldUsd, expected);
    env.send(ok(req.id, { backedUp: false, passkeys: 1 }));
    assert.deepEqual(await p, { backedUp: false, passkeys: 1 });
  }
  // The passkey wallet's Receive opens the popup and never renders the deposit address itself.
  const src = read("../src/components/TransferSheet.tsx");
  const receive = src.slice(src.indexOf("function EmbeddedReceive"), src.indexOf("function EmbeddedSend"));
  assert.match(receive, /manageEmbedded\(origin, action, \{ heldUsd \}\)/);
  assert.doesNotMatch(receive, /session\.evm/);
  assert.doesNotMatch(receive, /CopyRow/);
});

test("popup: errors, closing the window, and timeouts end the wait", async () => {
  {
    const env = fakeEnv();
    const p = WalletPopup.open(WALLET, env).connect("signin");
    env.send(ready);
    await tick();
    const { id } = env.win.posted[0]!.m;
    env.send({ v: 1, kind: "exclip-wallet", id, type: "result", ok: false, error: { code: "NO_WALLET", message: "No wallet here." } });
    await assert.rejects(p, walletError("NO_WALLET", /^No wallet here\.$/));
  }
  {
    const env = fakeEnv();
    const p = WalletPopup.open(WALLET, env).connect("signin");
    env.win.closed = true;
    env.fire("interval");
    await assert.rejects(p, walletError("CANCELLED"));
    assert.equal(env.pending(), 0);
  }
  {
    const env = fakeEnv();
    const p = WalletPopup.open(WALLET, env).connect("signin");
    env.fire(READY_TIMEOUT_MS);
    await assert.rejects(p, walletError("TIMEOUT"));
    assert.equal(env.win.closed, true, "a popup that never loaded is closed");
  }
  {
    const env = fakeEnv();
    const p = WalletPopup.open(WALLET, env).manage("add-passkey");
    env.send(ready);
    await tick();
    env.fire(REQUEST_TIMEOUT_MS.manage);
    await assert.rejects(p, walletError("TIMEOUT", /Nothing was signed/));
    assert.equal(env.pending(), 0);
  }
  {
    const env = fakeEnv();
    const popup = WalletPopup.open(WALLET, env);
    popup.close("The trade couldn't be prepared.");
    assert.equal(env.win.closed, true);
    await assert.rejects(popup.connect("create"), walletError("CANCELLED"));
  }
});

test("wallet-protocol.ts is the wallet's protocol.ts, byte for byte", () => {
  assert.equal(read("../src/lib/wallet-protocol.ts"), read("../../wallet/src/protocol.ts"));
});

/* ------------------------------------------------------------------ transactions */

const GWEI = 10n ** 9n;
const HASH = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const NATIVE = "0x0000000000000000000000000000000000000000";

type RpcOptions = {
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null;
  gasPrice?: bigint;
  estimate?: bigint | Error;
  nonce?: number;
  statuses?: ("success" | "reverted")[];
  returned?: (serialized: Hex) => Hex;
};
type FakeRpc = EvmRpc & { log: [string, ...unknown[]][] };

function fakeRpc({ fees = { maxFeePerGas: 30n * GWEI, maxPriorityFeePerGas: 2n * GWEI }, gasPrice = 5n * GWEI, estimate = 60_000n, nonce = 7, statuses = [], returned }: RpcOptions = {}): FakeRpc {
  const log: FakeRpc["log"] = [];
  return {
    log,
    async getTransactionCount(a) { log.push(["nonce", a.address, a.blockTag]); return nonce; },
    async estimateFeesPerGas() { if (!fees) throw new Error("no 1559"); return fees; },
    async getGasPrice() { return gasPrice; },
    async estimateGas(a) { log.push(["estimate", a.to]); if (estimate instanceof Error) throw estimate; return estimate; },
    async sendRawTransaction({ serializedTransaction }) { log.push(["send", serializedTransaction]); return returned?.(serializedTransaction) ?? HASH(Number(serializedTransaction.slice(2))); },
    async waitForTransactionReceipt({ hash }) { log.push(["wait", hash]); return { status: statuses.shift() ?? "success" }; },
  };
}
const raw = (to: string, kind: RawTx["kind"], value = 0n, data = "0x"): RawTx => ({ to, data, value, kind });

test("fillTxs: pending nonce, one EIP-1559 fee, estimate for the first tx, fixed gas for dependent ones", async () => {
  const rpc = fakeRpc();
  const txs = await fillTxs(rpc, OWN, [raw("0xa", "approve", 0n, "0x01"), raw("0xb", "approve", 0n, "0x02"), raw("0xc", "swap", 5n, "0x03")]);
  assert.deepEqual(txs.map(t => t.nonce), ["7", "8", "9"]);
  assert.deepEqual(txs.map(t => t.gas), ["75000", APPROVE_GAS.toString(), SWAP_GAS_AFTER_APPROVAL.toString()]);
  assert.deepEqual(txs[0]!.fee, { type: "eip1559", maxFeePerGas: "30000000000", maxPriorityFeePerGas: "2000000000" });
  assert.equal(txs[2]!.value, "5");
  assert.deepEqual(rpc.log[0], ["nonce", OWN, "pending"]);
  assert.equal(rpc.log.filter(l => l[0] === "estimate").length, 1);

  const legacy = await fillTxs(fakeRpc({ fees: null }), OWN, [raw("0xc", "transfer", 1n)]);
  assert.deepEqual(legacy[0]!.fee, { type: "legacy", gasPrice: "5000000000" });

  await assert.rejects(fillTxs(fakeRpc({ fees: { maxFeePerGas: MAX_FEE_PER_GAS + 1n, maxPriorityFeePerGas: 1n } }), OWN, [raw("0xc", "swap")]), /unusually high/);
  await assert.rejects(fillTxs(fakeRpc({ estimate: new Error("revert") }), OWN, [raw("0xc", "swap")]), /Nothing was sent/);
  await assert.rejects(fillTxs(fakeRpc(), OWN, [1, 2, 3, 4].map(() => raw("0xc", "approve"))), EmbeddedTradeError);
});

test("broadcast: in order, each confirmed before the next; hash mismatch or revert stops it", async () => {
  const signed: SignResult = { signed: ["0x1", "0x2"], hashes: [HASH(1), HASH(2)] };
  const rpc = fakeRpc();
  assert.deepEqual(await broadcast(rpc, signed), [HASH(1), HASH(2)]);
  assert.deepEqual(rpc.log.map(l => l[0]), ["send", "wait", "send", "wait"]);

  const reverted = fakeRpc({ statuses: ["reverted"] });
  await assert.rejects(broadcast(reverted, signed), tradeError(true, /failed on chain/));
  assert.equal(reverted.log.filter(l => l[0] === "send").length, 1, "the swap is never sent after a failed approval");

  const lying = fakeRpc({ returned: () => HASH(99) });
  await assert.rejects(broadcast(lying, signed), tradeError(true, /Don't resend/));
});

test("sends: ERC-20 calldata, native value scaled on Hedera, only embedded networks", () => {
  const to = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
  assert.equal(erc20TransferData(to, 5_000_000n), `0xa9059cbb${"0".repeat(24)}abcdef0123456789abcdef0123456789abcdef01${(5_000_000).toString(16).padStart(64, "0")}`);
  const usdc = sendTx({ chainKey: "0x2105.base", token: USDC_BASE, amount: 5n, to });
  assert.deepEqual(usdc.plan, { kind: "transfer", token: USDC_BASE, amount: "5", to });
  assert.equal(usdc.raw.to, USDC_BASE);
  assert.equal(usdc.raw.value, 0n);
  const hbar = sendTx({ chainKey: "hedera", token: NATIVE, amount: 3n * 10n ** 8n, to });
  assert.deepEqual([hbar.raw.to, hbar.raw.data, hbar.raw.value], [to, "0x", 3n * 10n ** 18n]);
  assert.equal(sendTx({ chainKey: "ethereum", token: NATIVE, amount: 7n, to }).raw.value, 7n);
  assert.throws(() => sendTx({ chainKey: "solana", token: "x", amount: 1n, to }), new RegExp(BROWSER_WALLET_MESSAGE));
  assert.throws(() => sendTx({ chainKey: "ethereum", token: NATIVE, amount: 1n, to: "0x123" }), /full EVM address/);
});

test("the embedded network list matches what the popup signs on", () => {
  const src = read("../../wallet/src/sodax/chains.ts");
  const start = src.indexOf("export const EVM_CHAINS");
  const block = src.slice(start, src.indexOf("});", start));
  const keys = [...block.matchAll(/^\s+(?:"([^"]+)"|(\w+)): chain\("([^"]+)"/gm)].map(m => m[3]);
  assert.deepEqual([...EMBEDDED_CHAINS].sort(), keys.sort());
});

const swapInput = (over: Partial<SwapInput> = {}): SwapInput => ({
  srcChainKey: "0x2105.base", dstChainKey: "ethereum", inputToken: USDC_BASE, outputToken: USDC_ETHEREUM,
  inputAmount: 1_000_000n, minOutputAmount: 990_000n, deadline: 2_000_000_000n, kind: "market", ...over,
});

test("swap problems are caught before the popup opens", () => {
  assert.equal(embeddedSwapProblem(swapInput(), OWN), null);
  assert.equal(embeddedSwapProblem(swapInput({ dstAddress: OWN.toUpperCase().replace("0X", "0x") }), OWN), null);
  assert.equal(embeddedSwapProblem(swapInput({ srcChainKey: "solana" }), OWN), BROWSER_WALLET_MESSAGE);
  assert.equal(embeddedSwapProblem(swapInput({ dstChainKey: "stellar" }), OWN), BROWSER_WALLET_MESSAGE);
  assert.match(embeddedSwapProblem(swapInput({ kind: "limit", deadline: 0n }), OWN) ?? "", /Limit orders/);
  assert.match(embeddedSwapProblem(swapInput({ dstAddress: "0x2222222222222222222222222222222222222222" }), OWN) ?? "", /only swaps into itself/);
});

type Call = [string, ...unknown[]];
type FakeSodax = SodaxSwaps & { calls: Call[]; rpcClient: FakeRpc };
type RelayResult = Awaited<ReturnType<SodaxSwaps["relay"]>>;

function fakeSodax({ allowed = true, reset = false, rpc = fakeRpc(), relay = { ok: true, value: HASH(500) } }: { allowed?: boolean; reset?: boolean; rpc?: FakeRpc; relay?: RelayResult } = {}): FakeSodax {
  const calls: Call[] = [];
  return {
    calls, rpcClient: rpc,
    async isAllowanceValid(p) { calls.push(["allowance", p]); return { ok: true, value: allowed }; },
    async buildApproveTxs(p) {
      calls.push(["approve", p]);
      return { ok: true, value: { ...(reset ? { resetTx: { to: "0xtoken", data: "0xreset", value: 0n } } : {}), approveTx: { to: "0xtoken", data: "0xapprove", value: 0n } } };
    },
    async createIntent(p, skip) {
      calls.push(["create", p, skip]);
      // SODAX's own numbers: the popup compares these to the plan, so the plan must not copy them.
      return { ok: true, value: { tx: { to: "0xam", data: "0xswap", value: 0n }, intent: { intentId: 9n, inputAmount: 999_000n, deadline: 2_000_000_000n, allowPartialFill: false }, relayData: { r: 1 } } };
    },
    async relay(chainKey, hash, data) { calls.push(["relay", chainKey, hash, data]); return relay; },
    async postExecution(h) { calls.push(["post", h]); return { ok: true, value: {} }; },
    rpc: () => rpc,
  };
}
const call = (sodax: FakeSodax, step: string) => sodax.calls.find(c => c[0] === step);

type SignBody = Omit<SignRequest, "v" | "kind" | "id" | "type">;
function fakeSigner(hashes?: Hex[]) {
  const s: Signer & { requests: SignBody[]; closed: string | null } = {
    requests: [], closed: null,
    async sign(body) { s.requests.push(body); return { signed: body.txs.map((_, i) => `0x${i + 1}` as const), hashes: hashes ?? body.txs.map((_, i) => HASH(i + 1)) }; },
    close(reason) { s.closed = reason ?? "closed"; },
  };
  return s;
}

test("embedded swap: approvals + intent go to the popup with the user's plan; broadcast, relay, notify", async () => {
  const sodax = fakeSodax({ allowed: false, reset: true });
  const signer = fakeSigner();
  const progress: string[] = [];
  const out = await embeddedSwap(sodax, signer, swapInput(), OWN, p => progress.push(p.step));
  const req = signer.requests[0]!;
  assert.equal(req.chainKey, "0x2105.base");
  assert.equal(req.from, OWN);
  assert.deepEqual(req.plan, swapPlan(swapInput(), OWN));
  assert.equal((req.plan as SwapPlan).inputAmount, "1000000", "gross amount from the user, not SODAX's net");
  assert.deepEqual(req.txs.map(t => t.data), ["0xreset", "0xapprove", "0xswap"]);
  assert.equal(call(sodax, "create")?.[2], true, "simulation skipped while the approval is pending");
  assert.equal((call(sodax, "create")?.[1] as Record<string, unknown>).dstAddress, OWN);
  assert.deepEqual(progress, ["sign", "approve", "submitted", "solving"]);
  assert.deepEqual(call(sodax, "relay")?.slice(1), ["0x2105.base", HASH(3), { r: 1 }]);
  assert.deepEqual(out, { srcTxHash: HASH(3), hubTxHash: HASH(500), intent: { intentId: "9", inputAmount: "999000", deadline: "2000000000", allowPartialFill: false } });
});

test("embedded swap: Sonic needs no relay; failures before signing close the popup; dev sign-only sends nothing", async () => {
  {
    const sodax = fakeSodax();
    const out = await embeddedSwap(sodax, fakeSigner(), swapInput({ srcChainKey: "sonic", inputToken: NATIVE }), OWN, () => {});
    assert.equal(out.hubTxHash, out.srcTxHash);
    assert.equal(call(sodax, "relay"), undefined);
    assert.equal(call(sodax, "create")?.[2], false);
  }
  {
    const sodax = fakeSodax();
    sodax.createIntent = async () => ({ ok: false, error: new Error("NO_PATH") });
    const signer = fakeSigner();
    await assert.rejects(embeddedSwap(sodax, signer, swapInput(), OWN, () => {}), tradeError(false, /Nothing was sent/));
    assert.notEqual(signer.closed, null, "popup closed");
    assert.equal(signer.requests.length, 0);
  }
  {
    const sodax = fakeSodax();
    await assert.rejects(embeddedSwap(sodax, fakeSigner(), swapInput(), OWN, () => {}, { signOnly: true }), new RegExp(SIGN_ONLY_MESSAGE));
    assert.equal(sodax.rpcClient.log.some(l => l[0] === "send"), false);
  }
  {
    const sodax = fakeSodax({ relay: { ok: false, error: "RELAY_TIMEOUT" } });
    await assert.rejects(embeddedSwap(sodax, fakeSigner(), swapInput(), OWN, () => {}), tradeError(true, /Don't resend/));
  }
});

/** The parts of the SDK's resolved settings this test reads. (Its options type wants a literal http(s) URL type.) */
const sdkSettings = (options: ReturnType<typeof sodaxOptions>) =>
  (new Sodax(options as ConstructorParameters<typeof Sodax>[0]) as unknown as { config: { swapPartnerFee?: unknown; moneyMarketPartnerFee?: unknown } }).config;

test("partner fee only when the server reports a receiver and more than 0 bps; without one, intents carry empty data", async () => {
  // A server without a fee, and every half-set fee the server refuses to pin: the SDK resolves no fee at all.
  for (const config of [{ partnerFeeBps: 0, feeReceiver: null }, { partnerFeeBps: 30, feeReceiver: null }, { partnerFeeBps: 0, feeReceiver: OWN }, null, undefined]) {
    const options = sodaxOptions(config, APP);
    assert.deepEqual(options, { api: { baseURL: `${APP}/api/exclip/sodax` } }, JSON.stringify(config));
    const sdk = sdkSettings(options);
    assert.equal(sdk.swapPartnerFee ?? null, null);
    assert.equal(sdk.moneyMarketPartnerFee ?? null, null);
  }
  // The SDK's encoding of "no fee": empty intent data (2.2.0; an upgrade that adds a default fee fails here). Without a
  // fee, that is the only kind the popup signs unless the receiver is on its reviewed list (apps/wallet/fee-receivers.json).
  const [feeData, feeAmount] = EvmSolverService.createIntentFeeData(undefined, 1_000_000n);
  assert.deepEqual([feeData, feeAmount, IntentDataService.composeIntentData(feeData)], ["0x", 0n, "0x"]);
  // A fee the server does pin reaches the SDK as is.
  assert.deepEqual(sdkSettings(sodaxOptions({ partnerFeeBps: 30, feeReceiver: OWN }, APP)).swapPartnerFee, { address: OWN, percentage: 30 });

  // The embedded swap's own requests to SODAX: empty data, no fee and no hook at every step (the fee is the SDK's).
  const sodax = fakeSodax({ allowed: false });
  await embeddedSwap(sodax, fakeSigner(), swapInput(), OWN, () => {});
  const steps = sodax.calls.filter(c => ["allowance", "approve", "create"].includes(c[0]));
  assert.deepEqual(steps.map(c => c[0]), ["allowance", "approve", "create"]);
  for (const [step, p] of steps) {
    const params = p as Record<string, unknown>;
    assert.deepEqual([params.data, "partnerFee" in params, "hook" in params], ["0x", false, false], step);
  }
});

test("embedded send: one transfer, broadcast once", async () => {
  const rpc = fakeRpc();
  const signer = fakeSigner();
  const hash = await embeddedSend(rpc, signer, { chainKey: "0x2105.base", token: USDC_BASE, amount: 5n, to: "0x2222222222222222222222222222222222222222" }, OWN);
  assert.equal(hash, HASH(1));
  assert.equal(signer.requests[0]!.plan.kind, "transfer");
  assert.equal(rpc.log.filter(l => l[0] === "send").length, 1);
});
