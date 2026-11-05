// Prerenders the static routes to real HTML after `vite build`.
//
// The site is a React application, but GitHub Pages has no server, and a client-only build
// would serve an empty shell to anyone without JavaScript. This runs the same React tree
// through `react-dom/server` and writes one file per static route, exactly once.
//
// This repository is standalone. It never reads from a parent checkout, never reads a local
// `docs/` tree and never ships a copy of the Markdown: documentation pages are fetched from
// Oqthara/oqthara at request time, so a documentation change needs no site rebuild. Because
// that content is not present at build time, those routes are emitted as static shells with
// a `<noscript>` link to the canonical file, and are not claimed as prerendered content.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const ssr = join(here, ".ssr");
const out = join(here, "_site");
const ROUTE_COUNT = 7;

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

// The documentation styles live in src/docs.css, imported by the client entry. A build that
// dropped them would still pass the structural checks, so fail loudly here rather than
// publishing unstyled tables and lists.
if (stylesheet) {
  const cssPath = join(dist, stylesheet[1].replace(/^\//, ""));
  const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";
  if (!css.includes(".doc-index")) fail("the built stylesheet is missing the documentation rules");
}

const assets = {
  script: script[1],
  stylesheet: stylesheet ? stylesheet[1] : "assets/site.css",
};

const { renderAll, renderDocShell, render404 } = await import(
  pathToFileURL(join(ssr, "prerender-entry.js")).href
);

const pages = renderAll(assets);
if (pages.length !== ROUTE_COUNT) {
  fail(`rendered ${pages.length} routes, expected ${ROUTE_COUNT}`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const page of pages) {
  const target = join(out, page.file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, page.html, "utf8");
  console.log("wrote", page.file);
}

// Documentation shells are written for the documents the catalog lists. They contain no
// Markdown, only a frame and a pointer to GitHub, so deep links work before the fetch.
// Shells for deep links into the documentation.
//
// These exist so a reader who opens `/docs/spec/language.html` directly gets a real 200
// response with the site chrome, even without JavaScript. They contain no Markdown. A
// document missing from this list still renders: the client route matches any
// `/docs/**.html`, fetches it and renders it. Only the no-JavaScript case depends on a
// shell being listed here, so this list is a convenience, not a source of truth.
const docRoutes = [
  ["docs/spec/language.md", "Language reference"],
  ["docs/spec/design.md", "Design"],
  ["docs/spec/backend.md", "Backend status and limitations"],
  ["docs/spec/fuzzing.md", "Fuzzing"],
  ["docs/stdlib/reference.md", "Standard library reference"],
  ["docs/reference/cli.md", "CLI reference"],
  ["docs/adr/0011-standalone-website-repository.md", "ADR-0011"],
];
for (const [path, title] of docRoutes) {
  const shell = renderDocShell({
    path,
    title,
    sourceUrl: `https://github.com/Oqthara/oqthara/blob/main/${path}`,
    assets,
  });
  const target = join(out, shell.file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, shell.html, "utf8");
  console.log("wrote", shell.file);
}

const notFound = render404(assets);
writeFileSync(join(out, notFound.file), notFound.html, "utf8");
console.log("wrote", notFound.file);

// Vite's hashed assets, plus the hand-written CSS so the design tokens stay greppable.
cpSync(join(dist, "assets"), join(out, "assets"), { recursive: true });
if (existsSync(join(here, "assets"))) {
  cpSync(join(here, "assets"), join(out, "assets"), { recursive: true });
}

// GitHub Pages must not run Jekyll over the prerendered output.
writeFileSync(join(out, ".nojekyll"), "", "utf8");

const { buildSearchIndex } = await import(
  pathToFileURL(join(here, "src", "search-index.js")).href
);
const searchIndex = buildSearchIndex(pages);
const indexJson = JSON.stringify(searchIndex) + "\n";
writeFileSync(join(out, "search-index.json"), indexJson, "utf8");
console.log(
  "wrote search-index.json with",
  searchIndex.length,
  "entries,",
  Buffer.byteLength(indexJson),
  "bytes",
);

console.log("prerendered", pages.length, "static routes into", out);
console.log("documentation routes are shells: content is fetched from GitHub at runtime");
