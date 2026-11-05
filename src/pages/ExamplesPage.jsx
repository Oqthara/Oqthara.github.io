import { createElement as h } from "react";
import { hrefFor, PageHead } from "../components/Layout.jsx";
import { ChannelBar } from "../components/ChannelSelect.jsx";
import { useChannels, useExamples, resolveChannel } from "../use-docs.js";
import { DEFAULT_REF, treeUrl } from "../source.js";

// Examples, discovered from the repository.
//
// The list is every `.oq` file under `examples/` at the selected ref, grouped by its first
// directory. There is no hand-written array and no count: adding a program to the repository
// adds it here. Opening a card goes to `/example.html`, which reads the source on demand.

function Failure({ error, onRetry, ref }) {
  return h(
    "div",
    { className: "status-block", "data-tone": "error", role: "alert" },
    h(
      "div",
      null,
      h("h2", null, "Could not load the examples"),
      h("p", null, error?.message ?? "GitHub could not be reached."),
      h(
        "div",
        { className: "status-block-actions" },
        h("a", { href: treeUrl("examples", ref) }, "Browse examples on GitHub"),
        h("button", { type: "button", className: "retry", onClick: onRetry }, "Try again"),
      ),
    ),
  );
}

/** Groups examples by their repository directory. */
export function groupExamples(examples) {
  const groups = new Map();
  for (const example of examples) {
    const key = example.category || "Examples";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(example);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function ExamplesPage({ query = {} }) {
  const { channels } = useChannels();
  const channel = resolveChannel(channels, query.ref);
  const { status, data, error, retry } = useExamples(channel.ref);
  const groups = data ? groupExamples(data) : [];

  return h(
    "div",
    { className: "content" },
    h(PageHead, {
      eyebrow: "Examples",
      title: "Examples",
      lead: "Every program in the Oqthara examples directory, discovered from the repository when you open this page. Open any of them to read the full source.",
    }),

    h(ChannelBar, { channels, channel, label: "Examples version" }),

    status === "loading"
      ? h(
          "div",
          { className: "status-block", role: "status", "aria-live": "polite" },
          h("div", null, h("p", null, "Discovering examples from GitHub…"), h("div", { className: "skeleton" })),
        )
      : null,

    status === "error" && !data ? h(Failure, { error, onRetry: retry, ref: channel.ref }) : null,

    data
      ? h(
          "div",
          null,
          groups.map(([category, entries]) =>
            h(
              "section",
              { className: "section-group", key: category },
              h("h2", null, category, h("span", { className: "count" }, entries.length)),
              h(
                "div",
                { className: "example-grid" },
                entries.map((example) =>
                  h(
                    "a",
                    { className: "example-card", href: example.route, key: example.path },
                    h("strong", null, `${example.name}.oq`),
                    h("span", null, example.path),
                  ),
                ),
              ),
            ),
          ),
        )
      : null,

    data && data.length === 0
      ? h("div", { className: "empty-state" }, h("p", null, "The repository has no .oq files under examples at this ref."))
      : null,

    error && data
      ? h("p", { className: "stale-note", role: "alert" }, "Showing the last result. The refresh failed: ", error.message)
      : null,

    h(
      "p",
      { className: "meta-row", style: { marginTop: "var(--space-6)" } },
      h("a", { href: hrefFor("/docs.html") }, "Documentation"),
      h("a", { href: hrefFor("/tour.html") }, "Guided tour"),
      h("a", { href: treeUrl("examples", channel.ref === DEFAULT_REF ? "main" : channel.ref) }, "Browse on GitHub"),
    ),
  );
}
