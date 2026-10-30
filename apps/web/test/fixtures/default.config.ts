/** A deployment's exclip.config.ts for build-config.test.ts that keeps ExClip's own name and logo, with production
 * origins of its own. */
import type { ExclipConfigInput } from "@exclip/config";

export default {
  origins: { app: "https://swap.example.org", wallet: "https://wallet.example.net" },
} satisfies ExclipConfigInput;
