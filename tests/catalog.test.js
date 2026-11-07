import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";

import {
  commitUrl,
  shortCommit,
  validCommit,
  validateCatalogRecord,
} from "../src/repositories/catalog.repository.js";
import {
  COLLECTION_CATALOG_ID,
  COLLECTIONS,
  FIELDS,
} from "../src/firebase/collections.js";

// The mirror follows `main`, a moving branch, so the catalogue is the only thing that makes the
// site's provenance claim checkable. These tests are about not claiming more than the record
// proves: every field is untrusted, and an absent commit must stay absent rather than being
// defaulted into something that reads as verified.

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("a well-formed catalogue record is accepted", () => {
  const record = validateCatalogRecord({
    [FIELDS.sourceRef]: "main",
    [FIELDS.sourceCommit]: SHA,
    [FIELDS.updatedAt]: "2026-01-01T00:00:00.000Z",
    counts: { written: 3, unchanged: 9, unpublished: 1, oversized: 0 },
  });
  assert.equal(record.sourceRef, "main");
  assert.equal(record.sourceCommit, SHA);
  assert.equal(record.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual({ ...record.counts }, { written: 3, unchanged: 9, unpublished: 1, oversized: 0 });
});

test("the commit is normalized but never invented", () => {
  // Uppercase is a formatting difference, not a different commit.
  assert.equal(validCommit(SHA.toUpperCase()), SHA);
  assert.equal(validCommit(` ${SHA} `), SHA);

  for (const value of ["", "main", "HEAD", SHA.slice(0, 7), `${SHA}0`, null, undefined, 42, {}]) {
    assert.equal(validCommit(value), "", `${JSON.stringify(value)} must not be read as a commit`);
  }
});

test("a record without a usable commit reports none rather than the branch name", () => {
  // The trap: defaulting an unresolvable commit to `sourceRef` would render "mirrored from main
  // at main", which looks like an answer and is not one.
  const record = validateCatalogRecord({ [FIELDS.sourceRef]: "main", [FIELDS.sourceCommit]: "main" });
  assert.equal(record.sourceCommit, "", "an unprovable commit must stay empty");
  assert.equal(shortCommit(record.sourceCommit), "", "and must not shorten into something visible");
  assert.equal(commitUrl(record.sourceCommit), "", "and must not produce a link to nowhere");
});

test("a malformed record degrades to defaults instead of throwing", () => {
  for (const value of [null, undefined, "string", 7, []]) {
    const record = validateCatalogRecord(value);
    assert.equal(record.sourceRef, "main");
    assert.equal(record.sourceCommit, "");
    assert.deepEqual({ ...record.counts }, { written: 0, unchanged: 0, unpublished: 0, oversized: 0 });
  }
});

test("counts that are not numbers are reported as zero", () => {
  const record = validateCatalogRecord({ counts: { written: "3", unchanged: NaN, unpublished: Infinity } });
  for (const [key, value] of Object.entries(record.counts)) {
    assert.equal(typeof value, "number", `${key} must be a number`);
    assert.ok(Number.isFinite(value), `${key} must be finite`);
  }
});

test("short and full forms point at the same commit", () => {
  assert.equal(shortCommit(SHA), SHA.slice(0, 7));
  assert.equal(commitUrl(SHA), `https://github.com/Oqthara/oqthara/commit/${SHA}`);
  assert.match(commitUrl(SHA), /\/commit\/[0-9a-f]{40}$/);
});

test("the catalogue id is the one the rules name and the sync script writes", () => {
  // Three files agree on this string by hand: the rules, the writer and this reader. A rename in
  // one of them would otherwise fail only at runtime, in production, as an empty provenance line.
  assert.equal(COLLECTION_CATALOG_ID, "catalog");
  assert.equal(COLLECTIONS.metadata, "metadata");

  const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
  assert.match(
    rules,
    new RegExp(`match /${COLLECTIONS.metadata}/${COLLECTION_CATALOG_ID} \\{`),
    "firestore.rules must name the same catalogue document",
  );
  assert.doesNotMatch(
    rules,
    new RegExp(`match /${COLLECTIONS.metadata}/${COLLECTION_CATALOG_ID} \\{\\s*allow (read|write): if true`),
    "the catalogue must not be unconditionally readable or writable",
  );
});

test("the sync script writes the catalogue it claims to write", () => {
  // The reader is only correct if the writer emits the same fields. This is the join between the
  // two, asserted directly because the pair crosses a process boundary a unit test cannot cross.
  const source = readFileSync(new URL("../scripts/sync-firestore.mjs", import.meta.url), "utf8");
  assert.match(source, /COLLECTION_CATALOG_ID/, "the sync script must use the shared id");
  assert.match(
    source,
    /\[FIELDS\.sourceCommit\]: commit/,
    "the sync script must write the resolved commit",
  );
  assert.match(
    source,
    new RegExp(`collection\\(COLLECTIONS\\.${"metadata"}\\)`),
    "the sync script must mirror the catalogue into the readable collection",
  );
});

// --- the release/documentation consistency model ---------------------------------------------

test("the sync job can only ever mirror main, never a release tag", () => {
  // The hazard the content model has to rule out: a detected Alpha tag being mirrored into the
  // unversioned `documentation` collection. Release tags contain far fewer documents than `main`,
  // and "absent from the desired set" means "unpublish" to the planner - so mirroring a tag would
  // retract every document that only exists on `main`, silently, for readers on the dev channel.
  //
  // The model avoids it structurally rather than by a check at write time: the only job holding
  // the service account runs from `main` and passes no `--ref`, so the ref is `MIRRORED_REF`.
  const workflow = readFileSync(
    new URL("../.github/workflows/alpha-release-sync.yml", import.meta.url),
    "utf8",
  );
  const parsed = YAML.parse(workflow);

  for (const [name, job] of Object.entries(parsed.jobs)) {
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const runsSync = steps.some((step) => /sync-firestore\.mjs/.test(step.run ?? ""));
    if (!runsSync) continue;
    assert.equal(
      job.if,
      "github.ref == 'refs/heads/main'",
      `the job that mirrors content (${name}) must be pinned to main`,
    );
    for (const step of steps) {
      const run = step.run ?? "";
      if (!/sync-firestore\.mjs/.test(run)) continue;
      assert.doesNotMatch(
        run,
        /--ref[= ]/,
        `the mirror must never be pointed at a release ref: ${run.trim()}`,
      );
    }
  }
});

test("a release channel is read from GitHub at its tag, not from the mirror", () => {
  // The other half of the policy: a release channel's provenance is its tag, so its documents come
  // from GitHub. If this ever routed a release channel at the mirror, an Alpha would display
  // `main` content under a release label - the exact confusion the model exists to prevent.
  const docs = readFileSync(new URL("../src/pages/DocsPage.jsx", import.meta.url), "utf8");
  assert.match(
    docs,
    /showsMirror\s*=\s*channel\.ref === DEFAULT_REF/,
    "only the development channel may be described as mirrored",
  );
});
