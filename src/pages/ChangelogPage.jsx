import { createElement as h } from "react";
import { hrefFor } from "../components/Layout.jsx";
import { ChannelBar } from "../components/ChannelSelect.jsx";
import { MarkdownWithToc } from "../components/Markdown.jsx";
import { useChangelog, useChannels, resolveChannel } from "../use-docs.js";
import { CHANGELOG_PATH } from "../source.js";

// The changelog, read from the repository root when the page opens.
//
// There is no snapshot in this repository, so a merged release entry appears here without a
// site change, and a release channel shows the changelog exactly as it was tagged.

function Failure({ error, onRetry, ref }) {
  return h(
    "div",
    { className: "status-block", "data-tone": "error", role: "alert" },
    h(
      "div",
      null,
      h("h2", null, "The changelog could not be loaded"),
      h("p", null, error?.message ?? "GitHub could not be reached."),
      h(
        "div",
        { className: "status-block-actions" },
        h("a", { href: error?.url ?? `https://github.com/Oqthara/oqthara/blob/${ref}/${CHANGELOG_PATH}` }, "Read CHANGELOG.md on GitHub"),
        h("button", { type: "button", className: "retry", onClick: onRetry }, "Try again"),
      ),
    ),
  );
}

export function ChangelogPage({ query = {} }) {
  const { channels } = useChannels();
  const channel = resolveChannel(channels, query.ref);
  const { status, data, error, retry } = useChangelog(channel.ref);

  return h(
    "div",
    { className: "content" },
    h(
      "section",
      { className: "page-head" },
      h("p", { className: "eyebrow" }, "Project history"),
      h("h1", null, "Changelog"),
      h("p", { className: "lead" }, "Every notable change, read from the repository changelog at the selected channel."),
    ),

    h(ChannelBar, { channels, channel, label: "Changelog version" }),

    status === "loading"
      ? h(
          "div",
          { className: "status-block", role: "status", "aria-live": "polite" },
          h("div", null, h("p", null, "Reading the changelog from GitHub…"), h("div", { className: "skeleton" })),
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
            h(MarkdownWithToc, { markdown: data, path: CHANGELOG_PATH, ref: channel.ref }),
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
          h("a", { href: `https://github.com/Oqthara/oqthara/blob/${channel.ref}/${CHANGELOG_PATH}` }, h("code", null, CHANGELOG_PATH)),
          h("span", null, "at"),
          h("code", null, channel.ref),
          h("a", { href: hrefFor("/status.html") }, "Status"),
        )
      : null,
  );
}
