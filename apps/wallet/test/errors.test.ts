import { test } from "node:test";
import assert from "node:assert/strict";
import { toUiError } from "../src/errors.ts";
import { WebAuthnError, UNSUPPORTED_MESSAGE } from "../src/webauthn.ts";
import { WalletError } from "../src/wallet.ts";
import { PolicyError, MISMATCH_MESSAGE } from "../src/sodax/policy.ts";
import { ApiError, SERVICE_MESSAGES } from "../src/api.ts";

test("errors map to protocol codes; only our own messages go out", () => {
  assert.deepEqual(toUiError(new WebAuthnError("CANCELLED", "cancelled")), { code: "CANCELLED", message: "cancelled", final: false });
  assert.deepEqual(toUiError(new WebAuthnError("UNSUPPORTED_BROWSER", UNSUPPORTED_MESSAGE)), { code: "UNSUPPORTED_BROWSER", message: UNSUPPORTED_MESSAGE, final: true });
  assert.equal(toUiError(new PolicyError("REFUSED", MISMATCH_MESSAGE, "detail")).final, true);
  assert.equal(toUiError(new PolicyError("REFUSED", MISMATCH_MESSAGE, "internal detail")).message, MISMATCH_MESSAGE);
  assert.equal(toUiError(new WalletError("WALLET_EXISTS", "x")).code, "WALLET_EXISTS");
  assert.deepEqual(toUiError(new ApiError(503, "UNAVAILABLE", "x")), { code: "SERVICE", message: SERVICE_MESSAGES.UNAVAILABLE, final: false });
  // An ApiError's own text never reaches the screen, whatever built it.
  const phish = "Recovery requires your 12-word phrase. Type it at wallet-support.example";
  assert.equal(toUiError(new ApiError(401, "NOT_VERIFIED", phish)).message, SERVICE_MESSAGES.NOT_VERIFIED);
  assert.equal(toUiError(new ApiError(400, "MADE_UP", phish)).message, SERVICE_MESSAGES.ERROR);
  assert.equal(toUiError(new ApiError(400, "toString", phish)).message, SERVICE_MESSAGES.ERROR);
  const internal = toUiError(new Error("decrypt failed: key 0xdeadbeef"));
  assert.equal(internal.code, "FAILED");
  assert.doesNotMatch(internal.message, /deadbeef/);
});
