// Runtime data hooks for the documentation pages.
//
// Nothing here fetches during server rendering: the prerenderer emits a loading shell, the
// browser hydrates the same shell, and the effect then asks GitHub for content. That keeps
// the build independent of `docs/` and makes hydration deterministic.

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_REF } from "./source.js";
import { loadCatalog, loadDocument, loadText } from "./github-docs.js";

/** Runs `load` when `nonce` or any dependency changes, keeping the last good value on error. */
function useAsync(load, deps) {
  const [state, setState] = useState({ status: "loading", data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    setState((previous) => ({ ...previous, status: previous.data ? "ready" : "loading", error: null }));
    load().then(
      (data) => {
        if (live) setState({ status: "ready", data, error: null });
      },
      (error) => {
        if (live) setState((previous) => ({ status: "error", data: previous.data, error }));
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, retry };
}

export function useCatalog(ref = DEFAULT_REF) {
  return useAsync(() => loadCatalog(ref), [ref]);
}

/** One document plus its catalog entry, so a page can show the real title before load. */
export function useDocument(ref, path) {
  return useAsync(() => loadDocument(ref, path), [ref, path]);
}

export function useText(ref, path) {
  return useAsync(() => loadText(ref, path), [ref, path]);
}
