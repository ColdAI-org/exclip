/** The configuration `pnpm run screenshots` starts the dev servers with (capture.mjs points EXCLIP_CONFIG here). It
 * sets nothing, so the screenshots show ExClip's own name, logo and colours whatever the repository's exclip.config.ts
 * says. It isn't called exclip.config.ts because .gitignore keeps files of that name out of git. */
import type { ExclipConfigInput } from "@exclip/config";

export default {} satisfies ExclipConfigInput;
