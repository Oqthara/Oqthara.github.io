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

test("every prose shell carries the reading measure", { skip }, () => {
  // `.doc-article` is the layout wrapper; `.doc` is the element that applies `--measure-prose`,
  // `--text-lead` and `--leading-doc`. Markdown pages always emit both. The tour is hand-built,
  // so nothing tied its markup to the Markdown path, and it shipped with the wrapper but not the
  // measure: prose rendered at 16px across 872px, 89 characters a line, while the stylesheet
  // comment beside it claimed "the same reading measure". A comment is not a contract. This is.
  // `tour-body` is named here because it is the other hand-built prose shell that exists today.
  const SHELLS = ["doc-article", "tour-body"];
  for (const file of htmlFiles(site)) {
    const html = readPage(file);
    for (const match of html.matchAll(/class="([^"]*)"/g)) {
      const classes = match[1].split(/\s+/).filter(Boolean);
      if (!classes.some((name) => SHELLS.includes(name))) continue;
      assert.ok(
        classes.includes("doc"),
        `${file}: <div class="${match[1]}"> holds prose but is not .doc, so it inherits no reading measure`,
      );
    }
  }
});

// --- design tokens ---------------------------------------------------------
//
// The typography and spacing scales live in `assets/site.css` as custom properties. A scale
// that is only declared is a wish: these tests read the stylesheet and hold it to the same
// contract the components are held to. Each one fails for a specific, nameable reason.

const css = readFileSync(path.join(root, "assets", "site.css"), "utf8");
// Comments in this sheet quote token names and sample values while explaining them, and a
// naive scan reads those as declarations. Strip them before parsing so the tests measure the
// rules rather than the prose about the rules.
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `--token:` declared anywhere in the sheet, mapped to its declared value. */
function declaredTokens() {
  const tokens = new Map();
  for (const match of rules.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) {
    if (!tokens.has(match[1])) tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

/** How many times `var(--token)` reads a token, as opposed to declaring it. */
function usageCount(name) {
  return [...rules.matchAll(new RegExp(`var\\(\\s*${name}\\b`, "g"))].length;
}

test("every declared design token is consumed by at least one rule", () => {
  // This is the test the spacing order actually asks for: a token system that exists only in
  // CSS and is ignored by the components is worse than no system, because it reads as done.
  // Four load-bearing tokens were dead when this was written; a rung nothing consumes is a
  // lie about the scale.
  const unreachable = [...declaredTokens()].filter(([name]) => usageCount(name) === 0);
  assert.deepEqual(
    unreachable.map(([name]) => name),
    [],
    "each token below is declared but no rule reads it with var()",
  );
});

test("the spacing ladder is an exact 4px scale with no missing rung", () => {
  // The order names twelve rungs; a scale with a hole in it is not a scale. Values are checked
  // in rem so the ladder survives a reader who sets a larger default font size.
  const expected = [4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96, 128];
  const tokens = declaredTokens();
  for (const [index, px] of expected.entries()) {
    const name = `--space-${index + 1}`;
    const value = tokens.get(name);
    assert.ok(value, `${name} must exist: the ladder runs 1-12 with no gaps`);
    const rem = value.match(/^([\d.]+)rem$/);
    assert.ok(rem, `${name} must be expressed in rem, found "${value}"`);
    assert.equal(
      Math.round(Number(rem[1]) * 16),
      px,
      `${name} must be ${px}px`,
    );
  }
});

test("each typographic role names a step of the modular scale", () => {
  // Thirteen roles, every one of them a token. The typography order asks for these by name; if
  // one is missing, the component that needed it fell back to a raw size somewhere.
  const roles = [
    "--text-display",
    "--text-page-title",
    "--text-section",
    "--text-subsection",
    "--text-body",
    "--text-secondary",
    "--text-caption",
    "--text-label",
    "--text-nav",
    "--text-button",
    "--text-inline-code",
    "--text-code",
  ];
  const tokens = declaredTokens();
  for (const role of roles) {
    assert.ok(tokens.has(role), `${role} must be declared`);
    assert.match(tokens.get(role), /var\(--step-|em$/, `${role} must resolve to the scale`);
  }
});

test("the light and dark appearances declare the same colour tokens", () => {
  // A token that exists in one appearance only is a hole a component falls through: the light
  // theme gets the intended colour and the dark theme inherits whatever :root happened to set.
  // Both light blocks (the explicit choice and the system preference) must match dark exactly.
  const block = (selector) => {
    const start = rules.indexOf(selector);
    assert.ok(start >= 0, `${selector} must exist`);
    const open = rules.indexOf("{", start);
    let depth = 0;
    let end = open;
    for (let i = open; i < rules.length; i += 1) {
      if (rules[i] === "{") depth += 1;
      else if (rules[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    return rules.slice(open, end);
  };
  // Only colour tokens are compared. A theme block may also re-declare a non-colour token
  // (print sets its own leading), and that is a different concern from a missing colour.
  const COLOUR = /^(#|rgba?\(|hsla?\(|color-mix\(|linear-gradient\(|transparent$|none$)/;
  const colours = (source) =>
    [...source.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)]
      .filter((match) => COLOUR.test(match[2].trim()))
      .map((match) => match[1])
      .sort();

  const dark = colours(block("\n:root {"));
  const light = colours(block(':root[data-theme="light"] {'));
  const system = colours(block(':root:not([data-theme="dark"]) {'));

  assert.ok(dark.length > 20, "the dark block must actually declare colour tokens");
  assert.deepEqual(light, dark, "the light theme must declare exactly the dark colour tokens");
  assert.deepEqual(system, dark, "the system light block must match the explicit light block");
});

test("no rule sets a type size or leading outside the scale", () => {
  // Raw sizes are how a scale rots: one component needs "a bit bigger" and the system stops
  // describing what the page does. Print is the documented exception -- points are a physical
  // unit and the browser's base size must not change them -- and `inherit` is a reset.
  const allowed = [/^inherit$/, /^\d+pt$/];
  const raw = [];
  for (const rule of rules.matchAll(/^\s*(font-size|line-height)\s*:\s*([^;]+);/gm)) {
    const value = rule[2].trim();
    if (value.startsWith("var(") || allowed.some((ok) => ok.test(value))) continue;
    raw.push(`${rule[1]}: ${value}`);
  }
  assert.deepEqual(raw, [], "these sizes bypass the type scale");
});

test("the code block size is not overruled by the inline code ratio", () => {
  // `code` styles every code element, including the ones inside `pre`. A ratio there compounds
  // with the block's own size and silently wins, which is how the shipped block rendered at
  // 12px while `--text-code` promised 13px. Only inline code may size itself by ratio.
  const bare = rules.match(/^code\s*\{([^}]*)\}/m);
  assert.ok(bare, "expected a bare `code` rule");
  assert.doesNotMatch(bare[1], /font-size/, "`code` must not set a size that pre then inherits");
});
