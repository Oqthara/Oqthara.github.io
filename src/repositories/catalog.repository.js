// The mirror's own record of what it is serving.
//
// Documentation and examples are mirrored from the canonical repository's `main` branch, so
// `sourceCommit` is the only field that answers "which exact revision is this content?" - `main`
// alone is a moving target. The sync script writes this into `metadata/catalog`, which is
// readable from a client precisely so a reader can check the claim rather than take it.
//
// Everything here is untrusted: a missing or malformed field is reported as absent, never
// coerced into something that reads as a valid provenance claim.

import { COLLECTION_CATALOG_ID, COLLECTIONS, MIRRORED_REF, FIELDS } from "../firebase/collections.js";
import { readDoc } from "../firebase/firestore.js";

/** A commit id the GitHub API would accept, or "" when the value is not one. */
export function validCommit(value) {
  const commit = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{40}$/.test(commit) ? commit : "";
}

/**
 * Validates the catalogue document.
 *
 * Returns `{ sourceRef, sourceCommit, updatedAt, counts }`, with `sourceCommit` empty when the
 * record cannot prove one. An empty commit is reported honestly rather than defaulted to the
 * branch name, which would make an unverifiable mirror look verified.
 */
export function validateCatalogRecord(entry) {
  const counts = entry?.counts;
  return Object.freeze({
    sourceRef: typeof entry?.[FIELDS.sourceRef] === "string" && entry[FIELDS.sourceRef].trim()
      ? entry[FIELDS.sourceRef].trim()
      : MIRRORED_REF,
    sourceCommit: validCommit(entry?.[FIELDS.sourceCommit]),
    updatedAt: typeof entry?.[FIELDS.updatedAt] === "string" ? entry[FIELDS.updatedAt] : "",
    counts: Object.freeze({
      written: Number.isFinite(counts?.written) ? counts.written : 0,
      unchanged: Number.isFinite(counts?.unchanged) ? counts.unchanged : 0,
      unpublished: Number.isFinite(counts?.unpublished) ? counts.unpublished : 0,
      oversized: Number.isFinite(counts?.oversized) ? counts.oversized : 0,
    }),
  });
}

/**
 * The mirror catalogue, or a typed failure the caller can render as "unknown".
 *
 * A missing document is not an error: a mirror that has never been reconciled has no catalogue,
 * and saying so is more accurate than fabricating one.
 */
export async function loadCatalog(options = {}) {
  const result = await readDoc(COLLECTIONS.metadata, COLLECTION_CATALOG_ID, {
    ...options,
    cacheKey: "catalog",
  });
  if (result.error) return result;
  const data = result.data;
  if (!data) return { ...result, data: null };
  return { ...result, data: validateCatalogRecord(data) };
}

/** A short, human-readable commit reference, or "" when there is nothing to show. */
export function shortCommit(commit) {
  const full = validCommit(commit);
  return full ? full.slice(0, 7) : "";
}

/** Where the commit can be read. Empty when there is no commit to link to. */
export function commitUrl(commit, { repo = "Oqthara/oqthara" } = {}) {
  const full = validCommit(commit);
  return full ? `https://github.com/${repo}/commit/${full}` : "";
}
