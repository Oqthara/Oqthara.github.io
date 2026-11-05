// Structural verification for the built site. Runs in CI before publishing.
//
// The site is static and its documentation is fetched at request time, so these checks assert
// the static contract: the routes that must exist, the chrome every page must carry, the
// absence of unsafe URLs, and — importantly — that no documentation has been copied into the
// published tree and no per-document file has crept back in.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
      if (entry.name === "assets") continue;
      collectHtml(path);
    } else if (entry.name.endsWith(".html")) {
      pageFiles.push(relative(site, path));
    }
  }
}
collectHtml(site);

const EXPECTED = [
  "index.html",
  "philosophy.html",
  "tour.html",
  "docs.html",
  "document.html",
  "examples.html",
  "example.html",
  "stdlib.html",
  "changelog.html",
  "status.html",
  "404.html",
];

for (const page of EXPECTED) {
  if (!pageFiles.includes(page)) problems.push(`missing page ${page}`);
}

// No per-document HTML may exist: one document route serves all of them.
for (const page of pageFiles) {
  if (/^docs\//.test(page) || /^examples\//.test(page)) {
    problems.push(`per-content page exists (must be served by document.html/example.html): ${page}`);
  }
}

const ids = new Map();
for (const page of pageFiles) {
  const html = readFileSync(join(site, page), "utf8");
  for (const [needle, label] of [
    ["<!DOCTYPE html>", "doctype"],
    ['lang="en"', "lang attribute"],
    ["<title>", "title"],
    ['id="main"', "main landmark"],
    ["skip-link", "skip link"],
    ['aria-label="Main"', "labelled navigation"],
    ["viewport", "viewport meta"],
    ["rel=\"stylesheet\"", "stylesheet"],
  ]) {
    if (!html.includes(needle)) problems.push(`${page}: missing ${label}`);
  }

  if (!html.includes('<div id="root">')) problems.push(`${page}: missing root container`);
  if (html.includes("${")) problems.push(`${page}: template literal leaked into output`);
  if (html.includes("__REFERENCE__") || html.includes("__FILE__")) {
    problems.push(`${page}: placeholder leaked into output`);
  }

  ids.set(page, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])));

  for (const match of html.matchAll(/href="([^"]*)"/g)) {
    const target = match[1];
    if (target.startsWith("http") || target.startsWith("mailto")) continue;
    if (target.startsWith("#")) {
      if (!ids.get(page).has(target.slice(1))) problems.push(`${page}: missing anchor target ${target}`);
      continue;
    }
    if (!target.startsWith("/")) {
      problems.push(`${page}: internal link is not root-relative: ${target}`);
      continue;
    }
    const pathOnly = target.split("?")[0].split("#")[0].slice(1) || "index.html";
    const resolved = pathOnly.endsWith("/") ? `${pathOnly}index.html` : pathOnly;
    // A content route is served by a real file; its ?path= is resolved at runtime.
    if (!existsSync(join(site, resolved))) problems.push(`${page}: broken link ${target}`);
  }

  // Static routes must carry real prerendered text; 404 is allowed to be short.
  if (page !== "404.html" && page !== "document.html" && page !== "example.html") {
    const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
    if (text.trim().length < 400) {
      problems.push(`${page}: prerendered text is suspiciously short (${text.trim().length} chars)`);
    }
  }
  if (statSync(join(site, page)).size < 900) problems.push(`${page}: suspiciously small page`);
}

// Unsafe schemes and the retired project path must not appear in any published page.
for (const page of pageFiles) {
  const html = readFileSync(join(site, page), "utf8");
  if (/(?:href|src)="\s*(?:javascript|data|vbscript):/i.test(html)) {
    problems.push(`${page}: contains an unsafe URL scheme`);
  }
  if (/(?:href|src)="\/oqthara\//.test(html) || html.includes("oqthara.github.io/oqthara")) {
    problems.push(`${page}: still references the retired /oqthara/ project path`);
  }
}

// Documentation must never be copied into the published tree.
if (existsSync(join(site, "docs"))) problems.push("documentation is copied into the site");
if (existsSync(join(site, "stdlib.md"))) problems.push("the stdlib reference is copied into the site");

// The 404 page must be able to redirect legacy content links, and must say what happened.
const notFound = readFileSync(join(site, "404.html"), "utf8");
if (!notFound.includes("document.html")) problems.push("404.html does not redirect legacy documentation links");
if (!notFound.toLowerCase().includes("does not exist")) problems.push("404.html does not render the not-found page");

// Navigation must reach every top-level page from every page.
for (const page of pageFiles) {
  const html = readFileSync(join(site, page), "utf8");
  for (const route of ["/docs.html", "/examples.html", "/philosophy.html", "/changelog.html"]) {
    if (!html.includes(`href="${route}"`)) problems.push(`${page}: navigation does not link ${route}`);
  }
}

// The Playground must be gone, in markup and in the bundle.
for (const page of pageFiles) {
  const html = readFileSync(join(site, page), "utf8");
  if (/playground/i.test(html)) problems.push(`${page}: still contains a Playground reference`);
}

const assets = join(site, "assets");
if (!existsSync(assets)) {
  problems.push("missing assets/");
} else {
  const files = readdirSync(assets);
  if (!files.some((file) => /^style-[^/]+\.css$/.test(file))) problems.push("missing built stylesheet");
  if (!files.some((file) => /^index-[^/]+\.js$/.test(file))) problems.push("missing built script");

  const js = files.filter((file) => file.endsWith(".js"));
  for (const file of js) {
    const source = readFileSync(join(assets, file), "utf8");
    if (/playground/i.test(source)) problems.push(`assets/${file}: still contains the Playground`);
  }

  const cssFile = files.find((file) => /^style-[^/]+\.css$/.test(file));
  if (cssFile) {
    const css = readFileSync(join(assets, cssFile), "utf8");
    for (const token of ["--bg", "--fg", "--accent", "--radius", "prefers-color-scheme",
      "prefers-reduced-motion", ":focus-visible", "docs-sidebar", "doc-with-toc"]) {
      if (!css.includes(token)) problems.push(`built stylesheet: missing ${token}`);
    }
  }
}

if (!existsSync(join(site, ".nojekyll"))) problems.push("missing .nojekyll");

if (problems.length) {
  console.error("verification failed:");
  for (const problem of problems) console.error("  -", problem);
  process.exit(1);
}

console.log(`verified ${pageFiles.length} HTML files in _site`);
console.log("  - every static route present with doctype, title, landmarks and a skip link");
console.log("  - no per-document HTML: documentation and examples use one route each");
console.log("  - every internal link resolves to a file that exists");
console.log("  - no unsafe URL schemes, no retired /oqthara/ path, no copied Markdown");
console.log("  - the Playground is absent from markup and bundle");
console.log("  - 404.html redirects legacy documentation links");
