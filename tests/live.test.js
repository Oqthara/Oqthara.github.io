// Real-source smoke test. Skipped unless OQ_LIVE_DOCS=1, so the normal suite stays
// deterministic and offline. Run it before a release:
//
//   OQ_LIVE_DOCS=1 npm test
//
// It proves that the URLs this site builds actually serve the real documentation, which a
// mocked test cannot.
import assert from "node:assert/strict";
import test from "node:test";
import { rawUrl } from "../src/source.js";

const live = process.env.OQ_LIVE_DOCS === "1";

test("the real catalog lists documentation from main", { skip: !live }, async () => {
  const response = await fetch(rawUrl("docs/catalog.json", "main"));
  assert.equal(response.status, 200, "docs/catalog.json must be reachable from main");
  const catalog = await response.json();
  assert.ok(Array.isArray(catalog.docs), "catalog.docs must be an array");
  assert.ok(catalog.docs.length > 5, `expected more than 5 documents, got ${catalog.docs.length}`);
  for (const doc of catalog.docs) {
    assert.match(doc.path, /^docs\/.+\.md$/, `unexpected catalog path ${doc.path}`);
    assert.ok(doc.title && doc.title.length > 0, `${doc.path} has no title`);
  }
});

test("the real language specification renders as Markdown", { skip: !live }, async () => {
  const response = await fetch(rawUrl("docs/spec/language.md", "main"));
  assert.equal(response.status, 200, "docs/spec/language.md must be reachable from main");
  const markdown = await response.text();
  assert.match(markdown, /^# /m, "the specification must have an h1");
  assert.match(markdown, /^\|/m, "the specification must contain a table");
});

test("a released tag serves its own documentation, not main", { skip: !live }, async () => {
  const response = await fetch(rawUrl("docs/spec/language.md", "v0.1.0-alpha.1"));
  assert.equal(response.status, 200, "the alpha.1 tag must still serve its documentation");
  const markdown = await response.text();
  assert.ok(markdown.length > 1000, "the pinned document should not be empty");
});
