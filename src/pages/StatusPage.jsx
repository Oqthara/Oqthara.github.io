import { createElement as h } from "react";
import { hrefFor } from "../components/Layout.jsx";
import { ChannelBar } from "../components/ChannelSelect.jsx";
import { SourceNote } from "../components/SourceNote.jsx";
import { Markdown } from "../components/Markdown.jsx";
import { useChannels, useDocument, resolveChannel } from "../use-docs.js";
import { DEFAULT_REF } from "../source.js";

// Status, read from the canonical backend document.
//
// The previous page hard-coded capability claims ("does not support X yet") which drifted from
// the implementation the moment the compiler changed. Anything the site states about the backend
// is now the repository's own documented boundary, rendered from its source of truth.

const BACKEND_PATH = "docs/spec/backend.md";

function Failure({ error, onRetry, ref }) {
  return h(
    "div",
    { className: "status-block", "data-tone": "error", role: "alert" },
    h(
      "div",
      null,
      h("h2", null, "The status document could not be loaded"),
      h("p", null, error?.message ?? "Neither the content mirror nor GitHub could be reached."),
      h(
        "div",
        { className: "status-block-actions" },
        h("a", { href: error?.url ?? `https://github.com/Oqthara/oqthara/blob/${ref}/${BACKEND_PATH}` }, "Read it on GitHub"),
        h("button", { type: "button", className: "retry", onClick: onRetry }, "Try again"),
      ),
    ),
  );
}

export function StatusPage({ query = {} }) {
  const { channels } = useChannels();
  const channel = resolveChannel(channels, query.ref);
  const { status, data, source, error, retry } = useDocument(channel.ref, BACKEND_PATH);

  return h(
    "div",
    { className: "content content-narrow" },
    h(
      "section",
      { className: "page-head" },
      h("p", { className: "eyebrow" }, "Status"),
      h("h1", null, "What works, stated plainly"),
      h(
        "p",
        { className: "lead" },
        "This page does not keep its own list of capabilities. It renders the backend document from the repository, which is the boundary the compiler is tested against.",
      ),
    ),

    h(ChannelBar, { channels, channel, label: "Status version" }),

    status === "loading"
      ? h(
          "div",
          { className: "status-block", role: "status", "aria-live": "polite" },
          h("div", null, h("p", null, "Reading the backend document…"), h("div", { className: "skeleton" })),
        )
      : null,

    status === "error" && !data ? h(Failure, { error, onRetry: retry, ref: channel.ref }) : null,

    data ? h(Markdown, { markdown: data.markdown, path: BACKEND_PATH, ref: channel.ref }) : null,

    error && data
      ? h("p", { className: "stale-note", role: "alert" }, "Showing the last loaded copy. The refresh failed: ", error.message)
      : null,

    data
      ? h(
          "p",
          { className: "doc-source" },
          h("span", null, "Source:"),
          h("a", { href: data.sourceUrl }, h("code", null, BACKEND_PATH)),
          h("span", null, "at"),
          h("code", null, channel.ref),
          h(SourceNote, { source }),
          h("a", { href: hrefFor("/docs.html") }, "All documentation"),
        )
      : null,
  );
}
