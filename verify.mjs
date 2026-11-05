// Structural verification for the prerendered React site. Runs in CI before publishing.
//
// This repository is standalone: documentation under `docs/spec` and `docs/adr` is optional
// and only checked when a local checkout provides it. The authoritative documentation lives
// in Oqthara/oqthara and is rendered from GitHub in a later stage.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { plainInline } from "./src/markdown.js";
import { CHANGELOG_FILE, CHANGELOG_ROUTE, CHANGELOG_SOURCE } from "./src/changelog.js";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "_site");
const problems = [];

if (!existsSync(site)) {
  console.error("_site does not exist; run `npm run build` first");
  process.exit(1);
}

const pageFiles = [];
function collectHtml(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "versions" || entry.name === "assets") continue;
      collectHtml(path);
    } else if (entry.name.endsWith(".html")) {
      pageFiles.push(relative(site, path));
    }
  }
}
collectHtml(site);

const EXPECTED = ["index.html", "tour.html", "docs.html", "examples.html", "stdlib.html", CHANGELOG_FILE, "status.html"];
for (const page of EXPECTED) {
  if (!pageFiles.includes(page)) problems.push(`missing page ${page}`);
}

// Every Markdown document under a local docs/spec and docs/adr must have a generated page.
// The directory is optional here; the language repository owns the authoritative files.
const renderedDocs = [];
for (const dir of ["spec", "adr"]) {
  const absolute = join(here, "docs", dir);
  if (!existsSync(absolute)) continue;
  for (const name of readdirSync(absolute).sort()) {
    if (!name.endsWith(".md")) continue;
    const source = `docs/${dir}/${name}`;
    const page = `docs/${dir}/${name.replace(/\.md$/, ".html")}`;
    renderedDocs.push({ source, page });
    if (!pageFiles.includes(page)) problems.push(`missing documentation page ${page}`);
  }
}

const ids = new Map();
for (const page of pageFiles) {
  const html = readFileSync(join(site, page), "utf8");
  const required = [
    ["<!DOCTYPE html>", "doctype"],
    ['lang="en"', "lang attribute"],
    ["<title>", "title"],
    ['id="main"', "main landmark"],
    ["skip-link", "skip link"],
    ['aria-label="Main"', "labelled navigation"],
    ["viewport", "viewport meta"],
    ['href="/assets/', "root-relative asset reference"],
  ];
  for (const [needle, label] of required) {
    if (!html.includes(needle)) problems.push(`${page}: missing ${label}`);
  }

  // The page must contain real prerendered content, not an empty React shell.
  if (!html.includes('<div id="root">')) problems.push(`${page}: missing root container`);
  const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
  if (text.trim().length < 400) {
    problems.push(`${page}: prerendered text is suspiciously short (${text.trim().length} chars)`);
  }

  ids.set(page, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])));

  for (const match of html.matchAll(/href="([^"]*)"/g)) {
    const target = match[1];
    if (target.startsWith("http") || target.startsWith("mailto")) continue;
    if (target.startsWith("#")) {
      if (!ids.get(page).has(target.slice(1))) {
        problems.push(`${page}: missing anchor target ${target}`);
      }
      continue;
    }
    if (!target.startsWith("/")) {
      problems.push(`${page}: internal link is not root-relative: ${target}`);
      continue;
    }
    const relativeTarget = target.slice(1) || "index.html";
    const resolved = relativeTarget.endsWith("/") ? `${relativeTarget}index.html` : relativeTarget;
    if (!existsSync(join(site, resolved))) problems.push(`${page}: broken link ${target}`);
  }

  if (html.includes("${")) problems.push(`${page}: template literal leaked into output`);
  if (html.includes("__REFERENCE__") || html.includes("__FILE__")) {
    problems.push(`${page}: placeholder leaked into output`);
  }
  if (statSync(join(site, page)).size < 1200) problems.push(`${page}: suspiciously small page`);
}

// The old GitHub Pages project path must never appear in the published output.
for (const page of pageFiles) {
  const html = readFileSync(join(site, page), "utf8");
  // Site paths only: `https://github.com/Oqthara/oqthara/...` is a legitimate repository URL.
  if (/(?:href|src)="\/oqthara\//.test(html) || html.includes("oqthara.github.io/oqthara")) {
    problems.push(`${page}: still references the retired /oqthara/ project path`);
  }
  if (html.includes("oqthara.github.io/oqthara")) {
    problems.push(`${page}: still references the retired project URL`);
  }
}

// The changelog page must be the checked-in snapshot, rendered as real structure, and the
// navigation on every page must link it.
const changelogPage = readFileSync(join(site, CHANGELOG_FILE), "utf8");
for (const [needle, label] of [
  ['<h1 id="changelog">Changelog</h1>', "h1 rendered from the changelog snapshot"],
  ['<h2 id="unreleased">', "unreleased section"],
  ["<h3 id=", "release subsections"],
  ["<ul>", "change lists"],
  ["<li>", "change entries"],
  ['href="https://github.com/Oqthara/oqthara/compare/', "reference-style link"],
]) {
  if (!changelogPage.includes(needle)) problems.push(`changelog.html: missing ${label}`);
}
if (!changelogPage.includes('<article class="doc">')) problems.push("changelog.html: missing article");
if (changelogPage.includes("<p>[Unreleased]:")) problems.push("changelog.html: link definitions leaked as prose");
if (!changelogPage.includes("Snapshot")) problems.push("changelog.html: does not label itself as a snapshot");

// The changelog source must not be copied into the site tree beyond the one checked-in
// snapshot the build reads.
const changelogSource = readFileSync(join(here, CHANGELOG_SOURCE), "utf8");
const changelogText = changelogPage
  .replace(/<script[\s\S]*?<\/script>/g, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ");
const firstEntry = plainInline(changelogSource.match(/^- (.+)$/m)?.[1] ?? "");
if (firstEntry && !changelogText.includes(firstEntry.slice(0, 60))) {
  problems.push("changelog.html: does not contain the first changelog entry");
}

for (const page of pageFiles) {
  const html = readFileSync(join(site, page), "utf8");
  if (!html.includes(`href="${CHANGELOG_ROUTE}"`)) {
    problems.push(`${page}: navigation does not link the changelog`);
  }
}

// The docs index must link every locally rendered document, not a hand-picked subset.
const docsIndex = readFileSync(join(site, "docs.html"), "utf8");
for (const doc of renderedDocs) {
  const url = `/${doc.page}`;
  if (!docsIndex.includes(`href="${url}"`)) problems.push(`docs.html: does not list ${doc.source}`);
  const html = readFileSync(join(site, doc.page), "utf8");
  if (!html.includes('<article class="doc">')) problems.push(`${doc.page}: missing article`);
  if (!/<h1 id="[^"]+">/.test(html)) problems.push(`${doc.page}: missing anchored h1`);
}

// When a local specification is present it must convert to real structure.
const specPath = join(site, "docs/spec/language.html");
if (existsSync(specPath)) {
  const spec = readFileSync(specPath, "utf8");
  for (const [needle, label] of [
    ["<table>", "table"],
    ["<pre><code", "fenced code"],
    ["<h2 id=", "headings"],
    ["<ul>", "list"],
    ["<a href=", "links"],
  ]) {
    if (!spec.includes(needle)) problems.push(`rendered specification: missing ${label}`);
  }
}

// The embedded reference must actually be present, so /stdlib renders from the snapshot.
const stdlib = readFileSync(join(site, "stdlib.html"), "utf8");
if (!stdlib.includes('id="oq-reference"')) problems.push("stdlib.html: missing embedded reference");
if (!stdlib.includes("Global functions")) problems.push("stdlib.html: reference has no functions section");

// Documentation pages must embed the same documentation the client hydrates from.
const embeddedDocs = join(site, "docs.html");
if (!readFileSync(embeddedDocs, "utf8").includes('id="oq-docs"')) {
  problems.push("docs.html: missing embedded documentation data");
}

const assets = join(site, "assets");
if (!existsSync(assets)) problems.push("missing assets/");
else {
  const files = readdirSync(assets);
  if (!files.some((file) => /^site\.css$/.test(file))) problems.push("missing unbundled site.css");
  if (!files.some((file) => /^style-[^/]+\.css$/.test(file))) problems.push("missing built stylesheet");
  if (!files.some((file) => /^index-[^/]+\.js$/.test(file))) problems.push("missing built script");

  const css = readFileSync(join(assets, "site.css"), "utf8");
  for (const token of ["--bg", "--fg", "--accent", "--radius", "prefers-color-scheme",
    "prefers-reduced-motion", ":focus-visible"]) {
    if (!css.includes(token)) problems.push(`site.css: missing ${token}`);
  }
  if (!css.includes("animation: none !important")) problems.push("site.css: reduced motion must disable animation");
  if (!css.includes("transition: none !important")) problems.push("site.css: reduced motion must disable transition");
}

if (!existsSync(join(site, ".nojekyll"))) problems.push("missing .nojekyll");
if (!existsSync(join(site, "stdlib.md"))) problems.push("missing stdlib.md");

// Search is a static index generated during prerendering, so check that it exists, stays
// small, and only names pages and anchors that were actually written.
const indexPath = join(site, "search-index.json");
if (!existsSync(indexPath)) {
  problems.push("missing search-index.json");
} else {
  const raw = readFileSync(indexPath, "utf8");
  if (Buffer.byteLength(raw) > 64 * 1024) {
    problems.push(`search-index.json is too large (${Buffer.byteLength(raw)} bytes)`);
  }
  let entries = null;
  try {
    entries = JSON.parse(raw);
  } catch {
    problems.push("search-index.json is not valid JSON");
  }
  if (entries !== null) {
    if (!Array.isArray(entries) || entries.length === 0) {
      problems.push("search-index.json has no entries");
    } else {
      for (const entry of entries) {
        const url = typeof entry?.url === "string" ? entry.url : "";
        if (!url.startsWith("/")) {
          problems.push(`search-index.json: ${url || "(missing url)"} must be root-relative`);
          continue;
        }
        const [path, anchor] = url.split("#");
        const relativePath = path.slice(1) || "index.html";
        const file = relativePath.endsWith("/") ? `${relativePath}index.html` : relativePath;
        if (!existsSync(join(site, file))) {
          problems.push(`search-index.json: ${url} does not resolve to a page`);
          continue;
        }
        if (anchor) {
          const target = readFileSync(join(site, file), "utf8");
          if (!target.includes(`id="${anchor}"`)) problems.push(`search-index.json: ${url} has no anchor`);
        }
      }
    }
  }
}

const home = readFileSync(join(site, "index.html"), "utf8");
for (const needle of ['role="search"', 'role="combobox"', 'aria-controls="site-search-results"']) {
  if (!home.includes(needle)) problems.push(`index.html: missing search markup ${needle}`);
}

if (problems.length) {
  console.error("Site verification failed:");
  for (const problem of problems) console.error("  -", problem);
  process.exit(1);
}
console.log(`Verified ${pageFiles.length} prerendered pages (${renderedDocs.length} from a local docs/ tree), assets and stdlib reference.`);
