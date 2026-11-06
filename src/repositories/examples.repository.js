// Firestore-backed examples repository.
//
// Examples are shorter than documents and share the same record schema (`path`, `title`,
// `content`, `published`, ...). The site's example shape is `{ path, name, category, route,
// sourceUrl }`, which is derived here so a caller never has to know Firestore's layout.

import { blobUrl, exampleRoute, isExamplePath } from "../source.js";
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

export const MAX_EXAMPLES = 1000;

function unsupportedRef(ref) {
  return firestoreError(
    "unsupported-ref",
    `Firestore mirrors ${MIRRORED_REF} only; ${ref} is read from GitHub.`,
    { retryable: false },
  );
}

/** Validates one example record; returns `{ record }` or `{ warning }`. */
export function validateExampleRecord(entry, { ref = MIRRORED_REF } = {}) {
  const id = typeof entry?.id === "string" ? entry.id : "";
  const data = entry?.data;
  if (!isPlainObject(data)) {
    return { warning: { id, reason: "example payload is not an object" } };
  }
  if (!isNonEmptyString(data[FIELDS.path])) {
    return { warning: { id, reason: "missing or empty path" } };
  }
  const path = data[FIELDS.path].trim();
  if (!isExamplePath(path)) {
    return { warning: { id, path, reason: "path is not an example path" } };
  }
  if (docIdFor(path) !== id) {
    return { warning: { id, path, reason: "document id does not match the path" } };
  }
  if (data[FIELDS.published] !== true) {
    return { warning: { id, path, reason: "example is not published" } };
  }
  if (typeof data[FIELDS.content] !== "string") {
    return { warning: { id, path, reason: "content is not a string" } };
  }
  const updatedAt = asIsoTimestamp(data[FIELDS.updatedAt]);
  if (data[FIELDS.updatedAt] !== undefined && updatedAt === null) {
    return { warning: { id, path, reason: "updatedAt is not a usable timestamp" } };
  }

  const parts = path.split("/");
  const file = parts[parts.length - 1] ?? path;
  const name = file.replace(/\.oq$/i, "");
  return {
    record: Object.freeze({
      path,
      ref,
      name,
      // The first directory beneath examples/ is the category, exactly as loadExamples does.
      category: parts.length > 2 ? parts[1] : "Examples",
      title: isNonEmptyString(data[FIELDS.title]) ? data[FIELDS.title].trim() : name,
      source: data[FIELDS.content],
      route: exampleRoute(path, ref),
      sourceUrl: blobUrl(path, ref),
      contentHash: isNonEmptyString(data[FIELDS.contentHash]) ? data[FIELDS.contentHash] : "",
      updatedAt: updatedAt ?? "",
    }),
  };
}

/** The index entry shape `loadExamples` already produces. */
export function toExampleEntry(record) {
  return Object.freeze({
    path: record.path,
    name: record.name,
    category: record.category,
    route: record.route,
    sourceUrl: record.sourceUrl,
    size: record.source.length,
  });
}

/** Every published example. Filtering is `published === true`; sorting is local. */
export async function listExamples({ ref = MIRRORED_REF, limit: max = MAX_EXAMPLES, env } = {}) {
  if (ref !== MIRRORED_REF) {
    return { ok: false, data: [], error: unsupportedRef(ref), warnings: [], cached: false };
  }
  const bounded = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_EXAMPLES;
  const result = await readDocs(
    COLLECTIONS.examples,
    (module, base) => module.query(base, module.where(FIELDS.published, "==", true), module.limit(bounded)),
    { cacheKey: `published:${bounded}`, env },
  );
  if (!result.ok) {
    return { ok: false, data: [], error: result.error, warnings: [], cached: Boolean(result.cached) };
  }

  const records = [];
  const warnings = [];
  for (const entry of result.data) {
    const { record, warning } = validateExampleRecord(entry, { ref });
    if (record) records.push(record);
    else warnings.push(warning);
  }
  records.sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );
  return { ok: true, data: records, error: null, warnings, cached: Boolean(result.cached) };
}

/** The examples index for a ref. */
export async function listExamplesIndex(options = {}) {
  const result = await listExamples(options);
  return { ...result, data: result.data.map(toExampleEntry) };
}

/** One published example's source by repository path; `data: null` when absent. */
export async function getExample({ path, ref = MIRRORED_REF, env } = {}) {
  if (ref !== MIRRORED_REF) {
    return { ok: false, data: null, error: unsupportedRef(ref), warnings: [], cached: false };
  }
  if (!isNonEmptyString(path) || !isExamplePath(path)) {
    return {
      ok: false,
      data: null,
      error: firestoreError("invalid-argument", `Not an example path: ${String(path)}`, {
        retryable: false,
      }),
      warnings: [],
      cached: false,
    };
  }
  const repoPath = path.trim();
  const result = await readDoc(COLLECTIONS.examples, docIdFor(repoPath), {
    cacheKey: repoPath,
    env,
  });
  if (!result.ok) {
    return { ok: false, data: null, error: result.error, warnings: [], cached: Boolean(result.cached) };
  }
  if (result.data === null) {
    return { ok: true, data: null, error: null, warnings: [], cached: Boolean(result.cached) };
  }
  const { record, warning } = validateExampleRecord(
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
