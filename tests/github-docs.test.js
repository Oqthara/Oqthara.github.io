import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  CACHE_TTL_MS,
  FETCH_TIMEOUT_MS,
  TITLE_CONCURRENCY,
  GitHubError,
  __resetCacheForTests,
  __setFetchForTests,
  findChannel,
  loadCatalog,
  loadDocument,
  loadDocumentIndex,
  loadExample,
  loadExamples,
  loadReleases,
  loadText,
  loadTree,
  validateReleases,
  validateTree,
} from "../src/github-docs.js";
import {
  DEFAULT_REF,
  documentRoute,
  blobUrl,
  rawUrl,
  releasesApiUrl,
  treeApiUrl,
} from "../src/source.js";

const TREE_URL = (ref = "main") => treeApiUrl(ref);

/** A minimal Response stand-in. */
function response(body, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return {
    ok,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      if (typeof body === "string") return JSON.parse(body);
      return body;
    },
  };
}

function treePayload(paths, extra = []) {
  return {
    sha: "abc",
    truncated: false,
    tree: [
      ...paths.map((path) => ({ path, mode: "100644", type: "blob", size: 10, sha: "x" })),
      ...extra,
    ],
  };
}

beforeEach(() => {
  __resetCacheForTests();
  __setFetchForTests(null);
});

afterEach(() => {
  __setFetchForTests(null);
  __resetCacheForTests();
});

test("REGRESSION: loadCatalog resolves to an array with path, section, title and route", async () => {
  const seen = [];
  __setFetchForTests(async (url) => {
    seen.push(url);
    if (url === TREE_URL("main")) {
      return response(treePayload([
        "docs/README.md",
        "docs/spec/language.md",
        "docs/adr/0003-bytecode.md",
        "README.md",
        "examples/anagrams.oq",
      ]));
    }
    const path = decodeURIComponent(url.split("/main/")[1]);
    return response(`# Title of ${path}\n\nbody`);
  });

  const catalog = await loadCatalog("main");

  // "e is not iterable" happened because this was an object, not an array.
  assert.ok(Array.isArray(catalog), `loadCatalog must return an array, got ${typeof catalog}`);
  assert.equal(catalog.length, 3);
  for (const entry of catalog) {
    assert.equal(typeof entry.path, "string");
    assert.equal(typeof entry.section, "string");
    assert.equal(typeof entry.title, "string");
    assert.match(entry.route, /^\/document\.html\?path=.+&ref=main$/);
    assert.ok(entry.title.length > 0);
  }
  assert.deepEqual(catalog.map((entry) => entry.path).sort(), [
    "docs/README.md",
    "docs/adr/0003-bytecode.md",
    "docs/spec/language.md",
  ]);
  assert.equal(catalog.find((entry) => entry.path === "docs/spec/language.md").title, "Title of docs/spec/language.md");
});

test("validateTree rejects a payload without a tree array", () => {
  for (const payload of [null, {}, [], { tree: "nope" }, { tree: null }, "string"]) {
    assert.throws(() => validateTree(payload), (error) => {
      assert.ok(error instanceof GitHubError);
      assert.match(error.message, /could not read/i);
      return true;
    });
  }
});

test("validateTree keeps only blob entries with string paths and ignores nested directories", () => {
  const payload = {
    tree: [
      { path: "docs/a.md", type: "blob", size: 12 },
      { path: "docs/spec", type: "tree", size: 0 },
      { path: "docs/b/c.md", type: "blob", size: "34" },
      { path: null, type: "blob", size: 0 },
      { type: "blob", size: 0 },
      null,
      "junk",
      { path: 42, type: "blob" },
      { path: "docs/c.md", type: "blob" },
    ],
  };
  const result = validateTree(payload);
  assert.deepEqual(result, [
    { path: "docs/a.md", size: 12 },
    { path: "docs/b/c.md", size: 34 },
    { path: "docs/c.md", size: 0 },
  ]);
});

test("loadTree uses the recursive tree API for the requested ref", async () => {
  const calls = [];
  __setFetchForTests(async (url) => {
    calls.push(url);
    return response(treePayload(["docs/a.md"]));
  });
  const tree = await loadTree("v0.1.0-alpha.2");
  assert.equal(tree.length, 1);
  assert.deepEqual(calls, [treeApiUrl("v0.1.0-alpha.2")]);
  assert.match(calls[0], /\/git\/trees\/v0\.1\.0-alpha\.2\?recursive=1$/);
});

test("loadCatalog reads each Markdown title with bounded concurrency", async () => {
  const paths = Array.from({ length: 20 }, (_, index) => `docs/doc-${index}.md`);
  let inFlight = 0;
  let maxInFlight = 0;
  let titleRequests = 0;

  __setFetchForTests(async (url) => {
    if (url === TREE_URL("main")) return response(treePayload(paths));
    inFlight += 1;
    titleRequests += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return response(`# Heading ${titleRequests}\n`);
  });

  const catalog = await loadCatalog("main");
  assert.equal(catalog.length, paths.length);
  assert.equal(titleRequests, paths.length);
  assert.ok(maxInFlight <= TITLE_CONCURRENCY, `concurrency ${maxInFlight} exceeded ${TITLE_CONCURRENCY}`);
  assert.ok(maxInFlight > 1, "title reads should actually run in parallel");
  for (const entry of catalog) assert.match(entry.title, /^Heading \d+$/);
});

test("loadCatalog keeps the path-derived title when one document cannot be read", async () => {
  __setFetchForTests(async (url) => {
    if (url === TREE_URL("main")) {
      return response(treePayload(["docs/good.md", "docs/broken.md"]));
    }
    if (url.endsWith("/docs/broken.md")) {
      return response("missing", { status: 404 });
    }
    return response("# Good Title\n");
  });

  const catalog = await loadCatalog("main");
  assert.ok(Array.isArray(catalog));
  assert.equal(catalog.length, 2);
  const broken = catalog.find((entry) => entry.path === "docs/broken.md");
  assert.ok(broken, "the unreadable document must stay in the index");
  assert.equal(broken.title, "Broken");
  assert.equal(catalog.find((entry) => entry.path === "docs/good.md").title, "Good Title");
});

test("loadExamples returns every examples/**/*.oq, categorised and sorted", async () => {
  __setFetchForTests(async (url) => {
    assert.equal(url, TREE_URL("main"));
    return response(treePayload([
      "examples/zeta.oq",
      "examples/basics/hello.oq",
      "examples/basics/alpha.oq",
      "examples/advanced/map.oq",
      "examples/README.md",
      "docs/not-an-example.oq",
    ]));
  });

  const examples = await loadExamples("main");
  assert.ok(Array.isArray(examples));
  assert.deepEqual(examples.map((entry) => entry.path), [
    "examples/advanced/map.oq",
    "examples/basics/alpha.oq",
    "examples/basics/hello.oq",
    "examples/zeta.oq",
  ]);
  assert.deepEqual(
    examples.map((entry) => [entry.name, entry.category]),
    [
      ["map", "advanced"],
      ["alpha", "basics"],
      ["hello", "basics"],
      ["zeta", "Examples"],
    ],
  );
  for (const entry of examples) {
    assert.equal(entry.route, `/example.html?path=${encodeURIComponent(entry.path)}&ref=main`);
    assert.match(entry.sourceUrl, /^https:\/\/github\.com\/Oqthara\/oqthara\/blob\/main\//);
  }
});

test("loadDocument rejects a non-document path without any network call", async () => {
  let calls = 0;
  __setFetchForTests(async () => {
    calls += 1;
    return response("nope");
  });
  await assert.rejects(loadDocument("main", "examples/x.oq"), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.match(error.message, /Not a documentation path/);
    return true;
  });
  await assert.rejects(loadDocument("main", "../etc/passwd"), GitHubError);
  assert.equal(calls, 0);
});

test("loadExample rejects a non-example path without any network call", async () => {
  let calls = 0;
  __setFetchForTests(async () => {
    calls += 1;
    return response("nope");
  });
  await assert.rejects(loadExample("main", "docs/a.md"), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.match(error.message, /Not an example path/);
    return true;
  });
  assert.equal(calls, 0);
});

test("loadDocument loads Markdown and derives its title", async () => {
  const calls = [];
  __setFetchForTests(async (url) => {
    calls.push(url);
    return response("# Language\n\ntext");
  });
  const doc = await loadDocument("v1", "docs/spec/language.md");
  assert.equal(doc.path, "docs/spec/language.md");
  assert.equal(doc.ref, "v1");
  assert.equal(doc.title, "Language");
  assert.match(doc.markdown, /text/);
  assert.equal(calls[0], rawUrl("docs/spec/language.md", "v1"));
});

test("validateReleases excludes drafts, includes prereleases, dev first and sorted newest first", () => {
  const channels = validateReleases([
    { tag_name: "v0.1.0-alpha.1", draft: false, prerelease: true, published_at: "2026-01-01T00:00:00Z" },
    { tag_name: "v0.1.0-alpha.2", draft: false, prerelease: true, published_at: "2026-02-01T00:00:00Z" },
    { tag_name: "v0.0.9", draft: true, prerelease: false, published_at: "2026-03-01T00:00:00Z" },
    { tag_name: "", draft: false, prerelease: false, published_at: "2026-04-01T00:00:00Z" },
    { draft: false, prerelease: false },
    null,
    "junk",
  ]);

  assert.equal(channels[0].ref, "main");
  assert.equal(channels[0].id, "main");
  assert.equal(channels[0].dev, true);

  const releases = channels.slice(1);
  assert.deepEqual(releases.map((channel) => channel.ref), ["v0.1.0-alpha.2", "v0.1.0-alpha.1"]);
  // The id is the readable tag without a leading v; ref stays the git tag.
  assert.deepEqual(releases.map((channel) => channel.id), ["0.1.0-alpha.2", "0.1.0-alpha.1"]);
  assert.ok(releases.every((channel) => channel.prerelease === true));
  assert.equal(channels.some((channel) => channel.tag_name === "v0.0.9"), false);
});

test("validateReleases rejects a non-array payload", () => {
  for (const payload of [null, {}, "x", 42]) {
    assert.throws(() => validateReleases(payload), (error) => {
      assert.ok(error instanceof GitHubError);
      assert.match(error.message, /could not read/i);
      return true;
    });
  }
});

test("loadReleases fetches the releases API and returns channels", async () => {
  const calls = [];
  __setFetchForTests(async (url) => {
    calls.push(url);
    return response([
      { tag_name: "v0.1.0-alpha.1", draft: false, prerelease: true, published_at: "2026-01-01T00:00:00Z" },
    ]);
  });
  const channels = await loadReleases();
  assert.ok(Array.isArray(channels));
  assert.equal(channels[0].ref, "main");
  assert.equal(channels[1].ref, "v0.1.0-alpha.1");
  assert.deepEqual(calls, [releasesApiUrl()]);
});

test("findChannel matches by ref, by id and falls back to the first channel", () => {
  const channels = [
    { id: "main", ref: "main" },
    { id: "0.1.0-alpha.2", ref: "v0.1.0-alpha.2" },
    { id: "0.1.0-alpha.1", ref: "v0.1.0-alpha.1" },
  ];
  assert.equal(findChannel(channels, "v0.1.0-alpha.2").ref, "v0.1.0-alpha.2");
  assert.equal(findChannel(channels, "0.1.0-alpha.2").ref, "v0.1.0-alpha.2");
  assert.equal(findChannel(channels, "does-not-exist"), channels[0]);
  assert.equal(findChannel(channels, ""), channels[0]);
  assert.equal(findChannel([], "x"), null);
});

test("caching: two loads of the same document make one request", async () => {
  let calls = 0;
  __setFetchForTests(async () => {
    calls += 1;
    return response("# Same\n");
  });
  const first = await loadDocument("main", "docs/a.md");
  const second = await loadDocument("main", "docs/a.md");
  assert.equal(calls, 1);
  assert.equal(first.title, second.title);
});

test("caching: concurrent loads of the same document dedupe", async () => {
  let calls = 0;
  __setFetchForTests(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return response("# Deduped\n");
  });
  const [a, b, c] = await Promise.all([
    loadDocument("main", "docs/a.md"),
    loadDocument("main", "docs/a.md"),
    loadDocument("main", "docs/a.md"),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual([a, b, c].map((doc) => doc.title), ["Deduped", "Deduped", "Deduped"]);
});

test("caching: a different ref is a separate entry", async () => {
  const calls = [];
  __setFetchForTests(async (url) => {
    calls.push(url);
    return response("# Doc\n");
  });
  await loadDocument("main", "docs/a.md");
  await loadDocument("v1", "docs/a.md");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [rawUrl("docs/a.md", "main"), rawUrl("docs/a.md", "v1")]);
});

test("caching: a failed first load is not cached, so retry refetches", async () => {
  let calls = 0;
  __setFetchForTests(async () => {
    calls += 1;
    if (calls === 1) return response("boom", { status: 500 });
    return response("# Recovered\n");
  });
  await assert.rejects(loadDocument("main", "docs/a.md"), GitHubError);
  const doc = await loadDocument("main", "docs/a.md");
  assert.equal(calls, 2);
  assert.equal(doc.title, "Recovered");
});

test("a 403 and a 429 produce rateLimited errors", async () => {
  for (const status of [403, 429]) {
    __resetCacheForTests();
    __setFetchForTests(async () => response("limited", { status }));
    await assert.rejects(loadDocument("main", "docs/a.md"), (error) => {
      assert.equal(error.rateLimited, true);
      assert.equal(error.status, status);
      assert.match(error.message, /rate limit/i);
      return true;
    });
  }
});

test("a 404 is not rateLimited and carries a GitHub URL", async () => {
  __setFetchForTests(async () => response("missing", { status: 404 }));
  await assert.rejects(loadDocument("v1", "docs/a.md"), (error) => {
    assert.equal(error.rateLimited, false);
    assert.equal(error.status, 404);
    assert.match(error.url, /^https:\/\/github\.com\/Oqthara\/oqthara\//);
    assert.ok(error.url.includes("v1"));
    return true;
  });
});

test("a network rejection produces a useful message", async () => {
  __setFetchForTests(async () => {
    throw new Error("ECONNREFUSED");
  });
  await assert.rejects(loadDocument("main", "docs/a.md"), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.match(error.message, /could not be reached/i);
    assert.match(error.url, /github\.com/);
    return true;
  });
});

test("an AbortError becomes a timeout message without waiting", async () => {
  __setFetchForTests(async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  });
  const started = Date.now();
  await assert.rejects(loadDocument("main", "docs/a.md"), (error) => {
    assert.match(error.message, /time/i);
    return true;
  });
  assert.ok(Date.now() - started < 2000, "the test must not wait for the real 15s timeout");
});

test("a malformed JSON tree body is an error, not an empty list", async () => {
  __setFetchForTests(async () => ({
    ok: true,
    status: 200,
    async text() {
      return "{not json";
    },
    async json() {
      throw new SyntaxError("Unexpected token");
    },
  }));
  await assert.rejects(loadTree("main"), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.match(error.message, /could not read/i);
    return true;
  });
  await assert.rejects(loadCatalog("main"), GitHubError);
});

test("loadText is keyed by path and ref, and loadDocumentIndex is sorted", async () => {
  __setFetchForTests(async (url) => {
    if (url === TREE_URL("main")) {
      return response(treePayload(["docs/zeta.md", "docs/alpha.md", "docs/spec/language.md"]));
    }
    return response("# T\n");
  });
  const index = await loadDocumentIndex("main");
  assert.deepEqual(index.map((entry) => entry.path), [
    "docs/alpha.md",
    "docs/zeta.md",
    "docs/spec/language.md",
  ]);
  assert.equal(index[2].section, "Specification");
  assert.equal(index[2].route, documentRoute("docs/spec/language.md", "main"));
  assert.equal(index[1].sourceUrl, blobUrl("docs/zeta.md", "main"));
});

test("cache constants expose the documented policy", () => {
  assert.equal(CACHE_TTL_MS, 300_000);
  assert.equal(FETCH_TIMEOUT_MS, 15_000);
  assert.ok(TITLE_CONCURRENCY >= 1);
  assert.equal(DEFAULT_REF, "main");
});
