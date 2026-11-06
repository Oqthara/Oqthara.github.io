import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeOptionId, keyAction, optionId, rankEntries } from "../search.js";

import { loadCatalog, loadExamples } from "../github-docs.js";
import { DEFAULT_REF, documentRoute, exampleRoute, parseQuery, sectionForPath } from "../source.js";

// Site search over dynamically discovered content.
//
// The index is not a build artefact and is not a list of pages: it is built at request time
// from the same discovery the documentation and examples pages use. A document or example
// added to the repository is therefore searchable without a site change.
//
// The index is built on first use, not on page load, so a reader who never searches pays
// nothing for it. It is built once per session and shared by every Search instance.

function buildIndex(ref = DEFAULT_REF) {
  return Promise.all([
    loadCatalog(ref).catch(() => []),
    loadExamples(ref).catch(() => []),
  ]).then(([docs, examples]) => {
    const entries = [];
    for (const doc of docs) {
      entries.push({
        title: doc.title,
        text: `${sectionForPath(doc.path)} ${doc.path}`,
        url: documentRoute(doc.path, ref),
        kind: "Documentation",
      });
    }
    for (const example of examples) {
      entries.push({
        title: `${example.name}.oq`,
        text: `${example.category} example ${example.path}`,
        url: exampleRoute(example.path, ref),
        kind: "Example",
      });
    }
    return entries;
  });
}

const indexCache = new Map();

/**
 * The search index for a ref.
 *
 * Keyed by ref: the site can be read at `main` or at a release, and a search from a pinned
 * manual must return links into that manual, not into development.
 */
function ensureIndex(ref) {
  if (!indexCache.has(ref)) {
    const promise = buildIndex(ref).catch((error) => {
      // Let a later attempt try again instead of caching the failure forever.
      indexCache.delete(ref);
      throw error;
    });
    indexCache.set(ref, promise);
  }
  return indexCache.get(ref);
}

/** Test seam: forget the shared index. */
export function __resetSearchIndexForTests() {
  indexCache.clear();
}

export function Search() {
  const ref = typeof window === "undefined" ? DEFAULT_REF : parseQuery(window.location.search).ref;
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const requested = useRef(false);
  const options = useRef(null);
  const container = useRef(null);

  const results = entries ? rankEntries(entries, query) : [];
  const expanded = open && query.trim() !== "";

  useEffect(() => {
    if (!expanded || active < 0 || !options.current) return;
    const node = options.current.querySelector(`#${optionId(active)}`);
    if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
  }, [expanded, active]);

  // Close on an outside click so the panel does not cover the page while reading.
  useEffect(() => {
    if (!expanded) return;
    const onDown = (event) => {
      if (container.current && !container.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [expanded]);

  const ensure = useCallback(() => {
    if (entries || requested.current) return;
    requested.current = true;
    setError(null);
    ensureIndex(ref)
      .then(setEntries)
      .catch((cause) => {
        requested.current = false;
        setError(cause?.message ?? "Search is unavailable right now.");
      });
  }, [entries, ref]);

  const onKeyDown = (event) => {
    // `keyAction` returns a typed action; comparing it to a string silently did nothing, which
    // is why arrow keys never moved the selection.
    const action = keyAction(event.key, { expanded, active, count: results.length });
    if (!action) return;
    if (action.type === "close") {
      setOpen(false);
      setActive(-1);
      return;
    }
    if (action.type === "move") {
      event.preventDefault();
      setActive(action.index);
      return;
    }
    if (action.type === "open") {
      const target = results[action.index];
      if (!target) return;
      event.preventDefault();
      window.location.href = target.url;
    }
  };

  const status = useMemo(() => {
    if (error) return error;
    if (entries === null) return "Loading the search index…";
    if (!query.trim()) return `${entries.length} entries`;
    if (!results.length) return `No matches for “${query.trim()}”`;
    return `${results.length} of ${entries.length} entries`;
  }, [error, entries, query, results.length]);

  return h(
    "div",
    { className: "search", ref: container },
    h(
      "label",
      { className: "visually-hidden", htmlFor: "site-search" },
      "Search documentation and examples",
    ),
    h("input", {
      id: "site-search",
      type: "search",
      className: "search-input",
      placeholder: "Search…",
      autoComplete: "off",
      value: query,
      "aria-expanded": expanded ? "true" : "false",
      "aria-controls": "site-search-results",
      "aria-autocomplete": "list",
      // The combobox keeps DOM focus on the input; the active option is announced through
      // aria-activedescendant. Without this, arrow keys moved a highlight no screen reader
      // could follow.
      "aria-activedescendant": expanded ? activeOptionId(true, active) : undefined,
      role: "combobox",
      onFocus: () => {
        ensure();
        setOpen(true);
      },
      onChange: (event) => {
        ensure();
        setQuery(event.target.value);
        setOpen(true);
        setActive(-1);
      },
      onKeyDown,
    }),
    expanded
      ? h(
          "div",
          { className: "search-panel" },
          h("p", { className: "search-status", role: "status", "aria-live": "polite" }, status),
          error
            ? null
            : h(
                "ul",
                { className: "search-results", id: "site-search-results", role: "listbox", ref: options },
                results.map((entry, index) =>
                  h(
                    "li",
                    {
                      key: entry.url,
                      id: optionId(index),
                      role: "option",
                      "aria-selected": index === active ? "true" : "false",
                    },
                    h(
                      "a",
                      {
                        href: entry.url,
                        onMouseEnter: () => setActive(index),
                        tabIndex: -1,
                      },
                      h("strong", null, entry.title),
                      h("span", null, `${entry.kind} · ${entry.text}`),
                    ),
                  ),
                ),
              ),
        )
      : null,
    expanded && active >= 0
      ? h(
          "span",
          { className: "visually-hidden", "aria-live": "polite" },
          `${results[active]?.title ?? ""} selected, ${active + 1} of ${results.length}`,
        )
      : null,
  );
}
