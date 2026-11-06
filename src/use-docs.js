// React data hooks for every piece of GitHub-backed content.
//
// One hook, one request shape. Nothing fetches during server rendering: the prerenderer emits
// a loading shell, the browser hydrates exactly that shell, and an effect then asks GitHub for
// content. That is what keeps hydration deterministic.
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
  loadCatalog,
  loadChangelog,
  loadDocument,
  loadExample,
  loadExamples,
  loadReleases,
  loadText,
} from "./github-docs.js";

/**
 * Runs `load` when a dependency changes, keeping the previous value across reloads.
 *
 * `status` is `loading` only when there is nothing to show yet; a background refresh leaves it
 * `ready` and sets `refreshing`, which is what lets a page keep its content on screen.
 */
function useAsync(load, deps) {
  const [state, setState] = useState({ status: "loading", data: null, error: null, refreshing: false });
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
      error: null,
      refreshing: Boolean(previous.data),
    }));
    load().then(
      (data) => {
        if (live) setState({ status: "ready", data, error: null, refreshing: false });
      },
      (error) => {
        if (!live) return;
        setState((previous) => ({
          // Content already on screen is still shown; only the absence of content is a failure.
          status: previous.data ? "ready" : "error",
          data: previous.data,
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
  const { status, data, error, retry } = useAsync(() => loadReleases(), []);
  const channels = data ?? [];
  return { status, channels, error, retry };
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
  return useAsync(() => loadCatalog(ref), [ref]);
}

/** One document for a ref. */
export function useDocument(ref, path) {
  return useAsync(() => loadDocument(ref, path), [ref, path]);
}

/** Every example for a ref. */
export function useExamples(ref = DEFAULT_REF) {
  return useAsync(() => loadExamples(ref), [ref]);
}

/** One example's source for a ref. */
export function useExample(ref, path) {
  return useAsync(() => loadExample(ref, path), [ref, path]);
}

/** The changelog for a ref. */
export function useChangelog(ref = DEFAULT_REF) {
  return useAsync(() => loadChangelog(ref), [ref]);
}

/** Any repository text file for a ref (used by status and philosophy). */
export function useText(ref, path) {
  return useAsync(() => loadText(ref, path), [ref, path]);
}
