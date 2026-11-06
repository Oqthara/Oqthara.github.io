import test from "node:test";
import assert from "node:assert/strict";

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
