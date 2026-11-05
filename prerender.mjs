// Prerenders every route to static HTML after `vite build`.
//
// The site is a React application, but GitHub Pages has no server, and a client-only build
// would serve an empty shell to anyone without JavaScript. This runs the same React tree
// through `react-dom/server` and writes one file per route. The browser then hydrates that
// markup, which is why the playground stays interactive while `curl` still sees real HTML.
//
// This repository is standalone: it never reads from a parent checkout. Documentation is
// rendered here only when a local `docs/` directory exists; the authoritative documentation
// lives in Oqthara/oqthara and a later stage renders it from GitHub at runtime. The stdlib
// reference and the changelog are checked-in snapshots under `content/`, refreshed by CI.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseMarkdown, plainInline, renderMarkdown } from "./src/markdown.js";
import { firstParagraph, resolveDocLink, routeForSource, slugForSource } from "./src/docs.js";
import { CHANGELOG_FILE, CHANGELOG_ROUTE, CHANGELOG_SOURCE } from "./src/changelog.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const ssr = join(here, ".ssr");
const out = join(here, "_site");
const ROUTE_COUNT = 7;
const STDLIB_SOURCE = "content/stdlib.md";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!existsSync(dist)) fail("dist/ does not exist; run `vite build` first");
if (!existsSync(join(ssr, "prerender-entry.js"))) {
  fail(".ssr/prerender-entry.js does not exist; run `vite build --ssr src/prerender-entry.jsx --outDir .ssr`");
}

// Vite emits hashed file names; read the built index.html instead of guessing them.
const built = readFileSync(join(dist, "index.html"), "utf8");
const script = built.match(/<script[^>]+src="([^"]+)"/);
const stylesheet = built.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/);
if (!script) fail("could not find the built entry script in dist/index.html");

// The documentation styles live in src/docs.css, imported by the client entry. A build
// that dropped them would still pass the structural checks, so fail loudly here instead of
// publishing unstyled tables and lists. The site is served from the root, so the emitted
// asset path starts with a single "/".
if (stylesheet) {
  const cssPath = join(dist, stylesheet[1].replace(/^\//, ""));
  const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";
  if (!css.includes(".doc-index")) fail("the built stylesheet is missing the documentation rules");
}

const referencePath = join(here, STDLIB_SOURCE);
if (!existsSync(referencePath)) fail(`${STDLIB_SOURCE} is missing`);
const reference = readFileSync(referencePath, "utf8");

/** Repository-relative source paths for local documentation, when a docs/ tree exists. */
function documentationSources() {
  const sources = [];
  for (const dir of ["spec", "adr"]) {
    const absolute = join(here, "docs", dir);
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute).sort()) {
      if (name.endsWith(".md")) sources.push(`docs/${dir}/${name}`);
    }
  }
  return sources;
}

function loadDocs(sources) {
  return sources.map((source) => {
    const markdown = readFileSync(join(here, source), "utf8");
    const blocks = parseMarkdown(markdown);
    const resolveHref = (href) => resolveDocLink(href, source, sources);
    const { html, headings } = renderMarkdown(markdown, { resolveHref });
    const title = headings.find((heading) => heading.level === 1)?.text ?? source;
    return {
      source,
      route: routeForSource(source),
      file: slugForSource(source),
      title,
      summary: plainInline(firstParagraph(blocks)),
      headings,
      html,
    };
  });
}

const sources = documentationSources();
const docs = loadDocs(sources);

/** Renders the checked-in changelog snapshot once; the page component only receives this. */
function loadChangelog(sources) {
  const path = join(here, CHANGELOG_SOURCE);
  if (!existsSync(path)) fail(`${CHANGELOG_SOURCE} is missing`);
  const markdown = readFileSync(path, "utf8");
  const resolveHref = (href) => resolveDocLink(href, CHANGELOG_SOURCE, sources);
  const { html, headings } = renderMarkdown(markdown, { resolveHref });
  const title = headings.find((heading) => heading.level === 1)?.text ?? "Changelog";
  return {
    source: CHANGELOG_SOURCE,
    route: CHANGELOG_ROUTE,
    file: CHANGELOG_FILE,
    title,
    summary: plainInline(firstParagraph(parseMarkdown(markdown))),
    headings,
    html,
  };
}

const changes = loadChangelog(sources);

const { renderAll } = await import(pathToFileURL(join(ssr, "prerender-entry.js")).href);
const pages = renderAll(reference, {
  script: script[1],
  stylesheet: stylesheet ? stylesheet[1] : "assets/site.css",
}, { versions: [], latest: null }, docs, changes);

if (pages.length !== ROUTE_COUNT + docs.length) {
  fail(`rendered ${pages.length} pages, expected ${ROUTE_COUNT + docs.length}`);
}

// The search index is derived from the HTML that was just rendered, so a result can only
// point at a page that exists. It is a plain static file; no server is involved.
const { buildSearchIndex } = await import(pathToFileURL(join(here, "src", "search-index.js")).href);
const searchIndex = buildSearchIndex(pages);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const page of pages) {
  const target = join(out, page.file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, page.html, "utf8");
  console.log("wrote", page.file);
}

// Vite's hashed assets, plus the hand-written CSS so the design tokens stay greppable.
cpSync(join(dist, "assets"), join(out, "assets"), { recursive: true });
if (existsSync(join(here, "assets"))) {
  cpSync(join(here, "assets"), join(out, "assets"), { recursive: true });
}
cpSync(referencePath, join(out, "stdlib.md"));

// GitHub Pages must not run Jekyll over the prerendered output.
writeFileSync(join(out, ".nojekyll"), "", "utf8");

const indexJson = JSON.stringify(searchIndex) + "\n";
writeFileSync(join(out, "search-index.json"), indexJson, "utf8");
console.log("wrote search-index.json with", searchIndex.length, "entries,", Buffer.byteLength(indexJson), "bytes");

for (const doc of docs) {
  if (!existsSync(join(out, doc.file))) fail(`documentation page was not written: ${doc.file}`);
}
if (!existsSync(join(out, CHANGELOG_FILE))) fail(`changelog page was not written: ${CHANGELOG_FILE}`);
if (docs.length === 0) {
  console.log("no local docs/ directory; skipped documentation pages (rendered from Oqthara/oqthara later)");
}

console.log("rendered", docs.length, "documentation pages from docs/");
console.log("rendered the changelog page from", CHANGELOG_SOURCE);
console.log("prerendered", pages.length, "routes into", out);
