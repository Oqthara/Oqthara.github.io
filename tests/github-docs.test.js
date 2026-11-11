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
  invalidateCache,
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
  assert.equal(catalog.length, 2);
  for (const entry of catalog) {
    assert.equal(typeof entry.path, "string");
    assert.equal(typeof entry.section, "string");
    assert.equal(typeof entry.title, "string");
    assert.match(entry.route, /^\/document\.html\?path=.+&ref=main$/);
    assert.ok(entry.title.length > 0);
  }
  // The tree also carries `docs/adr/0003-bytecode.md`. Decision records are development
  // material and stay on GitHub, so the catalogue must not include them — the site publishes
  // user documentation only.
  assert.deepEqual(catalog.map((entry) => entry.path).sort(), [
    "docs/README.md",
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
      { path: "docs/spec/a.md", type: "blob", size: 12 },
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
    { path: "docs/spec/a.md", size: 12 },
    { path: "docs/b/c.md", size: 34 },
    { path: "docs/c.md", size: 0 },
  ]);
});

test("loadTree uses the recursive tree API for the requested ref", async () => {
  const calls = [];
  __setFetchForTests(async (url) => {
    calls.push(url);
    return response(treePayload(["docs/spec/a.md"]));
  });
  const tree = await loadTree("v0.1.0-alpha.2");
  assert.equal(tree.length, 1);
  assert.deepEqual(calls, [treeApiUrl("v0.1.0-alpha.2")]);
  assert.match(calls[0], /\/git\/trees\/v0\.1\.0-alpha\.2\?recursive=1$/);
});

test("loadCatalog reads each Markdown title with bounded concurrency", async () => {
  const paths = Array.from({ length: 20 }, (_, index) => `docs/spec/doc-${index}.md`);
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
      return response(treePayload(["docs/spec/good.md", "docs/spec/broken.md"]));
    }
    if (url.endsWith("/docs/spec/broken.md")) {
      return response("missing", { status: 404 });
    }
    return response("# Good Title\n");
  });

  const catalog = await loadCatalog("main");
  assert.ok(Array.isArray(catalog));
  assert.equal(catalog.length, 2);
  const broken = catalog.find((entry) => entry.path === "docs/spec/broken.md");
  assert.ok(broken, "the unreadable document must stay in the index");
  assert.equal(broken.title, "Broken");
  assert.equal(catalog.find((entry) => entry.path === "docs/spec/good.md").title, "Good Title");
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
  await assert.rejects(loadExample("main", "docs/spec/a.md"), (error) => {
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
  const first = await loadDocument("main", "docs/spec/a.md");
  const second = await loadDocument("main", "docs/spec/a.md");
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
    loadDocument("main", "docs/spec/a.md"),
    loadDocument("main", "docs/spec/a.md"),
    loadDocument("main", "docs/spec/a.md"),
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
  await loadDocument("main", "docs/spec/a.md");
  await loadDocument("v1", "docs/spec/a.md");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [rawUrl("docs/spec/a.md", "main"), rawUrl("docs/spec/a.md", "v1")]);
});

test("caching: a failed first load is not cached, so retry refetches", async () => {
  let calls = 0;
  __setFetchForTests(async () => {
    calls += 1;
    if (calls === 1) return response("boom", { status: 500 });
    return response("# Recovered\n");
  });
  await assert.rejects(loadDocument("main", "docs/spec/a.md"), GitHubError);
  const doc = await loadDocument("main", "docs/spec/a.md");
  assert.equal(calls, 2);
  assert.equal(doc.title, "Recovered");
});

test("a 403 and a 429 produce rateLimited errors", async () => {
  for (const status of [403, 429]) {
    __resetCacheForTests();
    __setFetchForTests(async () => response("limited", { status }));
    await assert.rejects(loadDocument("main", "docs/spec/a.md"), (error) => {
      assert.equal(error.rateLimited, true);
      assert.equal(error.status, status);
      assert.match(error.message, /rate limit/i);
      return true;
    });
  }
});

test("a 404 is not rateLimited and carries a GitHub URL", async () => {
  __setFetchForTests(async () => response("missing", { status: 404 }));
  await assert.rejects(loadDocument("v1", "docs/spec/a.md"), (error) => {
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
  await assert.rejects(loadDocument("main", "docs/spec/a.md"), (error) => {
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
  await assert.rejects(loadDocument("main", "docs/spec/a.md"), (error) => {
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
      return response(
        treePayload(["docs/stdlib/reference.md", "docs/spec/language.md", "docs/README.md"]),
      );
    }
    return response("# T\n");
  });
  const index = await loadDocumentIndex("main");
  // Section first, then path inside a section: `Overview`, then `Specification`, then
  // `Standard library`. The tree is deliberately not in this order.
  assert.deepEqual(index.map((entry) => entry.path), [
    "docs/README.md",
    "docs/spec/language.md",
    "docs/stdlib/reference.md",
  ]);
  assert.deepEqual(index.map((entry) => entry.section), ["Overview", "Specification", "Standard library"]);
  assert.equal(index[1].route, documentRoute("docs/spec/language.md", "main"));
  assert.equal(index[2].sourceUrl, blobUrl("docs/stdlib/reference.md", "main"));
});

test("cache constants expose the documented policy", () => {
  assert.equal(CACHE_TTL_MS, 300_000);
  assert.equal(FETCH_TIMEOUT_MS, 15_000);
  assert.ok(TITLE_CONCURRENCY >= 1);
  assert.equal(DEFAULT_REF, "main");
});

/** A minimal sessionStorage stand-in, installed as `globalThis.window` for one test. */
function withSessionStorage(run) {
  const store = new Map();
  const previous = globalThis.window;
  globalThis.window = {
    sessionStorage: {
      get length() {
        return store.size;
      },
      key: (index) => [...store.keys()][index] ?? null,
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  };
  const persisted = () =>
    [...store.entries()]
      .filter(([key]) => key.startsWith("oq-cache:"))
      .map(([, value]) => JSON.parse(value).value);
  /** Writes an entry as an earlier page load would have left it. */
  const seed = (key, value, at) => store.set(`oq-cache:${key}`, JSON.stringify({ at, value }));
  return Promise.resolve(run({ persisted, seed })).finally(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
}

test("REGRESSION: a load already in flight when the mirror republishes does not re-persist itself", async () => {
  // `invalidateCache()` cleared sessionStorage, but a request that started before it finished
  // after it and wrote its now-stale value back with a fresh timestamp, so the stale content
  // survived a reload for the whole persistence TTL. The generation guard drops that write.
  await withSessionStorage(async ({ persisted }) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    __setFetchForTests(async () => {
      await gate;
      return response("STALE BEFORE REPUBLISH");
    });

    const inFlight = loadText("main", "README.md");
    await Promise.resolve();
    invalidateCache();
    release();

    assert.equal(await inFlight, "STALE BEFORE REPUBLISH", "the caller still gets its answer");
    assert.deepEqual(persisted(), [], "but it is not persisted as current content");
  });
});

test("a load that starts after the invalidation does persist its value", () => {
  return withSessionStorage(async ({ persisted }) => {
    __setFetchForTests(async () => response("CURRENT AFTER REPUBLISH"));
    invalidateCache();
    assert.equal(await loadText("main", "README.md"), "CURRENT AFTER REPUBLISH");
    assert.deepEqual(persisted(), ["CURRENT AFTER REPUBLISH"]);
  });
});

test("invalidateCache clears what was already persisted", () => {
  return withSessionStorage(async ({ persisted }) => {
    __setFetchForTests(async () => response("OLD"));
    await loadText("main", "README.md");
    assert.deepEqual(persisted(), ["OLD"]);
    invalidateCache();
    assert.deepEqual(persisted(), []);
  });
});

test("REGRESSION: an abandoned background refresh does not refill the cleared cache", () => {
  // A stale persisted entry starts a stale-while-revalidate refresh in the background. If the
  // mirror republishes while that request is in flight, its answer is not current and must be
  // dropped rather than reinstated as the cache entry and as fresh persistence.
  return withSessionStorage(async ({ persisted, seed }) => {
    seed(
      "tree:main",
      [{ path: "docs/old.md", size: 1 }],
      Date.now() - CACHE_TTL_MS - 1_000,
    );

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    __setFetchForTests(async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return response({ sha: "x", truncated: false, tree: [{ path: "docs/abandoned.md", type: "blob", size: 1 }] });
      }
      return response({ sha: "x", truncated: false, tree: [{ path: "docs/fresh.md", type: "blob", size: 1 }] });
    });

    const served = await loadTree("main");
    assert.deepEqual(served.map((entry) => entry.path), ["docs/old.md"], "the persisted value is served at once");

    await Promise.resolve();
    invalidateCache();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(persisted(), [], "the abandoned refresh is not persisted");
    assert.deepEqual(
      (await loadTree("main")).map((entry) => entry.path),
      ["docs/fresh.md"],
      "the cleared cache is not refilled by the abandoned refresh",
    );
  });
});
