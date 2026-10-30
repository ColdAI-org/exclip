/** Prints the response headers each origin must send, for a web server or CDN that serves the built apps instead of
 * apps/server (docs/self-hosting.md): `pnpm --filter @exclip/config run headers`. */
import { appSecurityHeaders, walletSecurityHeaders } from "../src/index.ts";

const origins = [
  ["App origin (origins.app): every response", appSecurityHeaders(true)],
  ["Wallet origin (origins.wallet): every response, API answers and errors included", walletSecurityHeaders(true)],
] as const;

for (const [title, headers] of origins) {
  console.log(`# ${title}`);
  for (const [name, value] of Object.entries(headers)) console.log(`${name}: ${value}`);
  console.log("");
}
