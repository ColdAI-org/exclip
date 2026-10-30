/** Tiny DOM builder. Text only ever goes in through textContent / text nodes: the page's CSP requires Trusted Types
 * for script sinks, and nothing here uses innerHTML, inline styles or inline handlers. */

export type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | undefined | ((e: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") {
      if (!k.startsWith("on")) throw new Error(`not an event: ${k}`);
      el.addEventListener(k.slice(2), v);
    } else if (k === "style" || k.startsWith("on")) {
      throw new Error(`attribute not allowed: ${k}`);
    } else {
      el.setAttribute(k, v === true ? "" : v);
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
}

/** Replaces the whole screen. */
export function show(root: Element, ...children: Child[]): void {
  root.replaceChildren();
  append(root, children);
  const focus = root.querySelector<HTMLElement>("[data-autofocus]") ?? root.querySelector<HTMLElement>("h1");
  focus?.focus();
}

/** Runs `fn` with every button on the screen disabled, so a flow can't be started twice. */
export async function busy<T>(root: Element, label: string, fn: () => Promise<T>): Promise<T> {
  const buttons = [...root.querySelectorAll("button")];
  for (const b of buttons) b.disabled = true;
  const status = root.querySelector("[data-status]");
  if (status) status.textContent = label;
  try {
    return await fn();
  } finally {
    for (const b of buttons) b.disabled = false;
    if (status) status.textContent = "";
  }
}
