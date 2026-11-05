import { createElement as h } from "react";
import { hrefFor } from "../components/Layout.jsx";
import { ChannelBar } from "../components/ChannelSelect.jsx";
import { MarkdownWithToc } from "../components/Markdown.jsx";
import { useChannels, useDocument, resolveChannel } from "../use-docs.js";

// The standard library reference, read from the generated document in the repository.
//
// `oq doc` produces `docs/stdlib/reference.md` and the language repository's CI fails when it
// is out of date, so this page cannot advertise a function that does not exist. The site adds
// presentation only.

const STDLIB_PATH = "docs/stdlib/reference.md";

function Failure({ error, onRetry, ref }) {
  return h(
    "div",
    { className: "status-block", "data-tone": "error", role: "alert" },
    h(
      "div",
      null,
      h("h2", null, "The standard library reference could not be loaded"),
      h("p", null, error?.message ?? "GitHub could not be reached."),
      h(
        "div",
        { className: "status-block-actions" },
        h("a", { href: error?.url ?? `https://github.com/Oqthara/oqthara/blob/${ref}/${STDLIB_PATH}` }, "Read it on GitHub"),
        h("button", { type: "button", className: "retry", onClick: onRetry }, "Try again"),
      ),
    ),
  );
}

export function StdlibPage({ query = {} }) {
  const { channels } = useChannels();
  const channel = resolveChannel(channels, query.ref);
  const { status, data, error, retry } = useDocument(channel.ref, STDLIB_PATH);

  return h(
    "div",
    { className: "content" },
    h(
      "section",
      { className: "page-head" },
      h("p", { className: "eyebrow" }, "Standard library"),
      h("h1", null, "Standard library"),
      h(
        "p",
        { className: "lead" },
        "Generated from the implementation by oq doc and read from the repository when you open this page. If a function is listed here, it exists; the language repository fails its build when this reference is out of date.",
      ),
    ),

    h(ChannelBar, { channels, channel, label: "Reference version" }),

    status === "loading"
      ? h(
          "div",
          { className: "status-block", role: "status", "aria-live": "polite" },
          h("div", null, h("p", null, "Reading the generated reference from GitHub…"), h("div", { className: "skeleton" })),
        )
      : null,

    status === "error" && !data ? h(Failure, { error, onRetry: retry, ref: channel.ref }) : null,

    data
      ? h(
          "div",
          { className: "doc-with-toc" },
          h(
            "div",
            { className: "doc-article" },
            h(MarkdownWithToc, { markdown: data.markdown, path: STDLIB_PATH, ref: channel.ref }),
          ),
        )
      : null,

    error && data
      ? h("p", { className: "stale-note", role: "alert" }, "Showing the last loaded copy. The refresh failed: ", error.message)
      : null,

    data
      ? h(
          "p",
          { className: "doc-source" },
          h("span", null, "Source:"),
          h("a", { href: data.sourceUrl }, h("code", null, STDLIB_PATH)),
          h("span", null, "at"),
          h("code", null, channel.ref),
          h("a", { href: hrefFor("/docs.html") }, "All documentation"),
        )
      : null,
  );
}
