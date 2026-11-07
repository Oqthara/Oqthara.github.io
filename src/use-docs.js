// React data hooks for every piece of content the site reads.
//
// One hook, one request shape. Each hook answers `{ status, data, source, error, retry }`, where
// `source` is `firestore` (the content mirror), `cache` (a TTL-cached mirror read) or `github`
// (the fallback), so a page can report which backend answered.
//
// Nothing fetches during server rendering: the prerenderer emits a loading shell, the browser
// hydrates exactly that shell, and an effect then asks for content. That is what keeps
// hydration deterministic.
//
// Two rules are enforced here rather than in each page:
//
//   * a reload keeps the last good value, so switching a channel never blanks the screen and a
//     failed background refresh does not destroy content the reader is already reading;
//   * a late response from an abandoned request can never overwrite newer state.

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_REF } from "./source.js";
import {
  findChannel,
  setRefreshErrorListener,
  loadText,
} from "./github-docs.js";
import {
  getCatalog,
  getChangelog,
  getDocument,
  getExample,
  getExamples,
  getReleases,
} from "./services/content.service.js";
import { loadCatalog } from "./repositories/catalog.repository.js";

/**
 * Unwraps a service result into the pair the hooks keep: the value and where it came from.
 *
 * The service never throws; it answers `{ data, source, stale, error }` because a page needs to
 * know whether it is reading the mirror or the fallback. `source` is `firestore`, `cache` or
 * `github`, and pages render it so a reader can tell a mirrored page from a fallback one.
 *
 * Rethrow only when there is nothing to show, which is what puts a page into its error state.
 * Content that arrived is never discarded because a later refresh failed.
 */
function unwrap(result) {
  const source = result?.source ?? null;
  if (result && result.data !== null && result.data !== undefined) return { data: result.data, source };
  if (result?.error) throw result.error;
  return { data: result?.data ?? null, source };
}

/**
 * Runs `load` when a dependency changes, keeping the previous value across reloads.
 *
 * `load` resolves to `{ data, source }`; `source` is carried alongside the value so a page can
 * report which backend answered.
 *
 * `status` is `loading` only when there is nothing to show yet; a background refresh leaves it
 * `ready` and sets `refreshing`, which is what lets a page keep its content on screen.
 */
function useAsync(load, deps) {
  const [state, setState] = useState({ status: "loading", data: null, source: null, error: null, refreshing: false });
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => setNonce((value) => value + 1), []);

  // A refresh that failed while cached content was on screen has no promise left to reject, so
  // it is reported out of band. This is what makes the stale note appear.
  useEffect(
    () =>
      setRefreshErrorListener((error) => {
        setState((previous) => (previous.data ? { ...previous, error, status: "ready" } : previous));
      }),
    [],
  );

  useEffect(() => {
    let live = true;
    setState((previous) => ({
      status: previous.data ? "ready" : "loading",
      data: previous.data,
      source: previous.source,
      error: null,
      refreshing: Boolean(previous.data),
    }));
    load().then(
      (answer) => {
        if (live) setState({ status: "ready", data: answer?.data ?? null, source: answer?.source ?? null, error: null, refreshing: false });
      },
      (error) => {
        if (!live) return;
        setState((previous) => ({
          // Content already on screen is still shown; only the absence of content is a failure.
          status: previous.data ? "ready" : "error",
          data: previous.data,
          source: previous.source,
          error,
          refreshing: false,
        }));
      },
    );
    return () => {
      live = false;
    };
    // `load` is rebuilt every render by the callers below on purpose: its identity follows the
    // dependencies that are listed here, and those are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, retry };
}

/**
 * The release channels plus the channel the URL asked for.
 *
 * `channels` always contains development first. If the release list cannot be loaded, the
 * development channel is still returned so the site keeps working instead of showing an empty
 * selector, and `error` lets the header say the release list is unavailable.
 */
export function useChannels() {
  const { status, data, source, error, retry } = useAsync(() => getReleases().then(unwrap), []);
  const channels = data ?? [];
  return { status, channels, source, error, retry };
}

/**
 * The mirror's own record of the commit it was last reconciled from.
 *
 * Only meaningful for the development channel, whose content is mirrored from `main`. A release
 * channel is read from GitHub at its tag, so its provenance is the tag rather than this record.
 * A mirror that predates the catalogue, or could not be read, resolves to `null` and the caller
 * says so rather than showing a commit it cannot prove.
 */
export function useMirrorCatalog() {
  const { status, data, error, retry } = useAsync(() => loadCatalog().then(unwrap), []);
  return { status, catalog: data ?? null, error, retry };
}

/** Resolves a `ref` from the URL against the live channel list. */
export function resolveChannel(channels, ref) {
  const wanted = String(ref ?? "").trim() || DEFAULT_REF;
  if (!channels.length) {
    return { id: wanted.replace(/^v/, ""), label: wanted, ref: wanted, dev: wanted === DEFAULT_REF, pending: true };
  }
  const found = findChannel(channels, wanted);
  return { ...found, pending: false };
}

/** The documentation catalogue for a ref. Always an array. */
export function useCatalog(ref = DEFAULT_REF) {
  return useAsync(() => getCatalog(ref).then(unwrap), [ref]);
}

/** One document for a ref. */
export function useDocument(ref, path) {
  return useAsync(() => getDocument(ref, path).then(unwrap), [ref, path]);
}

/** Every example for a ref. */
export function useExamples(ref = DEFAULT_REF) {
  return useAsync(() => getExamples(ref).then(unwrap), [ref]);
}

/** One example's source for a ref. */
export function useExample(ref, path) {
  return useAsync(() => getExample(ref, path).then(unwrap), [ref, path]);
}

/** The changelog for a ref. */
export function useChangelog(ref = DEFAULT_REF) {
  return useAsync(() => getChangelog(ref).then(unwrap), [ref]);
}

/** Any repository text file for a ref (used by status and philosophy). */
export function useText(ref, path) {
  return useAsync(() => loadText(ref, path).then((text) => ({ data: text, source: "github" })), [ref, path]);
}
