// Collection names, field names and the deterministic document-id scheme.
//
// Firestore has no path hierarchy in a collection: a document is addressed by an id inside a
// collection. The canonical repository is a tree, so the mirror flattens it with one stable
// rule:
//
//   docs/spec/language.md  ->  docs__spec__language.md
//
// A repository path with every `/` replaced by `__`. The mapping is deterministic, so a
// document can be read without a lookup table, and it is reversible for paths that do not
// themselves contain `__` (a corner case documented rather than guessed at).
//
// The mirror follows the `main` branch only. Pinned release channels keep reading GitHub, so a
// document id never has to encode a ref and a release can never overwrite `main` content.

import { normalizePath, normalizeRepoPath } from "../source.js";

export const COLLECTIONS = Object.freeze({
  documentation: "documentation",
  examples: "examples",
  releases: "releases",
  stdlib: "stdlib",
  metadata: "metadata",
  sync: "sync",
});

/** Collections that mirror canonical repository content. */
export const CONTENT_COLLECTIONS = Object.freeze([
  COLLECTIONS.documentation,
  COLLECTIONS.examples,
  COLLECTIONS.releases,
  COLLECTIONS.stdlib,
]);

export const FIELDS = Object.freeze({
  path: "path",
  title: "title",
  content: "content",
  published: "published",
  sourceRef: "sourceRef",
  contentHash: "contentHash",
  updatedAt: "updatedAt",
  kind: "kind",
  // Release records.
  ref: "ref",
  label: "label",
  prerelease: "prerelease",
  publishedAt: "publishedAt",
  url: "url",
  // Sync bookkeeping.
  collection: "collection",
  status: "status",
  reason: "reason",
  bytes: "bytes",
});

export const SYNC_STATUS = Object.freeze({
  published: "published",
  unpublished: "unpublished",
  oversized: "oversized",
});

/** The only branch the Firestore mirror holds. */
export const MIRRORED_REF = "main";

/** The generated standard library reference. Produced by `oq doc` in the language repository. */
export const STDLIB_REFERENCE_PATH = "docs/stdlib/reference.md";

export const DOC_ID_SEPARATOR = "__";

/**
 * The Firestore document id for a repository path.
 *
 * `docs/spec/language.md` -> `docs__spec__language.md`. Leading slashes, `.` segments and
 * backslashes are removed first, so two spellings of the same path cannot create two docs.
 */
export function docIdFor(path) {
  const normalized = normalizePath(normalizeRepoPath(path));
  return normalized.split("/").join(DOC_ID_SEPARATOR);
}

/**
 * Sync bookkeeping ids are namespaced by collection because the same path can appear in two
 * mirrors (`docs/stdlib/reference.md` is both documentation and the stdlib reference).
 */
export function syncIdFor(collection, path) {
  return `${collection}${DOC_ID_SEPARATOR}${docIdFor(path)}`;
}

/** Release records use a repository-style path so their ids are deterministic too. */
export function releaseIdFor(tag) {
  return docIdFor(`releases/${String(tag ?? "").trim()}`);
}

/** Non-empty string, trimmed; anything else is a malformed Firestore value. */
export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** A plain JSON-like object (not an array, not null, not a Firestore class instance). */
export function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * Normalizes a timestamp field to an ISO string, or null when it cannot be understood.
 *
 * Firestore may hand back an ISO string (what the sync writes) or a Timestamp. A missing or
 * malformed value is not fatal for reading content, but it is reported by the validators.
 */
export function asIsoTimestamp(value) {
  if (isNonEmptyString(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (value && typeof value.toDate === "function") {
    try {
      const date = value.toDate();
      return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
    } catch {
      return null;
    }
  }
  return null;
}
