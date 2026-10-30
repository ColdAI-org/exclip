import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, getAddress, maxUint256, type Hex } from "viem";
import { BROWSER_WALLET_MESSAGE, MAX_FEE_PER_GAS, MISMATCH_MESSAGE, PolicyError, STABLE_FLOOR_MESSAGE, checkSignRequest, lookAlike } from "../src/sodax/policy.ts";
import { SODAX_TOKENS } from "../src/sodax/tokens.ts";

const findTokenBySymbol = (chainKey: string, symbol: string) => SODAX_TOKENS[chainKey]!.find(([, s]) => s === symbol)![0];
import { parseRequest, type SignRequest } from "../src/protocol.ts";
import { OPERATOR_NAME } from "../src/config.ts";
import { EVM_CHAINS, INTENTS_CONTRACT, NATIVE_TOKEN } from "../src/sodax/chains.ts";
import { ERC20_ABI, NOW, OWN, approveTx, buildIntent, ctx, swapRequest, swapTx, tx, type SwapSpec } from "./sodax-fixtures.ts";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_SONIC = "0x29219dd400f2Bf60E5a23d13Be72B486D4038894";
const SOL_NATIVE = "11111111111111111111111111111111";

const base: SwapSpec = { src: "0x2105.base", dst: "ethereum", input: USDC_BASE, output: USDC_ETH, amount: 1_000_000n, min: 990_000n, approvals: [1_000_000n] };

function refused(fn: () => unknown, code: PolicyError["code"] = "REFUSED", detail?: RegExp) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof PolicyError, String(e));
    assert.equal(e.code, code);
    if (detail) assert.match(e.detail, detail);
    return true;
  });
}

const mutate = (req: SignRequest, f: (r: SignRequest) => void): SignRequest => {
  const copy = structuredClone(req);
  f(copy);
  return parseRequest(copy) as SignRequest; // still a well-formed message: only the policy can catch it
};

test("a spoke swap with an exact approval passes and the review shows the decoded trade", () => {
  const review = checkSignRequest(swapRequest(base), ctx());
  assert.equal(review.kind, "swap");
  assert.equal(review.txs.length, 2);
  assert.equal(review.txs[0]!.chainId, 8453);
  assert.equal(review.txs[1]!.nonce, review.txs[0]!.nonce + 1);
  const text = review.lines.map((l) => `${l.label}: ${l.value}`).join("\n");
  assert.match(text, /Network: Base/);
  assert.match(text, /You pay: 1 USDC/);
  assert.match(text, /You receive \(at least\): 0\.99 USDC on Ethereum/);
  assert.match(text, new RegExp(`Receiving address \\(yours\\): ${OWN.evm}`));
  assert.match(text, new RegExp(`Spender \\(exact amount\\): ${EVM_CHAINS["0x2105.base"]!.assetManager}`));
  assert.match(text, /Signing from: https:\/\/wallet\.test/);
});

test("native input on a spoke (no approval, value = amount) and on Hedera (value scaled to weibars)", () => {
  const eth = { src: "0x2105.base", dst: "ethereum", input: NATIVE_TOKEN, output: USDC_ETH, amount: 10n ** 16n, min: 1n };
  assert.equal(checkSignRequest(swapRequest(eth), ctx()).txs[0]!.value, 10n ** 16n);
  const hbar = { src: "hedera", dst: "ethereum", input: NATIVE_TOKEN, output: USDC_ETH, amount: 5n * 10n ** 8n, min: 1n };
  assert.equal(checkSignRequest(swapRequest(hbar), ctx()).txs[0]!.value, 5n * 10n ** 18n);
  // An approval in front of a native swap is refused.
  refused(() => checkSignRequest(swapRequest({ ...eth, approvals: [10n ** 16n] }), ctx()), "REFUSED", /approval/);
});

test("Sonic (hub) swap: createIntent straight to the intents contract, tokens as-is", () => {
  const s = { src: "sonic", dst: "0x2105.base", input: USDC_SONIC, output: USDC_BASE, amount: 2_000_000n, min: 1_980_000n, approvals: [0n, 2_000_000n] };
  const review = checkSignRequest(swapRequest(s), ctx());
  assert.equal(review.txs.length, 3, "reset to 0, exact approve, swap");
  assert.equal(review.txs[2]!.to, INTENTS_CONTRACT);
  assert.match(review.txs[0]!.label, /Reset/);
});

test("Solana and Sui destinations must be the wallet's own address", () => {
  const sol = { src: "0x2105.base", dst: "solana", input: USDC_BASE, output: SOL_NATIVE, amount: 1_000_000n, min: 1n, approvals: [1_000_000n] };
  assert.equal(checkSignRequest(swapRequest(sol), ctx()).kind, "swap");
  const someoneElse = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  refused(() => checkSignRequest(swapRequest({ ...sol, dstAddress: someoneElse }), ctx()), "REFUSED", /destination/);
});

test("USD stable ↔ USD stable: a minimum below 97% of the gross input is refused", () => {
  // Exactly 97% passes, with the largest fee and slippage ExClip allows (1% + 1%).
  assert.equal(checkSignRequest(swapRequest({ ...base, min: 970_000n }), ctx()).kind, "swap");
  assert.equal(checkSignRequest(swapRequest({ ...base, feeBps: 100n, min: 980_000n }), ctx()).swap!.net, 990_000n);
  for (const min of [969_999n, 500_000n, 1n]) {
    assert.throws(() => checkSignRequest(swapRequest({ ...base, min }), ctx()), (e: unknown) =>
      e instanceof PolicyError && e.code === "REFUSED" && e.message === STABLE_FLOOR_MESSAGE && /stable minimum/.test(e.detail));
  }
  // Different decimals compare exactly: 1 USDC (6) on Sonic → bnUSD (18) on Arbitrum.
  const BNUSD_ARB = findTokenBySymbol("0xa4b1.arbitrum", "bnUSD");
  const toBnUsd = { src: "sonic", dst: "0xa4b1.arbitrum", input: USDC_SONIC, output: BNUSD_ARB, amount: 1_000_000n, approvals: [1_000_000n] };
  assert.equal(checkSignRequest(swapRequest({ ...toBnUsd, min: 97n * 10n ** 16n }), ctx()).kind, "swap");
  refused(() => checkSignRequest(swapRequest({ ...toBnUsd, min: 97n * 10n ** 16n - 1n }), ctx()), "REFUSED", /stable minimum/);
  // Not a stable pair: no floor here (the popup's own quote and the band table handle it in wallet.ts).
  const sol = { src: "0x2105.base", dst: "solana", input: USDC_BASE, output: SOL_NATIVE, amount: 1_000_000n, min: 1n, approvals: [1_000_000n] };
  const review = checkSignRequest(swapRequest(sol), ctx());
  assert.deepEqual({ ...review.swap, input: review.swap!.input.symbol, output: review.swap!.output.symbol }, { input: "USDC", output: "SOL", gross: 1_000_000n, net: 1_000_000n, minOut: 1n });
});

test("a partner fee up to 1% to the allowlisted receiver passes; above the cap or to anyone else is refused", () => {
  assert.equal(checkSignRequest(swapRequest({ ...base, feeBps: 100n }), ctx()).kind, "swap");
  refused(() => checkSignRequest(swapRequest({ ...base, feeBps: 101n }), ctx()), "REFUSED", /cap/);
  refused(() => checkSignRequest(swapRequest({ ...base, feeBps: 50n, feeReceiver: "0x4444444444444444444444444444444444444444" }), ctx()), "REFUSED", /receiver/);
  refused(() => checkSignRequest(swapRequest({ ...base, feeBps: 50n }), ctx({ feeReceivers: [] })), "REFUSED", /receiver/);
});

test("with an empty fee allowlist (the default) a fee-free intent passes and shows only the network fee", () => {
  const empty = ctx({ feeReceivers: [] });
  const sonic = { src: "sonic", dst: "0x2105.base", input: USDC_SONIC, output: USDC_BASE, amount: 2_000_000n, min: 1_980_000n, approvals: [2_000_000n] };
  for (const spec of [base, sonic]) {
    const review = checkSignRequest(swapRequest(spec), empty);
    assert.equal(review.kind, "swap", spec.src);
    assert.equal(review.swap!.net, review.swap!.gross, "nothing is taken off the input");
    const text = review.lines.map((l) => `${l.label}: ${l.value}`).join("\n");
    assert.match(text, /^Fees: network up to /m);
    assert.doesNotMatch(text, new RegExp(`${OPERATOR_NAME} fee|Fee receiver`));
  }
  // Any fee at all needs a receiver on the allowlist, and the default allowlist has none.
  refused(() => checkSignRequest(swapRequest({ ...base, feeBps: 1n }), empty), "REFUSED", /receiver/);
});

test("approvals: unlimited, too large, wrong spender or wrong token are refused", () => {
  refused(() => checkSignRequest(swapRequest({ ...base, approvals: [maxUint256] }), ctx()), "REFUSED", /exactly/);
  refused(() => checkSignRequest(swapRequest({ ...base, approvals: [1_000_001n] }), ctx()), "REFUSED", /exactly/);
  refused(() => checkSignRequest(mutate(swapRequest(base), (r) => { r.txs[0] = approveTx(base, 1_000_000n, 7, "0x5555555555555555555555555555555555555555"); }), ctx()), "REFUSED", /spender/);
  refused(() => checkSignRequest(mutate(swapRequest(base), (r) => { r.txs[0]!.to = USDC_ETH; }), ctx()), "REFUSED", /approval target/);
  refused(() => checkSignRequest(swapRequest({ ...base, approvals: [5n, 1_000_000n] }), ctx()), "REFUSED", /exactly/);
});

test("every intent field must match the plan and this wallet", () => {
  const cases: [string, Partial<ReturnType<typeof buildIntent>>, RegExp][] = [
    ["creator", { creator: "0x6666666666666666666666666666666666666666" }, /creator/],
    ["min out", { minOutputAmount: 1n }, /minimum/],
    ["amount", { inputAmount: 999_999n }, /amount/],
    ["deadline", { deadline: NOW + 301n }, /deadline/],
    ["partial", { allowPartialFill: true }, /partial/],
    ["dst chain", { dstChain: 5n }, /networks/],
    ["dst address", { dstAddress: "0x7777777777777777777777777777777777777777" }, /destination/],
    ["src address", { srcAddress: "0x7777777777777777777777777777777777777777" }, /source/],
    ["solver", { solver: "0x8888888888888888888888888888888888888888" }, /solver/],
    ["output token", { outputToken: "0x9999999999999999999999999999999999999999" }, /output token/],
    ["delivery hook data", { data: "0x03aa" as Hex }, /plain fee/],
  ];
  for (const [name, patch, detail] of cases) {
    const intent = { ...buildIntent(base), ...patch };
    const req = swapRequest(base, intent);
    req.plan = swapRequest(base).plan; // the plan says what the user asked for
    refused(() => checkSignRequest(req, ctx()), "REFUSED", detail);
    assert.ok(name);
  }
});

test("deposit: wrong asset manager, hub account, amount, value or extra bytes are refused", () => {
  const good = swapRequest(base);
  refused(() => checkSignRequest(mutate(good, (r) => { r.txs[1]!.to = EVM_CHAINS.ethereum!.assetManager!; }), ctx()), "REFUSED", /swap target/);
  refused(() => checkSignRequest(good, ctx({ hubWallet: "0x6666666666666666666666666666666666666666" })), "REFUSED", /hub account/);
  refused(() => checkSignRequest(mutate(good, (r) => { r.txs[1]!.value = "1"; }), ctx()), "REFUSED", /value/);
  refused(() => checkSignRequest(mutate(good, (r) => { r.txs[1]!.data += "00"; }), ctx()), "REFUSED", /non-canonical|undecodable/);
  refused(() => checkSignRequest(mutate(good, (r) => { r.plan = { ...r.plan, inputAmount: "2000000" } as never; }), ctx()));
  refused(() => checkSignRequest(good, ctx({ hubWallet: null })), "REFUSED", /hub/);
});

test("chain must be allowlisted; the request must be for this wallet; nonces consecutive; fees sane", () => {
  refused(() => checkSignRequest(mutate(swapRequest(base), (r) => { r.chainKey = "solana"; }), ctx()), "UNSUPPORTED_NETWORK");
  assert.throws(() => checkSignRequest(mutate(swapRequest(base), (r) => { r.chainKey = "injective-1"; }), ctx()), { message: BROWSER_WALLET_MESSAGE });
  refused(() => checkSignRequest(mutate(swapRequest(base), (r) => { (r.plan as { dstChainKey: string }).dstChainKey = "stellar"; }), ctx()), "UNSUPPORTED_NETWORK");
  refused(() => checkSignRequest(mutate(swapRequest(base), (r) => { r.from = "0x6666666666666666666666666666666666666666"; }), ctx()), "WRONG_ACCOUNT");
  refused(() => checkSignRequest(mutate(swapRequest(base), (r) => { r.txs[1]!.nonce = "9"; }), ctx()), "REFUSED", /nonces/);
  refused(() => checkSignRequest(mutate(swapRequest(base), (r) => { r.txs[1]!.gas = "50000000"; }), ctx()), "REFUSED", /gas/);
  refused(() => checkSignRequest(mutate(swapRequest(base), (r) => { r.txs[1]!.fee = { type: "eip1559", maxFeePerGas: "1", maxPriorityFeePerGas: "2" }; }), ctx()), "REFUSED", /fee/);
  // A token SODAX doesn't list on that network.
  refused(() => checkSignRequest(mutate(swapRequest(base), (r) => { (r.plan as { inputToken: string }).inputToken = "0x1234567890123456789012345678901234567890"; }), ctx()), "REFUSED", /not listed/);
});

test("a swap transaction alone can't stand in for something else (e.g. the approve as the swap)", () => {
  refused(() => checkSignRequest(mutate(swapRequest(base), (r) => { r.txs = [r.txs[0]!]; }), ctx()), "REFUSED");
  refused(() => checkSignRequest(mutate(swapRequest(base), (r) => { r.txs = [r.txs[1]!, r.txs[0]!]; r.txs[0]!.nonce = "7"; r.txs[1]!.nonce = "8"; }), ctx()), "REFUSED");
});

/* ------------------------------------------------------------------ transfers */

const send = (to: string, token = USDC_BASE, amount = 5_000_000n): SignRequest => ({
  v: 1, kind: "exclip-wallet", id: "req_0123456789abcdef", type: "sign", chainKey: "0x2105.base", from: OWN.evm,
  plan: { kind: "transfer", token, amount: amount.toString(), to },
  txs: [token === NATIVE_TOKEN
    ? tx(to, "0x", amount)
    : tx(token, encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to as Hex, amount] }))],
});
const FRIEND = getAddress("0xabcdef0123456789abcdef0123456789abcdef01");

test("plain transfers: full checksum address, first-time and look-alike warnings", () => {
  const first = checkSignRequest(send(FRIEND), ctx());
  assert.equal(first.kind, "transfer");
  assert.ok(first.lines.some((l) => l.value === FRIEND && l.mono), "full checksummed address shown");
  assert.match(first.warnings.join(" "), /haven't sent to this address before/);
  assert.equal(first.recipient, FRIEND.toLowerCase());

  const known = checkSignRequest(send(FRIEND), ctx({ knownRecipients: [FRIEND.toLowerCase()] }));
  assert.deepEqual(known.warnings, []);

  const poison = "0xabcd000000000000000000000000000000ef01".padEnd(42, "0").slice(0, 38) + "ef01";
  assert.equal(poison.length, 42);
  const warned = checkSignRequest(send(poison), ctx({ knownRecipients: [FRIEND.toLowerCase()] }));
  assert.match(warned.warnings.join(" "), /look-alike/);
  assert.equal(lookAlike(poison, [FRIEND.toLowerCase()]), FRIEND.toLowerCase());
  assert.equal(lookAlike(FRIEND, [FRIEND.toLowerCase()]), null);

  assert.equal(checkSignRequest(send(FRIEND, NATIVE_TOKEN, 10n ** 15n), ctx()).txs[0]!.value, 10n ** 15n);

  // HBAR: the plan is in tinybars (8 decimals), the transaction value in weibars (×10^10). Unscaled is refused, because
  // it would send 10^10 times less than the review shows.
  const hbar = (value: bigint): SignRequest => ({
    ...send(FRIEND, NATIVE_TOKEN, 3n * 10n ** 8n), chainKey: "hedera",
    txs: [tx(FRIEND, "0x", value)],
  });
  const hbarReview = checkSignRequest(hbar(3n * 10n ** 18n), ctx());
  assert.ok(hbarReview.lines.some((l) => l.value === "3 HBAR"));
  refused(() => checkSignRequest(hbar(3n * 10n ** 8n), ctx()));

  // A one-character typo in a checksummed address is caught by the checksum.
  const typo = FRIEND.slice(0, 41) + (FRIEND[41] === "1" ? "2" : "1");
  const typoReq = send(FRIEND);
  (typoReq.plan as { to: string }).to = typo;
  assert.notEqual(getAddress(typo.toLowerCase()), typo, "the typo keeps the old (now wrong) checksum casing");
  assert.throws(() => checkSignRequest(typoReq, ctx()), /checksum/);
});

test("transfers: amount/recipient must match the plan; token and SODAX contracts are refused as recipients", () => {
  refused(() => checkSignRequest(mutate(send(FRIEND), (r) => { (r.plan as { amount: string }).amount = "1"; }), ctx()));
  refused(() => checkSignRequest(mutate(send(FRIEND), (r) => { (r.plan as { to: string }).to = "0x6666666666666666666666666666666666666666"; }), ctx()));
  for (const contract of [USDC_BASE, INTENTS_CONTRACT, EVM_CHAINS["0x2105.base"]!.assetManager!, NATIVE_TOKEN]) {
    assert.throws(() => checkSignRequest(send(contract), ctx()), /token or SODAX contract/);
  }
  // An approve dressed as a transfer.
  refused(() => checkSignRequest(mutate(send(FRIEND), (r) => {
    r.txs[0]!.data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [FRIEND as Hex, 5_000_000n] });
  }), ctx()));
});

const GWEI = 10n ** 9n;
const withFee = (req: SignRequest, perGas: bigint, legacy = false): SignRequest => mutate(req, (r) => {
  for (const t of r.txs) t.fee = legacy ? { type: "legacy", gasPrice: perGas.toString() } : { type: "eip1559", maxFeePerGas: perGas.toString(), maxPriorityFeePerGas: "1" };
});
const onChain = (req: SignRequest, chainKey: string, token: string): SignRequest => mutate(req, (r) => {
  r.chainKey = chainKey;
  (r.plan as { token: string }).token = token;
  r.txs[0]!.to = token;
});

test("the fee is capped per network, at most MAX_FEE_PER_GAS anywhere", () => {
  for (const c of Object.values(EVM_CHAINS)) assert.ok(c.maxFeePerGas > 0n && c.maxFeePerGas <= MAX_FEE_PER_GAS, c.key);
  assert.equal(EVM_CHAINS.ethereum!.maxFeePerGas, 500n * GWEI);
  for (const k of ["0x2105.base", "0xa4b1.arbitrum", "0xa.optimism"]) assert.equal(EVM_CHAINS[k]!.maxFeePerGas, 10n * GWEI, k);

  // Base (a rollup): 10 gwei signs, a wei more is refused, either fee type. The old global cap would have let 10,000 through.
  for (const legacy of [false, true]) {
    checkSignRequest(withFee(send(FRIEND), 10n * GWEI, legacy), ctx());
    refused(() => checkSignRequest(withFee(send(FRIEND), 10n * GWEI + 1n, legacy), ctx()), "REFUSED", /fee out of range/);
    refused(() => checkSignRequest(withFee(send(FRIEND), 10_000n * GWEI, legacy), ctx()), "REFUSED", /fee out of range/);
  }
  // Ethereum: 500 gwei.
  const eth = onChain(send(FRIEND), "ethereum", USDC_ETH);
  checkSignRequest(withFee(eth, 500n * GWEI), ctx());
  refused(() => checkSignRequest(withFee(eth, 501n * GWEI), ctx()), "REFUSED", /fee out of range/);
  // A swap's approval is held to the same cap as its swap.
  refused(() => checkSignRequest(mutate(swapRequest(base), (r) => { r.txs[0]!.fee = { type: "eip1559", maxFeePerGas: String(11n * GWEI), maxPriorityFeePerGas: "1" }; }), ctx()), "REFUSED", /fee/);
});

test("a warning when the network fee could be more than 5% of what moves", () => {
  const known = ctx({ knownRecipients: [FRIEND.toLowerCase()] });
  // Native coin: exact. 300,000 gas × 1 gwei = 0.0003 ETH.
  assert.deepEqual(checkSignRequest(send(FRIEND, NATIVE_TOKEN, 10n ** 16n), known).warnings, []); // 3%
  assert.deepEqual(checkSignRequest(send(FRIEND, NATIVE_TOKEN, 6n * 10n ** 15n), known).warnings, []); // exactly 5%
  const high = checkSignRequest(send(FRIEND, NATIVE_TOKEN, 10n ** 15n), known).warnings;
  assert.equal(high.length, 1);
  assert.match(high[0]!, /could be up to 30% of what you send/);
  assert.match(checkSignRequest(send(FRIEND, NATIVE_TOKEN, 10n ** 12n), known).warnings[0]!, /up to 30,000%/);

  // A token: the fee at ETH's lowest band price ($300) against USDC at its highest ($1.05). 5 USDC on Base at 1 gwei is
  // $0.09 at most: no warning. On Ethereum at 500 gwei the fee is 0.15 ETH, at least $45: warned.
  assert.deepEqual(checkSignRequest(send(FRIEND), known).warnings, []);
  const l1 = checkSignRequest(withFee(onChain(send(FRIEND), "ethereum", USDC_ETH), 500n * GWEI), known).warnings;
  assert.equal(l1.length, 1);
  assert.match(l1[0]!, /could be more than 5% of what you send/);
  // A coin without a band (POL): no warning; the fee line is the only signal, and the cap still holds.
  const usdcPolygon = findTokenBySymbol("0x89.polygon", "USDC");
  assert.deepEqual(checkSignRequest(withFee(onChain(send(FRIEND), "0x89.polygon", usdcPolygon), 10_000n * GWEI), known).warnings, []);

  // Swaps compare against what you pay (gross). Two transactions × 300,000 gas × 1 gwei = 0.0006 ETH, at least $0.18:
  // warned on 1 USDC, not on 100 USDC.
  assert.match(checkSignRequest(swapRequest(base), ctx()).warnings.join(" "), /more than 5% of what you pay/);
  const big = { ...base, amount: 100_000_000n, min: 99_000_000n, approvals: [100_000_000n] };
  assert.deepEqual(checkSignRequest(swapRequest(big), ctx()).warnings, []);
  assert.deepEqual(checkSignRequest(withFee(swapRequest(big), 10n * GWEI), ctx()).warnings, []); // ≥ $1.80 of $105: under 5%
  const nativeSwap = { src: "0x2105.base", dst: "ethereum", input: NATIVE_TOKEN, output: USDC_ETH, amount: 10n ** 15n, min: 1n };
  assert.match(checkSignRequest(swapRequest(nativeSwap), ctx()).warnings.join(" "), /up to 30% of what you pay/);
});

test("the review states the nonce, so a transaction held back for later shows it", () => {
  const line = (r: ReturnType<typeof checkSignRequest>) => r.lines.find((l) => l.label.startsWith("Transaction number"));
  assert.deepEqual(line(checkSignRequest(send(FRIEND), ctx())), { label: "Transaction number (nonce)", value: "7" });
  assert.deepEqual(line(checkSignRequest(mutate(send(FRIEND), (r) => { r.txs[0]!.nonce = "1234"; }), ctx())), { label: "Transaction number (nonce)", value: "1234" });
  assert.deepEqual(line(checkSignRequest(swapRequest(base), ctx())), { label: "Transaction numbers (nonces)", value: "7 to 8" });
  // Shown before "Signing from", the last line.
  const labels = checkSignRequest(swapRequest(base), ctx()).lines.map((l) => l.label);
  assert.equal(labels.indexOf("Transaction numbers (nonces)"), labels.length - 2);
});

test("anything that isn't a sign/connect/manage request never reaches the policy (no personal_sign, no typed data)", () => {
  for (const type of ["personal_sign", "eth_signTypedData_v4", "eth_sendTransaction", "eth_sign"]) {
    assert.throws(() => parseRequest({ v: 1, kind: "exclip-wallet", id: "req_0123456789abcdef", type, params: ["0x00"] }));
  }
  assert.equal(MISMATCH_MESSAGE.includes("Nothing was signed"), true);
  // A swap tx whose target is fine but whose data calls something else entirely.
  const other = swapTx(base);
  other.data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [FRIEND as Hex, 1n] });
  refused(() => checkSignRequest({ ...swapRequest(base), txs: [approveTx(base, 1_000_000n), { ...other, nonce: "8" }] }, ctx()));
});
