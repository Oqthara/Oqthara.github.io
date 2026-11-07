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
  recordedHashMatches,
  resolveToken,
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
