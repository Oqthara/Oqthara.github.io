// Firestore-backed release metadata repository.
//
// Release records mirror the GitHub releases API, normalized into the channel shape the site's
// selector already uses. A record that cannot be read is skipped: a release is navigation, not
// content, and a malformed one must not take the selector down.
//
// Development (`main`) is synthesized locally, exactly as `validateReleases` does, so it is
// always present even when Firestore holds no releases.

import { DEFAULT_REF } from "../source.js";
import { findChannel } from "../github-docs.js";
import {
  COLLECTIONS,
  FIELDS,
  MIRRORED_REF,
  asIsoTimestamp,
  isNonEmptyString,
  isPlainObject,
  releaseIdFor,
} from "../firebase/collections.js";
import { firestoreError, readDoc, readDocs } from "../firebase/firestore.js";

export const MAX_RELEASES = 100;

/** The development channel, always first and always available. */
export function developmentChannel() {
  return Object.freeze({
    id: DEFAULT_REF,
    label: "Development (main)",
    ref: DEFAULT_REF,
    prerelease: false,
    dev: true,
    published: "",
    url: "",
  });
}

/** Validates one release record into a channel, or reports why it was skipped. */
export function validateReleaseRecord(entry) {
  const id = typeof entry?.id === "string" ? entry.id : "";
  const data = entry?.data;
  if (!isPlainObject(data)) {
    return { warning: { id, reason: "release payload is not an object" } };
  }
  if (!isNonEmptyString(data[FIELDS.ref])) {
    return { warning: { id, reason: "missing or empty ref" } };
  }
  const ref = data[FIELDS.ref].trim();
  if (releaseIdFor(ref) !== id) {
    return { warning: { id, ref, reason: "document id does not match the ref" } };
  }
  if (data[FIELDS.published] !== true) {
    return { warning: { id, ref, reason: "release is not published" } };
  }
  const published = asIsoTimestamp(data[FIELDS.publishedAt]) ?? "";
  const label = isNonEmptyString(data[FIELDS.label]) ? data[FIELDS.label].trim() : ref;
  return {
    record: Object.freeze({
      id: ref.replace(/^v/, ""),
      label,
      ref,
      prerelease: data[FIELDS.prerelease] === true,
      dev: false,
      published,
      url: isNonEmptyString(data[FIELDS.url]) ? data[FIELDS.url].trim() : "",
    }),
  };
}

function sortChannels(channels) {
  const [dev, ...releases] = channels;
  releases.sort((a, b) => {
    const at = Date.parse(a.published) || 0;
    const bt = Date.parse(b.published) || 0;
    if (at !== bt) return bt - at;
    return b.ref.localeCompare(a.ref, undefined, { numeric: true });
  });
  return dev ? [dev, ...releases] : releases;
}

/**
 * The channel list from Firestore.
 *
 * `data` is `[]` (not a failure) when the mirror holds no releases, so the caller can decide
 * whether GitHub's list is better. Development is added only when there is at least one real
 * release, because an empty mirror means "not synced yet", not "no releases exist".
 */
export async function listReleases({ limit: max = MAX_RELEASES, env } = {}) {
  const bounded = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_RELEASES;
  const result = await readDocs(
    COLLECTIONS.releases,
    (module, base) => module.query(base, module.where(FIELDS.published, "==", true), module.limit(bounded)),
    { cacheKey: `published:${bounded}`, env },
  );
  if (!result.ok) {
    return { ok: false, data: [], error: result.error, warnings: [], cached: Boolean(result.cached) };
  }

  const releases = [];
  const warnings = [];
  for (const entry of result.data) {
    const { record, warning } = validateReleaseRecord(entry);
    if (record) releases.push(record);
    else warnings.push(warning);
  }
  if (!releases.length) {
    return { ok: true, data: [], error: null, warnings, cached: Boolean(result.cached) };
  }
  return {
    ok: true,
    data: Object.freeze(sortChannels([developmentChannel(), ...releases])),
    error: null,
    warnings,
    cached: Boolean(result.cached),
  };
}

/** One release by tag; `data: null` when the mirror does not have it. */
export async function getRelease({ ref, env } = {}) {
  if (!isNonEmptyString(ref)) {
    return {
      ok: false,
      data: null,
      error: firestoreError("invalid-argument", "A release ref is required.", { retryable: false }),
      warnings: [],
      cached: false,
    };
  }
  const tag = ref.trim();
  const result = await readDoc(COLLECTIONS.releases, releaseIdFor(tag), { cacheKey: tag, env });
  if (!result.ok) {
    return { ok: false, data: null, error: result.error, warnings: [], cached: Boolean(result.cached) };
  }
  if (result.data === null) {
    return { ok: true, data: null, error: null, warnings: [], cached: Boolean(result.cached) };
  }
  const { record, warning } = validateReleaseRecord({ id: releaseIdFor(tag), data: result.data });
  if (!record) {
    return {
      ok: true,
      data: null,
      error: null,
      warnings: [{ id: releaseIdFor(tag), ref: tag, reason: warning.reason }],
      cached: Boolean(result.cached),
    };
  }
  return { ok: true, data: record, error: null, warnings: [], cached: Boolean(result.cached) };
}

/** Resolves a URL ref against the Firestore channel list. Mirrors `resolveChannel`'s rules. */
export function resolveFirestoreChannel(channels, ref) {
  const wanted = String(ref ?? "").trim() || MIRRORED_REF;
  if (!Array.isArray(channels) || !channels.length) {
    return { id: wanted.replace(/^v/, ""), label: wanted, ref: wanted, dev: wanted === MIRRORED_REF, pending: true };
  }
  return { ...findChannel(channels, wanted), pending: false };
}
