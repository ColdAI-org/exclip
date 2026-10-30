/** Response headers for ExClip's two origins. One definition, used by the Vite dev and preview servers and by
 * apps/server when it serves the built apps (EXCLIP_SERVE_STATIC). If you put ExClip behind another web server or a
 * CDN, send exactly these (docs/self-hosting.md). */

/**
 * The wallet origin. Its page holds the user's keys, so it runs only its own files and talks to three places: its
 * own backup API, SODAX's quote endpoint as one exact URL (the wallet's independent price reference) and Sonic's
 * public RPC (the wallet reads the user's SODAX hub account from the chain itself).
 *
 * COOP stays unsafe-none on purpose: the wallet is a popup opened by the app (another origin) and answers through
 * window.opener. Any other COOP value puts it in a new browsing context group, which nulls window.opener and breaks the
 * channel. The channel's safety comes from the message checks instead (exact targetOrigin, an event.origin allowlist,
 * event.source === window.opener); framing is ruled out by frame-ancestors 'none' and X-Frame-Options.
 */
export const WALLET_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://api.sodax.com/v1/intent/quote https://rpc.soniclabs.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
].join("; ");

export const WALLET_PERMISSIONS_POLICY = [
  "publickey-credentials-get=(self)",
  "publickey-credentials-create=(self)",
  ...["accelerometer", "autoplay", "bluetooth", "camera", "clipboard-read", "clipboard-write", "display-capture",
    "encrypted-media", "fullscreen", "geolocation", "gyroscope", "hid", "identity-credentials-get", "idle-detection",
    "local-fonts", "magnetometer", "microphone", "midi", "otp-credentials", "payment", "picture-in-picture",
    "screen-wake-lock", "serial", "storage-access", "usb", "window-management", "xr-spatial-tracking"].map((f) => `${f}=()`),
].join(", ");

const HSTS = "max-age=63072000; includeSubDomains";

/** Every response from the wallet origin. `secure`: served over https (adds HSTS). */
export function walletSecurityHeaders(secure: boolean): Record<string, string> {
  return {
    "content-security-policy": WALLET_CSP,
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    "cross-origin-opener-policy": "unsafe-none",
    "permissions-policy": WALLET_PERMISSIONS_POLICY,
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    ...(secure ? { "strict-transport-security": HSTS } : {}),
  };
}

/**
 * The app origin. Scripts: same-origin files only, no inline script, no eval. Styles allow 'unsafe-inline' because
 * React renders style attributes (skeletons, charts); styles can't run code. connect-src, img-src and frame-src stay
 * open to https because the browser-wallet path (the SODAX wallet SDK, WalletConnect) talks to the chain RPCs and
 * relays the user's wallet picks, and token logos are remote; none of those can inject script. Trusted Types are
 * report-only until you have checked a real browser session for violations.
 */
export function appCsp(secure: boolean): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss:",
    "frame-src https:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(secure ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** Every response from the app origin. COOP same-origin-allow-popups: pages that open the app lose their handle on
 * it, while the wallet popup the app opens (COOP unsafe-none) keeps window.opener for its answer. Never
 * "same-origin": that would cut the popup's opener and break the wallet channel. */
export function appSecurityHeaders(secure: boolean): Record<string, string> {
  return {
    "content-security-policy": appCsp(secure),
    "content-security-policy-report-only": "require-trusted-types-for 'script'",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cross-origin-opener-policy": "same-origin-allow-popups",
    "permissions-policy": ["camera", "microphone", "geolocation", "payment", "usb", "hid", "serial", "bluetooth", "midi",
      "publickey-credentials-get", "publickey-credentials-create", "display-capture"].map((f) => `${f}=()`).join(", "),
    "x-content-type-options": "nosniff",
    ...(secure ? { "strict-transport-security": HSTS } : {}),
  };
}
