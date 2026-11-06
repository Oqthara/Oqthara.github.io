// The single integration point between pages and content backends.
//
// Firestore is preferred; GitHub is the fallback. That order exists because the mirror is
// cheaper and faster, while GitHub remains the canonical source of truth: a document that was
// merged a minute ago is not in Firestore yet, and the site must still render it.
//
// Rules:
//
//   * never throw — every function resolves to `{ data, source, stale, error }`;
//   * never duplicate GitHub logic — the fallback calls the existing `github-docs.js` loaders,
//     so their promise deduplication, session persistence and stale-while-revalidate behaviour
//     are preserved exactly;
//   * Firestore never wins for a pinned release channel or for the changelog at a non-main ref:
//     the mirror follows `main`, so a released manual keeps reading its own tag from GitHub.
//
// `source` values:
//   "firestore" — a fresh read from the mirror (or its repository layer);
//   "cache"     — the mirror answered from its in-process TTL cache, i.e. no network round trip;
//   "github"    — GitHub served the request, either because Firestore is unavailable/empty or
//                 because the ref is not the mirrored branch.
//
// `stale` is true when the answer is not a fresh canonical read: a cached Firestore answer, or
// a GitHub fallback after the mirror failed or had nothing.

import { CHANGELOG_PATH, DEFAULT_REF } from "../source.js";
import {
  loadCatalog,
  loadChangelog,
  loadDocument,
  loadExample,
  loadExamples,
  loadReleases,
  loadText,
} from "../github-docs.js";
import {
  getDocument as firestoreDocument,
  listDocumentationCatalog,
} from "../repositories/documentation.repository.js";
import {
  getExample as firestoreExample,
  listExamplesIndex,
} from "../repositories/examples.repository.js";
import { listReleases as firestoreReleases } from "../repositories/releases.repository.js";
import {
  STDLIB_REFERENCE_PATH,
  getStdlibReference as firestoreStdlibReference,
} from "../repositories/stdlib.repository.js";
import { MIRRORED_REF } from "../firebase/collections.js";

/** The GitHub loaders, injectable so the fallback decision is testable without network. */
export const GITHUB_BACKEND = Object.freeze({
  loadCatalog,
  loadChangelog,
  loadDocument,
  loadExample,
  loadExamples,
  loadReleases,
  loadText,
});

/** The Firestore repositories, injectable for the same reason. */
export const FIRESTORE_BACKEND = Object.freeze({
  listDocumentationCatalog,
  getDocument: firestoreDocument,
  listExamplesIndex,
  getExample: firestoreExample,
  listReleases: firestoreReleases,
  getStdlibReference: firestoreStdlibReference,
});

/** A uniform result, so a page never has to know which backend answered. */
export function contentResult(data, { source, stale = false, error = null, warnings = [] } = {}) {
  return Object.freeze({ data, source, stale, error, warnings: Object.freeze([...warnings]) });
}

/** True when a Firestore result carries usable data. */
function hasData(result) {
  return Boolean(result?.ok) && result.data !== null && result.data !== undefined;
}

/** True when a Firestore result was served from the TTL cache. */
function isCached(result) {
  return Boolean(result?.cached);
}

/** True when a Firestore result carries nothing: a failure, or a successful empty answer. */
function isEmptyOrFailed(result) {
  if (!result || result.ok !== true) return true;
  const { data } = result;
  if (data === null || data === undefined) return true;
  if (Array.isArray(data) && data.length === 0) return true;
  return false;
}

function errorFrom(result) {
  return result?.error ?? null;
}

/**
 * The fallback decision, extracted so it is one obvious rule and one unit-test target.
 *
 * Returns `{ useFirestore: true }` or `{ useFirestore: false, reason }` where `reason` is one
 * of `unavailable`, `empty`, `error`, or `wrong-ref`.
 */
export function decideSource({ ref = MIRRORED_REF, result = null } = {}) {
  if (ref !== MIRRORED_REF) return { useFirestore: false, reason: "wrong-ref" };
  if (!result) return { useFirestore: false, reason: "empty" };
  if (result.ok !== true) return { useFirestore: false, reason: "error" };
  if (isEmptyOrFailed(result)) return { useFirestore: false, reason: "empty" };
  return { useFirestore: true, reason: "hit" };
}

/**
 * Runs a Firestore read, then GitHub when the mirror cannot answer.
 *
 * `firestore` and `github` are thunks so the fallback is only attempted when it is needed.
 */
async function preferFirestore({ ref, firestore, github, mapFirestore = (data) => data, mapGithub = (data) => data }) {
  let firestoreResult = null;
  try {
    firestoreResult = await firestore();
  } catch (error) {
    // The repository layer does not throw, but a bug or a mocked partial must not reach React.
    firestoreResult = { ok: false, data: null, error: { code: "unknown", message: String(error?.message ?? error), fallback: true } };
  }

  const decision = decideSource({ ref, result: firestoreResult });
  if (decision.useFirestore) {
    const cached = isCached(firestoreResult);
    return contentResult(mapFirestore(firestoreResult.data), {
      source: cached ? "cache" : "firestore",
      stale: cached,
      error: null,
      warnings: firestoreResult.warnings ?? [],
    });
  }

  try {
    const data = await github();
    return contentResult(mapGithub(data), {
      source: "github",
      // A GitHub answer after a mirror failure or miss is not a fresh canonical read of the
      // mirror: say so rather than pretending the two sources are interchangeable.
      stale: true,
      error: errorFrom(firestoreResult),
      warnings: firestoreResult?.warnings ?? [],
    });
  } catch (error) {
    // GitHub failed too. Return the previous Firestore data if it existed, marked stale, so a
    // reader keeps content instead of losing the page; otherwise surface GitHub's error.
    if (!isEmptyOrFailed(firestoreResult)) {
      return contentResult(mapFirestore(firestoreResult.data), {
        source: "cache",
        stale: true,
        error,
        warnings: firestoreResult.warnings ?? [],
      });
    }
    return contentResult(null, { source: "github", stale: false, error });
  }
}

/**
 * The documentation catalogue. Firestore preferred, GitHub fallback.
 *
 * Returns `{ data: [{ path, section, title, route, sourceUrl }], source, stale, error }`.
 */
export async function getCatalog(ref = DEFAULT_REF, options = {}) {
  const firestore = options.firestore ?? FIRESTORE_BACKEND;
  const github = options.github ?? GITHUB_BACKEND;
  return preferFirestore({
    ref,
    firestore: () => firestore.listDocumentationCatalog({ ref, env: options.env }),
    github: () => github.loadCatalog(ref),
  });
}

/** One Markdown document: `{ path, ref, title, markdown, sourceUrl }`. */
export async function getDocument(ref, path, options = {}) {
  const firestore = options.firestore ?? FIRESTORE_BACKEND;
  const github = options.github ?? GITHUB_BACKEND;
  return preferFirestore({
    ref,
    firestore: () => firestore.getDocument({ path, ref, env: options.env }),
    github: () => github.loadDocument(ref, path),
  });
}

/** The changelog document, from the mirror on `main` and from its tag on a release channel. */
export async function getChangelog(ref = DEFAULT_REF, options = {}) {
  const firestore = options.firestore ?? FIRESTORE_BACKEND;
  const github = options.github ?? GITHUB_BACKEND;
  return preferFirestore({
    ref,
    firestore: () => firestore.getDocument({ path: CHANGELOG_PATH, ref, env: options.env }),
    github: async () => {
      const markdown = await github.loadChangelog(ref);
      return { path: CHANGELOG_PATH, ref, title: "", markdown, sourceUrl: "" };
    },
  });
}

/** The changelog as plain Markdown, matching `loadChangelog`'s existing return type. */
export async function getChangelogText(ref = DEFAULT_REF, options = {}) {
  const result = await getChangelog(ref, options);
  return contentResult(result.data?.markdown ?? null, {
    source: result.source,
    stale: result.stale,
    error: result.error,
    warnings: result.warnings,
  });
}

/** Every example: `{ path, name, category, route, sourceUrl }`. */
export async function getExamples(ref = DEFAULT_REF, options = {}) {
  const firestore = options.firestore ?? FIRESTORE_BACKEND;
  const github = options.github ?? GITHUB_BACKEND;
  return preferFirestore({
    ref,
    firestore: () => firestore.listExamplesIndex({ ref, env: options.env }),
    github: () => github.loadExamples(ref),
  });
}

/** One example's source: `{ path, ref, source, sourceUrl }`. */
export async function getExample(ref, path, options = {}) {
  const firestore = options.firestore ?? FIRESTORE_BACKEND;
  const github = options.github ?? GITHUB_BACKEND;
  return preferFirestore({
    ref,
    firestore: () => firestore.getExample({ path, ref, env: options.env }),
    github: () => github.loadExample(ref, path),
  });
}

/** The release channels. Firestore preferred, GitHub fallback. */
export async function getReleases(options = {}) {
  const firestore = options.firestore ?? FIRESTORE_BACKEND;
  const github = options.github ?? GITHUB_BACKEND;
  return preferFirestore({
    ref: MIRRORED_REF,
    firestore: () => firestore.listReleases({ env: options.env }),
    github: () => github.loadReleases(),
  });
}

/** The generated standard library reference. */
export async function getStdlibReference(ref = DEFAULT_REF, options = {}) {
  const firestore = options.firestore ?? FIRESTORE_BACKEND;
  const github = options.github ?? GITHUB_BACKEND;
  return preferFirestore({
    ref,
    firestore: () => firestore.getStdlibReference({ ref, env: options.env }),
    github: () => github.loadDocument(ref, STDLIB_REFERENCE_PATH),
  });
}

/**
 * Any repository text file (status, philosophy, ad-hoc reads).
 *
 * Only the changelog and docs in `documentation` are mirrored, so arbitrary text is read from
 * GitHub directly. It goes through the fallback shape so a page has one result contract.
 */
export async function getText(ref, path, options = {}) {
  const github = options.github ?? GITHUB_BACKEND;
  try {
    const text = await github.loadText(ref, path);
    return contentResult(text, { source: "github", stale: false });
  } catch (error) {
    return contentResult(null, { source: "github", stale: false, error });
  }
}

export const contentService = Object.freeze({
  getCatalog,
  getDocument,
  getChangelog,
  getChangelogText,
  getExamples,
  getExample,
  getReleases,
  getStdlibReference,
  getText,
  decideSource,
  GITHUB_BACKEND,
  FIRESTORE_BACKEND,
});
