import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeOptionId, keyAction, optionId, rankEntries } from "../search.js";

import { loadCatalog, loadExamples, loadText } from "../github-docs.js";
import { ensureIndex, onRebuild } from "../search-index.js";
import { DEFAULT_REF, documentRoute, exampleRoute, parseQuery, sectionForPath } from "../source.js";

// Site search over dynamically discovered content.
//
// The index is not a build artefact and is not a list of pages: it is built at request time
// from the same discovery the documentation and examples pages use. A document or example
// added to the repository is therefore searchable without a site change.
//
// The index is built on first use, not on page load, so a reader who never searches pays
// nothing for it. It is built once per ref until a republish, then rebuilt, and shared by every
// Search instance through the cache in `../search-index.js`.

function buildIndex(ref = DEFAULT_REF) {
  return Promise.all([
    loadCatalog(ref).catch(() => []),
    loadExamples(ref).catch(() => []),
  ]).then(async ([docs, examples]) => {
    const entries = [];

    // The catalogue already shrank the documents' Markdown for their titles, so the bodies are
    // in the cache. Indexing a short excerpt is what makes a search for a term that appears
    // only in the text (a type name, a function) find the document at all.
    const excerpts = await Promise.all(
      docs.map(async (doc) => {
        try {
          const markdown = await loadText(ref, doc.path);
          return excerpt(markdown);
        } catch {
          return "";
        }
      }),
    );

    docs.forEach((doc, index) => {
      entries.push({
        title: doc.title,
        text: `${sectionForPath(doc.path)} ${doc.path} ${excerpts[index]}`,
        url: documentRoute(doc.path, ref),
        kind: "Documentation",
      });
    });
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

const EXCERPT_CHARS = 1200;

/** A trimmed window of document text, enough for matching without bloating the index. */
function excerpt(markdown) {
  return String(markdown ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`|\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EXCERPT_CHARS);
}

export function Search() {
  const ref = typeof window === "undefined" ? DEFAULT_REF : parseQuery(window.location.search).ref;
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const requested = useRef(false);
  // Incremented on republish. An in-flight build that resolves afterwards still belongs to the
  // old catalogue, so its entries must not be rendered over the ones the new build produced.
  const buildToken = useRef(0);
  // Whether this reader has ever asked for the index. A republish rebuilds for them; a reader
  // who has never searched stays at "not started" rather than being told a load is running.
  const wanted = useRef(false);
  // Bumped on republish. An effect keyed on it rebuilds, which keeps the rebuild out of the
  // subscription callback so it always sees the current `entries` rather than a stale closure.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const options = useRef(null);
  const container = useRef(null);

  const results = entries ? rankEntries(entries, query) : [];
  const expanded = open && query.trim() !== "";

  const ensure = useCallback(() => {
    if (entries || requested.current) return;
    wanted.current = true;
    requested.current = true;
    setError(null);
    const startedAt = buildToken.current;
    ensureIndex(ref, buildIndex)
      .then((built) => {
        if (startedAt === buildToken.current) setEntries(built);
      })
      .catch((cause) => {
        if (startedAt !== buildToken.current) return;
        requested.current = false;
        setError(cause?.message ?? "Search is unavailable right now.");
      });
  }, [entries, ref]);

  // A republish invalidates the built index and calls back here. Drop the rendered entries and
  // re-arm the one-shot guard; the effect below then rebuilds for a reader who is using search.
  useEffect(
    () =>
      onRebuild(() => {
        buildToken.current += 1;
        setActive(-1);
        setEntries(null);
        setError(null);
        setRefreshNonce((value) => value + 1);
      }),
    [],
  );

  // Rebuild after a republish, but only for a reader who had already asked for the index.
  // Without this the open panel kept announcing a load that nothing had started, and stayed that
  // way until the reader typed another character. Keyed on the nonce, so it does not re-run when
  // `entries` changes as a result of its own rebuild.
  useEffect(() => {
    if (refreshNonce === 0 || !wanted.current) return;
    requested.current = false;
    ensure();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-running on `entries` would loop.
  }, [refreshNonce]);

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
