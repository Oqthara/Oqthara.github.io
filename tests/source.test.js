import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REF,
  documentRoute,
  exampleRoute,
  parseQuery,
  normalizePath,
  normalizeRepoPath,
  isDocumentPath,
  isExamplePath,
  isRenderablePath,
  rawUrl,
  blobUrl,
  treeUrl,
  treeApiUrl,
  releasesApiUrl,
  sectionForPath,
  sectionTitle,
  titleFromPath,
  titleFromMarkdown,
  resolveRelative,
  resolveImage,
  safeUrl,
  legacyRouteToCanonical,
  isLegacyContentRoute,
  docsIndexUrl,
} from "../src/source.js";

test("documentRoute builds the canonical document URL with an encoded path and ref", () => {
  assert.equal(
    documentRoute("docs/spec/language.md", "main"),
    "/document.html?path=docs%2Fspec%2Flanguage.md&ref=main",
  );
  assert.equal(
    documentRoute("docs/guides/a b.md", "v0.1.0-alpha.1"),
    "/document.html?path=docs%2Fguides%2Fa%20b.md&ref=v0.1.0-alpha.1",
  );
  // A ref containing a slash must not escape the query parameter.
  assert.equal(
    documentRoute("docs/a.md", "feature/next"),
    "/document.html?path=docs%2Fa.md&ref=feature%2Fnext",
  );
});

test("exampleRoute builds the canonical example URL with an encoded path and ref", () => {
  assert.equal(
    exampleRoute("examples/basics/hello.oq", "main"),
    "/example.html?path=examples%2Fbasics%2Fhello.oq&ref=main",
  );
  assert.equal(
    exampleRoute("examples/a b.oq", "v1"),
    "/example.html?path=examples%2Fa%20b.oq&ref=v1",
  );
});

test("parseQuery round-trips a canonical route and defaults ref to main", () => {
  const route = documentRoute("docs/adr/0003-bytecode.md", "v0.1.0-alpha.2");
  const query = route.slice(route.indexOf("?"));
  assert.deepEqual(parseQuery(query), {
    path: "docs/adr/0003-bytecode.md",
    ref: "v0.1.0-alpha.2",
  });

  assert.deepEqual(parseQuery("?path=docs/a.md"), { path: "docs/a.md", ref: DEFAULT_REF });
  assert.deepEqual(parseQuery("path=docs/a.md&ref="), { path: "docs/a.md", ref: DEFAULT_REF });
});

test("parseQuery strips a leading ? and normalizes ./ and backslashes", () => {
  assert.deepEqual(parseQuery("?path=./docs/a.md&ref=main"), { path: "docs/a.md", ref: "main" });
  assert.deepEqual(parseQuery("?path=docs\\spec\\language.md&ref=main"), {
    path: "docs/spec/language.md",
    ref: "main",
  });
  assert.deepEqual(parseQuery("?path=./docs/a.md&ref=main"), { path: "docs/a.md", ref: "main" });
  assert.deepEqual(parseQuery(""), { path: "", ref: "main" });
});

test("traversal cannot climb out of docs/", () => {
  const parsed = parseQuery("?path=../../etc/passwd");
  assert.equal(isDocumentPath(parsed.path), false);
  assert.equal(isExamplePath(parsed.path), false);

  // normalizePath drops leading `..` when there is nothing to pop.
  assert.equal(normalizePath("docs/../../x"), "x");
  assert.equal(normalizePath("../../etc/passwd"), "etc/passwd");
  assert.equal(normalizePath("docs/a/../b.md"), "docs/b.md");

  for (const candidate of ["../../etc/passwd", "docs/../../../etc/passwd", "/etc/passwd"]) {
    assert.equal(isDocumentPath(candidate), false);
    assert.equal(isRenderablePath(candidate), false);
  }
});

test("isDocumentPath accepts only docs/**/*.md", () => {
  assert.equal(isDocumentPath("docs/a.md"), true);
  assert.equal(isDocumentPath("docs/x/y/z.md"), true);
  assert.equal(isDocumentPath("docs/a.MD"), true); // case-insensitive extension
  assert.equal(isDocumentPath("docs/a.txt"), false);
  assert.equal(isDocumentPath("README.md"), false);
  assert.equal(isDocumentPath("docs/../x.md"), false);
  assert.equal(isDocumentPath(""), false);
  assert.equal(isDocumentPath("examples/a.md"), false);
});

test("isExamplePath accepts only examples/**/*.oq", () => {
  assert.equal(isExamplePath("examples/a.oq"), true);
  assert.equal(isExamplePath("examples/sub/a.oq"), true);
  assert.equal(isExamplePath("docs/a.oq"), false);
  assert.equal(isExamplePath("examples/a.md"), false);
  assert.equal(isExamplePath("examples/a.txt"), false);
  assert.equal(isExamplePath(""), false);
});

test("rawUrl, blobUrl, treeUrl and the API URLs encode refs and paths", () => {
  assert.equal(
    rawUrl("docs/a b.md", "v1.0/rc"),
    "https://raw.githubusercontent.com/Oqthara/oqthara/v1.0%2Frc/docs/a%20b.md",
  );
  assert.equal(
    blobUrl("docs/a#b.md", "main"),
    "https://github.com/Oqthara/oqthara/blob/main/docs/a%23b.md",
  );
  assert.equal(
    treeUrl("docs/spec", "v1"),
    "https://github.com/Oqthara/oqthara/tree/v1/docs/spec",
  );
  assert.equal(
    treeApiUrl("v0.1.0-alpha.1"),
    "https://api.github.com/repos/Oqthara/oqthara/git/trees/v0.1.0-alpha.1?recursive=1",
  );
  assert.match(treeApiUrl("main"), /\/git\/trees\/main\?recursive=1$/);
  assert.equal(releasesApiUrl(10), "https://api.github.com/repos/Oqthara/oqthara/releases?per_page=10");
  assert.equal(docsIndexUrl("main"), "https://github.com/Oqthara/oqthara/tree/main/docs");
});

test("sectionForPath derives sections without a per-file table", () => {
  assert.equal(sectionForPath("docs/README.md"), "Overview");
  assert.equal(sectionForPath("docs/spec/language.md"), "Specification");
  assert.equal(sectionForPath("docs/adr/x.md"), "Decision records");
  assert.equal(sectionForPath("docs/reference/cli.md"), "Reference");
  assert.equal(sectionForPath("docs/my-guides/a.md"), "My guides");
  assert.equal(sectionForPath("README.md"), "Other");
  assert.equal(sectionTitle("stdlib"), "Standard library");
  assert.equal(sectionTitle("unknown"), "Unknown");
});

test("titleFromPath gives a readable name before Markdown is read", () => {
  assert.equal(titleFromPath("docs/adr/0003-bytecode.md"), "Bytecode");
  assert.equal(titleFromPath("README.md"), "Overview");
  assert.equal(titleFromPath("docs/README.md"), "Docs overview");
  assert.equal(titleFromPath("docs/spec/README.md"), "Specification overview");
  assert.equal(titleFromPath("examples/anagrams.oq"), "Anagrams");
  assert.equal(titleFromPath("docs/spec/language-reference.md"), "Language reference");
});

test("titleFromMarkdown finds the first h1 and ignores headings inside fences", () => {
  const markdown = [
    "```md",
    "# Not the title",
    "```",
    "",
    "# The Real Title",
    "",
    "## A section",
  ].join("\n");
  assert.equal(titleFromMarkdown(markdown), "The Real Title");
  assert.equal(titleFromMarkdown("no heading here"), "");
  assert.equal(titleFromMarkdown("~~~\n# fenced\n~~~\n# After"), "After");
  assert.equal(titleFromMarkdown("## second level only"), "");
});

test("resolveRelative builds canonical document routes and preserves the ref", () => {
  assert.equal(
    resolveRelative("docs/adr/0001-x.md", "../spec/language.md", "v0.1.0-alpha.2"),
    "/document.html?path=docs%2Fspec%2Flanguage.md&ref=v0.1.0-alpha.2",
  );
  assert.equal(
    resolveRelative("docs/spec/language.md", "../../docs/adr/0003-bytecode.md", "main"),
    "/document.html?path=docs%2Fadr%2F0003-bytecode.md&ref=main",
  );
  assert.equal(
    resolveRelative("docs/adr/x.md", "../spec/language.md#grammar", "main"),
    "/document.html?path=docs%2Fspec%2Flanguage.md&ref=main#grammar",
  );
});

test("resolveRelative handles changelog, examples, unrendered files and external URLs", () => {
  assert.equal(resolveRelative("README.md", "CHANGELOG.md", "v1"), "/changelog.html");
  assert.equal(resolveRelative("docs/a.md", "../CHANGELOG.md#v010", "main"), "/changelog.html#v010");
  assert.equal(
    resolveRelative("README.md", "./examples/basics/hello.oq", "v2"),
    "/example.html?path=examples%2Fbasics%2Fhello.oq&ref=v2",
  );
  assert.equal(
    resolveRelative("docs/a.md", "LICENSE", "main"),
    "https://github.com/Oqthara/oqthara/blob/main/docs/LICENSE",
  );
  assert.equal(resolveRelative("docs/a.md", "https://example.com/x", "main"), "https://example.com/x");
  assert.equal(resolveRelative("docs/a.md", "#local", "main"), "#local");
  assert.equal(resolveRelative("docs/a.md", "javascript:alert(1)", "main"), null);
  assert.equal(resolveRelative("docs/a.md", "?path=docs/a.md", "main"), "?path=docs/a.md");
});

test("resolveImage sends relative images to the raw CDN and keeps absolute ones", () => {
  assert.equal(
    resolveImage("docs/adr/0001-x.md", "../assets/diagram.png", "v1"),
    "https://raw.githubusercontent.com/Oqthara/oqthara/v1/docs/assets/diagram.png",
  );
  assert.equal(resolveImage("docs/a.md", "https://cdn.example/x.png", "main"), "https://cdn.example/x.png");
  assert.equal(resolveImage("docs/a.md", "javascript:alert(1)", "main"), null);
  assert.equal(resolveImage("docs/a.md", "mailto:x@y.z", "main"), null);
});

test("safeUrl rejects script-bearing schemes and accepts safe ones", () => {
  for (const unsafe of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "\u0000javascript:alert(1)",
  ]) {
    assert.equal(safeUrl(unsafe), null, `${JSON.stringify(unsafe)} must be rejected`);
  }
  for (const safe of [
    "https://example.com",
    "http://example.com",
    "mailto:team@example.com",
    "#anchor",
    "?path=docs/a.md",
    "docs/a.md",
    "../a.md",
    "",
  ]) {
    if (safe === "") assert.equal(safeUrl(safe), null);
    else assert.equal(safeUrl(safe), safe);
  }
});

test("legacyRouteToCanonical preserves old links and their ref", () => {
  assert.equal(
    legacyRouteToCanonical("/docs/spec/language.html"),
    "/document.html?path=docs%2Fspec%2Flanguage.md&ref=main",
  );
  assert.equal(
    legacyRouteToCanonical("/docs/spec/language.html", "?ref=v0.1.0-alpha.1"),
    "/document.html?path=docs%2Fspec%2Flanguage.md&ref=v0.1.0-alpha.1",
  );
  assert.equal(
    legacyRouteToCanonical("/docs/spec/language.html#grammar", "?ref=v0.1.0-alpha.1"),
    "/document.html?path=docs%2Fspec%2Flanguage.md&ref=v0.1.0-alpha.1",
  );
  assert.equal(
    legacyRouteToCanonical("/examples/anagrams.html", "?ref=v1"),
    "/example.html?path=examples%2Fanagrams.oq&ref=v1",
  );
  // Encoded legacy paths are decoded before mapping.
  assert.equal(
    legacyRouteToCanonical("/docs/guides/a%20b.html"),
    "/document.html?path=docs%2Fguides%2Fa%20b.md&ref=main",
  );
  for (const junk of ["/about.html", "/docs/", "/docs/a.txt", "/examples/a.md", "nonsense"]) {
    assert.equal(legacyRouteToCanonical(junk), null, `${junk} should not map`);
  }
});

test("isLegacyContentRoute recognises /docs/** and /examples/**", () => {
  assert.equal(isLegacyContentRoute("/docs/spec/language.html"), true);
  assert.equal(isLegacyContentRoute("/examples/anagrams.html"), true);
  assert.equal(isLegacyContentRoute("/docs/a/b/c"), true);
  assert.equal(isLegacyContentRoute("/document.html"), false);
  assert.equal(isLegacyContentRoute("/docs"), false);
  assert.equal(isLegacyContentRoute("/"), false);
});

test("normalizeRepoPath is conservative but predictable", () => {
  assert.equal(normalizeRepoPath("/docs/a.md"), "docs/a.md");
  assert.equal(normalizeRepoPath("./docs/a.md"), "docs/a.md");
  assert.equal(normalizeRepoPath("docs\\a.md"), "docs/a.md");
  assert.equal(normalizeRepoPath(null), "");
});
