/**
 * The built index.html against the app's CSP (packages/config/src/headers.ts): scripts only from same-origin files, so
 * no inline script, no inline event handler and no javascript: URL. vite.config.ts runs this on every production
 * build, so a page that would break under the CSP fails the build instead of shipping. Node and browser safe: no
 * build-time globals.
 */

/** A <script> element without src, with its attributes and body. */
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
/** Data blocks never run, so the CSP allows them. */
const DATA_BLOCK = /\btype\s*=\s*["']?application\/(?:ld\+)?json["']?/i;
const EVENT_HANDLER = /<[^>]*\son[a-z]+\s*=/i;
const SCRIPT_URL = /<[^>]*=\s*["']?\s*javascript:/i;
/** The entry Vite writes: one same-origin module script with a hashed name. */
const ENTRY = /<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js"><\/script>/;

/** Returns `html` unchanged, or throws naming the first thing the CSP would block. */
export function strictPage(html: string): string {
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    if (!DATA_BLOCK.test(m[1] ?? "")) throw new Error("index.html has an inline <script>, which the CSP (script-src 'self') blocks");
  }
  if (EVENT_HANDLER.test(html)) throw new Error("index.html has an inline event handler (on…=), which the CSP blocks");
  if (SCRIPT_URL.test(html)) throw new Error("index.html has a javascript: URL, which the CSP blocks");
  if (!ENTRY.test(html)) throw new Error("index.html doesn't load its entry as a same-origin module script (/assets/index-….js)");
  return html;
}
