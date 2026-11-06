// Mirror canonical repository content into Cloud Firestore.
//
// The canonical repository stays the source of truth. This script copies it, so the website can
// answer most reads from Firestore and fall back to GitHub for anything the mirror has not seen
// yet (a document merged a minute ago, a pinned release channel).
//
// What it reads
// -------------
//   docs/**/*.md            -> documentation collection (plus the dedicated stdlib copy)
//   CHANGELOG.md            -> documentation collection
//   examples/**/*.oq        -> examples collection
//   docs/stdlib/reference.md-> stdlib collection
//   releases API            -> releases collection
//
// Change detection
// ----------------
// Every document gets a SHA-256 `contentHash`. The `sync` collection stores the hash that was
// last written for each document (plus `oversized` / `unpublished` bookkeeping). An incremental
// run writes a document only when its hash differs, so a daily run touches the documents that
// changed and nothing else. `--full` rewrites every mirrored document regardless of its hash,
// which repairs a mirror that was modified out of band; both modes unpublish what disappeared.
//
// Deletions
// ---------
// A document whose source disappeared is never hard-deleted. It is written with
// `published: false` and recorded in `sync` as `unpublished`, which keeps the history and lets
// the security rules hide it from readers immediately.
//
// The 1 MiB limit
// ---------------
// Firestore caps a document at 1 MiB. Content at or above 900 KB is skipped whole, recorded in
// `sync` as `oversized` with the byte count and the reason, and the run continues. It is never
// truncated: a truncated manual that renders without an error is worse than a document that
// visibly falls back to GitHub.
//
// Credentials
// -----------
// Writing needs the Admin SDK, and the Admin SDK needs a service account, from exactly two
// places: `FIREBASE_SERVICE_ACCOUNT` (the JSON itself) or `GOOGLE_APPLICATION_CREDENTIALS`
// (a path to the JSON). There is no third option and no invented credential. Without one, a
// write run exits with code 2 and a diagnostic; `--dry-run` works with no credential at all.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CHANGELOG_PATH,
  DEFAULT_REF,
  REPO,
  normalizePath,
  normalizeRepoPath,
  rawUrl,
  releasesApiUrl,
  titleFromMarkdown,
  titleFromPath,
  treeApiUrl,
} from "../src/source.js";
import {
  COLLECTIONS,
  FIELDS,
  MIRRORED_REF,
  STDLIB_REFERENCE_PATH,
  SYNC_STATUS,
  docIdFor,
  releaseIdFor,
  syncIdFor,
} from "../src/firebase/collections.js";

/** Exit codes, documented in README-firebase.md so CI can tell the failures apart. */
export const EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  missingCredentials: 2,
  sourceFailed: 3,
  writeFailed: 4,
});

/** Firestore's hard limit is 1 MiB; 900 KB leaves room for the rest of the record. */
export const CONTENT_LIMIT_BYTES = 900 * 1024;

/** Firestore allows at most 500 operations per batch. */
export const BATCH_SIZE = 400;

const FETCH_TIMEOUT_MS = 30 * 1000;

/** Every mirrored source path, described once so the planner has no per-kind branches. */
export const SOURCE_KINDS = Object.freeze({
  documentation: "documentation",
  changelog: "documentation",
  example: "examples",
  stdlib: "stdlib",
});

/** SHA-256 of the exact bytes that are stored, as lowercase hex. */
export function contentHashOf(content) {
  return createHash("sha256").update(String(content ?? ""), "utf8").digest("hex");
}

/** UTF-8 byte length, which is what Firestore's limit is measured in. */
export function byteLengthOf(content) {
  return Buffer.byteLength(String(content ?? ""), "utf8");
}

/**
 * A repository path is mirrored when it is a document, the changelog, an example, or the
 * generated stdlib reference. `source.js` already owns those predicates; this mirrors them for
 * the tree walker without importing the browser-oriented module surface.
 */
export function classifyPath(path) {
  const normalized = normalizePath(normalizeRepoPath(path));
  if (normalized === CHANGELOG_PATH) return { collection: COLLECTIONS.documentation, kind: "changelog" };
  if (normalized === STDLIB_REFERENCE_PATH) {
    // The same source is stored twice on purpose: as a document (so it renders like any other)
    // and in the dedicated stdlib collection (so the stdlib page can ask for it directly).
    return { collection: COLLECTIONS.documentation, kind: "documentation", also: COLLECTIONS.stdlib };
  }
  if (/^docs\/.+\.md$/i.test(normalized)) return { collection: COLLECTIONS.documentation, kind: "documentation" };
  if (/^examples\/.+\.oq$/i.test(normalized)) return { collection: COLLECTIONS.examples, kind: "example" };
  return null;
}

/** The full record written for a mirrored document. */
export function buildDocumentRecord({ path, content, collection, now = new Date().toISOString() }) {
  const normalized = normalizePath(normalizeRepoPath(path));
  return {
    collection,
    id: docIdFor(normalized),
    data: {
      [FIELDS.path]: normalized,
      [FIELDS.title]: titleFromMarkdown(content) || titleFromPath(normalized),
      [FIELDS.content]: content,
      [FIELDS.published]: true,
      [FIELDS.sourceRef]: MIRRORED_REF,
      [FIELDS.contentHash]: contentHashOf(content),
      [FIELDS.updatedAt]: now,
    },
  };
}

/** The release record written for a published GitHub release. */
export function buildReleaseRecord(release, { now = new Date().toISOString() } = {}) {
  const ref = typeof release?.tag_name === "string" ? release.tag_name.trim() : "";
  if (!ref) return null;
  const name = typeof release.name === "string" && release.name.trim() ? release.name.trim() : ref;
  const body = typeof release.body === "string" ? release.body : "";
  return {
    collection: COLLECTIONS.releases,
    id: releaseIdFor(ref),
    data: {
      [FIELDS.path]: `releases/${ref}`,
      [FIELDS.title]: name,
      [FIELDS.content]: body,
      [FIELDS.published]: true,
      [FIELDS.sourceRef]: MIRRORED_REF,
      [FIELDS.contentHash]: contentHashOf(`${ref}\n${name}\n${body}`),
      [FIELDS.updatedAt]: now,
      [FIELDS.ref]: ref,
      [FIELDS.label]: name,
      [FIELDS.prerelease]: Boolean(release.prerelease),
      [FIELDS.publishedAt]:
        typeof release.published_at === "string" ? release.published_at : "",
      [FIELDS.url]: typeof release.html_url === "string" ? release.html_url : "",
    },
  };
}

/** The sync bookkeeping record for a mirrored document. */
export function buildSyncRecord({
  collection,
  path,
  status,
  contentHash = "",
  bytes = 0,
  reason = "",
  now = new Date().toISOString(),
}) {
  return {
    collection: COLLECTIONS.sync,
    id: syncIdFor(collection, path),
    data: {
      [FIELDS.collection]: collection,
      [FIELDS.path]: normalizePath(normalizeRepoPath(path)),
      [FIELDS.status]: status,
      [FIELDS.contentHash]: contentHash,
      [FIELDS.bytes]: bytes,
      [FIELDS.reason]: reason,
      [FIELDS.updatedAt]: now,
    },
  };
}

/**
 * Compares desired records against the recorded sync state.
 *
 * Pure: no I/O, no clock. The caller passes `now` through the records it built.
 *
 * `existing` is a Map of `syncId` -> sync record data. A document is written when
 *
 *   * it has no sync record (never mirrored),
 *   * its recorded hash differs (changed),
 *   * its sync record is not `published` (it was oversized or unpublished before), or
 *   * `full` is set (a full reconciliation rewrites every source, repairing an out-of-band edit).
 *
 * A mirrored source absent from `desired` is returned as an unpublish candidate, never a delete.
 */
export function planSync({ desired, existing, full = false }) {
  const writes = [];
  const oversized = [];
  const unchanged = [];
  const desiredSyncIds = new Set();

  for (const record of desired) {
    const bytes = byteLengthOf(record.data[FIELDS.content]);
    const syncId = syncIdFor(record.collection, record.data[FIELDS.path]);
    desiredSyncIds.add(syncId);
    if (bytes >= CONTENT_LIMIT_BYTES) {
      oversized.push({ ...record, bytes, syncId });
      continue;
    }
    const previous = existing.get(syncId);
    const sameHash =
      previous &&
      previous[FIELDS.status] === SYNC_STATUS.published &&
      previous[FIELDS.contentHash] === record.data[FIELDS.contentHash];
    if (sameHash && !full) {
      unchanged.push({ ...record, syncId });
      continue;
    }
    writes.push({ ...record, syncId, previous: previous ?? null, reason: previous ? "changed" : "new" });
  }

  const unpublish = [];
  for (const [syncId, previous] of existing) {
    if (desiredSyncIds.has(syncId)) continue;
    if (previous?.[FIELDS.status] !== SYNC_STATUS.published) continue;
    const collection = String(previous[FIELDS.collection] ?? "");
    const path = String(previous[FIELDS.path] ?? "");
    if (!collection || !path) continue;
    if (!Object.values(COLLECTIONS).includes(collection)) continue;
    unpublish.push({ collection, path, syncId, previous });
  }

  unpublish.sort((a, b) => a.collection.localeCompare(b.collection) || a.path.localeCompare(b.path));
  writes.sort((a, b) => a.collection.localeCompare(b.collection) || a.data[FIELDS.path].localeCompare(b.data[FIELDS.path]));

  return { writes, oversized, unchanged, unpublish };
}

/** Splits a list into Firestore-sized batches. */
export function chunk(list, size = BATCH_SIZE) {
  const out = [];
  const step = Number.isFinite(size) && size > 0 ? Math.floor(size) : BATCH_SIZE;
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
  return out;
}

/** A human-readable diff summary. Dry-run prints exactly this. */
export function formatPlan(plan, { full = false, stateAvailable = true } = {}) {
  const lines = [];
  lines.push(`mode: ${full ? "full reconciliation" : "incremental"}`);
  if (!stateAvailable) {
    lines.push("sync state: unavailable (no credentials) — assuming nothing is mirrored yet");
  }
  lines.push(
    `would write ${plan.writes.length}, skip ${plan.unchanged.length} unchanged, ` +
      `unpublish ${plan.unpublish.length}, skip ${plan.oversized.length} oversized`,
  );

  const byCollection = new Map();
  for (const write of plan.writes) {
    const bucket = byCollection.get(write.collection) ?? [];
    bucket.push(`  write ${write.data[FIELDS.path]} (${write.reason})`);
    byCollection.set(write.collection, bucket);
  }
  for (const { collection, path } of plan.unpublish) {
    const bucket = byCollection.get(collection) ?? [];
    bucket.push(`  unpublish ${path}`);
    byCollection.set(collection, bucket);
  }
  for (const { collection, data, bytes } of plan.oversized) {
    const bucket = byCollection.get(collection) ?? [];
    bucket.push(`  skip ${data[FIELDS.path]} (oversized: ${bytes} bytes)`);
    byCollection.set(collection, bucket);
  }

  for (const [collection, entries] of [...byCollection].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${collection}:`);
    lines.push(...entries);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "oqthara-site-firestore-sync",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * `fetch` with a bounded wait.
 *
 * Without a timeout a stalled connection hangs the run until the job's own 6-hour limit, and the
 * mirror then holds whatever state the previous run left. `fetchImpl` stays injectable so tests
 * can drive the network paths without one.
 */
async function fetchWithTimeout(url, { token, accept, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { ...githubHeaders(token), Accept: accept ?? "application/vnd.github+json" },
    });
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status} for ${url}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/** The recursive tree for `ref`, filtered to the paths this mirror cares about. */
export async function listSourceFiles({ ref = MIRRORED_REF, token = "", fetchImpl = fetch } = {}) {
  const response = await fetchWithTimeout(treeApiUrl(ref), { token, fetchImpl });
  if (!response.ok) throw new Error(`GitHub tree request returned ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.tree)) {
    throw new Error("GitHub returned a tree this script could not read");
  }
  if (payload.truncated === true) {
    throw new Error("GitHub returned a truncated tree; refusing to publish an incomplete mirror");
  }
  return payload.tree
    .filter((entry) => entry && entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => normalizePath(normalizeRepoPath(entry.path)))
    .filter((path) => classifyPath(path) !== null);
}

/** Raw file text. raw.githubusercontent.com has no API quota. */
export async function readSourceFile(path, { ref = MIRRORED_REF, token = "", fetchImpl = fetch } = {}) {
  const response = await fetchWithTimeout(rawUrl(path, ref), {
    token,
    accept: "text/plain, */*",
    fetchImpl,
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${path}`);
  return response.text();
}

/** Published releases; drafts and malformed entries are dropped. */
export async function listReleases({ token = "", fetchImpl = fetch } = {}) {
  const response = await fetchWithTimeout(releasesApiUrl(100), { token, fetchImpl });
  if (!response.ok) throw new Error(`GitHub releases request returned ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("GitHub returned a release list this script could not read");
  return payload.filter((release) => release && !release.draft);
}

/**
 * Reads every mirrored source from GitHub and builds the desired records.
 *
 * `readFile` and the listing functions are injectable so a test can run the planner without a
 * network. A single unreadable file fails the run rather than publishing a mirror with holes.
 */
export async function collectDesired({
  ref = MIRRORED_REF,
  token = "",
  now = new Date().toISOString(),
  fetchImpl = fetch,
  listFiles = listSourceFiles,
  readFile = readSourceFile,
  releases = listReleases,
} = {}) {
  const paths = await listFiles({ ref, token, fetchImpl });
  const desired = [];
  const stdlibDuplicates = [];

  for (const path of paths) {
    const kind = classifyPath(path);
    if (!kind) continue;
    const content = await readFile(path, { ref, token, fetchImpl });
    const record = buildDocumentRecord({ path, content, collection: kind.collection, now });
    desired.push(record);
    if (kind.also) {
      stdlibDuplicates.push(buildDocumentRecord({ path, content, collection: kind.also, now }));
    }
  }
  desired.push(...stdlibDuplicates);

  for (const release of await releases({ token, fetchImpl })) {
    const record = buildReleaseRecord(release, { now });
    if (record) desired.push(record);
  }
  return desired;
}

// ---------------------------------------------------------------------------
// Credentials and Firestore
// ---------------------------------------------------------------------------

/**
 * Resolves Admin credentials from the two documented variables only.
 *
 * Returns `{ ok: true, credential }`, `{ ok: false, reason }`, or `{ ok: false, reason,
 * malformed: true }` for an unparseable JSON value. It never reads a default file location
 * other than the one `GOOGLE_APPLICATION_CREDENTIALS` names.
 */
export async function loadCredentials(env = process.env) {
  const inline = String(env.FIREBASE_SERVICE_ACCOUNT ?? "").trim();
  const file = String(env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();

  if (inline) {
    let parsed;
    try {
      parsed = JSON.parse(inline);
    } catch {
      return { ok: false, reason: "FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON", malformed: true };
    }
    if (!parsed || typeof parsed !== "object" || !parsed.project_id || !parsed.private_key) {
      return {
        ok: false,
        reason: "FIREBASE_SERVICE_ACCOUNT is JSON but not a service account key (needs project_id and private_key)",
        malformed: true,
      };
    }
    return { ok: true, source: "FIREBASE_SERVICE_ACCOUNT", projectId: parsed.project_id, serviceAccount: parsed };
  }

  if (file) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      return { ok: false, reason: `GOOGLE_APPLICATION_CREDENTIALS points at ${file}, which could not be read (${error.code ?? "error"})`, malformed: true };
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !parsed.project_id || !parsed.private_key) {
        return { ok: false, reason: `GOOGLE_APPLICATION_CREDENTIALS file ${file} is not a service account key`, malformed: true };
      }
      return { ok: true, source: "GOOGLE_APPLICATION_CREDENTIALS", projectId: parsed.project_id, serviceAccount: parsed };
    } catch {
      return { ok: false, reason: `GOOGLE_APPLICATION_CREDENTIALS file ${file} is not valid JSON`, malformed: true };
    }
  }

  return {
    ok: false,
    reason:
      "No Admin credential. Set FIREBASE_SERVICE_ACCOUNT (the service account JSON) or " +
      "GOOGLE_APPLICATION_CREDENTIALS (a path to it). --dry-run needs neither.",
  };
}

/** A Firestore handle backed by the Admin SDK. Dynamically imported: dry-run never loads it. */
export async function openFirestore(serviceAccount) {
  const app = await import("firebase-admin/app");
  const firestore = await import("firebase-admin/firestore");
  const existing = app.getApps();
  const instance = existing.length
    ? existing[0]
    : app.initializeApp({ credential: app.cert(serviceAccount) });
  return firestore.getFirestore(instance);
}

/** Reads every `sync` record into a Map keyed by sync id. */
export async function readSyncState(db) {
  const sync = db.collection(COLLECTIONS.sync);
  const snapshot = await sync.get();
  const state = new Map();
  for (const document of snapshot.docs) {
    const data = typeof document.data === "function" ? document.data() : null;
    if (data && typeof data === "object") state.set(document.id, data);
  }
  return state;
}

/**
 * Applies a plan: writes, sync bookkeeping, unpublishes — in batches of at most 500 operations.
 *
 * `db` is a Firestore handle (`collection().doc()` returning a ref with `set`). The Admin SDK
 * and a test double satisfy that shape.
 */
export async function applyPlan(db, plan, { now = new Date().toISOString() } = {}) {
  const operations = [];

  for (const write of plan.writes) {
    operations.push({
      collection: write.collection,
      id: write.id,
      data: { ...write.data, [FIELDS.updatedAt]: now },
    });
    operations.push(
      buildSyncRecord({
        collection: write.collection,
        path: write.data[FIELDS.path],
        status: SYNC_STATUS.published,
        contentHash: write.data[FIELDS.contentHash],
        bytes: byteLengthOf(write.data[FIELDS.content]),
        now,
      }),
    );
  }

  for (const oversized of plan.oversized) {
    operations.push(
      buildSyncRecord({
        collection: oversized.collection,
        path: oversized.data[FIELDS.path],
        status: SYNC_STATUS.oversized,
        contentHash: oversized.data[FIELDS.contentHash],
        bytes: oversized.bytes,
        reason: `content is ${oversized.bytes} bytes; the Firestore document limit is 1 MiB and the safety cutoff is ${CONTENT_LIMIT_BYTES} bytes. The site falls back to GitHub for this file.`,
        now,
      }),
    );
    // An oversized document that was previously published must be withdrawn, not left stale.
    operations.push({
      collection: oversized.collection,
      id: oversized.id,
      data: { [FIELDS.published]: false, [FIELDS.updatedAt]: now },
      merge: true,
    });
  }

  for (const { collection, path, id } of plan.unpublish.map((entry) => ({
    ...entry,
    id: docIdFor(entry.path),
  }))) {
    operations.push({
      collection,
      id,
      data: { [FIELDS.published]: false, [FIELDS.updatedAt]: now },
      merge: true,
    });
    operations.push(
      buildSyncRecord({
        collection,
        path,
        status: SYNC_STATUS.unpublished,
        contentHash: "",
        bytes: 0,
        reason: "source no longer exists in the canonical repository; unpublished, not deleted",
        now,
      }),
    );
  }

  let written = 0;
  for (const batch of chunk(operations)) {
    const bulk = db.batch();
    for (const operation of batch) {
      bulk.set(db.collection(operation.collection).doc(operation.id), operation.data, operation.merge ? { merge: true } : undefined);
    }
    await bulk.commit();
    written += batch.length;
  }

  // One catalogue-level record so a later run can see when the mirror was last reconciled.
  await db.collection(COLLECTIONS.sync).doc("catalog").set(
    {
      [FIELDS.status]: "published",
      [FIELDS.sourceRef]: MIRRORED_REF,
      [FIELDS.updatedAt]: now,
      counts: {
        written: plan.writes.length,
        unchanged: plan.unchanged.length,
        unpublished: plan.unpublish.length,
        oversized: plan.oversized.length,
      },
    },
    { merge: true },
  );

  return { operations: written };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Parses the supported flags. Unknown flags are a usage error, not a silent no-op. */
export function parseArgs(argv = []) {
  const options = { dryRun: false, full: false, ref: MIRRORED_REF, help: false };
  const unknown = [];
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--full") options.full = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--ref=")) {
      const value = arg.slice("--ref=".length).trim();
      if (value) options.ref = value;
    } else unknown.push(arg);
  }
  return { options, unknown };
}

export const USAGE = `Usage: node scripts/sync-firestore.mjs [--dry-run] [--full] [--ref=main]

  --dry-run   Read GitHub, compute hashes and print what would change. Needs no credentials.
  --full      Full reconciliation: rewrite every mirrored document even when its hash matches.
  --ref=REF   Repository ref to mirror. Defaults to ${DEFAULT_REF}; the site reads main only.

Credentials for a write run come from FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS.
Exit codes: 0 ok, 1 usage, 2 missing credentials, 3 GitHub failure, 4 Firestore failure.`;

/**
 * Runs the command. Returns an exit code instead of calling `process.exit`, so tests can call it.
 */
export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    log = (...args) => console.log(...args),
    error = (...args) => console.error(...args),
    collect = collectDesired,
    credentials = loadCredentials,
    openDb = openFirestore,
    now = new Date().toISOString(),
  } = {},
) {
  const { options, unknown } = parseArgs(argv);
  if (options.help) {
    log(USAGE);
    return EXIT.ok;
  }
  if (unknown.length) {
    error(`Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
    error(USAGE);
    return EXIT.usage;
  }

  const token = String(env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "").trim();
  let desired;
  try {
    desired = await collect({ ref: options.ref, token, now });
  } catch (cause) {
    error(`Could not read the canonical repository: ${cause?.message ?? cause}`);
    return EXIT.sourceFailed;
  }
  log(
    `read ${desired.length} source record${desired.length === 1 ? "" : "s"} from ${REPO}@${options.ref}`,
  );

  const resolved = await credentials(env);
  let existing = new Map();
  let stateAvailable = false;

  if (resolved.ok) {
    let db;
    try {
      db = await openDb(resolved.serviceAccount);
      existing = await readSyncState(db);
      stateAvailable = true;
    } catch (cause) {
      error(`Could not read the Firestore sync state: ${cause?.message ?? cause}`);
      return EXIT.writeFailed;
    }
  }

  const plan = planSync({ desired, existing, full: options.full });
  log(formatPlan(plan, { full: options.full, stateAvailable }));

  if (options.dryRun) {
    log("dry run: nothing was written");
    return EXIT.ok;
  }

  if (!resolved.ok) {
    error(resolved.reason);
    return EXIT.missingCredentials;
  }

  if (!plan.writes.length && !plan.oversized.length && !plan.unpublish.length) {
    log("mirror is already current; nothing to write");
    return EXIT.ok;
  }

  try {
    const result = await applyPlan(await openDb(resolved.serviceAccount), plan, { now });
    log(`wrote ${result.operations} operations to ${resolved.projectId ?? "the configured project"}`);
  } catch (cause) {
    error(`Could not write to Firestore: ${cause?.message ?? cause}`);
    return EXIT.writeFailed;
  }
  return EXIT.ok;
}

/**
 * True when this file is the program Node was asked to run, not a module imported by a test.
 * `process.argv[1]` may be relative, so both sides are resolved to absolute paths.
 */
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
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (cause) => {
      console.error(`sync-firestore failed: ${cause?.message ?? cause}`);
      process.exitCode = EXIT.writeFailed;
    },
  );
}
