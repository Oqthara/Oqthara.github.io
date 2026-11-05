import { createElement as h } from "react";
import { hrefFor } from "../components/Layout.jsx";
import { ChannelSelect } from "../components/ChannelSelect.jsx";
import { MarkdownWithToc } from "../components/Markdown.jsx";
import { DOC_INDEX_URL, channelById } from "../source.js";
import { useDocument } from "../use-docs.js";

// One documentation page, fetched from GitHub when it is opened.
//
// The route is the source path: `/docs/spec/language.html` renders `docs/spec/language.md`.
// Relative links inside the Markdown are resolved against that path, so a link written for
// GitHub lands on the same document here.

function Loading({ path }) {
  return h(
    "div",
    { className: "doc-status", role: "status", "aria-live": "polite" },
    h("p", null, "Fetching ", h("code", null, path), " from GitHub…"),
    h("div", { className: "skeleton", "aria-hidden": "true" }),
  );
}

function Failure({ error, path, onRetry }) {
  return h(
    "div",
    { className: "doc-status doc-status-error", role: "alert" },
    h("h2", null, "This page could not be loaded"),
    h("p", null, error?.message ?? "GitHub could not be reached."),
    h(
      "p",
      null,
      h(
        "a",
        { href: error?.url ?? DOC_INDEX_URL },
        "Read the original on GitHub",
      ),
      " · ",
      h("a", { href: hrefFor("/docs.html") }, "All documentation"),
    ),
    h(
      "p",
      null,
      h("button", { type: "button", className: "retry", onClick: onRetry }, "Try again"),
    ),
  );
}

export function DocPage({ path, query = {} }) {
  const channel = channelById(query.ref);
  const { status, data, error, retry } = useDocument(channel.ref, path);

  return h(
    "div",
    null,
    h(
      "p",
      { className: "eyebrow" },
      h("a", { href: hrefFor("/docs.html") }, "Documentation"),
    ),
    h(ChannelSelect, { ref: channel.ref, path: `/docs/${path.replace(/^docs\//, "").replace(/\.md$/, ".html")}` }),

    status === "error" && !data
      ? h(Failure, { error, path, onRetry: retry })
      : null,
    status === "loading" && !data ? h(Loading, { path }) : null,

    data
      ? h(
          "div",
          null,
          h(MarkdownWithToc, {
            markdown: data.markdown,
            path: data.path,
            ref: channel.ref,
          }),
          h(
            "p",
            { className: "doc-source" },
            "Rendered from ",
            h("a", { href: data.sourceUrl }, h("code", null, data.path)),
            " at ",
            h("code", null, channel.ref),
            " · ",
            h("a", { href: hrefFor("/docs.html") }, "All documentation"),
          ),
        )
      : null,

    // A stale value can still be on screen when a refresh fails; say so instead of
    // pretending the content is current.
    status === "error" && data
      ? h(
          "p",
          { className: "doc-status-warning", role: "status" },
          "This copy may be out of date: ",
          error?.message ?? "the refresh failed.",
          " ",
          h("a", { href: data.sourceUrl }, "Check the current version on GitHub"),
          ".",
        )
      : null,
  );
}
