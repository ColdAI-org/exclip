/** The user's SODAX hub account on Sonic, looked up by the popup itself. A server answer would let a compromised
 * server plus a compromised ExClip page name an attacker's contract on the first swap, and would tell the server which
 * wallet address the IP behind it owns.
 *
 * Why an RPC call and not a local CREATE3 computation: @sodax/sdk 2.2.0 does not derive the address either. It asks
 * the contracts:
 *  - HubProvider.fetchUserHubWalletAddress (node_modules/@sodax/sdk/dist/index.mjs:29862-29873): for a spoke chain,
 *    `hubWallet.getDeployedAddress(uint256 relayChainId, bytes encodeAddress(user))` on the hub wallet factory; on
 *    Sonic itself, `walletRouter.getDeployedAddress(address user)` (getUserRouter, :29847-29854).
 *  - encodeAddress for EVM chains is the 0x address itself (:6817-6822).
 *  - ABIs: walletFactoryAbi (:11876-11899) and the router's sonicWalletFactoryAbi (:13292, getDeployedAddress :13360-13366).
 * The salt layout and proxy init code live only in SODAX's Solidity sources, which aren't in node_modules, and no known
 * (user, hub) pair is on record to test a local formula against. Shipping an untested formula would be a guess, so the
 * popup asks the factory directly over one pinned RPC. The factory is a view call; the answer is then pinned per
 * network on first use (wallet.ts), and every later answer must match the pin.
 *
 * Trust: the Sonic RPC run by Sonic Labs, reached over TLS from the popup's own origin. The operator's servers and the
 * ExClip page are not in the path. Constants from @sodax/types 2.2.0 dist/chains/chains.js: rpcUrl :1019,
 * hubWallet :1000, walletRouter :1009. */
import { decodeFunctionResult, encodeFunctionData, getAddress, type Hex } from "viem";
import { SONIC_KEY, SONIC_WALLET_ROUTER, evmChain } from "./chains.ts";

/** Pinned in the popup's CSP connect-src (@exclip/config WALLET_CSP). */
export const SONIC_RPC_URL = "https://rpc.soniclabs.com";
export const SODAX_HUB_WALLET_FACTORY = "0xA0ed3047D358648F2C0583B415CffCA571FDB544" as const;
export const HUB_LOOKUP_TIMEOUT_MS = 10_000;
const MAX_RPC_BYTES = 4_096;

const factoryAbi = [{
  type: "function", name: "getDeployedAddress", stateMutability: "view",
  inputs: [{ name: "chainId", type: "uint256" }, { name: "user", type: "bytes" }],
  outputs: [{ name: "computedAddress", type: "address" }],
}] as const;
const routerAbi = [{
  type: "function", name: "getDeployedAddress", stateMutability: "view",
  inputs: [{ name: "user", type: "address" }],
  outputs: [{ name: "computedAddress", type: "address" }],
}] as const;

export type RpcFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The eth_call that names `user`'s hub account for swaps from `chainKey`. Throws for a network the wallet doesn't
 * sign on or a malformed address. */
export function hubWalletCall(chainKey: string, user: string): { to: Hex; data: Hex } {
  const chain = evmChain(chainKey);
  if (!chain || !/^0x[0-9a-fA-F]{40}$/.test(user)) throw new Error("hub lookup: bad input");
  const addr = getAddress(user.toLowerCase());
  return chain.key === SONIC_KEY
    ? { to: SONIC_WALLET_ROUTER, data: encodeFunctionData({ abi: routerAbi, functionName: "getDeployedAddress", args: [addr] }) }
    : { to: SODAX_HUB_WALLET_FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: "getDeployedAddress", args: [chain.relayId, addr.toLowerCase() as Hex] }) };
}

/** `user`'s hub account (checksummed), or throws on any problem: network, HTTP, size, JSON-RPC error, a result that
 * isn't exactly one ABI word holding an address, or the zero address. Sends no credentials, cookies or referrer. */
export async function fetchHubWallet(fetchFn: RpcFetch, chainKey: string, user: string, timeoutMs = HUB_LOOKUP_TIMEOUT_MS): Promise<string> {
  const call = hubWalletCall(chainKey, user);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(SONIC_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [call, "latest"] }),
      signal: ctrl.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) throw new Error("hub lookup: HTTP");
    const text = await res.text();
    if (text.length > MAX_RPC_BYTES) throw new Error("hub lookup: oversized");
    const body = JSON.parse(text) as { jsonrpc?: unknown; id?: unknown; result?: unknown } | null;
    const result = body?.result;
    if (body?.jsonrpc !== "2.0" || body.id !== 1 || typeof result !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(result)) {
      throw new Error("hub lookup: bad result");
    }
    const abi = chainKey === SONIC_KEY ? routerAbi : factoryAbi;
    const hub = getAddress(decodeFunctionResult({ abi, functionName: "getDeployedAddress", data: result as Hex }));
    if (/^0x0{40}$/.test(hub)) throw new Error("hub lookup: zero address");
    return hub;
  } finally {
    clearTimeout(timer);
  }
}
