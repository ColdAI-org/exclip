/** The embedded wallet's flows (docs/embedded-wallet.md). Everything here runs on the wallet origin; the UI calls it,
 * the ExClip page never does. Dependencies are injected so the whole lifecycle runs in tests with MemoryStorage, a fake
 * authenticator and a fake API.
 *
 * Invariants:
 *  - The vault is unlocked only inside one flow and locked in that flow's `finally` (lock() wipes the seed and every
 *    pending approval). PRF outputs are wiped there too, and no copy of one is made: the vault's backup functions get
 *    the original, which they only read, and CeremonyPrf's private copy is wiped by dispose().
 *  - Every unlock is a fresh user-verified passkey ceremony. Nothing is remembered between flows except ciphertext
 *    and public facts in IndexedDB.
 *  - Results contain public data only: addresses, signed transactions, hashes, booleans, counts.
 *
 * The vault password: ClipVault needs one for create/enroll/backup/reveal. It is derived from the PRF output of the
 * passkey that created (or restored) the wallet on this device (password.ts), and a copy is sealed under the seed
 * (vault sealAppData, PASSWORD_BOX_KEY) so any enrolled passkey can reach it once it has unlocked the vault. Holding
 * the seed already means holding everything, so the sealed copy gives nothing away. */
import { ClipVault, passkeyBackup, type Clock, type VaultStorage } from "@clip-wallet/vault";
import { formatUnits, getAddress } from "viem";
import type { ConnectResult, ManageResult, PublicAccounts, SignRequest, SignResult } from "./protocol.ts";
import { VAULT_ARGON2, argon2id, deriveVaultPassword } from "./password.ts";
import { equalBytes, fromB64u, toB64u, wipe } from "./bytes.ts";
import { attestStatus, defaultLocks, readStatus, updateStatus, type LockManagerLike, type WalletStatusRecord } from "./storage.ts";
import {
  CeremonyPrf, createPasskey, getAssertion, type Asserted, type AuthenticationJson, type Challenge, type RegistrationJson, type WebAuthnEnv,
} from "./webauthn.ts";
import { BRAND_NAME, UNBACKED_LIMIT_USD, rpIdFor } from "./config.ts";
import { ApiError, type WalletApi } from "./api.ts";
import { PolicyError, checkSignRequest, needsHubWallet, type Review } from "./sodax/policy.ts";
import { EVM_ACCOUNT_ID, approvalHash, assemble, signingDigest } from "./evm.ts";
import { evmChain } from "./sodax/chains.ts";
import { isUsdStable, priceVerdict, type PriceVerdict, type SwapFacts } from "./sodax/price.ts";

// Storage keys and key-derivation labels are part of the on-device format: changing one later orphans existing vaults
// or derives different keys.
export const ACCOUNTS_KEY = "exclip-wallet/accounts/v1";
export const PASSWORD_BOX_KEY = "exclip-wallet/password-box/v1";
/** Registrations whose upload failed, for "Retry server backup". Public data only. */
export const PENDING_KEY = "exclip-wallet/pending-registrations/v1";
const MAX_PENDING = 4;
const PENDING_LOCK = "exclip-wallet/pending-registrations";
const PASSWORD_NS = "exclip-vault-pw";
/** The status record's MAC key, sealed under the seed (storage.ts statusMac). */
export const STATUS_MAC_BOX_KEY = "exclip-wallet/status-mac-key/v1";
const STATUS_MAC_NS = "exclip-status-mac";
export const STATUS_RESET_MESSAGE = "This wallet's local records were changed outside the wallet, so the review you saw may have been wrong. Nothing was signed. Open the request again.";
/** Approvals live only for the signing step that follows them. */
export const APPROVAL_TTL_MS = 60_000;
/** Belt and braces: the vault locks itself after this much inactivity even if a flow forgot to. */
export const AUTO_LOCK_MS = 60_000;
const LOCAL_CEREMONY_TIMEOUT_MS = 3 * 60_000;
const NO_WALLET_MESSAGE = `There's no ${BRAND_NAME} wallet in this browser. Sign in first.`;

export type WalletErrorCode = "NO_WALLET" | "WALLET_EXISTS" | "WRONG_ACCOUNT" | "SERVICE" | "FAILED";
export class WalletError extends Error {
  constructor(readonly code: WalletErrorCode, message: string) {
    super(message);
    this.name = "WalletError";
  }
}

export type WalletDeps = {
  storage: VaultStorage;
  api: WalletApi;
  webauthn: WebAuthnEnv;
  feeReceivers: readonly string[];
  /** Time and the vault's auto-lock timers (vault systemClock in the browser; tests pass one without timers). */
  clock: Clock;
  /** Test hook: a cheaper Argon2id. Production uses password.ts argon2id with VAULT_ARGON2. */
  argon2?: { params: { memoryKiB: number; iterations: number; parallelism: number }; fn: typeof argon2id };
  /** The popup's own price reference for swaps (price.ts fetchSodaxQuote), or null when it has none. Absent: the
   * build-time band table only. */
  quote?: (facts: SwapFacts) => Promise<bigint | null>;
  /** The user's SODAX hub account for swaps from `chainKey`, read by the popup itself from Sonic (sodax/hub.ts
   * fetchHubWallet). Never from the server or the request. Throws when it can't answer. */
  hubWallet: (chainKey: string, evm: string) => Promise<string>;
  /** The single-writer lock for local records. Absent: navigator.locks (storage.ts defaultLocks). */
  locks?: LockManagerLike;
  /** The build switched tokenised stocks on (config.ts STOCKS), so the policy lists them. Absent: off. */
  stocks?: boolean;
};

export const PRICE_UNCHECKED_WARNING = "The wallet couldn't check this price against its own reference. Compare \"You receive (at least)\" with the quote you expected.";

/** The red warning for a minimum far below the popup's own reference. Built only from decoded numbers. */
export function priceWarning(facts: SwapFacts, verdict: Extract<PriceVerdict, { level: "low" }>): string {
  const out = (raw: bigint) => `${formatUnits(raw, facts.output.decimals)} ${facts.output.symbol}`;
  return verdict.source === "quote"
    ? `This price looks wrong. You'd receive at least ${out(facts.minOut)}, but SODAX quotes about ${out(verdict.reference)} right now: ${verdict.belowPct}% less. Someone may be trying to take the difference.`
    : `This price looks wrong. ${out(facts.minOut)} is far less than ${formatUnits(facts.gross, facts.input.decimals)} ${facts.input.symbol} is worth. Someone may be trying to take the difference.`;
}

/** Deposits the popup tolerates on a wallet that isn't backed up, in US dollars (config.ts: exclip.config.ts
 * wallet.unbackedLimitUsd at build time, 100 by default). Fixed in the build: the ExClip page can't raise it. A nudge,
 * not a control: nothing on chain stops a transfer to the address. */
export { UNBACKED_LIMIT_USD };

export const NOT_BACKED_UP_WARNING = `This wallet isn't backed up. Keep it under $${UNBACKED_LIMIT_USD} until you save the recovery phrase or add a second passkey.`;

export type ReceiveView = { address: string; backedUp: boolean; limitUsd: number; hideAddress: boolean };

/** What the create flow hands to the recovery step. */
export type Created = ConnectResult & { serverBackup: boolean; passkeySynced: boolean };

/** `priceAlarm`: the popup shows it full screen, in red, and needs an extra tap before the review.
 * `hubPin`: a hub account seen for the first time, pinned only once the user signed with it (sign). */
export type PreparedSign = { review: Review; request: SignRequest; priceAlarm?: string; hubPin?: { chainKey: string; address: string } };

export class EmbeddedWallet {
  /** The one vault instance this page uses (its seed lives only here, only between unlock and lock). */
  private readonly v: ClipVault;
  /** The status record's MAC key, from this page's first unlock until the popup closes. It opens and signs nothing; it
   * only lets this page's later writes (after create, reveal or sign) carry a MAC. */
  private statusKey: Uint8Array | null = null;

  constructor(private readonly deps: WalletDeps) {
    this.v = new ClipVault({
      storage: deps.storage,
      argon2: deps.argon2?.params ?? VAULT_ARGON2,
      argon2id: deps.argon2?.fn ?? argon2id,
      autoLockMs: AUTO_LOCK_MS,
      clock: deps.clock,
    });
  }

  private vault(): ClipVault {
    return this.v;
  }

  private rpId(): string {
    return rpIdFor(this.deps.webauthn.origin, this.deps.webauthn.dev);
  }

  async hasWallet(): Promise<boolean> {
    return (await this.vault().status()) !== "empty";
  }

  /** "empty" | "locked" | "unlocked". Between flows it is never "unlocked". */
  vaultStatus(): Promise<"empty" | "locked" | "unlocked"> {
    return this.v.status();
  }

  async status(): Promise<WalletStatusRecord> {
    return readStatus(this.deps.storage);
  }

  /** Public addresses saved at create/restore (non-secret; re-checked against the vault whenever it is unlocked). */
  async accounts(): Promise<PublicAccounts | null> {
    const raw = await this.deps.storage.get(ACCOUNTS_KEY);
    if (!raw) return null;
    try {
      const a = JSON.parse(raw) as PublicAccounts;
      return typeof a.evm === "string" && typeof a.solana === "string" && typeof a.sui === "string" && typeof a.stellar === "string" ? a : null;
    } catch {
      return null;
    }
  }

  async backedUp(): Promise<boolean> {
    return isBackedUp(await readStatus(this.deps.storage), (await this.vault().listPasskeys()).length);
  }

  /* ------------------------------------------------------------------ create */

  /** New wallet: one passkey (created with PRF), a fresh phrase, its encrypted backup uploaded with the registration. */
  async create(): Promise<Created> {
    const vault = this.vault();
    if ((await vault.status()) !== "empty") throw new WalletError("WALLET_EXISTS", "This browser already has a wallet. Sign in instead.");
    const challenge = await this.deps.api.challenge("register");
    const created = await createPasskey(this.deps.webauthn, challenge);
    const prf = new CeremonyPrf(created.credentialId, created.prfOutput);
    let backup: Uint8Array | undefined;
    try {
      const password = deriveVaultPassword(created.prfOutput, created.credentialId);
      await vault.create(password);
      await vault.enrollPasskey(password, prf);
      await this.sealPassword(vault, password);
      await this.attestStatus(vault);
      const accounts = await this.deriveAccounts(vault);
      await this.deps.storage.set(ACCOUNTS_KEY, JSON.stringify(accounts));
      await this.updateStatus(() => ({ passwordCredential: toB64u(created.credentialId) }));
      let serverBackup = false, passkeySynced = false;
      try {
        backup = await checkedBackup(vault, password, created.prfOutput);
        const r = await this.deps.api.register(created.response, toB64u(backup));
        serverBackup = true;
        passkeySynced = r.backedUp;
        await this.markBackedUp(created.credentialId);
      } catch {
        // The wallet exists and works on this device; the banner stays until the phrase is saved, a passkey is added,
        // or "Retry server backup" uploads it later.
        await this.addPending(created.response);
      }
      return { accounts, backedUp: await this.backedUp(), serverBackup, passkeySynced };
    } finally {
      await vault.lock();
      prf.dispose();
      wipe(created.prfOutput, backup);
    }
  }

  /** The user confirmed, at the recovery step, that their passkey is saved in a synced password manager. */
  async confirmSynced(): Promise<boolean> {
    await this.updateStatus(() => ({ syncConfirmed: true }));
    return this.backedUp();
  }

  /* ------------------------------------------------------------------ sign in / restore */

  /** This device: unlock with one of its passkeys. New device: discoverable passkey → fetch backup → restore. */
  async signIn(): Promise<ConnectResult> {
    const vault = this.vault();
    if ((await vault.status()) !== "empty") {
      const { accounts } = await this.withUnlocked(vault, async () => undefined);
      return { accounts, backedUp: await this.backedUp() };
    }
    const challenge = await this.deps.api.challenge("fetch");
    const asserted = await getAssertion(this.deps.webauthn, challenge);
    const prf = new CeremonyPrf(asserted.credentialId, asserted.prfOutput);
    const blobs: Uint8Array[] = [];
    try {
      const { backups } = await this.deps.api.fetchBackup(asserted.response);
      const password = deriveVaultPassword(asserted.prfOutput, asserted.credentialId);
      // Newest first, falling back to an older version when a newer one doesn't decrypt with this passkey (a bad
      // append can't strand the wallet). Only this passkey's PRF output opens any of them, so whichever opens first was
      // made by this wallet. None opens: the newest one's error (wrong passkey, damaged backup).
      let restored = false, firstError: unknown;
      for (const { backup } of backups) {
        const blob = fromB64u(backup);
        blobs.push(blob);
        try {
          await vault.restorePasskeyBackup(blob, asserted.prfOutput, password);
          restored = true;
          break;
        } catch (e) {
          if ((e as { code?: unknown } | null)?.code !== "vault/backup-mismatch") throw e;
          firstError ??= e;
        }
      }
      if (!restored) throw firstError;
      await vault.enrollPasskey(password, prf);
      await this.sealPassword(vault, password);
      await this.attestStatus(vault);
      const accounts = await this.deriveAccounts(vault);
      await this.deps.storage.set(ACCOUNTS_KEY, JSON.stringify(accounts));
      await this.updateStatus(() => ({ passwordCredential: toB64u(asserted.credentialId) }));
      await this.markBackedUp(asserted.credentialId);
      return { accounts, backedUp: await this.backedUp() };
    } finally {
      await vault.lock();
      prf.dispose();
      wipe(asserted.prfOutput, ...blobs);
    }
  }

  /* ------------------------------------------------------------------ signing */

  /** Checks a sign request and builds the review. No passkey yet; nothing is unlocked. */
  async prepareSign(request: SignRequest): Promise<PreparedSign> {
    const accounts = await this.accounts();
    if (!accounts) throw new WalletError("NO_WALLET", NO_WALLET_MESSAGE);
    const hub = needsHubWallet(request) && evmChain(request.chainKey) ? await this.hubWallet(request.chainKey, accounts.evm) : null;
    const status = await readStatus(this.deps.storage);
    const review = checkSignRequest(request, {
      accounts,
      hubWallet: hub?.address ?? null,
      feeReceivers: this.deps.feeReceivers,
      knownRecipients: status.recipients,
      nowSec: BigInt(Math.floor(this.deps.clock.now() / 1000)),
      walletOrigin: this.deps.webauthn.origin,
      stocks: this.deps.stocks === true,
    });
    // The minimum against the popup's own reference (a fresh SODAX quote, else the band table).
    let priceAlarm: string | undefined;
    if (review.swap) {
      const stablePair = isUsdStable(review.swap.input) && isUsdStable(review.swap.output); // the policy's floor covers it
      const quote = this.deps.quote && !stablePair ? await this.deps.quote(review.swap).catch(() => null) : null;
      const verdict = priceVerdict(review.swap, quote);
      if (verdict.level === "low") {
        priceAlarm = priceWarning(review.swap, verdict);
        review.warnings.unshift(priceAlarm);
      } else if (verdict.level === "unchecked") review.warnings.push(PRICE_UNCHECKED_WARNING);
    }
    // The unbacked limit is a nudge; repeat it on every signature until the wallet is backed up.
    if (!isBackedUp(status, (await this.vault().listPasskeys()).length)) review.warnings.push(NOT_BACKED_UP_WARNING);
    // A new hub account is pinned by sign, once the user signed a payload that agreed with it (a mismatch, or a review
    // the user walks away from, pins nothing). Pinning there also means the pin is written with the record's MAC.
    return {
      review, request,
      ...(priceAlarm ? { priceAlarm } : {}),
      ...(hub?.isNew ? { hubPin: { chainKey: request.chainKey, address: hub.address } } : {}),
    };
  }

  /** After the user approved the review: fresh passkey ceremony → unlock → approval → sign → lock → wipe. */
  async sign(prepared: PreparedSign): Promise<SignResult> {
    const { review } = prepared;
    const vault = this.vault();
    const digests = review.txs.map(signingDigest);
    let again: Uint8Array[] = [];
    const chainKey = prepared.request.chainKey;
    const needsHub = needsHubWallet(prepared.request);
    try {
      const { result: { signed, hashes, pin } } = await this.withUnlocked(vault, async (accounts, _asserted, statusReset) => {
        // The review was built from the status record (known recipients, pinned hubs, backed-up state). If that record
        // failed its MAC at this unlock, what the user saw may have been forged: refuse, the next review is clean.
        if (statusReset) throw new PolicyError("REFUSED", STATUS_RESET_MESSAGE, "status record failed its check");
        // The review was checked against the SAVED addresses. Check the request again against the ones the keys
        // derive, and sign only if that yields exactly the transactions the user reviewed.
        const status = await readStatus(this.deps.storage);
        // The pinned hub, or the one this review looked up for the first time (pinned below once signed).
        const pinned = status.hubWallets[chainKey];
        const pin = needsHub && !pinned && prepared.hubPin?.chainKey === chainKey ? prepared.hubPin.address : null;
        const recheck = checkSignRequest(prepared.request, {
          accounts,
          hubWallet: needsHub ? pinned ?? pin : null,
          feeReceivers: this.deps.feeReceivers,
          knownRecipients: status.recipients,
          nowSec: BigInt(Math.floor(this.deps.clock.now() / 1000)),
          walletOrigin: this.deps.webauthn.origin,
          stocks: this.deps.stocks === true,
        });
        again = recheck.txs.map(signingDigest);
        if (!sameBytes(again, digests)) throw new PolicyError("REFUSED", "This request changed after you reviewed it. Nothing was signed.", "re-check differs");
        const approvalId = toB64u(this.deps.webauthn.random(16));
        vault.registerApproval(approvalId, digests.map(approvalHash), APPROVAL_TTL_MS);
        const signed: `0x${string}`[] = [], hashes: `0x${string}`[] = [];
        for (let i = 0; i < review.txs.length; i++) {
          const sig = await vault.sign({ accountId: EVM_ACCOUNT_ID, scheme: "ecdsa-secp256k1", bytes: digests[i]!, approvalId });
          const out = await assemble(review.txs[i]!, digests[i]!, sig, accounts.evm);
          signed.push(out.raw);
          hashes.push(out.hash);
        }
        vault.revokeApproval(approvalId);
        return { signed, hashes, pin };
      });
      const recipient = review.recipient;
      if (recipient) await this.updateStatus((s) => ({ recipients: [recipient, ...s.recipients.filter((r) => r !== recipient)] }));
      // Another popup may have pinned one meanwhile: the first pin stands, and the next sign re-checks against it.
      if (pin) await this.updateStatus((s) => (s.hubWallets[chainKey] ? {} : { hubWallets: { ...s.hubWallets, [chainKey]: pin } }));
      return { signed, hashes };
    } finally {
      wipe(...digests, ...again);
    }
  }

  /* ------------------------------------------------------------------ recovery */

  /** Reveals the phrase after a fresh ceremony. The caller shows it, never copies it, and drops it when closed. */
  async revealPhrase(): Promise<string> {
    const vault = this.vault();
    const { result } = await this.withUnlocked(vault, async () => vault.revealPhrase(await this.password(vault)));
    return result;
  }

  /** The user showed they wrote the phrase down (word check passed). */
  async markPhraseSaved(): Promise<ManageResult> {
    await this.updateStatus(() => ({ phraseSaved: true }));
    return this.manageResult();
  }

  /** Adds a second passkey (e.g. another password manager or a security key) with its own server backup.
   * Two prompts: one to unlock with an existing passkey, one to create the new one.
   *
   * The second prompt is user-paced, so it runs with the vault locked. The unlock only fetches the password and the
   * passkeys to exclude; enrolling and the backup need the password alone (ClipVault re-derives its key from it), so a
   * slow user can't run into the auto-lock and the seed isn't in memory while the browser waits. */
  async addPasskey(): Promise<ManageResult> {
    const vault = this.vault();
    let created: Awaited<ReturnType<typeof createPasskey>> | undefined;
    let backup: Uint8Array | undefined;
    let prf: CeremonyPrf | undefined;
    try {
      const { result: password } = await this.withUnlocked(vault, async () => this.password(vault));
      const exclude = (await vault.listPasskeys()).map((p) => p.credentialId);
      const challenge = await this.deps.api.challenge("register");
      created = await createPasskey(this.deps.webauthn, challenge, exclude);
      prf = new CeremonyPrf(created.credentialId, created.prfOutput);
      await vault.enrollPasskey(password, prf);
      backup = await checkedBackup(vault, password, created.prfOutput);
      try {
        await this.deps.api.register(created!.response, toB64u(backup!));
      } catch (e) {
        // Enrolled here already: "Retry server backup" can upload it later.
        await this.addPending(created!.response);
        throw e;
      }
      await this.markBackedUp(created!.credentialId);
      return this.manageResult();
    } finally {
      await vault.lock();
      prf?.dispose();
      wipe(created?.prfOutput, backup);
    }
  }

  /** A passkey enrolled on this device whose server backup never arrived (its upload failed at create or add). */
  async serverBackupPending(): Promise<boolean> {
    return (await this.pendingRegistrations()).length > 0;
  }

  /** "Retry server backup": one prompt with the pending passkey, on a server "register" challenge. That ceremony
   * unlocks the vault (its PRF output), a backup is made under it and checked, and the original registration goes up
   * with the assertion as proof (a late registration, apps/server). The server already having it (409: the first
   * upload landed, its answer didn't) counts as done. */
  async retryServerBackup(): Promise<ManageResult> {
    const vault = this.vault();
    const [pending] = await this.pendingRegistrations();
    if (!pending) return this.manageResult();
    const id = fromB64u(pending.id);
    const challenge = await this.deps.api.challenge("register");
    let backup: Uint8Array | undefined;
    let proof: AuthenticationJson | undefined;
    try {
      await this.withUnlocked(vault, async (_accounts, asserted) => {
        backup = await checkedBackup(vault, await this.password(vault), asserted.prfOutput);
        proof = asserted.response;
      }, { challenge, only: id });
      try {
        await this.deps.api.register(pending, toB64u(backup!), proof!);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "CONFLICT")) throw e;
      }
      await this.markBackedUp(id);
      await this.updatePending((list) => list.filter((p) => p.id !== pending.id));
      return this.manageResult();
    } finally {
      wipe(backup);
    }
  }

  /* ------------------------------------------------------------------ receive */

  /** What the receive screen shows: the saved EVM address (checksummed), with no unlock. The saved copy is compared
   * with the keys at every unlock (withUnlocked) and on demand (verifyAddresses). `heldUsd` is the ExClip page's
   * estimate and only ever hides the address (not backed up and at or above the popup's own limit), never shows it. */
  async receive(heldUsd?: number): Promise<ReceiveView> {
    const accounts = await this.accounts();
    if (!accounts) throw new WalletError("NO_WALLET", NO_WALLET_MESSAGE);
    const backedUp = await this.backedUp();
    const overLimit = heldUsd !== undefined && heldUsd >= UNBACKED_LIMIT_USD;
    return { address: getAddress(accounts.evm), backedUp, limitUsd: UNBACKED_LIMIT_USD, hideAddress: !backedUp && overLimit };
  }

  /** A passkey ceremony that re-derives every address and refuses if a saved one differs. */
  async verifyAddresses(): Promise<PublicAccounts> {
    return (await this.withUnlocked(this.vault(), async () => undefined)).accounts;
  }

  async manageResult(): Promise<ManageResult> {
    return { backedUp: await this.backedUp(), passkeys: (await this.vault().listPasskeys()).length };
  }

  /* ------------------------------------------------------------------ internals */

  /** One user-verified ceremony with an enrolled passkey, then `fn` with the vault unlocked; always locks. The challenge
   * is local unless `opts.challenge` is a server one (the assertion then also goes to the server); `opts.only` limits
   * the ceremony to one enrolled passkey. */
  private async withUnlocked<T>(
    vault: ClipVault,
    fn: (accounts: PublicAccounts, asserted: Asserted, statusReset: boolean) => Promise<T>,
    opts: { challenge?: Challenge; only?: Uint8Array } = {},
  ): Promise<{ result: T; accounts: PublicAccounts }> {
    const passkeys = await vault.listPasskeys();
    if (!passkeys.length) throw new WalletError("NO_WALLET", NO_WALLET_MESSAGE);
    const saved = await this.accounts();
    if (!saved) throw new WalletError("NO_WALLET", NO_WALLET_MESSAGE);
    const only = opts.only;
    const allow = only ? passkeys.map((p) => p.credentialId).filter((c) => equalBytes(c, only)) : passkeys.map((p) => p.credentialId);
    if (!allow.length) throw new WalletError("FAILED", "That passkey isn't part of this wallet on this device.");
    // A local challenge: this ceremony is checked here (PRF must unwrap the vault), not by the server.
    const asserted: Asserted = await getAssertion(
      this.deps.webauthn,
      opts.challenge ?? { challenge: toB64u(this.deps.webauthn.random(32)), rpId: this.rpId(), timeoutMs: LOCAL_CEREMONY_TIMEOUT_MS },
      allow,
    );
    const prf = new CeremonyPrf(asserted.credentialId, asserted.prfOutput);
    try {
      if (only && !equalBytes(asserted.credentialId, only)) throw new WalletError("FAILED", "A different passkey answered. Try again with the one asked for.");
      await vault.unlockWithPasskey(prf, asserted.credentialId);
      const accounts = await this.deriveAccounts(vault);
      if (!sameAccounts(accounts, saved)) throw new WalletError("WRONG_ACCOUNT", "This wallet's saved addresses don't match its keys.");
      const statusReset = await this.attestStatus(vault);
      return { result: await fn(accounts, asserted, statusReset), accounts };
    } finally {
      await vault.lock();
      prf.dispose();
      wipe(asserted.prfOutput);
    }
  }

  private async deriveAccounts(vault: ClipVault): Promise<PublicAccounts> {
    const list = await vault.listAccounts(["evm", "solana", "sui", "stellar"]);
    const first = (f: string) => list.find((a) => a.family === f && a.index === 0)?.address;
    const evm = first("evm"), solana = first("solana"), sui = first("sui"), stellar = first("stellar");
    if (!evm || !solana || !sui || !stellar) throw new WalletError("FAILED", "The wallet couldn't derive its addresses.");
    return { evm, solana, sui, stellar };
  }

  private async sealPassword(vault: ClipVault, password: string): Promise<void> {
    await this.deps.storage.set(PASSWORD_BOX_KEY, JSON.stringify(await vault.sealAppData(PASSWORD_NS, password)));
  }

  /** Unlocked vault only. */
  private async password(vault: ClipVault): Promise<string> {
    const raw = await this.deps.storage.get(PASSWORD_BOX_KEY);
    if (!raw) throw new WalletError("FAILED", "This wallet's local data is incomplete. Sign in again on a new device, or use your recovery phrase.");
    return vault.openAppData(PASSWORD_NS, JSON.parse(raw) as { nonce: string; ct: string });
  }

  /** Registrations (public: credential id, public key, no secret) whose upload failed, kept for "Retry server backup". */
  private async pendingRegistrations(): Promise<RegistrationJson[]> {
    try {
      const list = JSON.parse((await this.deps.storage.get(PENDING_KEY)) ?? "[]") as unknown;
      return Array.isArray(list) ? list.filter((r): r is RegistrationJson => isRegistrationJson(r)).slice(0, MAX_PENDING) : [];
    } catch {
      return [];
    }
  }

  /** Read-modify-write of the pending list under its own lock. */
  private async updatePending(change: (list: RegistrationJson[]) => RegistrationJson[]): Promise<void> {
    await (this.deps.locks ?? defaultLocks()).request(PENDING_LOCK, async () => {
      const list = change(await this.pendingRegistrations()).slice(0, MAX_PENDING);
      if (list.length) await this.deps.storage.set(PENDING_KEY, JSON.stringify(list));
      else await this.deps.storage.remove(PENDING_KEY);
    });
  }

  private async addPending(registration: RegistrationJson): Promise<void> {
    await this.updatePending((list) => (list.some((r) => r.id === registration.id) ? list : [...list, registration]));
  }

  /** Every status write carries the record's MAC, so it needs the key from an unlock earlier in this page (create,
   * sign-in, reveal, sign and add-passkey all unlock before they write). */
  private updateStatus(change: (current: WalletStatusRecord) => Partial<Omit<WalletStatusRecord, "v">>): Promise<WalletStatusRecord> {
    if (!this.statusKey) return Promise.reject(new WalletError("FAILED", "Unlock the wallet with your passkey first."));
    return updateStatus(this.deps.storage, change, this.deps.locks, this.statusKey);
  }

  /** At every unlock (vault unlocked): opens the status record's MAC key, or makes and seals one the first time (or
   * when its box is missing or doesn't open), keeps it for this page, and checks the record. True when the record
   * failed the check and was reset to the safe defaults. */
  private async attestStatus(vault: ClipVault): Promise<boolean> {
    const { key, reset } = await attestStatus(this.deps.storage, async () => {
      const raw = await this.deps.storage.get(STATUS_MAC_BOX_KEY);
      if (raw) {
        try {
          const k = fromB64u(await vault.openAppData(STATUS_MAC_NS, JSON.parse(raw) as { nonce: string; ct: string }));
          if (k.length === 32) return k;
        } catch {
          // Unreadable or forged: a new key, and the record it guarded is reset.
        }
      }
      const k = this.deps.webauthn.random(32);
      await this.deps.storage.set(STATUS_MAC_BOX_KEY, JSON.stringify(await vault.sealAppData(STATUS_MAC_NS, toB64u(k))));
      return k;
    }, this.deps.locks);
    if (this.statusKey && this.statusKey !== key) wipe(this.statusKey);
    this.statusKey = key;
    return reset;
  }

  private async markBackedUp(credentialId: Uint8Array): Promise<void> {
    const id = toB64u(credentialId);
    await this.updateStatus((s) => (s.backedUpCredentials.includes(id) ? {} : { backedUpCredentials: [...s.backedUpCredentials, id] }));
  }

  /** The popup's own lookup (deps.hubWallet: the SODAX factory over the pinned Sonic RPC), pinned per source network
   * on first use (by prepareSign, after the policy accepted it); a later answer that differs is refused. The first
   * answer must also match the swap payload the ExClip page built (policy.ts), so a lying page alone, or a lying RPC
   * alone, can't redirect a deposit. */
  private async hubWallet(chainKey: string, evm: string): Promise<{ address: string; isNew: boolean }> {
    const pinned = (await readStatus(this.deps.storage)).hubWallets[chainKey];
    let looked: string;
    try {
      looked = (await this.deps.hubWallet(chainKey, evm)).toLowerCase();
    } catch {
      if (pinned) return { address: pinned, isNew: false };
      throw new WalletError("SERVICE", "The network couldn't be reached. Try again.");
    }
    if (!/^0x[0-9a-f]{40}$/.test(looked)) throw new WalletError("SERVICE", "The network couldn't be reached. Try again.");
    if (pinned && pinned !== looked) throw new PolicyError("REFUSED", "This wallet's SODAX account on that network changed unexpectedly. Nothing was signed.", "hub wallet changed");
    return { address: looked, isNew: !pinned };
  }
}

/** A backup is uploaded only once it has decrypted, under the same PRF output, back to this vault's own phrase. A
 * backup that can't be read back is never sent (a server copy that restores nothing is worse than none). */
async function checkedBackup(vault: ClipVault, password: string, prfOutput: Uint8Array): Promise<Uint8Array> {
  const backup = await vault.createPasskeyBackup(password, prfOutput);
  let ok: boolean;
  try {
    ok = passkeyBackup.decrypt(backup, prfOutput) === (await vault.revealPhrase(password));
  } catch {
    ok = false;
  }
  if (ok) return backup;
  wipe(backup);
  throw new WalletError("FAILED", "The wallet couldn't make a backup it can read back. Nothing was uploaded.");
}

const B64U = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);

/** The shape webauthn.ts produces (and the server's registration check accepts), for records read back from storage. */
function isRegistrationJson(v: unknown): v is RegistrationJson {
  const r = v as Partial<RegistrationJson> | null;
  return !!r && typeof r === "object" && B64U(r.id, 1366) && r.id!.length >= 16 && r.rawId === r.id && r.type === "public-key"
    && !!r.response && B64U(r.response.clientDataJSON, 4096) && B64U(r.response.attestationObject, 8192)
    && (r.response.transports === undefined || (Array.isArray(r.response.transports) && r.response.transports.every((t) => typeof t === "string")))
    && !!r.clientExtensionResults && typeof r.clientExtensionResults === "object";
}

/** Every saved address is the one the keys derive (the policy treats all of them as "this wallet's own").
 * EVM and Sui are hex, compared case-insensitively; Solana (base58) and Stellar (base32) exactly. */
export function sameAccounts(derived: PublicAccounts, saved: PublicAccounts): boolean {
  return derived.evm.toLowerCase() === saved.evm.toLowerCase() && derived.sui.toLowerCase() === saved.sui.toLowerCase()
    && derived.solana === saved.solana && derived.stellar === saved.stellar;
}

function sameBytes(a: readonly Uint8Array[], b: readonly Uint8Array[]): boolean {
  return a.length === b.length && a.every((x, i) => x.length === b[i]!.length && x.every((v, j) => v === b[i]![j]));
}

/** Backed up = more than one way back in: the phrase was saved, or a synced passkey with a server backup the user
 * confirmed, or two passkeys each with a server backup. */
export function isBackedUp(status: WalletStatusRecord, passkeys: number): boolean {
  if (status.phraseSaved) return true;
  if (status.backedUpCredentials.length >= 1 && status.syncConfirmed) return true;
  return passkeys >= 2 && status.backedUpCredentials.length >= 2;
}
