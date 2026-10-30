/** The passkey wallet's review of a swap, for `pnpm run screenshots`: capture.mjs serves this module as the wallet's
 * page (see walletPage there). It runs the wallet's own screens.ts, policy.ts and styles.css on a sign request built
 * the way the SODAX SDK builds one (apps/wallet/test/sodax-fixtures.ts): 250 USDC for ETH on Base, the trade the
 * trade screenshot quotes. The wallet behind it is a stub whose prepareSign only runs the policy, as for a wallet that
 * is backed up and whose price check passed, and nothing can be signed. Never part of a build. */
import type { Session } from "../../apps/wallet/src/channel.ts";
import type { SignRequest } from "../../apps/wallet/src/protocol.ts";
import type { EmbeddedWallet, PreparedSign } from "../../apps/wallet/src/wallet.ts";
import { sign, type Ui } from "../../apps/wallet/src/screens.ts";
import { checkSignRequest } from "../../apps/wallet/src/sodax/policy.ts";
import { HUB, ctx, swapRequest } from "../../apps/wallet/test/sodax-fixtures.ts";
import account from "./fixtures/account.json";

const BASE = "0x2105.base";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ETH = "0x0000000000000000000000000000000000000000";
const own = { evm: account.evm, solana: account.solana, sui: account.sui };

const built = swapRequest({
  src: BASE,
  dst: BASE,
  input: USDC,
  output: ETH,
  amount: 250_000_000n,
  // The trade screenshot's quote (0.06456862 ETH) less 0.5 % slippage.
  min: 64_245_780_000_000_000n,
  approvals: [250_000_000n],
  own,
});
// The fixtures' hub wallet is 0x2222…2222; this account's own takes its place in the calldata (lower case, as ABI
// encoding writes it, so the encoding stays canonical).
const request: SignRequest = {
  ...built,
  txs: built.txs.map((tx) => ({ ...tx, data: tx.data.replaceAll(HUB.slice(2), account.hub.slice(2).toLowerCase()) })),
};
const policy = ctx({ accounts: own, hubWallet: account.hub, walletOrigin: location.origin });

const wallet = {
  prepareSign: async (req: SignRequest) => ({ review: checkSignRequest(req, policy), request: req }) as PreparedSign,
};
const root = document.getElementById("app")!;
const session: Session = {
  request,
  // The page that asked: capture.mjs puts the example app origin here.
  origin: root.dataset.opener!,
  reply: () => {},
  fail: () => {},
  answered: false,
};
const ui: Ui = {
  root,
  session,
  wallet: wallet as unknown as EmbeddedWallet,
  close: () => {},
  random: (n) => crypto.getRandomValues(new Uint8Array(n)),
};

void sign(ui, request);
