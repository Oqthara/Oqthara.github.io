// Firestore-backed standard library reference repository.
//
// `oq doc` generates `docs/stdlib/reference.md` in the canonical repository and its CI fails
// when the file is out of date. The mirror copies that generated file into two collections:
// `documentation` (so it renders like any other document) and `stdlib` (so a reader can ask
// for the reference directly without knowing its path).
//
// This repository reads the dedicated `stdlib` collection first and falls back to the
// `documentation` record for the same path. `data: null` means the mirror has never seen it.

import { blobUrl, isDocumentPath, titleFromPath } from "../source.js";
import {
  COLLECTIONS,
  FIELDS,
  MIRRORED_REF,
  STDLIB_REFERENCE_PATH,
  asIsoTimestamp,
  docIdFor,
  isNonEmptyString,
  isPlainObject,
} from "../firebase/collections.js";
import { firestoreError, readDoc, readDocs } from "../firebase/firestore.js";

export { STDLIB_REFERENCE_PATH };

export const MAX_STDLIB_DOCUMENTS = 200;

function unsupportedRef(ref) {
  return firestoreError(
    "unsupported-ref",
    `Firestore mirrors ${MIRRORED_REF} only; ${ref} is read from GitHub.`,
    { retryable: false },
  );
}

/** Validates one stdlib record into the document shape the page already consumes. */
export function validateStdlibRecord(entry, { ref = MIRRORED_REF } = {}) {
  const id = typeof entry?.id === "string" ? entry.id : "";
  const data = entry?.data;
  if (!isPlainObject(data)) {
    return { warning: { id, reason: "stdlib payload is not an object" } };
  }
  if (!isNonEmptyString(data[FIELDS.path])) {
    return { warning: { id, reason: "missing or empty path" } };
  }
  const path = data[FIELDS.path].trim();
  if (!isDocumentPath(path)) {
    return { warning: { id, path, reason: "path is not a documentation path" } };
  }
  if (docIdFor(path) !== id) {
    return { warning: { id, path, reason: "document id does not match the path" } };
  }
  if (data[FIELDS.published] !== true) {
    return { warning: { id, path, reason: "stdlib entry is not published" } };
  }
  if (typeof data[FIELDS.content] !== "string") {
    return { warning: { id, path, reason: "content is not a string" } };
  }
  const updatedAt = asIsoTimestamp(data[FIELDS.updatedAt]);
  if (data[FIELDS.updatedAt] !== undefined && updatedAt === null) {
    return { warning: { id, path, reason: "updatedAt is not a usable timestamp" } };
  }
  return {
    record: Object.freeze({
      path,
      ref,
      title: isNonEmptyString(data[FIELDS.title]) ? data[FIELDS.title].trim() : titleFromPath(path),
      markdown: data[FIELDS.content],
      sourceUrl: blobUrl(path, ref),
      contentHash: isNonEmptyString(data[FIELDS.contentHash]) ? data[FIELDS.contentHash] : "",
      updatedAt: updatedAt ?? "",
    }),
  };
}

/**
 * The generated reference.
 *
 * Reads `stdlib/<docId>`; when that record is absent, reads the same path from
 * `documentation`. Both are `main`-only, so a pinned release never sees a newer reference.
 */
export async function getStdlibReference({ ref = MIRRORED_REF, env } = {}) {
  if (ref !== MIRRORED_REF) {
    return { ok: false, data: null, error: unsupportedRef(ref), warnings: [], cached: false };
  }
  const id = docIdFor(STDLIB_REFERENCE_PATH);

  const primary = await readDoc(COLLECTIONS.stdlib, id, { cacheKey: STDLIB_REFERENCE_PATH, env });
  if (!primary.ok) {
    return { ok: false, data: null, error: primary.error, warnings: [], cached: Boolean(primary.cached) };
  }
  if (primary.data !== null) {
    const { record, warning } = validateStdlibRecord({ id, data: primary.data }, { ref });
    if (record) return { ok: true, data: record, error: null, warnings: [], cached: Boolean(primary.cached) };
    // A malformed stdlib record is reported, but the documentation copy is still worth trying.
    const secondary = await readDoc(COLLECTIONS.documentation, id, { cacheKey: STDLIB_REFERENCE_PATH, env });
    if (!secondary.ok) {
      return { ok: false, data: null, error: secondary.error, warnings: [warning], cached: Boolean(secondary.cached) };
    }
    if (secondary.data !== null) {
      const fallback = validateStdlibRecord({ id, data: secondary.data }, { ref });
      if (fallback.record) {
        return { ok: true, data: fallback.record, error: null, warnings: [warning], cached: Boolean(secondary.cached) };
      }
      return { ok: true, data: null, error: null, warnings: [warning, fallback.warning], cached: Boolean(secondary.cached) };
    }
    return { ok: true, data: null, error: null, warnings: [warning], cached: Boolean(primary.cached) };
  }

  const secondary = await readDoc(COLLECTIONS.documentation, id, { cacheKey: STDLIB_REFERENCE_PATH, env });
  if (!secondary.ok) {
    return { ok: false, data: null, error: secondary.error, warnings: [], cached: Boolean(secondary.cached) };
  }
  if (secondary.data === null) {
    return { ok: true, data: null, error: null, warnings: [], cached: false };
  }
  const { record, warning } = validateStdlibRecord({ id, data: secondary.data }, { ref });
  if (!record) {
    return { ok: true, data: null, error: null, warnings: [warning], cached: Boolean(secondary.cached) };
  }
  return { ok: true, data: record, error: null, warnings: [], cached: Boolean(secondary.cached) };
}

/** Every published stdlib document (the reference plus any future generated pages). */
export async function listStdlib({ ref = MIRRORED_REF, limit: max = MAX_STDLIB_DOCUMENTS, env } = {}) {
  if (ref !== MIRRORED_REF) {
    return { ok: false, data: [], error: unsupportedRef(ref), warnings: [], cached: false };
  }
  const bounded = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_STDLIB_DOCUMENTS;
  const result = await readDocs(
    COLLECTIONS.stdlib,
    (module, base) => module.query(base, module.where(FIELDS.published, "==", true), module.limit(bounded)),
    { cacheKey: `published:${bounded}`, env },
  );
  if (!result.ok) {
    return { ok: false, data: [], error: result.error, warnings: [], cached: Boolean(result.cached) };
  }
  const records = [];
  const warnings = [];
  for (const entry of result.data) {
    const { record, warning } = validateStdlibRecord(entry, { ref });
    if (record) records.push(record);
    else warnings.push(warning);
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, data: records, error: null, warnings, cached: Boolean(result.cached) };
}
