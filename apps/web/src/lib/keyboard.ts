/** Whether a keydown is Ctrl/⌘ plus one of `keys` (lower case; letters match either case). Keydown events
 * without a `key` (Chrome autofill sends them) never match. */
export function isModifierShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">, ...keys: string[]): boolean {
  if (typeof e.key !== "string" || !(e.metaKey || e.ctrlKey)) return false;
  return keys.includes(e.key.toLowerCase());
}
