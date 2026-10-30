#!/usr/bin/env node
/**
 * Checks that every relative link, heading anchor and image in the repository's Markdown resolves.
 *
 *   pnpm run docs:links
 *
 * Reads every .md file outside node_modules, dist and hidden folders (.github included). For each Markdown link or
 * image, reference definition, and HTML href, src or srcset, it checks that a relative target exists with the exact
 * case GitHub will see, and that a #fragment pointing into a Markdown file names one of its headings (by GitHub's slug
 * rules) or an HTML id. Links inside code are skipped. External URLs are counted but never fetched. Exits 1 if anything
 * is broken.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Every .md file under `dir`, as a root-relative path with forward slashes. */
function markdownFiles(dir = ROOT) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".github")) continue;
      files.push(...markdownFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relative(ROOT, join(dir, entry.name)).split(sep).join("/"));
    }
  }
  return files.sort();
}

const listings = new Map();
/** True when the root-relative `path` exists with exactly this case in every segment. macOS would forgive a wrong
 * case; GitHub doesn't. */
function existsExactly(path) {
  let dir = "";
  for (const segment of path.split("/").filter(Boolean)) {
    if (!listings.has(dir)) {
      try {
        listings.set(dir, readdirSync(join(ROOT, dir)));
      } catch {
        listings.set(dir, []);
      }
    }
    if (!listings.get(dir).includes(segment)) return false;
    dir = dir ? `${dir}/${segment}` : segment;
  }
  return true;
}

/** The file's lines, with fenced code blocks blanked so their contents never count as links or headings. */
function proseLines(text) {
  let fence = null;
  return text.split("\n").map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^\s*(`+|~+)\s*$/.test(line)) fence = null;
      return "";
    }
    if (marker) {
      fence = marker;
      return "";
    }
    return line;
  });
}

/** GitHub's id for a heading: the rendered text, lower-cased, with punctuation and symbols dropped and each space
 * turned into a hyphen (github-slugger's rules). */
function slug(heading) {
  const text = heading
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(`+)([\s\S]*?)\1/g, "$2")
    .replace(/<[^>]+>/g, "");
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_ -]/gu, "").replace(/ /g, "-");
}

const anchorCache = new Map();
/** Every fragment a Markdown file answers to: its headings' ids, numbered as GitHub numbers repeats, and HTML ids. */
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const ids = new Set();
  const repeats = new Map();
  for (const line of proseLines(readFileSync(join(ROOT, file), "utf8"))) {
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading) {
      const base = slug(heading[1]);
      const n = repeats.get(base) ?? 0;
      repeats.set(base, n + 1);
      ids.add(n ? `${base}-${n}` : base);
    }
    for (const match of line.matchAll(/<[a-z][^>]*\s(?:id|name)="([^"]+)"/gi)) ids.add(match[1]);
  }
  anchorCache.set(file, ids);
  return ids;
}

/** The link and image targets on one line of prose, code spans left out. */
function targetsIn(line) {
  const prose = line.replace(/(`+)[\s\S]*?\1/g, "");
  const targets = [];
  for (const match of prose.matchAll(/\]\(\s*<([^>]*)>/g)) targets.push(match[1]);
  for (const match of prose.matchAll(/\]\(\s*([^)\s<][^)\s]*)/g)) targets.push(match[1]);
  for (const match of prose.matchAll(/^ {0,3}\[(?!\^)[^\]]+\]:\s*<?([^\s>]+)/g)) targets.push(match[1]);
  for (const match of prose.matchAll(/\s(?:href|src)="([^"]*)"/g)) targets.push(match[1]);
  for (const match of prose.matchAll(/\ssrcset="([^"]*)"/g)) {
    for (const candidate of match[1].split(",")) targets.push(candidate.trim().split(/\s+/)[0]);
  }
  return targets;
}

/** Why `target`, linked from `file`, doesn't resolve, or null when it does. */
function problemWith(file, target) {
  const hash = target.indexOf("#");
  const pathPart = (hash === -1 ? target : target.slice(0, hash)).split("?")[0];
  const fragment = hash === -1 ? "" : target.slice(hash + 1);
  let path;
  try {
    path = decodeURIComponent(pathPart);
  } catch {
    return "isn't a valid URL";
  }
  const resolved = path === "" ? file : posix.normalize(path.startsWith("/") ? path.slice(1) : posix.join(posix.dirname(file), path));
  if (resolved === ".." || resolved.startsWith("../")) return "points outside the repository";
  if (!existsExactly(resolved)) return `${resolved} doesn't exist`;
  if (fragment && resolved.endsWith(".md") && !anchorsOf(resolved).has(fragment)) {
    return `${resolved} has no heading or id "${fragment}"`;
  }
  return null;
}

const files = markdownFiles();
const broken = [];
let checked = 0;
let external = 0;
for (const file of files) {
  proseLines(readFileSync(join(ROOT, file), "utf8")).forEach((line, index) => {
    for (const target of targetsIn(line)) {
      if (EXTERNAL.test(target)) {
        external += 1;
        continue;
      }
      checked += 1;
      const problem = problemWith(file, target);
      if (problem) broken.push(`${file}:${index + 1}: ${target}: ${problem}`);
    }
  });
}

console.log(`docs:links: ${files.length} Markdown files, ${checked} relative links and images, ${external} external links (not fetched)`);
if (broken.length) {
  for (const line of broken) console.error(`  ${line}`);
  console.error(`docs:links: ${broken.length} broken`);
  process.exit(1);
}
console.log("docs:links: every relative link, anchor and image resolves");
