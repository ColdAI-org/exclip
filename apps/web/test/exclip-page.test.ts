import test from "node:test";
import assert from "node:assert/strict";
import { strictPage } from "../src/lib/page-policy.ts";

const ENTRY = `<script type="module" crossorigin src="/assets/index-B4x_9kQ-.js"></script>`;
/** index.html as `vite build` writes it, with room for extra markup. */
const page = ({ head = "", body = "", entry = ENTRY } = {}) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>ExClip</title>
    <link rel="icon" href="/logo.svg" />
    ${entry}
    <link rel="stylesheet" crossorigin href="/assets/index-Cq2V1f0d.css">
    ${head}
  </head>
  <body>
    <div id="root"></div>
    ${body}
  </body>
</html>`;

test("a page Vite built passes unchanged; data blocks are not scripts", () => {
  assert.equal(strictPage(page()), page());
  const jsonLd = page({ head: `<script type="application/ld+json">{"@context":"https://schema.org"}</script>` });
  assert.equal(strictPage(jsonLd), jsonLd);
  assert.doesNotThrow(() => strictPage(page({ head: `<script type='application/json' id="seed">{}</script>` })));
});

test("anything the CSP (script-src 'self') would block fails the build", () => {
  for (const head of [
    `<script>window.x = 1</script>`,
    `<script type="module">import "/assets/x.js"</script>`,
    `<SCRIPT TYPE="text/javascript">1</SCRIPT>`,
  ]) {
    assert.throws(() => strictPage(page({ head })), /inline <script>/, head);
  }
  for (const body of [`<img src="/x.png" onerror="go()">`, `<div ONCLICK = "go()"></div>`]) {
    assert.throws(() => strictPage(page({ body })), /event handler/, body);
  }
  for (const body of [`<a href="javascript:go()">x</a>`, `<a href=' javascript:go()'>x</a>`]) {
    assert.throws(() => strictPage(page({ body })), /javascript: URL/, body);
  }
});

test("the page must load its entry as a same-origin module script", () => {
  // The source page (vite serve) and an entry from another origin both fail.
  assert.throws(() => strictPage(page({ entry: `<script type="module" src="/src/main.tsx"></script>` })), /entry/);
  assert.throws(() => strictPage(page({ entry: `<script type="module" crossorigin src="https://cdn.example.com/assets/index-B4x_9kQ-.js"></script>` })), /entry/);
  assert.throws(() => strictPage(page({ entry: "" })), /entry/);
});
