import { createElement as h } from "react";
import { hrefFor, Grid, Card } from "../components/Layout.jsx";

// A real 404 page.
//
// An unknown path says so instead of quietly rendering the homepage, and it offers the obvious
// ways out. `prerender.mjs` writes this same component to 404.html, and for a legacy
// `/docs/**.html` address that file redirects to the canonical document route, so a valid
// documentation link never lands here.

export function NotFoundPage({ path }) {
  return h(
    "div",
    { className: "content content-narrow" },
    h(
      "section",
      { className: "page-head" },
      h("p", { className: "eyebrow" }, "Not found"),
      h("h1", null, "That page does not exist"),
      h(
        "p",
        { className: "lead" },
        path
          ? h("span", null, "There is no page at ", h("code", null, path), ".")
          : "There is no page at this address.",
      ),
      h(
        "p",
        null,
        "If you followed a link into the documentation, the document may have moved. Everything the site publishes is discovered from the repository, so the index is the reliable place to look.",
      ),
    ),
    h(
      Grid,
      null,
      h(Card, { title: "Documentation", kicker: "Look here", href: hrefFor("/docs.html") },
        "Every document in the repository, grouped by directory."),
      h(Card, { title: "Examples", kicker: "Programs", href: hrefFor("/examples.html") },
        "Complete, runnable programs discovered from the examples directory."),
      h(Card, { title: "Home", kicker: "Start over", href: hrefFor("/") },
        "What Oqthara is and where to begin."),
    ),
  );
}
