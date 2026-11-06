import { createElement as h } from "react";
import { hrefFor } from "../components/Layout.jsx";
import { ChannelBar } from "../components/ChannelSelect.jsx";
import { MarkdownWithToc } from "../components/Markdown.jsx";
import { SourceNote } from "../components/SourceNote.jsx";
import { useCatalog, useChannels, useDocument, resolveChannel } from "../use-docs.js";
import { DEFAULT_REF, docsIndexUrl, isDocumentPath, sectionForPath, sectionTitle } from "../source.js";
import { groupDocuments } from "../lib/sections.js";

// The one page that renders any documentation file.
//
// `/document.html?path=docs/spec/language.md&ref=main` is a static file, so this route exists
// for every document without a build, a shell per document or a list of document paths. That
// is what makes a document added to GitHub today openable today.
//
// The sidebar is built from the same discovered catalogue as the index, so navigation is
// never a hard-coded list either.

function Sidebar({ docs, currentPath, channel }) {
  if (!docs || !docs.length) return null;
  // Same grouping and ordering as the index, so the two navigation surfaces never disagree.
  const ordered = groupDocuments(docs).map((group) => [group.section, group.entries]);

  return h(
    "aside",
    { className: "docs-sidebar", "aria-label": "Documentation navigation" },
    // Below 1000px the whole rail would be an eighteen-link wall above the document, so each
    // section is a disclosure that starts closed on small screens. On desktop the CSS turns the
    // summary into a plain heading and the lists stay visible.
    ordered.map(([section, entries]) =>
      h(
        "details",
        { key: section, className: "sidebar-section", open: entries.some((doc) => doc.path === currentPath) },
        h("summary", null, h("h2", null, section), h("span", { className: "count" }, entries.length)),
        h(
          "ul",
          null,
          entries.map((doc) =>
            h(
              "li",
              { key: doc.path },
              h(
                "a",
                {
                  href: doc.route,
                  "aria-current": doc.path === currentPath ? "page" : undefined,
                  title: doc.path,
                },
                doc.title,
              ),
            ),
          ),
        ),
      ),
    ),
    h("p", { className: "flow-sm" },
      h("a", { href: hrefFor("/docs.html") + (channel.ref === DEFAULT_REF ? "" : `?ref=${encodeURIComponent(channel.ref)}`) }, "All documentation")),
  );
}

function Loading({ path }) {
  return h(
    "div",
    { className: "status-block", role: "status", "aria-live": "polite" },
    h("div", null, h("p", null, "Loading ", h("code", null, path), "…"), h("div", { className: "skeleton" })),
  );
}

function Failure({ error, path, onRetry, ref }) {
  return h(
    "div",
    { className: "status-block", "data-tone": "error", role: "alert" },
    h(
      "div",
      null,
      h("h2", null, "This document could not be loaded"),
      h("p", null, error?.message ?? "Neither the content mirror nor GitHub could be reached."),
      h("p", { className: "meta-row" }, h("code", null, path)),
      h(
        "div",
        { className: "status-block-actions" },
        h("a", { href: error?.url ?? docsIndexUrl(ref) }, "Read it on GitHub"),
        h("a", { href: hrefFor("/docs.html") }, "All documentation"),
        h("button", { type: "button", className: "retry", onClick: onRetry }, "Try again"),
      ),
    ),
  );
}

export function DocumentPage({ query }) {
  const path = query.path;
  const { channels } = useChannels();
  const channel = resolveChannel(channels, query.ref);
  const document = useDocument(channel.ref, path);
  const catalog = useCatalog(channel.ref);

  const section = sectionForPath(path);
  const title = document.data?.title || path.split("/").pop()?.replace(/\.md$/i, "") || "Document";

  // Before the query string is read there is no document to show. This is the same state the
  // prerenderer wrote, so the first client render matches it exactly.
  if (!path) {
    return h(
      "div",
      { className: "content" },
      h(
        "div",
        { className: "status-block", role: "status", "aria-live": "polite" },
        h("div", null, h("p", null, "Opening the document…"), h("div", { className: "skeleton" })),
      ),
    );
  }

  // A `path` that is not a documentation file is an error the reader can understand, not a
  // request this site will ever make. It used to leave the loading skeleton on screen forever.
  if (!isDocumentPath(path)) {
    return h(
      "div",
      { className: "content" },
      h(
        "div",
        { className: "status-block", "data-tone": "error", role: "alert" },
        h(
          "div",
          null,
          h("h2", null, "That is not a documentation path"),
          h("p", null, h("code", null, path), " is not a Markdown file under docs/."),
          h(
            "div",
            { className: "status-block-actions" },
            h("a", { href: hrefFor("/docs.html") }, "All documentation"),
            h("a", { href: docsIndexUrl(query.ref) }, "Browse docs on GitHub"),
          ),
        ),
      ),
    );
  }

  return h(
    "div",
    { className: "content" },
    h(
      "div",
      { className: "docs-layout" },
      h(
        "div",
        { className: "docs-main" },
        h(
          "nav",
          { className: "breadcrumbs", "aria-label": "Breadcrumb" },
          h("a", { href: hrefFor("/docs.html") }, "Documentation"),
          h("span", { "aria-hidden": "true" }, "/"),
          h("span", null, sectionTitle(section)),
          h("span", { "aria-hidden": "true" }, "/"),
          h("span", { "aria-current": "page" }, title),
        ),
        h(ChannelBar, { channels, channel }),
        // The document's own heading names the page. It used to be here but visually hidden,
        // which left the reader with a breadcrumb and no title: every documentation page
        // looked like it had started in the middle.
        h("h1", { className: "doc-title" }, title),

        document.status === "loading" ? h(Loading, { path }) : null,
        document.status === "error" && !document.data
          ? h(Failure, { error: document.error, path, onRetry: document.retry, ref: channel.ref })
          : null,

        document.data
          ? h(MarkdownWithToc, {
              markdown: document.data.markdown,
              path: document.data.path,
              ref: channel.ref,
            })
          : null,

        document.error && document.data
          ? h(
              "p",
              { className: "stale-note", role: "alert" },
              "Showing the last loaded copy. The refresh failed: ",
              document.error.message,
            )
          : null,

        document.data
          ? h(
              "p",
              { className: "doc-source" },
              h("span", null, "Source:"),
              h("a", { href: document.data.sourceUrl }, h("code", null, document.data.path)),
              h("span", null, "at"),
              h("code", null, channel.ref),
              h(SourceNote, { source: document.source }),
              h("a", { href: document.data.sourceUrl.replace("/blob/", "/raw/") }, "raw"),
            )
          : null,
      ),
      // Rendered after the article so the document's own heading is the first heading in
      // reading order; CSS places it on the left.
      h(Sidebar, { docs: catalog.data, currentPath: path, channel }),
    ),
  );
}
