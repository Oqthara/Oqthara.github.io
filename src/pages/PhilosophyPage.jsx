import { createElement as h } from "react";
import { hrefFor } from "../components/Layout.jsx";
import { ChannelBar } from "../components/ChannelSelect.jsx";
import { MarkdownWithToc } from "../components/Markdown.jsx";
import { useChannels, useDocument, resolveChannel } from "../use-docs.js";
import { DEFAULT_REF, blobUrl } from "../source.js";

// Philosophy, read from the language repository's own design document.
//
// The website owns the presentation; the language repository owns the argument. Nothing here
// restates the principles in prose that could drift from `docs/spec/design.md`, and there is
// no second copy of that text in this repository.

const DESIGN_PATH = "docs/spec/design.md";

/** The principles, in the order the introduction on the homepage presents them. */
export const PRINCIPLES = [
  {
    title: "Readability first",
    body: "A program should read like the idea it expresses. Oqthara avoids punctuation that exists only to satisfy a compiler.",
  },
  {
    title: "No ceremony",
    body: "No class wrappers, no mandatory modifiers, no import boilerplate for the common case. The language keeps what carries meaning.",
  },
  {
    title: "Stay on the JVM",
    body: "Java interoperability is a first-class feature, not a bridge bolted on later. Any Java class is reachable from Oqthara.",
  },
  {
    title: "A small surface",
    body: "A language people can hold in their head is worth more than one with an answer for every style.",
  },
  {
    title: "Fast feedback",
    body: "Starting, checking and running a program should be quick enough that experimenting feels free.",
  },
  {
    title: "Errors that explain themselves",
    body: "A diagnostic says what went wrong, where, and what to do next.",
  },
  {
    title: "No accidental complexity",
    body: "If a feature does not remove more complexity than it adds, it does not go in.",
  },
  {
    title: "One semantic contract",
    body: "Interpreted and compiled execution are the same language, and a divergence is a bug, not a backend choice.",
  },
];

function Loading() {
  return h(
    "div",
    { className: "status-block", role: "status", "aria-live": "polite" },
    h("div", null, h("p", null, "Reading the design document from GitHub…"), h("div", { className: "skeleton" })),
  );
}

function Failure({ error, onRetry }) {
  return h(
    "div",
    { className: "status-block", "data-tone": "error", role: "alert" },
    h(
      "div",
      null,
      h("h2", null, "The design document could not be loaded"),
      h("p", null, error?.message ?? "GitHub could not be reached."),
      h(
        "div",
        { className: "status-block-actions" },
        h("a", { href: blobUrl(DESIGN_PATH, DEFAULT_REF) }, "Read the design document on GitHub"),
        h("button", { type: "button", className: "retry", onClick: onRetry }, "Try again"),
      ),
    ),
  );
}

export function PhilosophyPage({ query = {} }) {
  const { channels } = useChannels();
  const channel = resolveChannel(channels, query.ref);
  const { status, data, error, retry } = useDocument(channel.ref, DESIGN_PATH);

  return h(
    "div",
    { className: "content" },
    h(
      "section",
      { className: "page-head" },
      h("p", { className: "eyebrow" }, "Philosophy"),
      h("h1", null, "What Oqthara is trying to be"),
      h(
        "p",
        { className: "lead" },
        "A small language for the JVM that reads like pseudocode. These principles are the ones the project actually holds itself to, and they come from the language repository rather than from a marketing page.",
      ),
    ),

    h(
      "section",
      { className: "section", "aria-labelledby": "principles" },
      h(
        "div",
        { className: "section-head" },
        h("h2", { id: "principles" }, "The principles"),
        h("p", null, "Summarised for orientation. The full argument, including the goals and non-goals, is the design document rendered below."),
      ),
      h(
        "div",
        { className: "principles" },
        PRINCIPLES.map((principle, index) =>
          h(
            "article",
            { className: "principle", key: principle.title },
            h("span", { className: "principle-number" }, String(index + 1).padStart(2, "0")),
            h("h3", null, principle.title),
            h("p", null, principle.body),
          ),
        ),
      ),
    ),

    h("hr", { className: "divider" }),

    h(
      "section",
      { className: "section", "aria-labelledby": "design-document" },
      h(
        "div",
        { className: "section-head" },
        h("h2", { id: "design-document" }, "The design document"),
        h(
          "p",
          null,
          "Read from ",
          h("code", null, DESIGN_PATH),
          " in Oqthara/oqthara at the selected channel. This is the canonical statement of what the language is for.",
        ),
      ),
      h(ChannelBar, { channels, channel, label: "Design document version" }),

      status === "loading" ? h(Loading) : null,
      status === "error" && !data ? h(Failure, { error, onRetry: retry }) : null,

      data
        ? h(
            "div",
            { className: "doc-with-toc" },
            h(
              "div",
              { className: "doc-article" },
              h(MarkdownWithToc, { markdown: data.markdown, path: DESIGN_PATH, ref: channel.ref }),
            ),
          )
        : null,

      status === "ready" && error
        ? h("p", { className: "stale-note", role: "status" }, "Showing the last loaded copy. The refresh failed: ", error.message)
        : null,

      data
        ? h(
            "p",
            { className: "doc-source" },
            h("span", null, "Source:"),
            h("a", { href: data.sourceUrl }, h("code", null, DESIGN_PATH)),
            h("span", null, "at"),
            h("code", null, channel.ref),
            h("a", { href: hrefFor("/docs.html") }, "All documentation"),
          )
        : null,
    ),
  );
}
