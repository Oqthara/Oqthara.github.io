import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";

import * as syncModule from "../scripts/sync-firestore.mjs";
import {
  buildReleaseRecord,
  fetchWithTimeout,
  listReleases,
  listSourceFiles,
  planSync,
  resolveCommit,
  USAGE,
} from "../scripts/sync-firestore.mjs";
import { COLLECTIONS, FIELDS, syncIdFor } from "../src/firebase/collections.js";

// Two failure modes that only appear once the canonical repository is large enough.
//
// GitHub caps a releases page at 100 entries. The planner treats "missing from the desired
// set" as "deleted upstream" and unpublishes it. Read one page and the 101st release is
// unpublished while it still exists, silently, on the next scheduled run.
//
// And a mirror record that says only `main` cannot answer whether it is behind. The catalogue
// document has to carry the commit the run read.

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function release(index) {
  return { tag_name: `v0.0.${index}`, name: `v0.0.${index}`, body: "", draft: false };
}

test("listReleases pages past the hundredth release", async () => {
  // Page one is full at 100, so a second page must be requested. Returning after the first
  // is the defect: page two's releases would then read as deleted upstream.
  const pages = [Array.from({ length: 100 }, (_, i) => release(i)), [release(100), release(101)]];
  const requested = [];

  const result = await listReleases({
    perPage: 100,
    fetchImpl: async (url) => {
      requested.push(url);
      return jsonResponse(pages[requested.length - 1] ?? []);
    },
  });

  assert.equal(requested.length, 2, "a full page must be followed by the next one");
  assert.equal(result.length, 102);
  assert.equal(result.at(-1).tag_name, "v0.0.101");
});

test("listReleases asks for a stable page size", async () => {
  const requested = [];
  await listReleases({
    perPage: 100,
    fetchImpl: async (url) => {
      requested.push(url);
      return jsonResponse([]);
    },
  });
  assert.equal(requested.length, 1, "a short first page ends the read");
  assert.match(requested[0], /per_page=100/);
  assert.doesNotMatch(requested[0], /[?&]page=/, "page 1 is the default and need not be named");
});

test("listReleases drops drafts without shifting the page boundary", async () => {
  // GitHub counts drafts towards the page, so filtering must not look like a short page.
  const page = [...Array.from({ length: 99 }, (_, i) => release(i)), { tag_name: "v9", draft: true }];
  const requested = [];

  const result = await listReleases({
    perPage: 100,
    fetchImpl: async (url) => {
      requested.push(url);
      return requested.length === 1 ? jsonResponse(page) : jsonResponse([release(200)]);
    },
  });

  assert.equal(requested.length, 2, "100 raw entries is a full page even when one is a draft");
  assert.equal(result.length, 100);
  assert.ok(result.every((entry) => entry.draft !== true));
});

test("listReleases refuses an unbounded list instead of publishing a partial one", async () => {
  // Every page full, forever. Failing is the honest outcome: the alternative is a mirror that
  // claims to be complete and quietly unpublishes everything the loop did not reach.
  await assert.rejects(
    () => listReleases({ perPage: 2, fetchImpl: async () => jsonResponse([release(0), release(1)]) }),
    /refusing to publish a partial release list/,
  );
});

test("listReleases surfaces an API failure rather than returning an empty list", async () => {
  // An empty list means "nothing published upstream", which unpublishes the mirror.
  await assert.rejects(
    () => listReleases({ fetchImpl: async () => jsonResponse({}, { ok: false, status: 403 }) }),
    /403/,
  );
});

test("planSync unpublishes a release only when it is genuinely absent", () => {
  // The consequence of reading one page, expressed at the planner: a release the reader never
  // saw is treated as deleted. This pins the behaviour the pagination above has to feed.
  const desired = [
    {
      collection: COLLECTIONS.releases,
      id: "release--v0.0.0",
      data: {
        [FIELDS.path]: "releases/v0.0.0",
        [FIELDS.content]: "",
        [FIELDS.contentHash]: "abc",
        [FIELDS.published]: true,
      },
    },
  ];
  const existing = new Map([
    [
      syncIdFor(COLLECTIONS.releases, "releases/v0.0.0"),
      {
        [FIELDS.status]: "published",
        [FIELDS.contentHash]: "abc",
        [FIELDS.collection]: COLLECTIONS.releases,
        [FIELDS.path]: "releases/v0.0.0",
      },
    ],
    [
      syncIdFor(COLLECTIONS.releases, "releases/v0.0.1"),
      {
        [FIELDS.status]: "published",
        [FIELDS.contentHash]: "def",
        [FIELDS.collection]: COLLECTIONS.releases,
        [FIELDS.path]: "releases/v0.0.1",
      },
    ],
  ]);

  // v0.0.0 is still in the desired set and unchanged, so nothing is written for it.
  // v0.0.1 was not returned this run, which is exactly what one page of a two-page list
  // looks like, so the planner unpublishes it.
  const plan = planSync({ desired, existing });
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.unchanged.length, 1);
  assert.equal(plan.unpublish.length, 1);
  assert.equal(plan.unpublish[0].path, "releases/v0.0.1");
});

test("applyPlan records the upstream commit in the catalogue", async () => {
  // A record that names only `main` cannot be compared with upstream to answer "is the mirror
  // behind?". The commit is the answer, and it has to survive an empty plan too: a run that
  // writes nothing is still a run that read a specific commit.
  const { applyPlan } = await import("../scripts/sync-firestore.mjs");
  const written = [];

  const db = {
    batch() {
      return {
        set() {},
        async commit() {},
      };
    },
    collection(name) {
      return {
        doc(id) {
          return {
            async set(data) {
              written.push({ collection: name, id, data });
            },
          };
        },
      };
    },
  };

  const emptyPlan = { writes: [], oversized: [], unchanged: [], unpublish: [] };
  await applyPlan(db, emptyPlan, { now: "2026-11-06T00:00:00.000Z", commit: "abc1234" });

  const catalog = written.find((entry) => entry.id === "catalog");
  assert.ok(catalog, "the catalogue record is written even when nothing else changed");
  assert.equal(catalog.data[FIELDS.sourceCommit], "abc1234");
  assert.equal(catalog.data[FIELDS.sourceRef], "main");
});

test("a write run from a non-default ref is refused, because it would unpublish", async () => {
  // The planner publishes what a ref contains and unpublishes what it lacks. A tag holds a
  // strict subset of `main`, so mirroring one would unpublish every document added since the
  // tag, on what looks like a routine run.
  const { main, EXIT, USAGE } = await import("../scripts/sync-firestore.mjs");
  const errors = [];
  const code = await main(["--ref=v0.1.0-alpha.2"], {
    env: {},
    log: () => {},
    error: (line) => errors.push(line),
    collect: async () => {
      throw new Error("collect must not run: the ref is rejected first");
    },
  });

  assert.equal(code, EXIT.usage);
  assert.match(errors[0], /read-only/);
  assert.match(errors[0], /--dry-run/);
  assert.match(USAGE, /requires --dry-run/);
});

test("a dry run from a non-default ref is allowed, for reviewing a tag", async () => {
  const { main, EXIT } = await import("../scripts/sync-firestore.mjs");
  const lines = [];
  const code = await main(["--ref=v0.1.0-alpha.2", "--dry-run"], {
    env: {},
    collect: async () => ({ records: [], commit: "abc" }),
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  });

  assert.equal(code, EXIT.ok);
  assert.ok(lines.some((line) => /read 0 source records/.test(line)));
});

// --- request deadlines ---------------------------------------------------------------------

test("a body that never finishes is aborted, not awaited forever", async () => {
  // The defect: the deadline was cleared as soon as headers arrived, so `response.json()` had no
  // bound at all. A server that answers 200 and then stalls mid-body hung the run until the job's
  // own limit, leaving the mirror on the previous run's state with nothing in the log to explain it.
  let aborted = false;
  const hangs = () => new Promise(() => {});
  const fetchImpl = (url, { signal }) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return Promise.resolve({ ok: true, status: 200, json: hangs, text: hangs });
  };

  await assert.rejects(
    () => fetchWithTimeout("https://api.github.com/x", { fetchImpl, timeoutMs: 25 }).then((r) => r.json()),
    /aborted|time limit/,
  );
  assert.equal(aborted, true, "the request must be aborted, not merely abandoned");
});

test("a stalled body times out in a child process instead of exiting the process", async () => {
  // The deadline must stay ref'd. An unref'd timer is the only handle a stalled body leaves behind,
  // so Node decides the event loop is empty and exits with the promise still pending: the caller
  // sees success with no work done, and in a test runner the whole suite is torn down mid-flight.
  // This is invisible to an in-process assertion - it only shows up as an exit code, so it is run
  // in one.
  const script = `
    import { fetchWithTimeout } from ${JSON.stringify(new URL("../scripts/sync-firestore.mjs", import.meta.url).href)};
    const hangs = () => new Promise(() => {});
    const fetchImpl = () => Promise.resolve({ ok: true, status: 200, json: hangs, text: hangs });
    try {
      const response = await fetchWithTimeout("https://api.github.com/x", { fetchImpl, timeoutMs: 50 });
      await response.json();
      console.log("RESOLVED");
    } catch (error) {
      console.log("REJECTED " + error.message);
    }
  `;
  const { stdout, code } = await new Promise((resolve) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], (error, out) => {
      resolve({ stdout: out, code: error ? error.code : 0 });
    });
  });
  assert.equal(code, 0, "the process must survive to report the timeout, not exit while it is pending");
  assert.match(stdout, /REJECTED /, "the stalled body must surface as a timeout, not as silence");
});

test("the deadline survives until the body is consumed, and is cleared afterwards", async () => {
  // A body that finishes inside the deadline must resolve normally, and the timer must not be left
  // armed: a leaked timer keeps the process alive and eventually aborts an unrelated request.
  const cleared = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, ms) => {
    const id = realSetTimeout(fn, ms);
    timers.push(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    cleared.push(id);
    return realClearTimeout(id);
  };
  try {
    const fetchImpl = async () => jsonResponse({ sha: "abc" });
    const response = await fetchWithTimeout("https://api.github.com/x", { fetchImpl, timeoutMs: 5_000 });
    // Headers alone must not release the deadline, or the body is unbounded again.
    assert.equal(cleared.length, 0, "the deadline was cleared before the body was read");
    assert.deepEqual(await response.json(), { sha: "abc" });
    assert.equal(cleared.length, timers.length, "the deadline was not cleared after the body");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("text bodies get the same deadline as json bodies", async () => {
  const fetchImpl = (url, { signal }) => {
    signal.addEventListener("abort", () => {});
    return Promise.resolve({ ok: true, status: 200, text: () => new Promise(() => {}), json: () => new Promise(() => {}) });
  };
  await assert.rejects(
    () => fetchWithTimeout("https://api.github.com/x", { fetchImpl, timeoutMs: 20 }).then((r) => r.text()),
    /aborted|time limit/,
  );
});

test("a non-ok response still throws, as it did before, and leaks no deadline", async () => {
  // Unchanged behaviour worth pinning: the status is reported here rather than by each caller, and
  // the error names the URL. Turning this into a returned response would leave every caller's
  // `!response.ok` check unreachable and let a 404 look like an empty result.
  let cleared = 0;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = (id) => {
    cleared += 1;
    return realClearTimeout(id);
  };
  try {
    await assert.rejects(
      () => fetchWithTimeout("https://api.github.com/x", {
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" }),
        timeoutMs: 5_000,
      }),
      /GitHub returned 404/,
    );
    assert.equal(cleared, 1, "a failed response must not leak its deadline");
  } finally {
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("an unreachable host surfaces the transport error and leaks no deadline", async () => {
  let cleared = 0;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = (id) => {
    cleared += 1;
    return realClearTimeout(id);
  };
  try {
    await assert.rejects(
      () => fetchWithTimeout("https://api.github.com/x", {
        fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
        timeoutMs: 5_000,
      }),
      /ECONNREFUSED/,
    );
    assert.equal(cleared, 1, "a transport failure must not leak its deadline");
  } finally {
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("a fetcher that ignores its abort signal is still cut off", async () => {
  // Test doubles and some polyfills do not implement `signal`. Racing the body against the abort
  // event keeps the bound in that case instead of relying on cooperation.
  const fetchImpl = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}), text: () => new Promise(() => {}) });
  await assert.rejects(
    () => fetchWithTimeout("https://api.github.com/x", { fetchImpl, timeoutMs: 20 }).then((r) => r.json()),
    /aborted|time limit/,
  );
});

// --- provenance ----------------------------------------------------------------------------

const TREE_SHA = "7e1b3c5a9d2f4e6b8c0a1d3f5e7b9c2a4d6f8e0b";
const COMMIT_SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f809a1b2c3d4";

test("listSourceFiles records a commit, not the tree object's own sha", async () => {
  // GET /git/trees/:ref returns the *tree* sha. It is a different hash for the same content, so
  // writing it as `sourceCommit` produced a value that no commit lookup accepts, that never
  // matched the commit a release points at, and that made "is the mirror behind?" unanswerable.
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/git/trees/")) {
      return jsonResponse({ sha: TREE_SHA, truncated: false, tree: [{ type: "blob", path: "docs/spec/language.md" }] });
    }
    if (url.includes("/commits/")) {
      return jsonResponse({ sha: COMMIT_SHA, commit: { sha: COMMIT_SHA, tree: { sha: TREE_SHA } } });
    }
    throw new Error(`unexpected request ${url}`);
  };

  const listing = await listSourceFiles({ fetchImpl });
  assert.equal(listing.commit, COMMIT_SHA, "the recorded provenance must be the commit");
  assert.notEqual(listing.commit, TREE_SHA, "the tree sha must never be recorded as the commit");
  assert.equal(listing.tree, TREE_SHA);
  assert.deepEqual(listing.paths, ["docs/spec/language.md"]);
  assert.ok(calls.some((url) => url.includes("/commits/")), "the commit must actually be resolved");
});

test("an unresolvable commit fails closed instead of recording an unusable ref", async () => {
  // A mirror document whose provenance cannot be resolved is worse than a run that stopped:
  // the wrong hash is written to production and looks authoritative afterwards.
  const fetchImpl = async (url) => {
    if (url.includes("/git/trees/")) return jsonResponse({ sha: "abc", truncated: false, tree: [] });
    if (url.includes("/commits/")) return jsonResponse({ sha: "not-a-sha" });
    throw new Error(`unexpected request ${url}`);
  };
  await assert.rejects(() => listSourceFiles({ fetchImpl }), /did not resolve .* to a commit SHA/);
});

test("resolveCommit rejects a malformed payload rather than passing it through", async () => {
  await assert.rejects(
    () => resolveCommit({ fetchImpl: async () => jsonResponse({}) }),
    /did not resolve/,
  );
  await assert.rejects(
    () => resolveCommit({ fetchImpl: async () => jsonResponse({ sha: COMMIT_SHA.toUpperCase() + "x" }) }),
    /did not resolve/,
  );
});

test("resolveCommit prefers the commit an annotated tag points at", async () => {
  const TAG_OBJECT_SHA = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
  const payload = { sha: TAG_OBJECT_SHA, commit: { sha: COMMIT_SHA, tree: { sha: TREE_SHA } } };
  const resolved = await resolveCommit({ fetchImpl: async () => jsonResponse(payload) });
  assert.equal(resolved.commit, COMMIT_SHA, "the tag object is not the content's commit");
});

// --- release metadata changes --------------------------------------------------------------

const baseRelease = {
  tag_name: "v0.1.0-alpha.2",
  name: "Oqthara 0.1.0-alpha.2",
  body: "Notes.",
  draft: false,
  prerelease: true,
  published_at: "2026-01-02T03:04:05Z",
  html_url: "https://github.com/Oqthara/oqthara/releases/tag/v0.1.0-alpha.2",
};

const hashOf = (overrides = {}) => buildReleaseRecord({ ...baseRelease, ...overrides }).data[FIELDS.contentHash];

test("a metadata-only edit changes the release hash", () => {
  // The defect: the hash covered tag/name/body only. Changing the publication time, flipping
  // `prerelease`, or re-pointing the URL left the hash identical, so planSync skipped the write
  // and the site kept rendering stale metadata with no way to notice.
  const baseline = hashOf();
  for (const [label, overrides] of [
    ["published_at", { published_at: "2026-02-03T04:05:06Z" }],
    ["prerelease", { prerelease: false }],
    ["html_url", { html_url: "https://example.invalid/releases/tag/v0.1.0-alpha.2" }],
  ]) {
    assert.notEqual(hashOf(overrides), baseline, `changing ${label} must change the hash`);
  }
});

test("the release hash is deterministic and order-independent of the input object", () => {
  assert.equal(hashOf(), hashOf(), "the same release must hash the same way twice");
  const reordered = { html_url: baseRelease.html_url, body: baseRelease.body, published_at: baseRelease.published_at,
    prerelease: baseRelease.prerelease, draft: false, name: baseRelease.name, tag_name: baseRelease.tag_name };
  assert.equal(buildReleaseRecord(reordered).data[FIELDS.contentHash], hashOf(),
    "key order in the input object must not affect the hash");
});

test("the hash is unambiguous across field boundaries", () => {
  // JSON-encoding the tuple keeps "ab"+"c" distinct from "a"+"bc"; a plain join would collide.
  assert.notEqual(hashOf({ name: "ab", body: "c" }), hashOf({ name: "a", body: "bc" }));
});

test("a metadata-only change produces a write, not a skip", () => {
  // End to end through the planner: this is the behaviour the site depends on.
  const before = buildReleaseRecord({ ...baseRelease });
  const after = buildReleaseRecord({ ...baseRelease, prerelease: false });
  const existing = new Map([[before.id, {
    collection: before.collection,
    path: before.data[FIELDS.path],
    status: "published",
    contentHash: before.data[FIELDS.contentHash],
  }]]);
  const plan = planSync({ desired: [after], existing });
  assert.equal(plan.unchanged.length, 0, "the change must not be treated as unchanged");
  assert.equal(plan.writes.length, 1, "the change must be written");
});

test("an out-of-band edit is invisible incrementally and repaired by a full reconciliation", () => {
  // This is the case `--full` exists for, and the case the old workflow could not reach: a
  // document edited directly in Firestore still matches its recorded hash, because the hash
  // describes the *source*, not the stored bytes. An incremental run therefore skips the damaged
  // document forever. Only a full reconciliation rewrites it.
  const { buildDocumentRecord } = syncModule;
  const source = buildDocumentRecord({
    path: "docs/spec/language.md",
    content: "# Language\n\nThe specification.",
    collection: "docs",
    now: "2026-11-06T00:00:00.000Z",
  });

  // The bookkeeping record is untouched: this is what an out-of-band edit looks like.
  const existing = new Map([[syncIdFor(source.collection, source.data[FIELDS.path]), {
    collection: source.collection,
    path: source.data[FIELDS.path],
    status: "published",
    contentHash: source.data[FIELDS.contentHash],
  }]]);

  const incremental = planSync({ desired: [source], existing });
  assert.equal(incremental.writes.length, 0, "the hash still matches, so nothing is rewritten");
  assert.equal(incremental.unchanged.length, 1, "the damaged document is treated as current");

  const full = planSync({ desired: [source], existing, full: true });
  assert.equal(full.writes.length, 1, "a full reconciliation must rewrite it");
  assert.equal(full.writes[0].data[FIELDS.content], "# Language\n\nThe specification.");
});

test("the CLI accepts --full and reports the mode it is about to run", async () => {
  // The workflow passes `--full`; if the argument were ignored the forced run would silently be
  // incremental, which is the defect this whole path exists to fix.
  const { parseArgs, formatPlan } = syncModule;
  assert.equal(parseArgs(["--full"]).options.full, true);
  assert.equal(parseArgs([]).options.full, false);
  assert.match(USAGE, /--full/);

  const emptyPlan = { writes: [], unchanged: [], unpublish: [], oversized: [] };
  assert.match(formatPlan(emptyPlan, { full: true }).split("\n")[0], /full reconciliation/);
  assert.match(formatPlan(emptyPlan, { full: false }).split("\n")[0], /incremental/);
});

// ---------------------------------------------------------------------------
// The catalogue contract. `firestore.rules` grants a client read of
// `metadata/catalog` only when the document carries the literal boolean
// `published: true`. The rule test seeded that flag by hand, so a writer that
// never set it passed every test while shipping a catalogue no browser could
// read. These tests exercise the real producer payload instead.
// ---------------------------------------------------------------------------

/** A Firestore double that records every write, including batched content writes. */
function recordingDb(written = []) {
  return {
    written,
    batch() {
      const pending = [];
      return {
        set(ref, data) {
          pending.push({ ref, data });
        },
        async commit() {
          for (const entry of pending) written.push(entry);
        },
      };
    },
    collection(name) {
      return {
        doc(id) {
          const ref = { collection: name, id };
          return {
            async set(data) {
              written.push({ ref, data });
            },
            ref,
            _ref: ref,
          };
        },
      };
    },
  };
}

test("the catalogue record carries the boolean `published` flag its own rule requires", async () => {
  const { buildCatalogRecord } = await import("../scripts/sync-firestore.mjs");
  const record = buildCatalogRecord({ commit: "a".repeat(40), now: "2026-11-06T00:00:00.000Z" });

  assert.equal(
    record.published,
    true,
    "metadata/catalog is readable only when `published` is the boolean true",
  );
  assert.equal(typeof record.published, "boolean");
  assert.equal(
    record.status,
    "published",
    "the informational status is kept alongside the flag, not used in place of it",
  );
});

test("the public and private catalogue copies are the same record", async () => {
  // Two hand-written payloads is how the public copy drifted from its rule. One builder means a
  // reader of `metadata/catalog` and an operator reading `sync/catalog` cannot disagree.
  const { applyPlan } = await import("../scripts/sync-firestore.mjs");
  const db = recordingDb();
  await applyPlan(db, { writes: [], oversized: [], unchanged: [], unpublish: [] }, {
    now: "2026-11-06T00:00:00.000Z",
    commit: "b".repeat(40),
  });

  const publicCatalog = db.written.find(
    (entry) => entry.ref.collection === "metadata" && entry.ref.id === "catalog",
  );
  const privateCatalog = db.written.find(
    (entry) => entry.ref.collection === "sync" && entry.ref.id === "catalog",
  );

  assert.ok(publicCatalog, "the public catalogue must be written");
  assert.ok(privateCatalog, "the private catalogue must be written");
  assert.deepEqual(publicCatalog.data, privateCatalog.data);
  assert.equal(publicCatalog.data.published, true);
  assert.equal(publicCatalog.data.sourceCommit, "b".repeat(40));
});

test("a catalogue is readable by the browser validator once the writer produces it", async () => {
  // The end of the chain: the producer's payload must satisfy the consumer. A field named right
  // in one and read under another name is exactly the gap this guards.
  const { buildCatalogRecord } = await import("../scripts/sync-firestore.mjs");
  const { validateCatalogRecord } = await import("../src/repositories/catalog.repository.js");

  const commit = "0123456789abcdef0123456789abcdef01234567";
  const payload = buildCatalogRecord({
    commit,
    now: "2026-11-06T00:00:00.000Z",
    counts: { written: 3, unchanged: 55, unpublished: 1, oversized: 0 },
  });
  const validated = validateCatalogRecord(payload);

  assert.equal(validated.sourceCommit, commit, "the writer's commit must survive the reader");
  assert.equal(validated.sourceRef, "main");
  assert.equal(validated.updatedAt, "2026-11-06T00:00:00.000Z");
  assert.deepEqual({ ...validated.counts }, { written: 3, unchanged: 55, unpublished: 1, oversized: 0 });
});

test("catalogue counts mirrored documents, not their bookkeeping records", async () => {
  // Every content write costs two operations (the document and its sync record), so a total
  // taken from the operation list would double. The count must describe documents mirrored.
  const { applyPlan } = await import("../scripts/sync-firestore.mjs");
  const written = [];

  const db = {
    batch() {
      const pending = [];
      return {
        set(ref, data) {
          pending.push({ ref, data });
        },
        async commit() {
          for (const entry of pending) written.push(entry);
        },
      };
    },
    collection(name) {
      return {
        doc(id) {
          return {
            async set(data) {
              written.push({ ref: { collection: name, id }, data });
            },
          };
        },
      };
    },
  };

  const plan = {
    writes: [
      { collection: "documentation", id: "a__b", data: { path: "a/b.md", published: true, contentHash: "h1", content: "x" } },
      { collection: "documentation", id: "c__d", data: { path: "c/d.md", published: true, contentHash: "h2", content: "y" } },
    ],
    oversized: [],
    unchanged: [{ collection: "documentation", id: "e__f" }],
    unpublish: [{ collection: "documentation", path: "gone.md" }],
  };

  await applyPlan(db, plan, { now: "2026-11-06T00:00:00.000Z", commit: "c".repeat(40) });

  const catalog = written.find((entry) => entry.ref.id === "catalog" && entry.ref.collection === "metadata");
  assert.ok(catalog, "the public catalogue must be written");
  assert.equal(catalog.data.counts.written, 2, "only mirrored documents count as written, not their bookkeeping");
  assert.equal(catalog.data.counts.unchanged, 1);
  assert.equal(catalog.data.counts.unpublished, 1);
  assert.equal(catalog.data.counts.oversized, 0);
});

test("an unpublish withdrawal is not counted as a written document", async () => {
  // The withdrawal is a `merge` on an existing content document. It shares the collection with a
  // mirrored write but mirrors nothing, so counting it would inflate the published total.
  const { applyPlan } = await import("../scripts/sync-firestore.mjs");
  const written = [];

  const db = {
    batch() {
      const pending = [];
      return {
        set(ref, data) {
          pending.push({ ref, data });
        },
        async commit() {
          for (const entry of pending) written.push(entry);
        },
      };
    },
    collection(name) {
      return {
        doc(id) {
          return {
            async set(data) {
              written.push({ ref: { collection: name, id }, data });
            },
          };
        },
      };
    },
  };

  const plan = {
    writes: [],
    oversized: [],
    unchanged: [],
    unpublish: [{ collection: "documentation", path: "gone.md" }],
  };

  await applyPlan(db, plan, { now: "2026-11-06T00:00:00.000Z", commit: "d".repeat(40) });

  const catalog = written.find((entry) => entry.ref.id === "catalog" && entry.ref.collection === "metadata");
  assert.equal(catalog.data.counts.written, 0, "nothing was mirrored");
  assert.equal(catalog.data.counts.unpublished, 1);
});

test("a batch that throws part-way publishes no catalogue at all", async () => {
  // The counts are written only after every batch has committed, so the honest guarantee is not
  // "the count excludes failed writes" - it is that a failed run publishes no catalogue. A
  // catalogue claiming success must never survive an operation that threw.
  const { applyPlan } = await import("../scripts/sync-firestore.mjs");
  const written = [];
  let batchIndex = 0;

  const db = {
    batch() {
      const pending = [];
      const thisBatch = batchIndex++;
      return {
        set(ref, data) {
          pending.push({ ref, data });
        },
        async commit() {
          if (thisBatch > 0) throw new Error("emulator closed the connection");
          for (const entry of pending) written.push(entry);
        },
      };
    },
    collection(name) {
      return {
        doc(id) {
          return {
            async set(data) {
              written.push({ ref: { collection: name, id }, data });
            },
          };
        },
      };
    },
  };

  const content = (id, path) => ({
    collection: "documentation",
    id,
    data: { path, published: true, contentHash: `h-${id}`, content: "x".repeat(400) },
  });

  // 500 operations per batch, and each content write costs two operations, so 300 writes span
  // more than one batch and the second commit is guaranteed to run.
  const plan = {
    writes: Array.from({ length: 300 }, (_, index) => content(`doc${index}`, `doc${index}.md`)),
    oversized: [],
    unchanged: [],
    unpublish: [],
  };

  await assert.rejects(
    () => applyPlan(db, plan, { now: "2026-11-06T00:00:00.000Z", commit: "e".repeat(40) }),
    /emulator closed the connection/,
    "a failed batch must propagate, not be swallowed into a false success",
  );

  const catalog = written.find((entry) => entry.ref.id === "catalog" && entry.ref.collection === "metadata");
  assert.equal(catalog, undefined, "no catalogue is published for an operation that did not complete");
});

// The catalogue carried only the upstream commit, and a commit is not a content identity here:
// a release is published by pushing a tag, so the mirror gains a release document while `main`
// never moves. A reader comparing commits saw no change and kept rendering the old release list.

test("the catalogue carries a content digest that a tag-only release changes", async () => {
  const { applyPlan, buildReleaseRecord } = await import("../scripts/sync-firestore.mjs");
  const release = (tag, published) =>
    buildReleaseRecord(
      { tag_name: tag, name: tag, body: "", published_at: published, html_url: `https://example.test/${tag}` },
      { now: "2026-11-06T00:00:00.000Z" },
    );

  const record = (entry) => ({ collection: entry.collection, id: entry.id, data: entry.data, syncId: entry.id });
  const write = (catalogues, entries) =>
    applyPlan(
      {
        batch: () => ({ set() {}, async commit() {} }),
        collection: (name) => ({
          doc: (id) => ({
            async set(data) {
              if (name === COLLECTIONS.metadata && id === "catalog") catalogues.push(data);
            },
          }),
        }),
      },
      { writes: entries.map(record), oversized: [], unchanged: [], unpublish: [] },
      { now: "2026-11-06T00:00:00.000Z", commit: "a".repeat(40) },
    );

  const before = [];
  await write(before, [release("v1", "2026-01-01T00:00:00Z")]);
  const after = [];
  await write(after, [release("v1", "2026-01-01T00:00:00Z"), release("v2", "2026-02-01T00:00:00Z")]);

  const first = before.at(-1);
  const second = after.at(-1);
  assert.equal(first[FIELDS.sourceCommit], second[FIELDS.sourceCommit], "the commit is deliberately unchanged");
  assert.match(first[FIELDS.contentDigest], /^[0-9a-f]{64}$/);
  assert.notEqual(
    first[FIELDS.contentDigest],
    second[FIELDS.contentDigest],
    "a newly published release must move the digest even though main did not move",
  );
});

test("the digest is stable across runs that reconcile identical content", async () => {
  const { contentDigestOf } = await import("../scripts/sync-firestore.mjs");
  const record = (path, hash) => ({ collection: "documentation", data: { [FIELDS.path]: path, [FIELDS.contentHash]: hash } });
  const a = record("docs/a.md", "1");
  const b = record("docs/b.md", "2");
  assert.equal(contentDigestOf([a, b]), contentDigestOf([b, a]), "order of discovery is not content");
  assert.equal(contentDigestOf([a, b]), contentDigestOf([a, b]), "a repeat run is not a change");
  assert.notEqual(contentDigestOf([a, b]), contentDigestOf([a, record("docs/b.md", "3")]), "an edit is a change");
  assert.notEqual(contentDigestOf([a, b]), contentDigestOf([a]), "a removal is a change");
  assert.equal(contentDigestOf([]), contentDigestOf());
});

test("the digest covers stored documents only, so an oversized source cannot announce itself", async () => {
  // Oversized sources are skipped rather than stored, so a change confined to one does not alter
  // what the site serves. Counting it would refresh every open page for no reason.
  const { contentDigestOf } = await import("../scripts/sync-firestore.mjs");
  const stored = { collection: "documentation", data: { [FIELDS.path]: "docs/a.md", [FIELDS.contentHash]: "1" } };
  assert.equal(contentDigestOf([stored]), contentDigestOf([stored]));
  assert.notEqual(contentDigestOf([stored]), contentDigestOf([]));
});

test("the digest orders records independently of the host's collation", async () => {
  // `localeCompare` ranks "a.md" before "B.md"; code-unit order ranks "B.md" first. A digest that
  // followed the locale would hash the same content two ways depending on which machine ran the
  // sync, so CI and a developer's laptop could disagree about whether anything had changed.
  // The expected value is a known answer, computed from an explicit code-unit-sorted list.
  const { contentDigestOf, contentHashOf } = await import("../scripts/sync-firestore.mjs");
  const record = (path, hash) => ({ collection: "documentation", data: { [FIELDS.path]: path, [FIELDS.contentHash]: hash } });
  const expected = contentHashOf(
    ["documentation\u0000docs/B.md\u00002", "documentation\u0000docs/a.md\u00001"].join("\n"),
  );
  assert.equal(
    contentDigestOf([record("docs/a.md", "1"), record("docs/B.md", "2")]),
    expected,
    "B.md (0x42) sorts before a.md (0x61) by UTF-16 code unit",
  );
  assert.equal(
    contentDigestOf([record("docs/B.md", "2"), record("docs/a.md", "1")]),
    expected,
    "discovery order must not matter",
  );
});

test("the digest orders astral characters the way code units do, not the way codepoints do", async () => {
  // Astral characters are the one case where UTF-16 code-unit order and Unicode codepoint order
  // disagree: U+1F600 is stored as the surrogate pair 0xD83D 0xDE00, and 0xD83D sorts below
  // U+FFFD. The comment on `compareEntries` says the digest follows code units, so this pins it.
  const { contentDigestOf, contentHashOf } = await import("../scripts/sync-firestore.mjs");
  const record = (path) => ({ collection: "documentation", data: { [FIELDS.path]: path, [FIELDS.contentHash]: "1" } });
  const astral = "docs/\u{1F600}.md";
  const replacement = "docs/\uFFFD.md";

  const expected = contentHashOf(
    [`documentation\u0000${astral}\u00001`, `documentation\u0000${replacement}\u00001`].join("\n"),
  );
  assert.equal(
    contentDigestOf([record(replacement), record(astral)]),
    expected,
    "the astral name sorts first because its leading code unit 0xD83D is below 0xFFFD (codepoint ordering would put it after)",
  );
});
