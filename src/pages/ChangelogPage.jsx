import { createElement as h } from "react";
import { hrefFor } from "../components/Layout.jsx";
import { CHANGELOG_SOURCE } from "../changelog.js";

// The changelog is rendered from a checked-in snapshot of the language repository's
// CHANGELOG.md. A future stage fetches it from GitHub at runtime; for now CI refreshes the
// snapshot, and the page says so rather than presenting it as live data.
//
// The Markdown already supplies the page's h1 ("Changelog"), so this component adds no
// second heading of its own.

export function ChangelogPage({ changes }) {
  return h(
    "div",
    null,
    h("p", { className: "eyebrow" }, "Project history"),
    h(
      "p",
      { className: "note" },
      "Snapshot: this page is rendered from a checked-in copy of ",
      h(
        "a",
        { href: "https://github.com/Oqthara/oqthara/blob/main/CHANGELOG.md" },
        "CHANGELOG.md",
      ),
      " in Oqthara/oqthara, refreshed by the website build. Newer entries may not appear here yet; the repository file is authoritative.",
    ),
    changes?.html
      ? h("article", {
          className: "doc",
          dangerouslySetInnerHTML: { __html: changes.html },
        })
      : h("p", null, "The changelog snapshot is missing."),
    h(
      "p",
      { className: "doc-source" },
      "Snapshot: ",
      h("code", null, CHANGELOG_SOURCE),
      " · ",
      h("a", { href: hrefFor("/status.html") }, "Status"),
      " · ",
      h("a", { href: "https://github.com/Oqthara/oqthara/releases" }, "Releases"),
    ),
  );
}
