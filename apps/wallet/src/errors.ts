/** Maps whatever a flow threw to a protocol error, and decides whether the popup's one request ends with it.
 * Messages are ours (never an exception's text from a dependency), so nothing internal leaks to ExClip. */
import type { ErrorCode } from "./protocol.ts";
import { WebAuthnError } from "./webauthn.ts";
import { WalletError } from "./wallet.ts";
import { PolicyError } from "./sodax/policy.ts";
import { ApiError, SERVICE_MESSAGES, type ServiceCode } from "./api.ts";

export type UiError = { code: ErrorCode; message: string; /** The request is over: answer it and offer only Close. */ final: boolean };

const GENERIC = "Something went wrong. Nothing was signed or sent.";
const FINAL: readonly ErrorCode[] = ["UNSUPPORTED_BROWSER", "NO_WALLET", "WALLET_EXISTS", "WRONG_ACCOUNT", "REFUSED", "UNSUPPORTED_NETWORK"];

export function toUiError(e: unknown): UiError {
  let code: ErrorCode = "FAILED";
  let message = GENERIC;
  if (e instanceof WebAuthnError || e instanceof WalletError || e instanceof PolicyError) {
    code = e.code;
    message = e.message;
  } else if (e instanceof ApiError) {
    // Text by code from our own table, never the error's message: a server can't put its own words on the screen.
    code = "SERVICE";
    message = Object.hasOwn(SERVICE_MESSAGES, e.code) ? SERVICE_MESSAGES[e.code as ServiceCode] : SERVICE_MESSAGES.ERROR;
  }
  return { code, message: message.slice(0, 300), final: FINAL.includes(code) };
}
