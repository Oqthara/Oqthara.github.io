import { createElement as h } from "react";
import { hrefFor } from "../components/Layout.jsx";
import { ChannelBar } from "../components/ChannelSelect.jsx";
import { CodeBlock } from "../components/Code.js";
import { useChannels, useExample, resolveChannel } from "../use-docs.js";
import { DEFAULT_REF, exampleRoute, treeUrl } from "../source.js";

// One example, read from the repository when it is opened.
//
// Like the documentation route, this is a single static file serving any example, so a new
// `.oq` file needs no site change. Previous and next links come from the discovered list, so
// browsing keeps working as the corpus grows.

const PREVIEW_LINES = 40;

function Failure({ error, path, onRetry, ref }) {
  return h(
    "div",
    { className: "status-block", "data-tone": "error", role: "alert" },
    h(
      "div",
      null,
      h("h2", null, "This example could not be loaded"),
      h("p", null, error?.message ?? "GitHub could not be reached."),
      h("p", { className: "meta-row" }, h("code", null, path)),
      h(
        "div",
        { className: "status-block-actions" },
        h("a", { href: error?.url ?? treeUrl("examples", ref) }, "Read it on GitHub"),
        h("a", { href: hrefFor("/examples.html") }, "All examples"),
        h("button", { type: "button", className: "retry", onClick: onRetry }, "Try again"),
      ),
    ),
  );
}

export function ExamplePage({ query }) {
  const path = query.path;
  const { channels } = useChannels();
  const channel = resolveChannel(channels, query.ref);
  const { status, data, error, retry } = useExample(channel.ref, path);

  if (!path) {
    return h(
      "div",
      { className: "content" },
      h(
        "div",
        { className: "status-block", role: "status", "aria-live": "polite" },
        h("div", null, h("p", null, "Opening the example…"), h("div", { className: "skeleton" })),
      ),
    );
  }

  const name = path.split("/").pop()?.replace(/\.oq$/i, "") ?? "example";
  const withoutComments = (data?.source ?? "")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const lineCount = data ? data.source.replace(/\n$/, "").split("\n").length : 0;

  return h(
    "div",
    { className: "content" },
    h(
      "nav",
      { className: "breadcrumbs", "aria-label": "Breadcrumb" },
      h("a", { href: hrefFor("/examples.html") }, "Examples"),
      h("span", { "aria-hidden": "true" }, "/"),
      h("span", { "aria-current": "page" }, `${name}.oq`),
    ),
    h(
      "section",
      { className: "page-head" },
      h("p", { className: "eyebrow" }, "Example program"),
      h("h1", null, `${name}.oq`),
      h(
        "p",
        { className: "meta-row" },
        h("code", null, path),
        data ? h("span", null, `${lineCount} lines`) : null,
        h("a", { href: exampleRoute(path, channel.ref) }, "permalink"),
      ),
    ),

    h(ChannelBar, { channels, channel, label: "Examples version" }),

    status === "loading"
      ? h(
          "div",
          { className: "status-block", role: "status", "aria-live": "polite" },
          h("div", null, h("p", null, "Reading the source from GitHub…"), h("div", { className: "skeleton" })),
        )
      : null,

    status === "error" && !data ? h(Failure, { error, path, onRetry: retry, ref: channel.ref }) : null,

    data ? h(CodeBlock, { code: data.source, label: `${name}.oq` }) : null,

    data && withoutComments.trim() === "" && lineCount > PREVIEW_LINES
      ? h("p", { className: "meta-row" }, "This program is mostly comments.")
      : null,

    error && data
      ? h("p", { className: "stale-note", role: "alert" }, "Showing the last loaded copy. The refresh failed: ", error.message)
      : null,

    data
      ? h(
          "p",
          { className: "doc-source" },
          h("span", null, "Source:"),
          h("a", { href: data.sourceUrl }, h("code", null, data.path)),
          h("span", null, "at"),
          h("code", null, channel.ref === DEFAULT_REF ? "main" : channel.ref),
          h("a", { href: hrefFor("/examples.html") }, "All examples"),
        )
      : null,
  );
}
