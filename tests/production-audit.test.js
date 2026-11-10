import test from "node:test";
import assert from "node:assert/strict";

import {
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  auditProduction,
  classifyOrphan,
  compareRecord,
  compareSyncRecord,
  decodeFields,
  formatReport,
  readOnlyClient,
  recordedHashMatches,
  resolveToken,
  retryDelayMs,
} from "../scripts/audit-production.mjs";
import { buildReleaseRecord, contentHashOf } from "../scripts/sync-firestore.mjs";
import { COLLECTIONS, FIELDS } from "../src/firebase/collections.js";

// The audit decides whether production may be reconciled, so its comparison must be provably
// correct rather than merely quiet. Every case below is one the live audit actually hit:
//
//   * a release stores a composite hash, so comparing it to a hash of its body reports a
//     difference on every release forever;
//   * content stores a hash of its body, so the same equality must hold there;
//   * a document whose only difference is the recorded hash is not an out-of-band edit and must
//     not be described as one, because that wording would justify overwriting real content.

const NOW = "2026-11-06T12:55:29.224Z";

function documentRecord({ path = "docs/a.md", content = "# A\n", collection = COLLECTIONS.documentation } = {}) {
  return {
    collection,
    id: path.replaceAll("/", "__"),
    data: {
      [FIELDS.path]: path,
      [FIELDS.title]: "A",
      [FIELDS.content]: content,
      [FIELDS.published]: true,
      [FIELDS.sourceRef]: "oqthara/oqthara",
      [FIELDS.contentHash]: contentHashOf(content),
      [FIELDS.updatedAt]: NOW,
    },
  };
}

function releaseRecord(tag = "v0.1.0-alpha.1", body = "notes") {
  return buildReleaseRecord(
    {
      tag_name: tag,
      name: tag,
      body,
      prerelease: true,
      published_at: "2026-11-04T15:28:04Z",
      html_url: `https://example.test/${tag}`,
    },
    { now: NOW },
  );
}

/** The record as Firestore returns it: fields only, no collection or id wrapper. */
function storedOf(record) {
  return { name: `projects/oqthara/databases/(default)/documents/${record.collection}/${record.id}`, fields: { ...record.data } };
}

test("a release whose fields all match is a MATCH, not a hash difference", () => {
  const desired = releaseRecord();
  const stored = storedOf(desired);
  const result = compareRecord(desired, stored);
  assert.equal(result.status, AUDIT_STATUS.MATCH, `unexpected difference: ${result.difference.join("; ")}`);
  assert.deepEqual(result.difference, []);
});

test("a release edited upstream is still reported when a rendered field changes", () => {
  const desired = releaseRecord();
  const stored = storedOf(desired);
  stored.fields[FIELDS.content] = "different notes";
  const result = compareRecord(desired, stored);
  assert.equal(result.status, AUDIT_STATUS.UPDATE);
  // The composite hash cannot detect a body edit, so the body must be compared directly.
  assert.ok(result.difference.some((line) => line.includes("body differs")), `difference was: ${result.difference.join("; ")}`);
  assert.ok(result.risk.includes("out-of-band"), `risk was softened to: ${result.risk}`);
});

test("a release whose metadata changed is reported even when the body did not", () => {
  const desired = releaseRecord();
  const stored = storedOf(desired);
  stored.fields[FIELDS.prerelease] = false;
  const result = compareRecord(desired, stored);
  assert.equal(result.status, AUDIT_STATUS.UPDATE);
  assert.ok(result.difference.some((line) => line.startsWith("prerelease is")), `difference was: ${result.difference.join("; ")}`);
});

test("a release differing only by the recorded hash is described as a formula change", () => {
  const desired = releaseRecord();
  const stored = storedOf(desired);
  stored.fields[FIELDS.contentHash] = contentHashOf("some older formula");
  const result = compareRecord(desired, stored);
  assert.equal(result.status, AUDIT_STATUS.UPDATE);
  assert.ok(result.reason.includes("hash-formula"), `reason was: ${result.reason}`);
  assert.ok(result.risk.includes("only restamps"), `risk overstated as: ${result.risk}`);
});

test("a content document is compared against a hash of its own body", () => {
  const desired = documentRecord();
  assert.equal(compareRecord(desired, storedOf(desired)).status, AUDIT_STATUS.MATCH);

  const tampered = storedOf(desired);
  tampered.fields[FIELDS.content] = "# A\nedited\n";
  const result = compareRecord(desired, tampered);
  assert.equal(result.status, AUDIT_STATUS.UPDATE);
  assert.ok(result.difference.some((line) => line.startsWith("content hash differs")));
});

test("a genuinely absent document is MISSING and proposes an upsert", () => {
  const result = compareRecord(documentRecord(), null);
  assert.equal(result.status, AUDIT_STATUS.MISSING);
  assert.equal(result.action, "upsert");
  assert.equal(result.risk, "none until applied; the site currently falls back to GitHub for this path");
});

test("a non-boolean published flag is a difference even when it is truthy", () => {
  const desired = documentRecord();
  const stored = storedOf(desired);
  stored.fields[FIELDS.published] = "true";
  const result = compareRecord(desired, stored);
  assert.equal(result.status, AUDIT_STATUS.UPDATE);
  assert.ok(result.difference.some((line) => line.includes("published is")));
});

test("recordedHashMatches picks the formula from the collection, not the shape", () => {
  const release = releaseRecord();
  // Hashing the body would disagree; the composite hash must win for releases.
  assert.equal(recordedHashMatches(release, release.data[FIELDS.content], release.data[FIELDS.contentHash]), true);

  const doc = documentRecord();
  assert.equal(recordedHashMatches(doc, doc.data[FIELDS.content], doc.data[FIELDS.contentHash]), true);
  assert.equal(recordedHashMatches(doc, doc.data[FIELDS.content], "mismatched"), false);
});

test("a bookkeeping record is compared with the same formula as its content", () => {
  const release = releaseRecord();
  const syncFields = { [FIELDS.contentHash]: release.data[FIELDS.contentHash], [FIELDS.bytes]: Buffer.byteLength(release.data[FIELDS.content]), [FIELDS.status]: "published" };
  assert.deepEqual(compareSyncRecord(syncFields, release.data, COLLECTIONS.releases).differences, []);

  const doc = documentRecord();
  const docSync = { [FIELDS.contentHash]: doc.data[FIELDS.contentHash], [FIELDS.bytes]: Buffer.byteLength(doc.data[FIELDS.content]), [FIELDS.status]: "published" };
  assert.deepEqual(compareSyncRecord(docSync, doc.data, COLLECTIONS.documentation).differences, []);
});

test("a published orphan is an unpublish candidate and is never proposed for deletion", () => {
  const orphan = classifyOrphan(COLLECTIONS.documentation, "gone__page.md", { [FIELDS.path]: "gone/page.md", [FIELDS.published]: true });
  assert.equal(orphan.status, AUDIT_STATUS.UNPUBLISH_CANDIDATE);
  assert.equal(orphan.action, "unpublish");
  // Unpublishing is the strongest action the plan may take; no disposition anywhere offers a delete.
  const actions = new Set(AUDIT_ACTIONS);
  assert.ok(actions.has(orphan.action));
  assert.ok(!actions.has("delete"), "the plan must never offer a delete action");
});

test("an unpublished orphan needs no action", () => {
  const orphan = classifyOrphan(COLLECTIONS.documentation, "gone__page.md", { [FIELDS.path]: "gone/page.md", [FIELDS.published]: false });
  assert.equal(orphan.status, AUDIT_STATUS.ORPHAN);
  assert.equal(orphan.action, "none");
});

test("decodeFields unwraps the Firestore value union", () => {
  const decoded = decodeFields({
    a: { stringValue: "text" },
    b: { booleanValue: true },
    c: { integerValue: "7" },
    d: { arrayValue: { values: [{ stringValue: "x" }] } },
    e: { mapValue: { fields: { inner: { stringValue: "y" } } } },
    f: { nullValue: null },
  });
  assert.equal(decoded.a, "text");
  assert.equal(decoded.b, true);
  assert.equal(decoded.c, 7);
  assert.deepEqual(decoded.d, ["x"]);
  assert.deepEqual(decoded.e, { inner: "y" });
  assert.equal(decoded.f, null);
});

test("auditProduction classifies matches, updates, orphans and unexpected collections", async () => {
  const matching = documentRecord({ path: "docs/keep.md" });
  const drifted = documentRecord({ path: "docs/drift.md", content: "# old\n" });
  const orphan = documentRecord({ path: "docs/gone.md" });

  const store = new Map([
    [COLLECTIONS.documentation, new Map([
      [matching.id, storedOf(matching).fields],
      [drifted.id, storedOf(drifted).fields],
      [orphan.id, storedOf(orphan).fields],
    ])],
    ["surprise", new Map([["x", { [FIELDS.published]: true }]])],
  ]);

  const client = {
    listCollections: async () => [...store.keys()],
    listCollection: async (name) => [...(store.get(name) ?? new Map()).entries()].map(([id, fields]) => ({ id, fields })),
    getDocument: async () => null,
  };

  const report = await auditProduction({
    client,
    desired: [matching, documentRecord({ path: "docs/drift.md", content: "# new\n" }), documentRecord({ path: "docs/brand-new.md" })],
    commit: "7ffb6755847f30a1300d3201ff9d16a96fda26bb",
    generatedAt: NOW,
  });

  const byId = new Map(report.dispositions.map((entry) => [`${entry.collection}/${entry.id}`, entry]));
  assert.equal(byId.get(`${COLLECTIONS.documentation}/${matching.id}`).status, AUDIT_STATUS.MATCH);
  assert.equal(byId.get(`${COLLECTIONS.documentation}/${drifted.id}`).status, AUDIT_STATUS.UPDATE);
  assert.equal(byId.get(`${COLLECTIONS.documentation}/docs__brand-new.md`).status, AUDIT_STATUS.MISSING);
  assert.equal(byId.get(`${COLLECTIONS.documentation}/${orphan.id}`).status, AUDIT_STATUS.UNPUBLISH_CANDIDATE);
  assert.deepEqual(report.unexpectedCollections, ["surprise"]);
});

test("the client the audit is given is never asked to write", () => {
  // The read-only guarantee is a property of the client factory, so the report must be buildable
  // from an object that only offers reads. If a write ever crept in, this stub would throw.
  const forbidden = () => {
    throw new Error("the audit must not write");
  };
  const client = {
    listCollections: forbidden,
    listCollection: forbidden,
    getDocument: forbidden,
    setDocument: forbidden,
    patchDocument: forbidden,
    deleteDocument: forbidden,
  };
  assert.equal(typeof client.setDocument, "function");
  return assert.rejects(() => auditProduction({ client, desired: [], commit: "abc", generatedAt: NOW }), /must not write/);
});

// `resolveToken` picks the credential path that reaches live Firestore, so a bug here silently
// disables the tool or mints a token for the wrong identity. It shipped once with two: the async
// `loadCredentials` was not awaited, so `.ok` read `undefined` on a Promise and every call failed
// with the reason printed as "undefined"; and the field is `serviceAccount`, not `credential`.
// The `--token` path bypassed both, which is why they survived a passing suite.

test("resolveToken needs no credential when an explicit token is supplied", async () => {
  const result = await resolveToken({ useEnvToken: true, env: { OQ_AUDIT_TOKEN: "ya29.explicit" } });
  assert.equal(result.ok, true);
  assert.equal(result.token, "ya29.explicit");
});

test("resolveToken rejects an empty explicit token instead of minting one", async () => {
  const result = await resolveToken({ useEnvToken: true, env: { OQ_AUDIT_TOKEN: "   " } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /OQ_AUDIT_TOKEN is empty/);
});

test("resolveToken reports a genuine reason, never the string 'undefined'", async () => {
  // No credential in the environment at all: the failure must be explained, because this is the
  // message a maintainer sees and acts on.
  const result = await resolveToken({ useEnvToken: false, env: {} });
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, "string");
  assert.notEqual(result.reason, "undefined");
  assert.match(result.reason, /FIREBASE_SERVICE_ACCOUNT|GOOGLE_APPLICATION_CREDENTIALS/);
});

test("resolveToken rejects a credential whose identity is not the expected service account", async () => {
  // A well-formed key for the wrong account must stop before it is used, so a misconfigured
  // environment cannot read production as someone else.
  const wrongAccount = JSON.stringify({
    type: "service_account",
    project_id: "someone-else",
    client_email: "not-the-auditor@someone-else.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
  });
  const result = await resolveToken({ useEnvToken: false, env: { FIREBASE_SERVICE_ACCOUNT: wrongAccount } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /expected/);
  assert.match(result.reason, /someone-else/);
});

// ---------------------------------------------------------------------------
// The catalogue contract. The audit's job is to notice a state the sync writer
// can produce: a catalogue document that exists, holds the right commit, and is
// still unreadable because `published` is missing or not the boolean `true`.
// ---------------------------------------------------------------------------

test("a catalogue missing the published flag is reported unreadable", async () => {
  const { auditCatalogContract } = await import("../scripts/audit-production.mjs");
  const commit = "a".repeat(40);
  // Exactly what the writer shipped: status says published, the flag is absent.
  const contract = auditCatalogContract(
    { fields: { status: "published", sourceRef: "main", sourceCommit: commit, updatedAt: "2026-11-06T00:00:00.000Z", counts: { written: 1, unchanged: 2, unpublished: 0, oversized: 0 } } },
    commit,
  );

  assert.equal(contract.readable, false, "a catalogue without the boolean flag cannot be read by a client");
  assert.equal(contract.problems.length, 1);
  assert.match(contract.problems[0], /published is null \(undefined\)/);
});

test("a catalogue whose published flag is a truthy non-boolean is still unreadable", async () => {
  // `"true"` and `1` are truthy but fail `resource.data.published == true` in the rules, so a
  // report that only checked truthiness would call an unreadable catalogue healthy.
  const { auditCatalogContract } = await import("../scripts/audit-production.mjs");
  const commit = "b".repeat(40);
  const base = { sourceRef: "main", sourceCommit: commit, updatedAt: "2026-11-06T00:00:00.000Z", counts: { written: 0, unchanged: 1, unpublished: 0, oversized: 0 } };

  for (const published of ["true", 1, { value: true }]) {
    const contract = auditCatalogContract({ fields: { ...base, published } }, commit);
    assert.equal(contract.readable, false, `published ${JSON.stringify(published)} must not be accepted`);
    assert.match(contract.problems[0], /requires the literal boolean true/);
  }
});

test("a well-formed catalogue passes the contract", async () => {
  const { buildCatalogRecord } = await import("../scripts/sync-firestore.mjs");
  const { auditCatalogContract } = await import("../scripts/audit-production.mjs");
  const commit = "c".repeat(40);
  const contract = auditCatalogContract(
    { fields: buildCatalogRecord({ commit, now: "2026-11-06T00:00:00.000Z", counts: { written: 2, unchanged: 3, unpublished: 1, oversized: 0 } }) },
    commit,
  );

  assert.deepEqual(contract.problems, []);
  assert.equal(contract.readable, true, "the producer's own payload must satisfy the audit");
});

test("a catalogue recorded against a different commit is reported", async () => {
  const { buildCatalogRecord } = await import("../scripts/sync-firestore.mjs");
  const { auditCatalogContract } = await import("../scripts/audit-production.mjs");
  const contract = auditCatalogContract(
    { fields: buildCatalogRecord({ commit: "d".repeat(40), now: "2026-11-06T00:00:00.000Z" }) },
    "e".repeat(40),
  );

  assert.equal(contract.readable, false);
  assert.ok(contract.problems.some((problem) => /canonical branch is at/.test(problem)));
});

test("an absent catalogue is reported as unusable rather than as an error", async () => {
  const { auditCatalogContract } = await import("../scripts/audit-production.mjs");
  const contract = auditCatalogContract(null, "f".repeat(40));

  assert.equal(contract.readable, false);
  assert.equal(contract.problems.length, 1);
  assert.match(contract.problems[0], /does not exist/);
});

test("metadata documents other than the catalogue are reported, not silently dropped", async () => {
  // The audit skips metadata when comparing content. Skipping it *and* not reporting it would
  // make an unexpected write to that collection look like a clean audit, so the report names
  // every such document and its published value.
  const { auditProduction } = await import("../scripts/audit-production.mjs");
  const store = new Map([
    [COLLECTIONS.metadata, new Map([
      ["site", { title: "Oqthara", published: true }],
      ["experiment", { published: "yes" }],
    ])],
  ]);

  const client = {
    listCollections: async () => [...store.keys()],
    listCollection: async (name) => [...(store.get(name) ?? new Map()).entries()].map(([id, fields]) => ({ id, fields })),
    getDocument: async () => null,
  };

  const report = await auditProduction({
    client,
    desired: [],
    commit: "7ffb6755847f30a1300d3201ff9d16a96fda26bb",
    generatedAt: NOW,
  });

  assert.deepEqual(report.metadata.documents.map((entry) => entry.id), ["experiment", "site"]);
  const site = report.metadata.documents.find((entry) => entry.id === "site");
  assert.equal(site.published, true);
  assert.equal(site.publishedType, "boolean");
  const experiment = report.metadata.documents.find((entry) => entry.id === "experiment");
  assert.equal(experiment.published, "yes");
  assert.equal(experiment.publishedType, "string", "the type is reported because the rule tests the type");
});

test("the report states whether a client could read the catalogue", async () => {
  const { auditProduction } = await import("../scripts/audit-production.mjs");
  const commit = "7ffb6755847f30a1300d3201ff9d16a96fda26bb";
  const client = {
    listCollections: async () => [COLLECTIONS.metadata],
    listCollection: async () => [],
    getDocument: async (_collection, id) =>
      id === "catalog"
        ? { fields: { sourceRef: "main", sourceCommit: commit, updatedAt: "2026-11-06T00:00:00.000Z", counts: { written: 0, unchanged: 0, unpublished: 0, oversized: 0 } } }
        : null,
  };

  const report = await auditProduction({ client, desired: [], commit, generatedAt: NOW });

  assert.equal(report.catalog.metadata.exists, true);
  assert.equal(report.catalog.contract.readable, false, "a catalogue without the flag is unreadable");
  const rendered = formatReport(report);
  assert.match(rendered, /Catalogue readable by a client: NO/);
});

// ---------------------------------------------------------------------------
// Release-watch state
// ---------------------------------------------------------------------------

// `sync/upstream-release` is written by `scripts/check-upstream-release.mjs`, not by the content
// sync, and it has no `collection` or `path` because it describes a release rather than a
// document. Auditing it with the content-bookkeeping validator reported a permanent INVALID
// record that was in fact correct. These cases pin the real schema so that false alarm cannot
// return, and so a genuinely broken record is still caught.

const SYNCED_AT = "2026-11-06T12:00:00.000Z";
const SHA = "a".repeat(40);

function successfulState() {
  return {
    tag: "v0.1.0-alpha.2",
    commitSha: SHA,
    releaseHash: "49d578a36ff2",
    releaseId: 123456,
    publishedAt: "2026-11-05T00:00:00Z",
    prerelease: true,
    url: "https://github.com/Oqthara/oqthara/releases/tag/v0.1.0-alpha.2",
    syncedAt: SYNCED_AT,
    lastCheckedAt: SYNCED_AT,
    lastAttempt: { tag: "v0.1.0-alpha.2", commitSha: SHA, result: "ok", detail: "", finishedAt: SYNCED_AT },
    status: "ok",
  };
}

function failedState() {
  return {
    status: "failed",
    lastCheckedAt: SYNCED_AT,
    lastAttempt: {
      tag: "v0.1.0-alpha.2",
      commitSha: SHA,
      result: "failed",
      detail: "sync exited 4",
      finishedAt: SYNCED_AT,
    },
  };
}

test("a successful release-watch record is valid without collection or path", async () => {
  const { auditReleaseWatch } = await import("../scripts/audit-production.mjs");
  const result = auditReleaseWatch(successfulState());

  assert.equal(result.present, true);
  assert.equal(result.valid, true, result.problems.join("; "));
  assert.deepEqual(result.problems, []);
  assert.equal(result.tag, "v0.1.0-alpha.2");
  assert.equal(result.commitSha, SHA);
  assert.equal(result.lastAttempt.result, "ok");
});

test("a failed release-watch record is valid and keeps the failure detail", async () => {
  const { auditReleaseWatch } = await import("../scripts/audit-production.mjs");
  const result = auditReleaseWatch(failedState());

  assert.equal(result.valid, true, result.problems.join("; "));
  assert.equal(result.status, "failed");
  assert.equal(result.tag, null);
  assert.equal(result.lastAttempt.result, "failed");
  assert.equal(result.lastAttempt.detail, "sync exited 4");
});

test("a failed record that still carries the last good pointer stays valid", async () => {
  const { auditReleaseWatch } = await import("../scripts/audit-production.mjs");
  // buildStateUpdate merges with `{ merge: true }`, so the pointer from an earlier success
  // survives a later failure. That is deliberate — losing it would lose the last known good
  // release — and must not be reported as a contradiction.
  const result = auditReleaseWatch({ ...successfulState(), status: "failed", lastAttempt: failedState().lastAttempt });

  assert.equal(result.valid, true, result.problems.join("; "));
  assert.equal(result.tag, "v0.1.0-alpha.2");
});

test("an absent release-watch record is reported as absent, not as invalid", async () => {
  const { auditReleaseWatch } = await import("../scripts/audit-production.mjs");
  assert.deepEqual(auditReleaseWatch(undefined), {
    present: false,
    valid: false,
    status: null,
    problems: ["sync/upstream-release does not exist"],
  });
});

test("a record with no lastAttempt was not written by buildStateUpdate and is invalid", async () => {
  const { auditReleaseWatch } = await import("../scripts/audit-production.mjs");
  const result = auditReleaseWatch({ status: "ok", tag: "v1", commitSha: SHA, syncedAt: SYNCED_AT, lastCheckedAt: SYNCED_AT });
  assert.equal(result.valid, false);
  assert.match(result.problems.join(" "), /lastAttempt is missing/);
});

test("a bad SHA, unknown status, or non-UTC timestamp is caught", async () => {
  const { auditReleaseWatch } = await import("../scripts/audit-production.mjs");

  const badSha = auditReleaseWatch({ ...successfulState(), commitSha: "not-a-sha" });
  assert.equal(badSha.valid, false);
  assert.match(badSha.problems.join(" "), /commitSha is not a 40-character hex SHA/);

  const badStatus = auditReleaseWatch({ ...successfulState(), status: "synced" });
  assert.equal(badStatus.valid, false);
  assert.match(badStatus.problems.join(" "), /expected "ok" or "failed"/);

  const badTime = auditReleaseWatch({ ...successfulState(), syncedAt: "2026-11-06 12:00:00" });
  assert.equal(badTime.valid, false);
  assert.match(badTime.problems.join(" "), /syncedAt is not an ISO-8601 UTC timestamp/);

  const badResult = auditReleaseWatch({ ...successfulState(), lastAttempt: { ...successfulState().lastAttempt, result: "maybe" } });
  assert.equal(badResult.valid, false);
  assert.match(badResult.problems.join(" "), /lastAttempt.result is "maybe"/);
});

test("status ok with no pointer is a contradiction", async () => {
  const { auditReleaseWatch } = await import("../scripts/audit-production.mjs");
  const state = successfulState();
  delete state.tag;
  delete state.commitSha;
  const result = auditReleaseWatch(state);
  assert.equal(result.valid, false);
  assert.match(result.problems.join(" "), /no tag\/commitSha pointer/);
});

test("the report separates the release watch from content bookkeeping", async () => {
  const { auditReleaseWatch, formatReport } = await import("../scripts/audit-production.mjs");
  const report = {
    generatedAt: NOW,
    project: "oqthara",
    canonical: { commit: SHA, shortCommit: "aaaaaaa", records: 0 },
    collections: [COLLECTIONS.documentation],
    unexpectedCollections: [],
    countsByCollection: {},
    tally: {},
    dispositions: [],
    sync: { records: 1, dispositions: [] },
    releaseWatch: auditReleaseWatch(successfulState()),
    catalog: { sync: { exists: false }, metadata: { exists: false }, contract: { readable: false, problems: [] } },
    metadata: { documents: [] },
  };
  const text = formatReport(report);

  assert.match(text, /Bookkeeping records: 1, all consistent/);
  assert.match(text, /Release watch: valid \(status "ok"; v0\.1\.0-alpha\.2 at aaaaaaa synced/);
  assert.match(text, /last attempt: ok for v0\.1\.0-alpha\.2/);
});

test("formatting a malformed release-watch record reports it instead of crashing", async () => {
  const { auditReleaseWatch, formatReport } = await import("../scripts/audit-production.mjs");
  // This section exists to describe broken records, so a broken record must never be able to
  // abort the report that would have described it. `commitSha` null with `tag` set is exactly the
  // shape that used to throw on `.slice()`.
  const broken = {
    tag: "v0.1.0-alpha.2",
    status: "ok",
    lastCheckedAt: SYNCED_AT,
    lastAttempt: { tag: "v0.1.0-alpha.2", result: "ok", finishedAt: null, detail: "" },
  };
  const empty = {};

  for (const fields of [broken, empty]) {
    const report = {
      generatedAt: NOW,
      project: "oqthara",
      canonical: { commit: SHA, shortCommit: "aaaaaaa", records: 0 },
      collections: [],
      unexpectedCollections: [],
      countsByCollection: {},
      tally: {},
      dispositions: [],
      sync: { records: 1, dispositions: [] },
      releaseWatch: auditReleaseWatch(fields),
      catalog: { sync: { exists: false }, metadata: { exists: false }, contract: { readable: false, problems: [] } },
      metadata: { documents: [] },
    };
    const text = formatReport(report);
    assert.match(text, /Release watch: INVALID/, "a malformed record is reported, not swallowed");
  }
});

// A scheduled audit must survive a momentary quota answer. The live run on 2026-11-08 died on
// `429 listCollectionIds ... RESOURCE_EXHAUSTED` before comparing a single document, so the
// retry below is the difference between an audit that runs and one that never finishes.
test("a retryable status is retried and the eventual answer is returned", async () => {
  const seen = [];
  const answers = [
    { status: 429, body: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }) },
    { status: 503, body: "unavailable" },
    { status: 200, body: JSON.stringify({ collectionIds: ["documentation"] }) },
  ];
  const fetchImpl = async () => {
    const answer = answers[seen.length];
    seen.push(answer.status);
    return { ok: answer.status < 400, status: answer.status, text: async () => answer.body };
  };
  const slept = [];
  const client = readOnlyClient({ token: "t", fetchImpl, sleepImpl: async (ms) => slept.push(ms) });

  assert.deepEqual(await client.listCollections(), ["documentation"]);
  assert.deepEqual(seen, [429, 503, 200], "each transient answer is retried exactly once");
  assert.deepEqual(slept, [retryDelayMs(1), retryDelayMs(2)], "the wait grows between attempts");
});

test("a non-retryable status fails at once instead of spending the retry budget", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 403, text: async () => "forbidden" };
  };
  const client = readOnlyClient({ token: "t", fetchImpl, sleepImpl: async () => {} });

  await assert.rejects(() => client.listCollections(), /403 listCollectionIds forbidden/);
  assert.equal(calls, 1, "a bad credential does not improve by asking again");
});

test("retries are bounded, then the last answer is reported", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 429, text: async () => "quota" };
  };
  const client = readOnlyClient({ token: "t", fetchImpl, sleepImpl: async () => {} });

  await assert.rejects(() => client.listCollections(), /429 listCollectionIds quota/);
  assert.equal(calls, 4, "MAX_ATTEMPTS bounds the retries so a stuck quota cannot hang the job");
});
