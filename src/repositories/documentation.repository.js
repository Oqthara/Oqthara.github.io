// Firestore-backed documentation repository.
//
// Returns plain objects in the same shape the GitHub loaders already produce, and never trusts
// a Firestore payload: every field is type-checked and a malformed document is skipped with a
// recorded warning rather than rendered as an empty page.
//
// The mirror follows `main` only. A pinned release channel is served by GitHub, because a
// released manual must not be replaced by newer content.

import {
  CHANGELOG_PATH,
  blobUrl,
  documentRoute,
  isDocumentPath,
  sectionForPath,
  titleFromPath,
} from "../source.js";
import {
  COLLECTIONS,
  FIELDS,
  MIRRORED_REF,
  asIsoTimestamp,
  docIdFor,
  isNonEmptyString,
  isPlainObject,
} from "../firebase/collections.js";
import { firestoreError, readDoc, readDocs } from "../firebase/firestore.js";

export const MAX_DOCUMENTS = 1000;

/**
 * The mirror holds two kinds of Markdown in `documentation`: files under `docs/` and the
 * canonical `CHANGELOG.md`. The changelog is not part of the documentation catalogue, but it is
 * still a document the site reads, so it uses the same schema and the same id scheme.
 */
export function isMirroredDocumentPath(path) {
  return isDocumentPath(path) || path === CHANGELOG_PATH;
}

function unsupportedRef(ref) {
  return firestoreError(
    "unsupported-ref",
    `Firestore mirrors ${MIRRORED_REF} only; ${ref} is read from GitHub.`,
    { retryable: false },
  );
}

/**
 * Validates one Firestore document record.
 *
 * Returns `{ record }` or `{ warning }`. `record.markdown` is the name the rest of the site
 * uses for document text; the Firestore field is `content`.
 */
export function validateDocumentRecord(entry, { ref = MIRRORED_REF } = {}) {
  const id = typeof entry?.id === "string" ? entry.id : "";
  const data = entry?.data;
  if (!isPlainObject(data)) {
    return { warning: { id, reason: "document payload is not an object" } };
  }
  if (!isNonEmptyString(data[FIELDS.path])) {
    return { warning: { id, reason: "missing or empty path" } };
  }
  const path = data[FIELDS.path].trim();
  if (!isMirroredDocumentPath(path)) {
    return { warning: { id, path, reason: "path is not a mirrored document path" } };
  }
  if (docIdFor(path) !== id) {
    return { warning: { id, path, reason: "document id does not match the path" } };
  }
  if (data[FIELDS.published] !== true) {
    return { warning: { id, path, reason: "document is not published" } };
  }
  if (typeof data[FIELDS.content] !== "string") {
    return { warning: { id, path, reason: "content is not a string" } };
  }
  if (!isNonEmptyString(data[FIELDS.title])) {
    return { warning: { id, path, reason: "missing or empty title" } };
  }
  const updatedAt = asIsoTimestamp(data[FIELDS.updatedAt]);
  if (data[FIELDS.updatedAt] !== undefined && updatedAt === null) {
    return { warning: { id, path, reason: "updatedAt is not a usable timestamp" } };
  }

  return {
    record: Object.freeze({
      path,
      ref,
      title: data[FIELDS.title].trim(),
      markdown: data[FIELDS.content],
      sourceUrl: blobUrl(path, ref),
      contentHash: isNonEmptyString(data[FIELDS.contentHash]) ? data[FIELDS.contentHash] : "",
      updatedAt: updatedAt ?? "",
    }),
  };
}

/** The catalogue entry shape `loadCatalog` already produces. */
export function toCatalogEntry(record) {
  return Object.freeze({
    path: record.path,
    section: sectionForPath(record.path),
    title: record.title || titleFromPath(record.path),
    route: documentRoute(record.path, record.ref),
    sourceUrl: record.sourceUrl,
  });
}

function sortCatalog(entries) {
  return [...entries].sort(
    (a, b) => a.section.localeCompare(b.section) || a.path.localeCompare(b.path),
  );
}

/**
 * Every published documentation record, newest mirror first.
 *
 * The filter is `published === true`; ordering happens here, not in Firestore, so the mirror
 * needs no composite index. The security rules enforce the same filter server-side.
 */
export async function listDocumentation({ ref = MIRRORED_REF, limit: max = MAX_DOCUMENTS, env } = {}) {
  if (ref !== MIRRORED_REF) {
    return { ok: false, data: [], error: unsupportedRef(ref), warnings: [], cached: false };
  }
  const bounded = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_DOCUMENTS;
  const result = await readDocs(
    COLLECTIONS.documentation,
    (module, base) => module.query(base, module.where(FIELDS.published, "==", true), module.limit(bounded)),
    { cacheKey: `published:${bounded}`, env },
  );
  if (!result.ok) {
    return { ok: false, data: [], error: result.error, warnings: [], cached: Boolean(result.cached) };
  }

  const records = [];
  const warnings = [];
  for (const entry of result.data) {
    const { record, warning } = validateDocumentRecord(entry, { ref });
    if (record) records.push(record);
    else warnings.push(warning);
  }
  // CHANGELOG.md is mirrored so the changelog page can read it, but it is not part of the
  // documentation catalogue that /docs.html lists.
  const catalogued = records.filter((record) => isDocumentPath(record.path));
  catalogued.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, data: catalogued, error: null, warnings, cached: Boolean(result.cached) };
}

/** The documentation catalogue for a ref, or a typed failure the service falls back from. */
export async function listDocumentationCatalog(options = {}) {
  const result = await listDocumentation(options);
  return { ...result, data: result.data.map(toCatalogEntry) };
}

/**
 * One published document by repository path.
 *
 * A missing or unpublished document is `ok` with `data: null`: the caller then asks GitHub,
 * which is also the correct behaviour for a document the mirror has not seen yet.
 */
export async function getDocument({ path, ref = MIRRORED_REF, env } = {}) {
  if (ref !== MIRRORED_REF) {
    return { ok: false, data: null, error: unsupportedRef(ref), warnings: [], cached: false };
  }
  if (!isNonEmptyString(path) || !isMirroredDocumentPath(path)) {
    return {
      ok: false,
      data: null,
      error: firestoreError("invalid-argument", `Not a mirrored document path: ${String(path)}`, {
        retryable: false,
      }),
      warnings: [],
      cached: false,
    };
  }
  const repoPath = path.trim();
  const result = await readDoc(COLLECTIONS.documentation, docIdFor(repoPath), {
    cacheKey: repoPath,
    env,
  });
  if (!result.ok) {
    return { ok: false, data: null, error: result.error, warnings: [], cached: Boolean(result.cached) };
  }
  if (result.data === null) {
    return { ok: true, data: null, error: null, warnings: [], cached: Boolean(result.cached) };
  }
  const { record, warning } = validateDocumentRecord(
    { id: docIdFor(repoPath), data: result.data },
    { ref },
  );
  if (!record) {
    return {
      ok: true,
      data: null,
      error: null,
      warnings: [{ id: docIdFor(repoPath), path: repoPath, reason: warning.reason }],
      cached: Boolean(result.cached),
    };
  }
  return { ok: true, data: record, error: null, warnings: [], cached: Boolean(result.cached) };
}

/** Every published document as the catalogue shape, sorted like `loadCatalog`. */
export async function listDocumentationIndex(options = {}) {
  const result = await listDocumentationCatalog(options);
  return { ...result, data: sortCatalog(result.data) };
}
