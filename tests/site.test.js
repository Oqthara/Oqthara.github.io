import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Structural checks on the prerendered output. These read `_site` only: no network, no clock.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "_site");
const present = existsSync(site);
const skip = present ? false : "_site is absent; run `npm run build`";

const STATIC_ROUTES = [
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

function readPage(file) {
  return readFileSync(path.join(site, file), "utf8");
}

function htmlFiles(directory) {
  return readdirSync(directory).filter(
    (name) => statSync(path.join(directory, name)).isFile() && name.endsWith(".html"),
  );
}

function walk(directory, result = []) {
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) walk(full, result);
    else result.push(full);
  }
  return result;
}

test("the static route set is exactly the prerendered pages", { skip }, () => {
  const emitted = htmlFiles(site).sort();
  assert.deepEqual(emitted, [...STATIC_ROUTES].sort());
});

test("there are no per-document files under docs/", { skip }, () => {
  const docs = path.join(site, "docs");
  if (!existsSync(docs)) return;
  const emitted = walk(docs);
  assert.deepEqual(
    emitted.filter((file) => file.endsWith(".html")),
    [],
    "document routes must be served by document.html, not generated files",
  );
});

test("every page has the required document shell", { skip }, () => {
  for (const file of STATIC_ROUTES) {
    const html = readPage(file);
    assert.match(html, /<!doctype html>/i, `${file} has a doctype`);
    assert.match(html, /<html[^>]*\slang="en"/i, `${file} declares a language`);
    assert.match(html, /<title>[^<]+<\/title>/i, `${file} has a title`);
    assert.match(html, /<meta[^>]*name="viewport"[^>]*>/i, `${file} has a viewport`);
    assert.match(html, /class="skip-link"[^>]*href="#main"/i, `${file} has a skip link`);
    assert.match(html, /id="main"/i, `${file} has a main landmark`);
    assert.match(
      html,
      /<nav[^>]*aria-label="[^"]+"/i,
      `${file} has a labelled navigation`,
    );
    assert.match(
      html,
      /<link[^>]*rel="stylesheet"[^>]*href="\/[^"]+"/i,
      `${file} has a root-relative stylesheet`,
    );
  }
});

test("404.html shows the not-found page and the bundle can redirect legacy paths", { skip }, () => {
  const html = readPage("404.html");
  assert.match(html, /not found|404/i);
  assert.match(html, /That page does not exist/);
  // The redirect is implemented once, in the client bundle, through legacyRouteToCanonical.
  // A second inline copy in 404.html used to exist and drifted from the router.
  const assets = readdirSync(path.join(site, "assets")).filter((name) => name.endsWith(".js"));
  const bundle = assets.map((name) => readFileSync(path.join(site, "assets", name), "utf8")).join("");
  assert.ok(bundle.includes("/document.html"), "the bundle must know the canonical document route");
  assert.ok(bundle.includes("/example.html"), "the bundle must know the canonical example route");
});

test("no page emits an unsafe URL in href or src", { skip }, () => {
  for (const file of STATIC_ROUTES) {
    const html = readPage(file);
    assert.doesNotMatch(
      html,
      /(?:href|src)\s*=\s*["']\s*(?:javascript|data|vbscript):/i,
      `${file} must not emit a javascript:, data: or vbscript: URL`,
    );
  }
});

test("the Playground is gone from every emitted page and bundle", { skip }, () => {
  for (const file of STATIC_ROUTES) {
    assert.doesNotMatch(readPage(file), /playground/i, `${file} mentions Playground`);
  }
  const assets = path.join(site, "assets");
  if (!existsSync(assets)) return;
  for (const file of readdirSync(assets).filter((name) => name.endsWith(".js"))) {
    const source = readFileSync(path.join(assets, file), "utf8");
    assert.doesNotMatch(source, /playground/i, `${file} mentions Playground`);
  }
});

test("_site has .nojekyll", { skip }, () => {
  assert.ok(existsSync(path.join(site, ".nojekyll")), "_site/.nojekyll must exist");
});

test("every page declares an icon that the build actually ships", { skip }, () => {
  // A page with no icon link makes the browser request `/favicon.ico`, which GitHub Pages
  // answers with 404 — a console error on every visit, and a best-practices deduction.
  for (const file of STATIC_ROUTES) {
    const html = readPage(file);
    assert.match(
      html,
      /<link[^>]*rel="icon"[^>]*href="\/favicon\.svg"[^>]*>/i,
      `${file} declares the root icon`,
    );
  }
  const icon = path.join(site, "favicon.svg");
  assert.ok(existsSync(icon), "the icon must be copied to the site root");
  const svg = readFileSync(icon, "utf8");
  assert.match(svg, /viewBox="0 0 32 32"/, "the icon scales without a fixed raster size");
  assert.match(svg, /<rect[^>]*rx=/, "the icon has rounded corners, not a bare square");
});

test("the two visual scripts do not write to the same directory", () => {
  // Both scripts screenshot the same routes under the same filenames. When they shared an
  // output directory the committed images were silently replaced by differently-sized ones,
  // and consecutive captures looked nondeterministic when the cause was one clobbering the
  // other. Keep their outputs distinct so that failure cannot come back quietly.
  const read = (name) => readFileSync(path.join(root, "scripts", name), "utf8");
  const dirOf = (source, declaration) => {
    const match = source.match(new RegExp(`${declaration}\\s*=\\s*join\\([^)]*"artifacts",\\s*"([^"]+)"`));
    assert.ok(match, `${declaration} must resolve an artifacts/ subdirectory`);
    return match[1];
  };
  const captured = dirOf(read("capture-screenshots.mjs"), "const out");
  const audited = dirOf(read("audit-visual.mjs"), "const OUT");
  assert.notEqual(
    audited,
    captured,
    `audit-visual.mjs writes to artifacts/${audited}, which collides with the committed screenshots`,
  );
});
