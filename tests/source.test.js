import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANNELS,
  blobUrl,
  channelById,
  rawUrl,
  resolveImage,
  resolveRelative,
  routeForDocPath,
  safeUrl,
} from "../src/source.js";
import { CATALOG_PATH } from "../src/github-docs.js";

test("the catalog path is repository-relative", () => {
  assert.equal(CATALOG_PATH, "docs/catalog.json");
});

test("main resolves to the main branch", () => {
  assert.equal(
    rawUrl("docs/spec/language.md", "main"),
    "https://raw.githubusercontent.com/Oqthara/oqthara/main/docs/spec/language.md",
  );
});

test("a release channel resolves to its tag, not to main", () => {
  const release = channelById("0.1.0-alpha.1");
  assert.equal(release.ref, "v0.1.0-alpha.1");
  const url = rawUrl("docs/spec/language.md", release.ref);
  assert.match(url, /\/v0\.1\.0-alpha\.1\//);
  assert.ok(!url.includes("/main/"));
});

test("an unknown channel falls back to development", () => {
  assert.equal(channelById("nope").id, "main");
});

test("every channel has a tag ref except main", () => {
  for (const channel of CHANNELS) {
    if (channel.id === "main") {
      assert.equal(channel.ref, "main");
    } else {
      assert.match(channel.ref, /^v\d+\.\d+\.\d+/);
    }
  }
});

test("blob URLs point at GitHub", () => {
  assert.equal(
    blobUrl("CHANGELOG.md", "main"),
    "https://github.com/Oqthara/oqthara/blob/main/CHANGELOG.md",
  );
});

test("routes replace .md with .html", () => {
  assert.equal(routeForDocPath("docs/spec/language.md"), "/docs/spec/language.html");
});

test("relative links resolve against the containing document", () => {
  assert.equal(
    resolveRelative("docs/adr/0009-x.md", "../spec/language.md", "main"),
    "/docs/spec/language.html",
  );
  assert.equal(
    resolveRelative("docs/spec/language.md", "backend.md", "main"),
    "/docs/spec/backend.html",
  );
});

test("relative links keep their fragment", () => {
  assert.equal(
    resolveRelative("docs/spec/design.md", "language.md#types", "main"),
    "/docs/spec/language.html#types",
  );
});

test("a relative non-Markdown file becomes a GitHub blob URL at the same ref", () => {
  assert.equal(
    resolveRelative("docs/spec/design.md", "diagram.svg", "v0.1.0-alpha.1"),
    "https://github.com/Oqthara/oqthara/blob/v0.1.0-alpha.1/docs/spec/diagram.svg",
  );
});

test("a relative Markdown link on a pinned channel keeps the channel", () => {
  const target = resolveRelative("docs/spec/language.md", "backend.md", "v0.1.0-alpha.1");
  assert.match(target, /^\/docs\/spec\/backend\.html/);
  assert.match(target, /ref=v0\.1\.0-alpha\.1/);
});

test("in-page fragments pass through", () => {
  assert.equal(resolveRelative("docs/spec/language.md", "#syntax"), "#syntax");
});

test("a site-absolute path is resolved against the document, not the site root", () => {
  // A leading slash in a repository Markdown file means the repository root on GitHub, so
  // it must not be reinterpreted as a site route.
  assert.equal(
    resolveRelative("docs/spec/language.md", "/docs.html"),
    "https://github.com/Oqthara/oqthara/blob/main/docs/spec/docs.html",
  );
});

test("unsafe schemes are rejected before they reach a link", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "data:text/html;base64,AAAA",
    "vbscript:msgbox",
  ]) {
    assert.equal(safeUrl(bad), null, bad);
    assert.equal(resolveRelative("docs/spec/language.md", bad), null, bad);
  }
});

test("safe schemes are allowed", () => {
  for (const good of ["https://oqthara.github.io/", "http://example.com", "mailto:a@b.c", "#x", "../a.md"]) {
    assert.equal(safeUrl(good), good, good);
  }
});

test("images resolve relative to the document and reject unsafe sources", () => {
  assert.equal(
    resolveImage("docs/spec/design.md", "img/a.png", "main"),
    "https://raw.githubusercontent.com/Oqthara/oqthara/main/docs/spec/img/a.png",
  );
  assert.equal(resolveImage("docs/spec/design.md", "javascript:alert(1)", "main"), null);
});
