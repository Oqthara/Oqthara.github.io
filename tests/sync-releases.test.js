import test from "node:test";
import assert from "node:assert/strict";

import { listReleases, planSync } from "../scripts/sync-firestore.mjs";
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
