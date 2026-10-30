// The popup's own hub-account lookup (src/sodax/hub.ts): the exact eth_call the SDK makes, strict parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, getAddress, toFunctionSelector, type Hex } from "viem";
import { WALLET_CSP } from "@exclip/config";
import { SODAX_HUB_WALLET_FACTORY, SONIC_RPC_URL, fetchHubWallet, hubWalletCall, type RpcFetch } from "../src/sodax/hub.ts";
import { EVM_CHAINS, SONIC_WALLET_ROUTER } from "../src/sodax/chains.ts";

// The two ABIs as @sodax/sdk 2.2.0 declares them (dist/index.mjs walletFactoryAbi :11876, sonicWalletFactoryAbi :13360).
const SDK_FACTORY_ABI = [{ type: "function", name: "getDeployedAddress", stateMutability: "view", inputs: [{ name: "chainId", type: "uint256" }, { name: "user", type: "bytes" }], outputs: [{ name: "computedAddress", type: "address" }] }] as const;
const SDK_ROUTER_ABI = [{ type: "function", name: "getDeployedAddress", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "computedAddress", type: "address" }] }] as const;

const USER = "0x12a4" + "34".repeat(18);
const HUB = "0x9aBcdEf0123456789abcdef0123456789ABCdEF0";
const word = (addr: string) => "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();

test("the call: hubWallet.getDeployedAddress(relayChainId, user bytes) on spokes, walletRouter.getDeployedAddress(user) on Sonic", () => {
  for (const chain of Object.values(EVM_CHAINS)) {
    const call = hubWalletCall(chain.key, USER);
    if (chain.key === "sonic") {
      assert.equal(call.to, SONIC_WALLET_ROUTER);
      assert.equal(call.data.slice(0, 10), toFunctionSelector("getDeployedAddress(address)"));
      assert.deepEqual(decodeFunctionData({ abi: SDK_ROUTER_ABI, data: call.data }).args, [getAddress(USER)]);
    } else {
      assert.equal(call.to, SODAX_HUB_WALLET_FACTORY);
      assert.equal(call.data.slice(0, 10), toFunctionSelector("getDeployedAddress(uint256,bytes)"));
      // encodeAddress for EVM is the address itself: 20 bytes.
      assert.deepEqual(decodeFunctionData({ abi: SDK_FACTORY_ABI, data: call.data }).args, [chain.relayId, USER.toLowerCase()], chain.key);
    }
  }
  assert.equal(hubWalletCall("0x2105.base", USER).data, hubWalletCall("0x2105.base", USER.toUpperCase().replace("0X", "0x")).data, "case-insensitive input");
  for (const [chain, user] of [["solana", USER], ["nope", USER], ["0x2105.base", "0x1234"], ["0x2105.base", USER + "00"]]) {
    assert.throws(() => hubWalletCall(chain!, user!), /bad input/, `${chain} ${user}`);
  }
});

test("fetchHubWallet: one POST to the pinned Sonic RPC, no credentials or referrer, checksummed answer", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const rpc: RpcFetch = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(HUB) }));
  };
  assert.equal(await fetchHubWallet(rpc, "0x2105.base", USER), getAddress(HUB));
  const { url, init } = seen[0]!;
  assert.equal(url, SONIC_RPC_URL);
  assert.equal(SONIC_RPC_URL, "https://rpc.soniclabs.com");
  assert.equal(init.method, "POST");
  assert.equal(init.credentials, "omit");
  assert.equal(init.redirect, "error");
  assert.equal(init.referrerPolicy, "no-referrer");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal);
  assert.deepEqual(JSON.parse(String(init.body)), { jsonrpc: "2.0", id: 1, method: "eth_call", params: [hubWalletCall("0x2105.base", USER), "latest"] });
  // The wallet origin's CSP (@exclip/config, sent by Vite preview and apps/server) allows exactly this RPC.
  assert.match(WALLET_CSP, /connect-src 'self' https:\/\/api\.sodax\.com\/v1\/intent\/quote https:\/\/rpc\.soniclabs\.com;/);
});

test("fetchHubWallet refuses anything but one clean address word", async () => {
  const answer = (status: number, body: string): RpcFetch => async () => new Response(body, { status });
  const ok = (result: unknown, extra: object = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, result, ...extra });
  const bad: [string, RpcFetch][] = [
    ["HTTP 500", answer(500, ok(word(HUB)))],
    ["JSON-RPC error", answer(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } }))],
    ["wrong id", answer(200, JSON.stringify({ jsonrpc: "2.0", id: 2, result: word(HUB) }))],
    ["no jsonrpc", answer(200, JSON.stringify({ id: 1, result: word(HUB) }))],
    ["zero address", answer(200, ok(word("0x" + "0".repeat(40))))],
    ["dirty high bytes", answer(200, ok("0x" + "ff".repeat(12) + HUB.slice(2)))],
    ["short", answer(200, ok("0x" + HUB.slice(2)))],
    ["two words", answer(200, ok(word(HUB) + "0".repeat(64)))],
    ["empty result", answer(200, ok("0x"))],
    ["number", answer(200, ok(1))],
    ["not JSON", answer(200, "<html>")],
    ["oversized", answer(200, ok(word(HUB), { pad: "x".repeat(5000) }))],
    ["network", async () => { throw new TypeError("Failed to fetch"); }],
  ];
  for (const [name, rpc] of bad) await assert.rejects(fetchHubWallet(rpc, "0x2105.base", USER), Error, name);
  // A hung RPC is cut off by the timeout.
  const hung: RpcFetch = (_u, init) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(fetchHubWallet(hung, "sonic", USER, 10), /aborted/);
  // Unsupported input never reaches the network.
  let called = false;
  await assert.rejects(fetchHubWallet(async () => { called = true; return new Response(ok(word(HUB))); }, "solana", USER));
  assert.equal(called, false);
});

test("Sonic answers decode through the router ABI", async () => {
  const rpc: RpcFetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(HUB) as Hex }));
  assert.equal(await fetchHubWallet(rpc, "sonic", USER), getAddress(HUB));
});
