// Prerenders the static routes to real HTML after `vite build`.
//
// The site is a React application on GitHub Pages, which has no server. A client-only build
// would serve an empty shell, so each route is rendered through `react-dom/server` and written
// as a file. The browser then hydrates that exact markup.
//
// What is NOT written here, on purpose:
//
//   * one file per documentation page — `/document.html` serves them all from the query string;
//   * one file per example — `/example.html` does the same;
//   * any list of document paths, so a new Markdown file needs no build.
//
// `404.html` is written once. It contains the real NotFound page, and for a legacy
// `/docs/**.html` or `/examples/**.html` address it redirects to the canonical route, which is
// what keeps old links working without generating a file per document.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const ssr = join(here, ".ssr");
const out = join(here, "_site");

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!existsSync(dist)) fail("dist/ does not exist; run `vite build` first");
if (!existsSync(join(ssr, "prerender-entry.js"))) {
  fail(".ssr/prerender-entry.js does not exist; run `vite build --ssr src/prerender-entry.jsx --outDir .ssr`");
}

// Vite emits hashed names; read them from the built index.html instead of guessing.
const built = readFileSync(join(dist, "index.html"), "utf8");
const script = built.match(/<script[^>]+src="([^"]+)"/);
const stylesheet = built.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/);
if (!script) fail("could not find the built entry script in dist/index.html");

const assets = {
  script: script[1],
  stylesheet: stylesheet ? stylesheet[1] : "/assets/site.css",
};

// The documentation and prose styles live in bundled CSS. A build that dropped them would pass
// the structural checks while publishing unstyled tables, so fail loudly here.
{
  const cssPath = stylesheet ? join(dist, stylesheet[1].replace(/^\//, "")) : null;
  const css = cssPath && existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";
  if (!css.includes(".docs-layout")) fail("the built stylesheet is missing the documentation layout rules");
}

const { renderAll, render404 } = await import(
  pathToFileURL(join(ssr, "prerender-entry.js")).href
);

// Start from an empty output directory. Without this a removed route or an old hashed bundle
// survives from a previous build and gets published, which is exactly how the deleted
// Playground would have stayed reachable.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const pages = renderAll(assets);
for (const page of pages) {
  const target = join(out, page.file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, page.html, "utf8");
  console.log("wrote", page.file);
}

const notFound = render404(assets);
writeFileSync(join(out, notFound.file), notFound.html, "utf8");
console.log("wrote", notFound.file);

// Vite's hashed assets, plus the hand-written CSS so the design tokens stay greppable.
cpSync(join(dist, "assets"), join(out, "assets"), { recursive: true });
if (existsSync(join(here, "assets"))) {
  cpSync(join(here, "assets"), join(out, "assets"), { recursive: true });
}

// The icon must sit at the site root: a browser asks for `/favicon.ico` when a page declares
// none, and a 404 there is a console error on every page. Declaring an SVG and serving it from
// the root answers that request with something real.
if (!existsSync(join(here, "assets", "favicon.svg"))) fail("assets/favicon.svg is missing");
cpSync(join(here, "assets", "favicon.svg"), join(out, "favicon.svg"));

// GitHub Pages must not run Jekyll over the prerendered output.
writeFileSync(join(out, ".nojekyll"), "", "utf8");

console.log("prerendered", pages.length, "static routes and 404.html into", out);
console.log("documentation and examples are served by /document.html and /example.html at runtime");
