import { createElement as h } from "react";
import { hrefFor } from "../components/Layout.jsx";
import { ChannelSelect } from "../components/ChannelSelect.jsx";
import { Markdown } from "../components/Markdown.jsx";
import { channelById } from "../source.js";
import { useText } from "../use-docs.js";

// The changelog page renders CHANGELOG.md from the language repository at request time.
//
// There is no checked-in copy: a release entry appears here as soon as it is merged, and a
// release channel shows the changelog exactly as it was tagged.

const CHANGELOG_PATH = "CHANGELOG.md";

export function ChangelogPage({ query = {} }) {
  const channel = channelById(query.ref);
  const { status, data, error, retry } = useText(channel.ref, CHANGELOG_PATH);

  return h(
    "div",
    null,
    h("p", { className: "eyebrow" }, "Project history"),
    h(ChannelSelect, { ref: channel.ref, path: "/changelog.html" }),

    status === "loading" && !data
      ? h(
          "div",
          { className: "doc-status", role: "status", "aria-live": "polite" },
          h("p", null, "Fetching the changelog from GitHub…"),
          h("div", { className: "skeleton", "aria-hidden": "true" }),
        )
      : null,

    status === "error" && !data
      ? h(
          "div",
          { className: "doc-status doc-status-error", role: "alert" },
          h("h2", null, "The changelog could not be loaded"),
          h("p", null, error?.message ?? "GitHub could not be reached."),
          h(
            "p",
            null,
            h(
              "a",
              {
                href:
                  error?.url ??
                  "https://github.com/Oqthara/oqthara/blob/main/CHANGELOG.md",
              },
              "Read CHANGELOG.md on GitHub",
            ),
            " · ",
            h("button", { type: "button", className: "retry", onClick: retry }, "Try again"),
          ),
        )
      : null,

    data
      ? h(
          "div",
          null,
          h(Markdown, { markdown: data, path: CHANGELOG_PATH, ref: channel.ref }),
          h(
            "p",
            { className: "doc-source" },
            "Rendered from ",
            h(
              "a",
              {
                href: `https://github.com/Oqthara/oqthara/blob/${channel.ref}/${CHANGELOG_PATH}`,
              },
              h("code", null, CHANGELOG_PATH),
            ),
            " at ",
            h("code", null, channel.ref),
            " · ",
            h("a", { href: hrefFor("/status.html") }, "Status"),
          ),
        )
      : null,
  );
}
