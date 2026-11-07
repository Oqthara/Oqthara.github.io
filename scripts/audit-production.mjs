// Compare the live Cloud Firestore mirror with the canonical repository. Read-only.
//
// What this answers
// -----------------
// `sync-firestore.mjs` decides what to write by comparing the canonical source against the
// `sync` bookkeeping collection. That is the right question for a sync and the wrong question
// for an audit: a content document edited outside the script keeps its recorded hash, and a
// document written by an older version of the script may never have a bookkeeping record at
// all. So this script reads every content document and hashes what is actually stored, then
// reports the differences it finds rather than the differences the planner would act on.
//
// Safety
// ------
// Every call is a read-only Firestore operation (`GET` on a document, `POST …:listCollectionIds`
// to enumerate collections). There is no write path: no `PATCH`, no document `POST`, no `DELETE`
// and no batch object is ever created. `listCollectionIds` is a POST because it takes a request
// body, not because it mutates; it is a read method. A defect in this file can produce a wrong
// report, not a mutated database.
//
// Credentials
// -----------
// `--token` reads an access token from the environment (`OQ_AUDIT_TOKEN`), which is how the
// operator supplies a short-lived token from an existing `gcloud` session. Otherwise the
// service account from `loadCredentials()` is minted into a token. Neither the token nor the
// key is ever printed.
//
// Usage
// -----
//   node scripts/audit-production.mjs --out=artifacts/firestore-audit/report.json
//   node scripts/audit-production.mjs --token --out=... --json

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  COLLECTIONS,
  COLLECTION_CATALOG_ID,
  CONTENT_COLLECTIONS,
  FIELDS,
  SYNC_STATUS,
  docIdFor,
  syncIdFor,
  asIsoTimestamp,
  isNonEmptyString,
} from "../src/firebase/collections.js";
import { EXPECTED_EMAIL, EXPECTED_PROJECT, identityOf, mintAccessToken } from "./check-firebase-access.mjs";
import { CONTENT_LIMIT_BYTES, collectDesired, loadCredentials } from "./sync-firestore.mjs";

const PROJECT = "oqthara";
const FIRESTORE = "https://firestore.googleapis.com/v1";
const DOCUMENTS = `projects/${PROJECT}/databases/(default)/documents`;

/** Collections the schema expects. Anything else found at the root is reported, not ignored. */
const EXPECTED_COLLECTIONS = Object.freeze([
  COLLECTIONS.documentation,
  COLLECTIONS.examples,
  COLLECTIONS.releases,
  COLLECTIONS.stdlib,
  COLLECTIONS.sync,
  COLLECTIONS.metadata,
]);

export const AUDIT_STATUS = Object.freeze({
  MATCH: "MATCH",
  UPDATE: "UPDATE",
  MISSING: "MISSING",
  UNPUBLISH_CANDIDATE: "UNPUBLISH CANDIDATE",
  ORPHAN: "ORPHAN",
  INVALID: "INVALID",
  UNKNOWN: "UNKNOWN",
});

/**
 * The complete set of actions a reconciliation plan may propose.
 *
 * Deliberately closed and deliberately without a delete: the sync preserves documents that lose
 * their source and unpublishes them instead, so a plan that offered a delete would promise a
 * capability the implementation does not have.
 */
export const AUDIT_ACTIONS = Object.freeze(["none", "upsert", "unpublish"]);

// ---------------------------------------------------------------------------
// Firestore value decoding
// ---------------------------------------------------------------------------

/**
 * Decodes one Firestore `Value` into a plain JavaScript value.
 *
 * The REST encoding wraps every field in a single-key object. Timestamps become ISO strings so
 * they compare the same way the sync writes them; anything unrecognised is reported as a
 * tagged string rather than silently dropped, because a silently dropped field is how a
 * malformed record starts reading as a valid one.
 */
export function decodeValue(value) {
  if (value === null || typeof value !== "object") return null;
  const [kind] = Object.keys(value);
  const inner = value[kind];
  switch (kind) {
    case "nullValue":
      return null;
    case "booleanValue":
    case "stringValue":
      return inner;
    case "integerValue":
      return Number(inner);
    case "doubleValue":
      return Number(inner);
    case "timestampValue":
      return inner;
    case "mapValue":
      return decodeFields(inner?.fields ?? {});
    case "arrayValue":
      return (inner?.values ?? []).map(decodeValue);
    default:
      return `<${kind}>`;
  }
}

/** Decodes a Firestore `fields` map into a plain object. */
export function decodeFields(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) out[key] = decodeValue(value);
  return out;
}

/** Shortens a commit id for display; never invents one that is absent. */
export function shortCommit(commit) {
  return typeof commit === "string" && commit.length === 40 ? commit.slice(0, 7) : "";
}

/** SHA-256 of the content as stored. */
export function hashOf(content) {
  return createHash("sha256").update(String(content ?? ""), "utf8").digest("hex");
}

/**
 * Whether the stored `contentHash` field is the one the canonical builder would write.
 *
 * Content collections hash the body, so the stored field must equal a hash of the stored body.
 * Releases hash every rendered field via `releaseHashOf`, so their stored field can only be
 * compared against the canonical record's declared hash. Treating a release like content reports
 * a permanent false difference on every release.
 */
export function recordedHashMatches(desired, storedContent, storedRecordedHash) {
  const declared = desired?.data?.[FIELDS.contentHash];
  const collection = desired?.collection;
  if (collection === COLLECTIONS.releases && typeof declared === "string" && declared) {
    return storedRecordedHash === declared;
  }
  return storedRecordedHash === hashOf(storedContent);
}

/** UTF-8 byte length, the same measure `byteLengthOf` uses when it decides oversized. */
export function bytesOf(content) {
  return Buffer.byteLength(String(content ?? ""), "utf8");
}

// ---------------------------------------------------------------------------
// Read-only Firestore client
// ---------------------------------------------------------------------------

/**
 * A Firestore REST client that can only read.
 *
 * Deliberately has no `write`, `set`, `commit` or `delete` method. The "read-only" claim in the
 * header is enforced by the shape of this object: the only operations it can perform are the two
 * read methods below, one of which happens to use HTTP POST.
 */
export function readOnlyClient({ token, project = PROJECT, fetchImpl = globalThis.fetch }) {
  const base = `${FIRESTORE}/projects/${project}/databases/(default)/documents`;
  const headers = { authorization: `Bearer ${token}`, "x-goog-user-project": project };

  async function get(url) {
    const response = await fetchImpl(url, { headers });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${url.replace(base, "")} ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  return {
    async listCollections() {
      const response = await fetchImpl(`${base}:listCollectionIds`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ pageSize: 100 }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} listCollectionIds ${text.slice(0, 300)}`);
      return JSON.parse(text).collectionIds ?? [];
    },
    /** Every document in a collection, decoded. Follows pagination. */
    async listCollection(id) {
      const documents = [];
      let pageToken = "";
      do {
        const query = `pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
        const page = await get(`${base}/${encodeURIComponent(id)}?${query}`);
        for (const document of page.documents ?? []) {
          documents.push({ name: document.name, id: document.name.split("/").pop(), fields: decodeFields(document.fields) });
        }
        pageToken = page.nextPageToken ?? "";
      } while (pageToken);
      return documents;
    },
    /** One document, or null when it does not exist. */
    async getDocument(collection, id) {
      const url = `${base}/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
      const response = await fetchImpl(url, { headers });
      if (response.status === 404) return null;
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${collection}/${id} ${text.slice(0, 300)}`);
      const document = JSON.parse(text);
      return { name: document.name, id, fields: decodeFields(document.fields) };
    },
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compares one canonical record with the document actually stored.
 *
 * Returns a disposition entry. The `difference` field is a list of concrete field-level facts,
 * never a summary, so the plan can be reviewed without re-reading the database.
 */
export function compareRecord(desired, actual) {
  const collection = desired.collection;
  const id = desired.id;
  const path = desired.data[FIELDS.path];
  const base = { collection, id, path, current: null, desiredRef: "", difference: [], action: "none", risk: "", reason: "" };

  if (!actual) {
    return {
      ...base,
      status: AUDIT_STATUS.MISSING,
      desiredRef: desired.data[FIELDS.contentHash],
      difference: ["document is absent from production"],
      action: "upsert",
      reason: "canonical source exists and no production document does",
      risk: "none until applied; the site currently falls back to GitHub for this path",
      verification: `read ${collection}/${id} and confirm contentHash equals ${desired.data[FIELDS.contentHash]}`,
    };
  }

  const stored = actual.fields ?? {};
  const content = typeof stored[FIELDS.content] === "string" ? stored[FIELDS.content] : "";
  const actualHash = hashOf(content);
  const declaredHash = desired.data[FIELDS.contentHash];
  const desiredHash = declaredHash;

  // Two kinds of difference, kept apart because they justify different actions.
  //
  // A *content* difference means production holds something the canonical source does not; writing
  // would destroy it, so it needs a maintainer decision. A *hash* difference means the body is the
  // one the source produces but the stored digest was computed by an older formula, which is what a
  // release written before `releaseHashOf` gained its extra fields looks like. Conflating them
  // would either overstate the risk of a harmless restamp or hide a real edit behind one.
  const contentDiffs = [];
  const hashes = [];

  if (collection === COLLECTIONS.releases) {
    // The composite hash cannot stand in for the body, so the body is compared directly.
    if (content !== String(desired.data[FIELDS.content] ?? "")) contentDiffs.push("release body differs from the canonical body");
  } else if (actualHash !== declaredHash) {
    hashes.push(`content hash differs (stored ${actualHash.slice(0, 12)}, canonical ${declaredHash.slice(0, 12)})`);
  }
  if (!recordedHashMatches(desired, content, stored[FIELDS.contentHash])) {
    hashes.push(`recorded contentHash does not match the canonical hash (recorded ${String(stored[FIELDS.contentHash]).slice(0, 12)}, canonical ${String(declaredHash).slice(0, 12)})`);
  }
  if (stored[FIELDS.title] !== desired.data[FIELDS.title]) contentDiffs.push(`title is ${JSON.stringify(stored[FIELDS.title])}, expected ${JSON.stringify(desired.data[FIELDS.title])}`);
  for (const field of [FIELDS.ref, FIELDS.label, FIELDS.prerelease, FIELDS.publishedAt, FIELDS.url]) {
    if (field in desired.data && stored[field] !== desired.data[field]) {
      contentDiffs.push(`${field} is ${JSON.stringify(stored[field])}, expected ${JSON.stringify(desired.data[field])}`);
    }
  }

  const structural = [];
  if (stored[FIELDS.path] !== path) structural.push(`path is ${JSON.stringify(stored[FIELDS.path])}, expected ${JSON.stringify(path)}`);
  if (stored[FIELDS.published] !== true) structural.push(`published is ${JSON.stringify(stored[FIELDS.published])} (${typeof stored[FIELDS.published]}), expected boolean true`);
  if (stored[FIELDS.sourceRef] !== desired.data[FIELDS.sourceRef]) structural.push(`sourceRef is ${JSON.stringify(stored[FIELDS.sourceRef])}, expected ${JSON.stringify(desired.data[FIELDS.sourceRef])}`);
  const size = bytesOf(content);
  if (size > CONTENT_LIMIT_BYTES) structural.push(`stored content is ${size} bytes, above the ${CONTENT_LIMIT_BYTES} byte cutoff`);
  if (!isNonEmptyString(stored[FIELDS.updatedAt])) structural.push("updatedAt is missing or not a non-empty string");

  const difference = [...hashes, ...contentDiffs, ...structural];
  const status = difference.length === 0 ? AUDIT_STATUS.MATCH : AUDIT_STATUS.UPDATE;
  const onlyHashes = difference.length > 0 && contentDiffs.length === 0 && structural.length === 0;
  return {
    ...base,
    status,
    current: { contentHash: actualHash, recordedHash: stored[FIELDS.contentHash] ?? null, published: stored[FIELDS.published] ?? null, publishedType: typeof stored[FIELDS.published], bytes: size, updatedAt: asIsoTimestamp(stored[FIELDS.updatedAt]) },
    desiredRef: desiredHash,
    difference,
    action: status === AUDIT_STATUS.MATCH ? "none" : "upsert",
    reason:
      status === AUDIT_STATUS.MATCH
        ? "production matches the canonical source field for field"
        : onlyHashes
          ? "only the stored contentHash differs; every rendered field matches, so this is a hash-formula change and not an out-of-band edit"
          : "stored document differs from the canonical source",
    risk:
      status === AUDIT_STATUS.MATCH
        ? "none"
        : onlyHashes
          ? "none; the write only restamps contentHash with the current formula"
          : "overwrites an out-of-band edit in production with canonical content",
    verification: status === AUDIT_STATUS.MATCH ? "no read-back needed" : `read ${collection}/${id} and confirm contentHash equals ${desiredHash}`,
  };
}

/**
 * Classifies a production content document that has no canonical source.
 *
 * Unpublish, never delete: the sync script preserves history on purpose and this plan does not
 * invent a stronger action than the implementation offers.
 */
export function classifyOrphan(collection, id, fields) {
  const published = fields?.[FIELDS.published];
  const path = fields?.[FIELDS.path] ?? "";
  return {
    collection,
    id,
    path,
    status: published === true ? AUDIT_STATUS.UNPUBLISH_CANDIDATE : AUDIT_STATUS.ORPHAN,
    current: { contentHash: hashOf(fields?.[FIELDS.content] ?? ""), recordedHash: fields?.[FIELDS.contentHash] ?? null, published: published ?? null, publishedType: typeof published, bytes: bytesOf(fields?.[FIELDS.content] ?? ""), updatedAt: asIsoTimestamp(fields?.[FIELDS.updatedAt]) },
    desiredRef: "",
    difference: ["no canonical source produces this document id"],
    action: published === true ? "unpublish" : "none",
    reason: published === true ? "source no longer exists in the canonical repository; the sync unpublishes and does not delete" : "already unpublished",
    risk: published === true ? "removes public visibility; content is retained" : "none",
    verification: published === true ? `read ${collection}/${id} and confirm published is false` : "no read-back needed",
  };
}

/**
 * Checks whether a bookkeeping record agrees with the content it describes.
 *
 * A mismatch here is the case the incremental planner cannot see: the content was edited (or
 * restored) out of band while the recorded hash stayed put, so `planSync` would skip the write.
 */
export function compareSyncRecord(syncFields, contentFields, collection = "") {
  const recorded = syncFields?.[FIELDS.contentHash] ?? null;
  const actual = contentFields
    ? collection === COLLECTIONS.releases
      ? (contentFields[FIELDS.contentHash] ?? null)
      : hashOf(contentFields[FIELDS.content] ?? "")
    : null;
  const differences = [];
  if (contentFields && recorded !== actual) differences.push(`recorded hash ${String(recorded).slice(0, 12)} does not match stored content ${actual.slice(0, 12)}`);
  if (contentFields && syncFields?.[FIELDS.bytes] !== bytesOf(contentFields[FIELDS.content] ?? "")) differences.push(`recorded bytes ${syncFields?.[FIELDS.bytes]} do not match stored ${bytesOf(contentFields[FIELDS.content] ?? "")}`);
  return { recorded, actual, status: syncFields?.[FIELDS.status] ?? null, differences };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** The fields of a catalogue document that the report shows, or `{ exists: false }`. */
export function describeCatalog(document) {
  if (!document) return { exists: false };
  const fields = document.fields ?? {};
  return {
    exists: true,
    sourceRef: fields[FIELDS.sourceRef] ?? null,
    sourceCommit: fields[FIELDS.sourceCommit] ?? null,
    updatedAt: asIsoTimestamp(fields[FIELDS.updatedAt]),
    status: fields[FIELDS.status] ?? null,
    // Reported as a value and as a type, because the rule tests the type: `"true"` and `1` both
    // fail `resource.data.published == true`, so a report that showed only the value would let
    // a non-boolean look correct.
    published: fields[FIELDS.published] ?? null,
    publishedType: typeof fields[FIELDS.published],
    counts: fields.counts ?? null,
  };
}

/**
 * Checks the public readability contract the deployed rules enforce on `metadata/catalog`.
 *
 * The rules allow the read only when `published` is the literal boolean `true`. This is the exact
 * defect the sync writer shipped for several releases: it wrote `status: "published"` and no
 * `published` flag, so the catalogue existed, was correct, and was unreadable from a browser.
 * An audit that only reported "the document exists" called that state healthy.
 */
export function auditCatalogContract(document, canonicalCommit = "") {
  const problems = [];
  if (!document) {
    problems.push("metadata/catalog does not exist, so a client cannot read which commit the mirror holds");
    return { readable: false, problems };
  }
  const fields = document.fields ?? {};
  const published = fields[FIELDS.published];
  if (published !== true) {
    problems.push(
      `published is ${JSON.stringify(published ?? null)} (${typeof published}), but the rule requires the literal boolean true; a client read is denied`,
    );
  }
  const commit = fields[FIELDS.sourceCommit];
  if (!isNonEmptyString(commit) || !/^[0-9a-f]{40}$/.test(String(commit))) {
    problems.push(`sourceCommit is ${JSON.stringify(commit ?? null)}, expected a 40-character lowercase hex commit`);
  } else if (canonicalCommit && commit !== canonicalCommit) {
    problems.push(`sourceCommit is ${commit} but the canonical branch is at ${canonicalCommit}`);
  }
  if (!asIsoTimestamp(fields[FIELDS.updatedAt])) {
    problems.push(`updatedAt is ${JSON.stringify(fields[FIELDS.updatedAt] ?? null)}, expected an ISO timestamp`);
  }
  const counts = fields.counts;
  if (!counts || typeof counts !== "object") {
    problems.push("counts is absent, so the record does not say what the last run did");
  } else {
    for (const key of ["written", "unchanged", "unpublished", "oversized"]) {
      if (!Number.isFinite(counts[key])) problems.push(`counts.${key} is ${JSON.stringify(counts[key] ?? null)}, expected a number`);
    }
  }
  return { readable: problems.length === 0, problems };
}

/**
 * Runs the whole comparison against an already-created client and desired set.
 *
 * Separated from `main` so the tests can drive it with a stub client: no network, no
 * credential, no clock.
 */
export async function auditProduction({ client, desired, commit, generatedAt }) {
  const collections = await client.listCollections();
  const unexpected = collections.filter((id) => !EXPECTED_COLLECTIONS.includes(id));

  const desiredByKey = new Map();
  for (const record of desired) desiredByKey.set(`${record.collection}/${record.id}`, record);

  const dispositions = [];
  const countsByCollection = {};
  const syncRecords = new Map();
  const contentByKey = new Map();
  const metadataDocuments = new Map();

  for (const collection of collections) {
    const documents = await client.listCollection(collection);
    countsByCollection[collection] = documents.length;
    for (const document of documents) {
      const key = `${collection}/${document.id}`;
      if (collection === COLLECTIONS.sync) {
        syncRecords.set(document.id, document.fields);
      } else if (collection === COLLECTIONS.metadata) {
        // The catalogue is compared field by field below; every other metadata document is
        // recorded by id so the report can say it exists and is preserved. Dropping them
        // silently would let a write to a collection this tool does not understand look like a
        // clean audit.
        metadataDocuments.set(document.id, document.fields);
      } else {
        contentByKey.set(key, document.fields);
      }
    }
  }

  for (const record of desired) {
    const key = `${record.collection}/${record.id}`;
    dispositions.push(compareRecord(record, contentByKey.has(key) ? { id: record.id, fields: contentByKey.get(key) } : null));
  }

  for (const [key, fields] of contentByKey) {
    if (!desiredByKey.has(key)) {
      const [collection, id] = [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)];
      dispositions.push(classifyOrphan(collection, id, fields));
    }
  }

  // Bookkeeping is checked against actual content, not against the planner's view of it.
  const syncDispositions = [];
  for (const [id, fields] of syncRecords) {
    if (id === COLLECTION_CATALOG_ID) continue;
    const collection = fields?.[FIELDS.collection] ?? "";
    const path = fields?.[FIELDS.path] ?? "";
    if (!collection || !path) {
      syncDispositions.push({ id, status: AUDIT_STATUS.INVALID, differences: ["bookkeeping record has no collection or path"] });
      continue;
    }
    const expectedId = syncIdFor(collection, path);
    const contentFields = contentByKey.get(`${collection}/${docIdFor(path)}`) ?? null;
    const comparison = compareSyncRecord(fields, contentFields, collection);
    if (expectedId !== id) comparison.differences.push(`id ${id} is not syncIdFor(${collection}, ${path}) = ${expectedId}`);
    if (!contentFields && comparison.status === SYNC_STATUS.published) comparison.differences.push("bookkeeping says published but no content document exists");
    syncDispositions.push({
      id,
      collection,
      path,
      status: comparison.differences.length ? AUDIT_STATUS.INVALID : (comparison.status ?? AUDIT_STATUS.UNKNOWN),
      recordedHash: comparison.recorded,
      actualHash: comparison.actual,
      differences: comparison.differences,
    });
  }

  const syncCatalog = await client.getDocument(COLLECTIONS.sync, COLLECTION_CATALOG_ID);
  const metadataCatalog = await client.getDocument(COLLECTIONS.metadata, COLLECTION_CATALOG_ID);

  const tally = {};
  for (const disposition of dispositions) tally[disposition.status] = (tally[disposition.status] ?? 0) + 1;

  return {
    generatedAt,
    project: PROJECT,
    canonical: { commit, shortCommit: shortCommit(commit), records: desired.length },
    collections,
    unexpectedCollections: unexpected,
    countsByCollection,
    tally,
    dispositions,
    sync: { records: syncRecords.size, dispositions: syncDispositions.filter((entry) => entry.differences?.length) },
    catalog: {
      sync: describeCatalog(syncCatalog),
      metadata: describeCatalog(metadataCatalog),
      // The catalogue is the one document a reader is meant to see, so its readability is a
      // contract the audit can check without holding a browser: the rules grant the read only
      // when `published` is the literal boolean true. A catalogue without the flag is a
      // document no client can read, which is indistinguishable from an absent catalogue.
      contract: auditCatalogContract(metadataCatalog, commit),
    },
    metadata: {
      // Every metadata document that is not the catalogue. None is expected to be public, and
      // the audit reports them so an unexpected one is visible rather than invisible.
      documents: [...metadataDocuments.entries()]
        .filter(([id]) => id !== COLLECTION_CATALOG_ID)
        .map(([id, fields]) => ({
          id,
          published: fields?.[FIELDS.published] ?? null,
          publishedType: typeof fields?.[FIELDS.published],
          fields: Object.keys(fields ?? {}).sort(),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Parses the supported flags. Unknown flags are a usage error, not a silent no-op. */
export function parseArgs(argv = []) {
  const options = { out: "", token: false, json: false, help: false };
  const unknown = [];
  for (const arg of argv) {
    if (arg === "--token") options.token = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--out=")) options.out = arg.slice("--out=".length);
    else unknown.push(arg);
  }
  return { options, unknown };
}

export const USAGE = `Usage: node scripts/audit-production.mjs [--token] [--json] [--out=path]

  --token   read an access token from OQ_AUDIT_TOKEN instead of the service account
  --json    print the whole report as JSON
  --out     also write the report JSON to a path

Read-only. Never writes to Firestore and never calls the Rules API.`;

/** Resolves an access token without printing it. */
export async function resolveToken({ useEnvToken = false, env = process.env } = {}) {
  if (useEnvToken) {
    const token = String(env.OQ_AUDIT_TOKEN ?? "").trim();
    if (!token) return { ok: false, reason: "OQ_AUDIT_TOKEN is empty" };
    return { ok: true, token, source: "OQ_AUDIT_TOKEN" };
  }
  const credentials = await loadCredentials(env);
  if (!credentials.ok) return { ok: false, reason: credentials.reason };
  const identity = identityOf(credentials.serviceAccount);
  if (identity.clientEmail !== EXPECTED_EMAIL || identity.projectId !== EXPECTED_PROJECT) {
    return { ok: false, reason: `credential identity is ${identity.clientEmail || "(missing)"} in ${identity.projectId || "(missing)"}; expected ${EXPECTED_EMAIL} in ${EXPECTED_PROJECT}` };
  }
  const minted = await mintAccessToken(credentials.serviceAccount);
  if (!minted.ok) return { ok: false, reason: minted.reason };
  return { ok: true, token: minted.token, source: "service account" };
}

export function formatReport(report) {
  const lines = [];
  lines.push(`Canonical: Oqthara/oqthara@${report.canonical.shortCommit || "(unknown)"} — ${report.canonical.records} desired records`);
  lines.push(`Collections: ${report.collections.join(", ")}`);
  if (report.unexpectedCollections.length) lines.push(`Unexpected collections: ${report.unexpectedCollections.join(", ")}`);
  lines.push(`Documents per collection: ${Object.entries(report.countsByCollection).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push("");
  lines.push("Dispositions:");
  for (const [status, count] of Object.entries(report.tally)) lines.push(`  ${status}: ${count}`);
  const actionable = report.dispositions.filter((entry) => entry.action !== "none");
  if (actionable.length) {
    lines.push("");
    lines.push("Actionable:");
    for (const entry of actionable) {
      lines.push(`  ${entry.status} ${entry.collection}/${entry.id}`);
      for (const difference of entry.difference) lines.push(`    - ${difference}`);
    }
  }
  const badSync = report.sync.dispositions;
  lines.push("");
  lines.push(`Bookkeeping records: ${report.sync.records}${badSync.length ? `, ${badSync.length} inconsistent` : ", all consistent"}`);
  for (const entry of badSync.slice(0, 20)) {
    lines.push(`  ${entry.id}`);
    for (const difference of entry.differences) lines.push(`    - ${difference}`);
  }
  lines.push("");
  lines.push(`Catalogue sync: ${report.catalog.sync.exists ? `${report.catalog.sync.sourceCommit?.slice(0, 7) || "(no commit)"} at ${report.catalog.sync.updatedAt || "(no time)"}` : "absent"}`);
  lines.push(`Catalogue metadata: ${report.catalog.metadata.exists ? `${report.catalog.metadata.sourceCommit?.slice(0, 7) || "(no commit)"} at ${report.catalog.metadata.updatedAt || "(no time)"}` : "absent"}`);
  if (report.catalog.metadata.exists) {
    const published = report.catalog.metadata.published;
    lines.push(`Catalogue readable by a client: ${report.catalog.contract.readable ? "yes" : "NO"} (published ${JSON.stringify(published)} ${report.catalog.metadata.publishedType})`);
  }
  for (const problem of report.catalog.contract.problems) lines.push(`  - ${problem}`);
  lines.push(
    `Other metadata documents: ${report.metadata.documents.length === 0 ? "none" : report.metadata.documents.map((entry) => `${entry.id} (${entry.fields.length} fields, published ${JSON.stringify(entry.published)} ${entry.publishedType})`).join(", ")}`,
  );
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch, env = process.env, log = console.log } = {}) {
  const { options, unknown } = parseArgs(argv);
  if (options.help) {
    log(USAGE);
    return 0;
  }
  if (unknown.length) {
    log(`Unknown argument(s): ${unknown.join(" ")}\n\n${USAGE}`);
    return 1;
  }

  const token = await resolveToken({ useEnvToken: options.token, env });
  if (!token.ok) {
    log(`Cannot obtain a read token: ${token.reason}`);
    return 2;
  }

  const client = readOnlyClient({ token: token.token, fetchImpl });
  const desired = await collectDesired({ token: env.GITHUB_TOKEN ?? "", fetchImpl });
  const report = await auditProduction({ client, desired: desired.records, commit: desired.commit, generatedAt: new Date().toISOString() });

  const text = options.json ? JSON.stringify(report, null, 2) : formatReport(report);
  log(text);
  if (options.out) {
    const path = resolve(options.out);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log(`\nReport written to ${options.out}`);
  }
  return 0;
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // `process.exitCode`, not `process.exit`: the report is large enough that a piped stdout
  // buffer is still draining when the promise settles, and an immediate exit truncates it.
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`audit-production failed: ${error?.message ?? error}`);
      process.exitCode = 4;
    },
  );
}
