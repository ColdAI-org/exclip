/** Just enough DOM for dom.ts, so the screens run under Node. Imports nothing: a test sets the globals, the build's
 * names among them, before it imports config.ts or anything that reads it. */

export class FakeText {
  constructor(readonly text: string) {}
  get outerHTML(): string { return this.text; }
}

/** Keeps its attributes and children and prints them back. Finds nothing, so show() focuses nothing. */
export class FakeElement {
  readonly attrs: string[] = [];
  childNodes: (FakeElement | FakeText)[] = [];
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void { this.attrs.push(` ${name}="${value}"`); }
  addEventListener(): void {}
  append(...nodes: (FakeElement | FakeText)[]): void { this.childNodes.push(...nodes); }
  replaceChildren(): void { this.childNodes = []; }
  querySelector(): null { return null; }
  querySelectorAll(): FakeElement[] { return []; }
  get outerHTML(): string { return `<${this.tag}${this.attrs.join("")}>${this.childNodes.map((n) => n.outerHTML).join("")}</${this.tag}>`; }
}

export const fakeDocument = { createElement: (tag: string) => new FakeElement(tag), createTextNode: (text: string) => new FakeText(text) };
