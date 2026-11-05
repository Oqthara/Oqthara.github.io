import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  DocsError,
  __resetCacheForTests,
  loadCatalog,
  loadDocument,
  loadText,
  titleFromMarkdown,
  validateCatalog,
} from "../src/github-docs.js";

const CATALOG = {
  schema: 1,
  docs: [
    {
      path: "docs/spec/language.md",
      title: "Language",
      section: "spec",
      slug: "docs/spec/language",
    },
    { path: "docs/adr/0001.md", title: "One", section: "adr", slug: "docs/adr/0001" },
  ],
};

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    return handler(url, options);
  };
  return calls;
}

const respond = (body) => ({
  ok: true,
  status: 200,
  text: async () => body,
  json: async () => JSON.parse(body),
});

beforeEach(() => {
  __resetCacheForTests();
  delete globalThis.fetch;
});

test("loads and validates the catalog", async () => {
  stubFetch(() => respond(JSON.stringify(CATALOG)));
  const catalog = await loadCatalog("main");
  assert.equal(catalog.docs.length, 2);
  assert.equal(catalog.docs[0].path, "docs/spec/language.md");
});

test("the catalog request targets the raw main URL", async () => {
  const calls = stubFetch(() => respond(JSON.stringify(CATALOG)));
  await loadCatalog("main");
  assert.equal(
    calls[0],
    "https://raw.githubusercontent.com/Oqthara/oqthara/main/docs/catalog.json",
  );
});

test("rejects a catalog that is not JSON", async () => {
  stubFetch(() => ({
    ok: true,
    status: 200,
    text: async () => "not json",
    json: async () => {
      throw new SyntaxError("bad");
    },
  }));
  await assert.rejects(() => loadCatalog("main"), DocsError);
});

test("rejects an unsupported catalog schema", async () => {
  assert.throws(
    () => validateCatalog({ schema: 99, docs: CATALOG.docs }),
    /Unsupported documentation catalog schema/,
  );
});

test("rejects a catalog with no documents", async () => {
  assert.throws(() => validateCatalog({ schema: 1, docs: [] }), /no documents/);
});

test("rejects a catalog entry with an invalid path", async () => {
  assert.throws(
    () => validateCatalog({ schema: 1, docs: [{ path: "README.md", title: "x" }] }),
    /invalid path/,
  );
});

test("rejects a catalog entry with no title", async () => {
  assert.throws(
    () => validateCatalog({ schema: 1, docs: [{ path: "docs/a.md", title: "  " }] }),
    /has no title/,
  );
});

test("two loads of the same document make one request", async () => {
  const calls = stubFetch(() => respond("# Title\n"));
  await loadDocument("main", "docs/spec/language.md");
  await loadDocument("main", "docs/spec/language.md");
  assert.equal(calls.length, 1);
});

test("concurrent loads share one request", async () => {
  const calls = stubFetch(
    () => new Promise((resolve) => setTimeout(() => resolve(respond("# Title\n")), 10)),
  );
  await Promise.all([
    loadDocument("main", "docs/spec/language.md"),
    loadDocument("main", "docs/spec/language.md"),
    loadDocument("main", "docs/spec/language.md"),
  ]);
  assert.equal(calls.length, 1);
});

test("a different ref is a different cache entry", async () => {
  const calls = stubFetch(() => respond("# Title\n"));
  await loadDocument("main", "docs/spec/language.md");
  await loadDocument("v0.1.0-alpha.1", "docs/spec/language.md");
  assert.equal(calls.length, 2);
  assert.match(calls[1], /v0\.1\.0-alpha\.1/);
});

test("a 404 produces a DocsError carrying the GitHub URL", async () => {
  stubFetch(() => ({ ok: false, status: 404, text: async () => "" }));
  await assert.rejects(
    () => loadDocument("main", "docs/spec/missing.md"),
    (error) => {
      assert.ok(error instanceof DocsError);
      assert.equal(error.status, 404);
      assert.equal(
        error.url,
        "https://github.com/Oqthara/oqthara/blob/main/docs/spec/missing.md",
      );
      return true;
    },
  );
});

test("a failed request is not cached, so a retry refetches", async () => {
  let attempt = 0;
  const calls = stubFetch(() => {
    attempt += 1;
    if (attempt === 1) return Promise.reject(new Error("offline"));
    return respond("# Title\n");
  });
  await assert.rejects(() => loadDocument("main", "docs/spec/language.md"), DocsError);
  const doc = await loadDocument("main", "docs/spec/language.md");
  assert.match(doc.markdown, /Title/);
  assert.equal(calls.length, 2);
});

test("a document reports its title, path and source URL", async () => {
  stubFetch(() => respond("# The Language\n\nbody\n"));
  const doc = await loadDocument("main", "docs/spec/language.md");
  assert.equal(doc.title, "The Language");
  assert.equal(doc.path, "docs/spec/language.md");
  assert.equal(
    doc.sourceUrl,
    "https://github.com/Oqthara/oqthara/blob/main/docs/spec/language.md",
  );
});

test("a non-Markdown path is rejected before any request", async () => {
  const calls = stubFetch(() => respond(""));
  await assert.rejects(() => loadDocument("main", "docs/catalog.json"), DocsError);
  assert.equal(calls.length, 0);
});

test("the changelog is fetched from the repository root", async () => {
  const calls = stubFetch(() => respond("# Changelog\n"));
  const changes = await loadText("main", "CHANGELOG.md");
  assert.equal(
    calls[0],
    "https://raw.githubusercontent.com/Oqthara/oqthara/main/CHANGELOG.md",
  );
  assert.match(changes, /Changelog/);
});

test("titleFromMarkdown ignores headings inside fenced code", () => {
  assert.equal(titleFromMarkdown("```\n# not a title\n```\n\n# Real Title\n"), "Real Title");
  assert.equal(titleFromMarkdown("no headings here\n"), "");
});
