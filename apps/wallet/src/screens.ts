/** The popup's screens, one per request type (docs/embedded-wallet.md). DOM only, 375px first.
 *
 * Every screen answers the request exactly once (Session.reply / Session.fail): on success, on Cancel, on an error
 * that ends the request, or when the window closes (main.ts). Retryable errors (a cancelled passkey prompt, a
 * network hiccup) stay on the screen so the user can try again.
 *
 * Names in the copy come from the build (config.ts): BRAND_NAME is the product the user came from, OPERATOR_NAME
 * whoever runs this deployment and stores the encrypted backups. */
import type { Session } from "./channel.ts";
import type { EmbeddedWallet, Created, PreparedSign } from "./wallet.ts";
import type { ConnectRequest, ManageRequest, ManageResult, SignRequest } from "./protocol.ts";
import { busy, h, show, type Child } from "./dom.ts";
import { toUiError } from "./errors.ts";
import { encodeQr } from "./qr.ts";
import { EVM_CHAINS } from "./sodax/chains.ts";
import { BRAND_NAME, OPERATOR_NAME, WALLET_ORIGIN } from "./config.ts";

export const SELF_CUSTODY = `Self-custody: only your passkey can unlock this wallet; ${OPERATOR_NAME} stores an encrypted backup it cannot read.`;
const CLOSE_AFTER_MS = 900;

export type Ui = {
  root: HTMLElement; session: Session; wallet: EmbeddedWallet; close(): void; random(n: number): Uint8Array;
  /** Sent instead of CANCELLED when the window closes unanswered (receive: closing is how the user finishes). */
  answerOnClose?: ManageResult;
};

/* ------------------------------------------------------------------ shared pieces */

const header = (title: string, sub?: string) =>
  h("header", { class: "head" }, h("h1", { tabindex: "-1" }, title), sub ? h("p", { class: "sub" }, sub) : null);
const p = (text: string, cls?: string) => h("p", cls ? { class: cls } : {}, text);
const status = () => h("p", { class: "status", "data-status": true, role: "status" });
const errorBox = () => h("p", { class: "error", role: "alert", "data-error": true, hidden: true });
const button = (label: string, onclick: () => void, kind: "primary" | "secondary" | "danger" = "primary", autofocus = false) =>
  h("button", { type: "button", class: `btn ${kind}`, onclick, "data-autofocus": autofocus }, label);
const actions = (...children: Child[]) => h("div", { class: "actions" }, ...children);
/** ExClip's repository, which every copy credits in its footer (NOTICE). */
const EXCLIP_REPO = "https://github.com/ColdAI-org/exclip";
/** "Powered by ExClip", linked to the repository; under ExClip's own name, "ExClip is open source". No setting hides it:
 * NOTICE makes it ExClip's attribution notice. */
export const credit = (name = BRAND_NAME) =>
  h("p", { class: "credit" }, h("a", { href: EXCLIP_REPO, target: "_blank", rel: "noopener" }, name === "ExClip" ? "ExClip is open source" : "Powered by ExClip"));
const footer = (ui: Ui) =>
  h("footer", { class: "foot" }, p(`Wallet: ${location.host} · Requested by ${new URL(ui.session.origin).host}`), credit());
/** The host the new passkey is saved for, as the build was configured (this page's own host when it wasn't). */
const passkeyHost = () => (WALLET_ORIGIN ? new URL(WALLET_ORIGIN).hostname : location.hostname);

function setError(ui: Ui, message: string): void {
  const el = ui.root.querySelector<HTMLElement>("[data-error]");
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

/** Runs one user-initiated step. Final errors answer the request and leave only Close; others stay retryable. */
async function step<T>(ui: Ui, label: string, fn: () => Promise<T>): Promise<T | undefined> {
  setError(ui, "");
  try {
    return await busy(ui.root, label, fn);
  } catch (e) {
    const err = toUiError(e);
    if (err.final) {
      ui.session.fail(err.code, err.message);
      done(ui, "Nothing was signed", err.message, false);
    } else {
      setError(ui, err.message);
    }
    return undefined;
  }
}

function cancel(ui: Ui, message = "You closed the wallet."): void {
  ui.session.fail("CANCELLED", message);
  ui.close();
}

function done(ui: Ui, title: string, text: string, autoClose: boolean): void {
  show(ui.root, header(title), p(text), actions(button("Close", () => ui.close(), "secondary", true)));
  if (autoClose) setTimeout(() => ui.close(), CLOSE_AFTER_MS);
}

const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

/* ------------------------------------------------------------------ connect */

export async function connect(ui: Ui, req: ConnectRequest): Promise<void> {
  const exists = await ui.wallet.hasWallet();
  if (req.intent === "create" && !exists) return createScreen(ui);
  return signInScreen(ui, req.intent === "create");
}

function createScreen(ui: Ui): void {
  show(ui.root,
    header(`Create your ${BRAND_NAME} wallet`, "A wallet that lives in your passkey"),
    p(SELF_CUSTODY, "note"),
    p(`Your device will ask you to save a passkey for ${passkeyHost()}. Save it to a password manager that syncs (iCloud Keychain, Google Password Manager, 1Password…) so you can get back in from another device.`),
    errorBox(),
    actions(
      button("Create wallet with a passkey", async () => {
        const created = await step(ui, "Waiting for your passkey…", () => ui.wallet.create());
        if (created) recoveryScreen(ui, created);
      }, "primary", true),
      button("Cancel", () => cancel(ui), "secondary"),
    ),
    status(),
    footer(ui),
  );
}

function signInScreen(ui: Ui, alreadyExists: boolean): void {
  show(ui.root,
    header("Sign in to your wallet", alreadyExists ? "This browser already has a wallet" : undefined),
    p(`Use the passkey you saved when you created your ${BRAND_NAME} wallet. On a new device, pick it from your password manager or scan the QR code with your phone.`),
    p(SELF_CUSTODY, "note"),
    errorBox(),
    actions(
      button("Sign in with passkey", async () => {
        const r = await step(ui, "Waiting for your passkey…", () => ui.wallet.signIn());
        if (!r) return;
        ui.session.reply(r);
        done(ui, "Signed in", `Wallet ${shortAddr(r.accounts.evm)} is connected to ${BRAND_NAME}.`, true);
      }, "primary", true),
      button("Cancel", () => cancel(ui), "secondary"),
    ),
    status(),
    footer(ui),
  );
}

/** "Never lose funds": straight after creating, before the ExClip page gets the addresses. */
function recoveryScreen(ui: Ui, created: Created): void {
  const finish = async () => {
    const backedUp = await ui.wallet.backedUp();
    ui.session.reply({ accounts: created.accounts, backedUp });
    done(ui, "Wallet ready", backedUp ? "Your wallet is backed up." : `${BRAND_NAME} will remind you to back up this wallet. Deposits are limited until you do.`, true);
  };
  const warnings: Child[] = [];
  if (!created.serverBackup) warnings.push(p(`The encrypted backup couldn't be saved to ${OPERATOR_NAME}. Save your recovery phrase now, or you could lose this wallet with this device.`, "warning"));
  if (!created.passkeySynced) warnings.push(p("Your passkey is stored only on this device. Save your recovery phrase or add a second passkey.", "warning"));
  show(ui.root,
    header("Make sure you can get back in", `Wallet ${shortAddr(created.accounts.evm)}`),
    p(`If you lose this device, your passkey and ${OPERATOR_NAME}'s encrypted backup are how you get your wallet back. Nobody, ${OPERATOR_NAME} included, can recover it for you.`),
    ...warnings,
    errorBox(),
    actions(
      created.serverBackup && created.passkeySynced
        ? button("My passkey is saved in a synced password manager", async () => {
          const ok = await step(ui, "Saving…", () => ui.wallet.confirmSynced());
          if (ok !== undefined) await finish();
        }, "primary", true)
        : null,
      button("Save recovery phrase", () => phraseScreen(ui, { check: true, after: () => void finish(), back: () => recoveryScreen(ui, created) }),
        created.serverBackup && created.passkeySynced ? "secondary" : "primary"),
      button("Not now", () => void finish(), "secondary"),
    ),
    status(),
    footer(ui),
  );
}

/* ------------------------------------------------------------------ recovery phrase */

/** `after`: the phrase was shown (and checked, with `check`). `back`: the user left without it. */
type PhraseOptions = { check: boolean; after: () => void; back: () => void; intro?: Child[] };

/** Reveal after a fresh passkey ceremony. Never copied to the clipboard; hidden when the window loses visibility. */
function phraseScreen(ui: Ui, opts: PhraseOptions): void {
  show(ui.root,
    header("Save your recovery phrase", "12 words that restore this wallet anywhere"),
    ...(opts.intro ?? []),
    h("ul", { class: "rules" },
      h("li", {}, "Anyone with these words can take everything in this wallet."),
      h("li", {}, "Write them on paper. No screenshots, no notes apps, no chat."),
      h("li", {}, `${OPERATOR_NAME} will never ask for them.`),
    ),
    errorBox(),
    actions(
      button("Show my recovery phrase", async () => {
        const phrase = await step(ui, "Waiting for your passkey…", () => ui.wallet.revealPhrase());
        if (phrase) wordsScreen(ui, phrase.split(" "), opts);
      }, "primary", true),
      button("Back", () => opts.back(), "secondary"),
    ),
    status(),
    footer(ui),
  );
}

function wordsScreen(ui: Ui, words: string[], opts: PhraseOptions): void {
  let shown = true;
  const leave = (next: () => void) => {
    shown = false;
    document.removeEventListener("visibilitychange", onHide);
    words.fill("");
    next();
  };
  const onHide = () => {
    if (document.visibilityState === "hidden" && shown) leave(() => phraseScreen(ui, { ...opts, intro: [p("The phrase was hidden when you left this window.", "warning")] }));
  };
  document.addEventListener("visibilitychange", onHide);
  show(ui.root,
    header("Your recovery phrase", "Write the words down in this order"),
    h("ol", { class: "words", "aria-label": "Recovery phrase" }, ...words.map((w) => h("li", {}, w))),
    actions(
      button(opts.check ? "I wrote it down" : "Done", () => {
        const copy = [...words];
        leave(() => (opts.check ? checkScreen(ui, copy, opts) : opts.after()));
      }, "primary", true),
    ),
    footer(ui),
  );
}

/** Asks for three random words before counting the phrase as saved. */
function checkScreen(ui: Ui, words: string[], opts: PhraseOptions): void {
  const picks: number[] = [];
  const rnd = ui.random(32);
  for (let i = 0; picks.length < 3 && i < rnd.length; i++) {
    const n = rnd[i]! % words.length;
    if (!picks.includes(n)) picks.push(n);
  }
  picks.sort((a, b) => a - b);
  const inputs = picks.map((n) => h("input", {
    type: "text", inputmode: "text", autocomplete: "off", autocapitalize: "none", autocorrect: "off", spellcheck: "false",
    "aria-label": `Word ${n + 1}`, id: `w${n}`,
  }));
  const wipeAll = () => {
    words.fill("");
    for (const i of inputs) i.value = "";
  };
  show(ui.root,
    header("Check your recovery phrase", "Type these words from your paper copy"),
    h("div", { class: "check" }, ...picks.map((n, i) => h("label", { for: `w${n}` }, `Word ${n + 1}`, inputs[i]!))),
    errorBox(),
    actions(
      button("Confirm", async () => {
        const ok = picks.every((n, i) => inputs[i]!.value.trim().toLowerCase() === words[n]);
        if (!ok) return setError(ui, "Those words don't match. Check your paper copy, or show the phrase again.");
        wipeAll();
        const r = await step(ui, "Saving…", () => ui.wallet.markPhraseSaved());
        if (r) opts.after();
      }, "primary"),
      button("Show the phrase again", () => {
        wipeAll();
        phraseScreen(ui, opts);
      }, "secondary"),
    ),
    status(),
    footer(ui),
  );
  inputs[0]?.focus();
}

/* ------------------------------------------------------------------ sign */

export async function sign(ui: Ui, req: SignRequest): Promise<void> {
  let prepared: PreparedSign;
  try {
    prepared = await busy(ui.root, "Checking the request…", () => ui.wallet.prepareSign(req));
  } catch (e) {
    const err = toUiError(e);
    ui.session.fail(err.code, err.message);
    return done(ui, "Nothing was signed", err.message, false);
  }
  if (prepared.priceAlarm) return priceAlarmScreen(ui, prepared, prepared.priceAlarm);
  reviewScreen(ui, prepared);
}

/** A minimum far below the popup's own reference. Red, full screen, Reject focused; the review (with the same warning
 * on top) is one extra, deliberate tap away. */
function priceAlarmScreen(ui: Ui, prepared: PreparedSign, text: string): void {
  show(ui.root,
    h("section", { class: "alarm", role: "alertdialog", "aria-labelledby": "alarm-title", "aria-describedby": "alarm-text" },
      h("h1", { id: "alarm-title", tabindex: "-1" }, "Stop: this price looks wrong"),
      h("p", { id: "alarm-text" }, text),
      p(`Reject this swap and get a new quote in ${BRAND_NAME}. ${OPERATOR_NAME} will never ask you to accept a worse price.`),
      actions(
        button("Reject (recommended)", () => cancel(ui, "You rejected the request. Nothing was signed."), "primary", true),
        button("I understand the risk, show the review", () => reviewScreen(ui, prepared), "danger"),
      ),
    ),
  );
}

function reviewScreen(ui: Ui, prepared: PreparedSign): void {
  const { review } = prepared;
  const steps = review.txs.length > 1
    ? h("div", { class: "txs" }, p(`${review.txs.length} transactions, one approval:`), h("ol", {}, ...review.txs.map((t) => h("li", {}, t.label))))
    : null;
  show(ui.root,
    header(review.title, review.chain.name),
    review.warnings.length ? h("div", { class: "warnings", role: "alert" }, ...review.warnings.map((w) => p(w, "warning"))) : null,
    h("dl", { class: "review" }, ...review.lines.flatMap((l) => [h("dt", {}, l.label), h("dd", l.mono ? { class: "mono" } : {}, l.value)])),
    steps,
    p(`Checked and signed by the wallet at ${location.host}. ${BRAND_NAME} sends the signed transaction${review.txs.length > 1 ? "s" : ""}.`, "note"),
    errorBox(),
    actions(
      button("Approve with passkey", async () => {
        const r = await step(ui, "Waiting for your passkey…", () => ui.wallet.sign(prepared));
        if (!r) return;
        ui.session.reply(r);
        done(ui, "Signed", `${BRAND_NAME} is sending it now.`, true);
      }, "primary"),
      button("Reject", () => cancel(ui, "You rejected the request. Nothing was signed."), "danger", true),
    ),
    status(),
    footer(ui),
  );
}

/* ------------------------------------------------------------------ receive */

const SVG_NS = "http://www.w3.org/2000/svg";
const EVM_NETWORK_NAMES = Object.values(EVM_CHAINS).map((c) => c.name).join(", ");

/** The QR code as an SVG drawn here (one path, dark on white in both colour schemes, 4-module quiet zone). */
export function qrSvg(text: string): SVGSVGElement {
  const q = encodeQr(text);
  const quiet = 4, n = q.size + quiet * 2;
  let d = "";
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.dark(x, y)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
  svg.setAttribute("class", "qr");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code of the address below");
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("width", String(n));
  bg.setAttribute("height", String(n));
  bg.setAttribute("fill", "#ffffff");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000000");
  svg.append(bg, path);
  return svg;
}

/** "0x" then groups of four, so the address can be compared group by group. Shown as spans spaced by CSS: a copy of
 * the text has no spaces (the popup can't write the clipboard, so users select and copy). */
export const addressGroups = (a: string): string[] => [a.slice(0, 2), ...a.slice(2).match(/.{1,4}/g)!];

/**
 * Receive: the deposit address and its QR code come from the wallet window, never from the page.
 * Until the wallet is backed up the popup states its own limit every time, and hides the address when ExClip says the
 * wallet already holds that much (ExClip can only make this stricter; the popup has no balance source of its own).
 * The answer to ExClip is sent when the window closes, so a backup made here reaches ExClip too.
 */
async function receiveScreen(ui: Ui, heldUsd: number | undefined): Promise<void> {
  const view = await busy(ui.root, "Loading your address…", () => ui.wallet.receive(heldUsd));
  const retry = await retryBackupButton(ui, () => void receiveScreen(ui, heldUsd));
  ui.answerOnClose = await ui.wallet.manageResult();
  const finish = async () => {
    const r = await ui.wallet.manageResult();
    ui.session.reply(r);
    ui.close();
  };
  const backUp = () => phraseScreen(ui, { check: true, after: () => void receiveScreen(ui, heldUsd), back: () => void receiveScreen(ui, heldUsd) });
  const banner = view.backedUp ? null : view.hideAddress
    ? p(`This wallet already holds about $${heldUsd} and isn't backed up. Back it up before you deposit more: without a backup, losing this device's passkey means losing the funds.`, "warning")
    : p(`This wallet isn't backed up. Keep it under $${view.limitUsd} in total until you back it up: without a backup, losing this device's passkey means losing the funds.`, "warning");
  const verified = h("p", { class: "note", role: "status" });
  show(ui.root,
    header("Receive", `Your ${BRAND_NAME} wallet address`),
    banner,
    view.hideAddress ? null : qrSvg(view.address),
    view.hideAddress ? null : h("p", { class: "address mono", "aria-label": `Your address: ${view.address}` }, ...addressGroups(view.address).map((g) => h("span", {}, g))),
    view.hideAddress ? null : p(`This address works on these networks only: ${EVM_NETWORK_NAMES}. Don't send Bitcoin, Solana or other networks' assets here.`, "note"),
    view.hideAddress ? null : p(`Trust the address in this window. If ${BRAND_NAME} shows a different one, don't use it.`, "note"),
    verified,
    errorBox(),
    actions(
      retry,
      view.backedUp ? null : button("Save recovery phrase", backUp, view.hideAddress ? "primary" : "secondary", view.hideAddress),
      view.hideAddress ? null : button("Check the address with my passkey", async () => {
        const accounts = await step(ui, "Waiting for your passkey…", () => ui.wallet.verifyAddresses());
        if (accounts) verified.textContent = "Checked: this address comes from your wallet's keys.";
      }, "secondary"),
      button("Close", () => void finish(), view.hideAddress ? "secondary" : "primary", !view.hideAddress),
    ),
    status(),
    footer(ui),
  );
}

/* ------------------------------------------------------------------ manage */

/** "Retry server backup", shown only while a passkey enrolled here has no server backup (its upload failed at create
 * or add). The popup's own button: ExClip can't hide it. */
async function retryBackupButton(ui: Ui, after: () => void): Promise<HTMLElement | null> {
  if (!(await ui.wallet.serverBackupPending())) return null;
  return button("Retry server backup", async () => {
    const r = await step(ui, "Waiting for your passkey…", () => ui.wallet.retryServerBackup());
    if (r) after();
  }, "secondary");
}

export async function manage(ui: Ui, req: ManageRequest): Promise<void> {
  if (!(await ui.wallet.hasWallet())) {
    ui.session.fail("NO_WALLET", `There's no ${BRAND_NAME} wallet in this browser. Sign in first.`);
    return done(ui, "No wallet here", `Sign in to your ${BRAND_NAME} wallet in this browser first.`, false);
  }
  const finish = async () => {
    const r = await ui.wallet.manageResult();
    ui.session.reply(r);
    done(ui, r.backedUp ? "Backed up" : "Done", r.backedUp ? "Your wallet is backed up." : "Your wallet isn't backed up yet.", true);
  };
  if (req.action === "receive") return receiveScreen(ui, req.heldUsd);
  if (req.action === "save-phrase") return phraseScreen(ui, { check: true, after: () => void finish(), back: () => cancel(ui) });
  if (req.action === "move-to-clip") {
    return phraseScreen(ui, {
      check: false,
      after: () => void finish(),
      back: () => cancel(ui),
      intro: [
        p("To move this wallet to the Clip Wallet extension: install Clip Wallet, choose “Import a recovery phrase”, and type the 12 words shown next. The same addresses appear there."),
        p(`Your ${BRAND_NAME} wallet keeps working too. Both hold the same keys.`, "note"),
      ],
    });
  }
  if (req.action !== "add-passkey") {
    ui.session.fail("BAD_REQUEST", "The wallet doesn't know that request.");
    return done(ui, "Nothing to do", "The wallet doesn't know that request.", false);
  }
  return addPasskeyScreen(ui);
}

async function addPasskeyScreen(ui: Ui): Promise<void> {
  const retry = await retryBackupButton(ui, () => void addPasskeyScreen(ui));
  show(ui.root,
    header("Add another passkey", "A second way into this wallet"),
    retry ? p(`A passkey on this device has no encrypted backup at ${OPERATOR_NAME} yet: its upload failed. Retry it, or add another passkey.`, "warning") : null,
    p("Use another password manager or a security key. Each passkey gets its own encrypted backup, so either one can restore the wallet on a new device."),
    p("You'll confirm with your current passkey first, then create the new one."),
    errorBox(),
    actions(
      retry,
      button("Add a passkey", async () => {
        const r = await step(ui, "Waiting for your passkeys…", () => ui.wallet.addPasskey());
        if (!r) return;
        ui.session.reply(r);
        done(ui, "Passkey added", `This wallet now has ${r.passkeys} passkeys.`, true);
      }, "primary", true),
      button("Cancel", () => cancel(ui), "secondary"),
    ),
    status(),
    footer(ui),
  );
}
