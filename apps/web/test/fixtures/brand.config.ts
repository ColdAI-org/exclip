/** A deployment's exclip.config.ts for build-config.test.ts: a brand name and logo with characters that HTML and
 * String.replace treat specially, and production origins of its own. */
import type { ExclipConfigInput } from "@exclip/config";

export default {
  brand: { name: `Tom & Jerry's "$&" Swap`, logo: "https://cdn.example.com/brand/logo.svg?v=2&size=64" },
  origins: { app: "https://swap.example.org", wallet: "https://wallet.example.net" },
} satisfies ExclipConfigInput;
