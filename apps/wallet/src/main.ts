/** Wallet popup entry (its own origin, exclip.config.ts origins.wallet). Opened by the ExClip page with window.open in a
 * click handler; serves one request, answers it, closes. Configuration is baked in at build time (config.ts); nothing
 * comes from the URL. */
import { systemClock } from "@clip-wallet/vault";
import { ChannelError, browserChannelEnv, openChannel, type Session } from "./channel.ts";
import { BRAND_NAME, DEV, FEE_RATE, FEE_RECEIVERS, FEE_SPLITS, PARENT_ORIGINS, STOCKS } from "./config.ts";
import { EmbeddedWallet } from "./wallet.ts";
import { IdbStorage } from "./storage.ts";
import { createApi } from "./api.ts";
import { browserEnv } from "./webauthn.ts";
import { h, show } from "./dom.ts";
import { connect, credit, manage, sign, type Ui } from "./screens.ts";
import { toUiError } from "./errors.ts";
import { fetchSodaxQuote } from "./sodax/price.ts";
import { fetchHubWallet } from "./sodax/hub.ts";

const root = document.getElementById("app")!;
// index.html carries a generic title; the brand is only known to the build.
document.title = `${BRAND_NAME} wallet`;

function standalone(message: string): void {
  show(root,
    h("header", { class: "head" }, h("h1", { tabindex: "-1" }, `${BRAND_NAME} wallet`)),
    h("p", {}, message),
    h("p", { class: "note" }, `This window only works when ${BRAND_NAME} opens it. You can close it.`),
    h("footer", { class: "foot" }, credit()),
  );
}

async function main(): Promise<void> {
  show(root, h("p", { class: "status", role: "status" }, `Connecting to ${BRAND_NAME}…`));
  let session: Session;
  try {
    session = await openChannel(browserChannelEnv(PARENT_ORIGINS));
  } catch (e) {
    return standalone(e instanceof ChannelError ? e.message : `Open the wallet from ${BRAND_NAME}.`);
  }
  const wallet = new EmbeddedWallet({
    storage: new IdbStorage(),
    api: createApi(),
    webauthn: { ...browserEnv(), dev: DEV },
    feeReceivers: FEE_RECEIVERS,
    feeSplits: FEE_SPLITS,
    feeRate: FEE_RATE,
    clock: systemClock,
    quote: (facts) => fetchSodaxQuote((url, init) => fetch(url, init), facts),
    hubWallet: (chainKey, evm) => fetchHubWallet((url, init) => fetch(url, init), chainKey, evm),
    stocks: STOCKS,
  });
  const ui: Ui = {
    root,
    session,
    wallet,
    close: () => window.close(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
  };
  // Closing the window is a cancel, except where a screen says closing is the normal end (receive). (If the page dies
  // before this fires, the ExClip page's own timeout and closed-window check end the request.)
  window.addEventListener("pagehide", () => {
    if (session.answered) return;
    if (ui.answerOnClose) session.reply(ui.answerOnClose);
    else session.fail("CANCELLED", "You closed the wallet.");
  });
  const req = session.request;
  try {
    if (req.type === "connect") await connect(ui, req);
    else if (req.type === "sign") await sign(ui, req);
    else await manage(ui, req);
  } catch (e) {
    const err = toUiError(e);
    session.fail(err.code, err.message);
    standalone(err.message);
  }
}

void main();
