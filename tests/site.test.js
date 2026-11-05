// Integration tests for the built site.
//
// The suite runs in plain Node with no DOM: the guarantees worth pinning are about the
// bytes that ship. Documentation is fetched from GitHub at request time, so these tests
// assert the shells, the absence of copied Markdown and the safety of every published URL
// rather than documentation bodies that are no longer built in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "..", "_site");
const hasBuild = existsSync(join(site, "index.html"));

const STATIC = [
  "index.html",
  "tour.html",
  "docs.html",
  "examples.html",
  "stdlib.html",
  "changelog.html",
  "status.html",
];

const page = (file) => readFileSync(join(site, file), "utf8");
const textOf = (html) =>
  html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("every static route is prerendered with real content", { skip: !hasBuild && "run `npm run build` first" }, () => {
  // Routes whose content is fetched from GitHub at request time prerender a loading state
  // and its explanation, not the document. That is the design, not an empty page.
  const markers = {
    "index.html": "pseudocode",
    "tour.html": "Learn Oqthara in one sitting",
    "docs.html": "Documentation",
    "examples.html": "Complete programs",
    "stdlib.html": "Standard library",
    "changelog.html": "Project history",
    "status.html": "What does not work yet",
  };
  for (const file of STATIC) {
    const html = page(file);
    assert.equal((html.match(/<div id="root">/g) || []).length, 1, `${file}: one root container`);
    assert.ok(textOf(html).includes(markers[file]), `${file}: expected "${markers[file]}"`);
    // A shell is allowed to be shorter, but it must still explain itself.
    assert.ok(textOf(html).length > 200, `${file}: content looks empty`);
  }
});

test("internal links are root-relative and never use the retired project path", { skip: !hasBuild && "run `npm run build` first" }, () => {
  for (const file of [...STATIC, "404.html"]) {
    for (const match of page(file).matchAll(/href="(\/[^"]*)"/g)) {
      assert.ok(match[1].startsWith("/"), `${file}: ${match[1]} must be root-relative`);
      assert.ok(!match[1].startsWith("/oqthara/"), `${file}: ${match[1]} uses the retired path`);
    }
  }
});

test("every internal link resolves to a real file", { skip: !hasBuild && "run `npm run build` first" }, () => {
  for (const file of [...STATIC, "404.html"]) {
    for (const match of page(file).matchAll(/href="(\/[^"]*)"/g)) {
      const relative = match[1].split("?")[0].slice(1);
      if (relative === "") continue;
      assert.ok(existsSync(join(site, relative)), `${file}: ${match[1]} does not exist`);
    }
  }
});

test("no published page contains an unsafe URL scheme", { skip: !hasBuild && "run `npm run build` first" }, () => {
  for (const file of readdirSync(site).filter((name) => name.endsWith(".html"))) {
    const html = page(file);
    assert.ok(!/(?:href|src)="\s*(?:javascript|data|vbscript):/i.test(html), `${file}: unsafe scheme`);
  }
});

test("documentation is not copied into the site", { skip: !hasBuild && "run `npm run build` first" }, () => {
  assert.ok(!existsSync(join(site, "docs/spec/language.md")), "specification Markdown must not be copied");
  assert.ok(!existsSync(join(site, "stdlib.md")), "the stdlib reference must not be copied");
  assert.ok(!existsSync(join(here, "..", "content", "changelog.md")), "the changelog must not be snapshotted");
});

test("documentation shells point at the canonical source", { skip: !hasBuild && "run `npm run build` first" }, () => {
  const shell = join(site, "docs", "spec", "language.html");
  assert.ok(existsSync(shell), "the specification shell must exist for a deep link");
  const html = readFileSync(shell, "utf8");
  assert.ok(
    html.includes("https://github.com/Oqthara/oqthara/blob/main/docs/spec/language.md"),
    "the shell must link the original document",
  );
  assert.ok(!/<article class="doc">/.test(html), "the shell must not claim to contain the document");
});

test("accessibility structure is present on every page", { skip: !hasBuild && "run `npm run build` first" }, () => {
  for (const file of [...STATIC, "404.html"]) {
    const html = page(file);
    assert.ok(html.includes('class="skip-link"'), `${file}: skip link`);
    assert.ok(html.includes('href="#main"'), `${file}: skip link target`);
    assert.ok(html.includes('<main id="main">'), `${file}: main landmark`);
    assert.ok(html.includes('<header class="site">'), `${file}: header landmark`);
    assert.ok(html.includes('aria-label="Main"'), `${file}: labelled nav`);
    assert.ok(html.includes('lang="en"'), `${file}: language`);
  }
});

test("the current page is marked in the navigation", { skip: !hasBuild && "run `npm run build` first" }, () => {
  const html = page("tour.html");
  assert.ok(
    /aria-current="page"[^>]*>Tour</.test(html) || /href="\/tour.html"[^>]*aria-current="page"/.test(html),
    "the tour link must be marked as the current page",
  );
  assert.ok(!/aria-current="page"[^>]*>Docs</.test(html), "only one link may be current");
});

test("no placeholder or template leakage ships", { skip: !hasBuild && "run `npm run build` first" }, () => {
  for (const file of [...STATIC, "404.html"]) {
    const html = page(file);
    assert.ok(!html.includes("${"), `${file}: template literal leaked`);
    assert.ok(!html.includes("__REFERENCE__"), `${file}: reference placeholder leaked`);
  }
});

test("the 404 page is a real page, not the home page", { skip: !hasBuild && "run `npm run build` first" }, () => {
  const html = page("404.html");
  assert.ok(textOf(html).includes("does not exist"), "404.html must say the page is missing");
});
