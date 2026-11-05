import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeOptionId, keyAction, optionId, rankEntries } from "../search.js";

import { loadCatalog, loadExamples } from "../github-docs.js";
import { DEFAULT_REF, documentRoute, exampleRoute, sectionForPath } from "../source.js";

// Site search over dynamically discovered content.
//
// The index is not a build artefact and is not a list of pages: it is built at request time
// from the same discovery the documentation and examples pages use. A document or example
// added to the repository is therefore searchable without a site change.
//
// The index is built on first use, not on page load, so a reader who never searches pays
// nothing for it. It is built once per session and shared by every Search instance.

let indexPromise = null;

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

function ensureIndex(ref) {
  if (!indexPromise) {
    indexPromise = buildIndex(ref).catch((error) => {
      // Let a later attempt try again instead of caching the failure forever.
      indexPromise = null;
      throw error;
    });
  }
  return indexPromise;
}

/** Test seam: forget the shared index. */
export function __resetSearchIndexForTests() {
  indexPromise = null;
}

export function Search() {
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
    ensureIndex(DEFAULT_REF)
      .then(setEntries)
      .catch((cause) => {
        requested.current = false;
        setError(cause?.message ?? "Search is unavailable right now.");
      });
  }, [entries]);

  const onKeyDown = (event) => {
    const action = keyAction(event.key);
    if (action === "close") {
      setOpen(false);
      setActive(-1);
      return;
    }
    if (action === "previous" || action === "next") {
      event.preventDefault();
      setActive((current) => {
        if (!results.length) return -1;
        if (action === "next") return (current + 1) % results.length;
        return current <= 0 ? results.length - 1 : current - 1;
      });
      return;
    }
    if (action === "open" && results[active]) {
      event.preventDefault();
      window.location.href = results[active].url;
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
      ? h("span", { className: "visually-hidden", "aria-live": "polite" }, activeOptionId(active))
      : null,
  );
}
