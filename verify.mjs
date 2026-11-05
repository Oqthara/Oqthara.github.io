// Structural verification for the prerendered site. Runs in CI before publishing.
//
// The site is standalone: it never reads a local `docs/` tree, and documentation routes are
// shells whose content is fetched from Oqthara/oqthara at request time. These checks
// therefore assert the static contract (routes, chrome, assets, safety) and the absence of
// the retired project path, not the presence of documentation bodies.
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
  "tour.html",
  "docs.html",
  "examples.html",
  "stdlib.html",
  "changelog.html",
  "status.html",
  "404.html",
];
for (const page of EXPECTED) {
  if (!pageFiles.includes(page)) problems.push(`missing page ${page}`);
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

  if (!html.includes('<div id="root">')) problems.push(`${page}: missing root container`);

  // Documentation routes are shells: they must not pretend to contain the document.
  const isDocShell = page.startsWith("docs/");
  // The changelog is fetched from GitHub like a document, so it also prerenders only its
  // frame and loading state.
  const isFetchedPage = isDocShell || page === "changelog.html";
  if (!isFetchedPage && page !== "404.html") {
    const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
    if (text.trim().length < 400) {
      problems.push(`${page}: prerendered text is suspiciously short (${text.trim().length} chars)`);
    }
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
    const relativeTarget = target.split("?")[0].slice(1) || "index.html";
    const resolved = relativeTarget.endsWith("/") ? `${relativeTarget}index.html` : relativeTarget;
    if (!existsSync(join(site, resolved))) problems.push(`${page}: broken link ${target}`);
  }

  if (html.includes("${")) problems.push(`${page}: template literal leaked into output`);
  if (html.includes("__REFERENCE__") || html.includes("__FILE__")) {
    problems.push(`${page}: placeholder leaked into output`);
  }
  if (statSync(join(site, page)).size < 1200) problems.push(`${page}: suspiciously small page`);

  // A documentation shell without a pointer to the canonical file is a dead end.
  if (isDocShell && !html.includes("github.com/Oqthara/oqthara/blob/main/docs/")) {
    problems.push(`${page}: documentation shell has no link to the source`);
  }
}

// No published file may contain an unsafe URL scheme or the retired project path.
for (const page of pageFiles) {
  const html = readFileSync(join(site, page), "utf8");
  if (/(?:href|src)="\s*(?:javascript|data|vbscript):/i.test(html)) {
    problems.push(`${page}: contains an unsafe URL scheme`);
  }
  if (/(?:href|src)="\/oqthara\//.test(html) || html.includes("oqthara.github.io/oqthara")) {
    problems.push(`${page}: still references the retired /oqthara/ project path`);
  }
}

// Documentation must not be copied into the published tree: the catalog is the only list.
if (existsSync(join(site, "docs/spec/language.md"))) {
  problems.push("published documentation Markdown is copied into the site");
}
if (existsSync(join(site, "stdlib.md"))) {
  problems.push("the stdlib reference is copied into the site");
}

// The navigation must link every top-level route on every page.
for (const page of pageFiles) {
  const html = readFileSync(join(site, page), "utf8");
  for (const route of ["/docs.html", "/changelog.html", "/stdlib.html"]) {
    if (!html.includes(`href="${route}"`)) {
      problems.push(`${page}: navigation does not link ${route}`);
    }
  }
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
}

if (!existsSync(join(site, ".nojekyll"))) problems.push("missing .nojekyll");
if (!existsSync(join(site, "search-index.json"))) problems.push("missing search-index.json");

if (problems.length) {
  console.error("verification failed:");
  for (const problem of problems) console.error("  -", problem);
  process.exit(1);
}

console.log(`verified ${pageFiles.length} HTML files in _site`);
console.log("  - every route present, with doctype, title, landmarks and a skip link");
console.log("  - every internal link resolves to a file that exists");
console.log("  - no unsafe URL schemes and no retired /oqthara/ project path");
console.log("  - no documentation Markdown copied into the published tree");
