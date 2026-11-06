import { createElement as h } from "react";
import { hrefFor, PageHead } from "../components/Layout.jsx";
import { ChannelBar } from "../components/ChannelSelect.jsx";
import { SourceNote } from "../components/SourceNote.jsx";
import { useCatalog, useChannels, resolveChannel } from "../use-docs.js";
import { DEFAULT_REF, docsIndexUrl } from "../source.js";
import { groupDocuments } from "../lib/sections.js";

// The documentation index.
//
// The list is discovered from the repository tree for the selected ref. There is no catalogue
// file, no committed document list and no per-document route: a Markdown file added to `docs/`
// at any depth appears here on the next load, in a section derived from its directory.
//
// This is also where the deployed `e is not iterable` bug is fixed. `useCatalog` resolves to
// an array of documents; the index iterates that array and nothing else.

function Loading({ what }) {
  return h(
    "div",
    { className: "status-block", role: "status", "aria-live": "polite" },
    h("div", null, h("p", null, `Discovering ${what}…`), h("div", { className: "skeleton" })),
  );
}

function Failure({ error, what, onRetry, ref }) {
  return h(
    "div",
    { className: "status-block", "data-tone": "error", role: "alert" },
    h(
      "div",
      null,
      h("h2", null, `Could not load ${what}`),
      h("p", null, error?.message ?? "Neither the content mirror nor GitHub could be reached."),
      h(
        "div",
        { className: "status-block-actions" },
        h("a", { href: docsIndexUrl(ref) }, "Browse docs on GitHub"),
        h("button", { type: "button", className: "retry", onClick: onRetry }, "Try again"),
      ),
    ),
  );
}

function DocumentIndex({ docs }) {
  const groups = groupDocuments(docs);
  return h(
    "div",
    null,
    groups.map((group) =>
      h(
        "section",
        { className: "section-group", key: group.section },
        h("h2", null, group.section, h("span", { className: "count" }, group.entries.length)),
        h(
          "ul",
          { className: "doc-list" },
          group.entries.map((doc) =>
            h(
              "li",
              { key: doc.path },
              h(
                "a",
                { href: doc.route },
                h("span", null, doc.title),
                h("span", { className: "doc-path" }, doc.path),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

export function DocsPage({ query = {} }) {
  const { channels, status: channelStatus } = useChannels();
  const channel = resolveChannel(channels, query.ref);
  const { status, data, source, error, retry } = useCatalog(channel.ref);

  return h(
    "div",
    { className: "content" },
    h(PageHead, {
      eyebrow: "Documentation",
      title: "Documentation",
      lead: "Every page here is discovered from the Oqthara repository when you open it, so this site never holds a second copy of the manual and never needs a change when a document is added.",
    }),

    h(ChannelBar, { channels, channel, label: channelStatus === "ready" ? undefined : "Documentation version (loading releases…)" }),

    status === "loading" ? h(Loading, { what: "the documentation index" }) : null,
    status === "error" && !data
      ? h(Failure, { error, what: "the documentation index", onRetry: retry, ref: channel.ref })
      : null,
    data && data.length
      ? h(DocumentIndex, { docs: data })
      : null,
    data && data.length === 0
      ? h(
          "div",
          { className: "empty-state" },
          h("p", null, "The repository tree has no Markdown documents under docs at this ref."),
          h("p", null, h("a", { href: docsIndexUrl(channel.ref) }, "Check the directory on GitHub")),
        )
      : null,

    // A background refresh that failed is reported without removing what is on screen.
    error && data
      ? h(
          "p",
          { className: "stale-note", role: "alert" },
          "Showing the last result. The refresh failed: ",
          error.message,
        )
      : null,

    h(
      "p",
      { className: "meta-row", style: { marginTop: "var(--space-6)" } },
      h("span", null, "Related:"),
      h("a", { href: hrefFor("/stdlib.html") }, "Standard library"),
      h("a", { href: hrefFor("/philosophy.html") }, "Philosophy"),
      h("a", { href: hrefFor("/status.html") }, "Backend status"),
      h("a", { href: hrefFor("/changelog.html") }, "Changelog"),
      h("code", null, channel.ref === DEFAULT_REF ? "main" : channel.ref),
      h(SourceNote, { source }),
    ),
  );
}
