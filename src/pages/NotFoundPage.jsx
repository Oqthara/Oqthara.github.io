import { createElement as h } from "react";
import { hrefFor, PageHead } from "../components/Layout.jsx";
import { DOC_INDEX_URL } from "../source.js";

// A real 404 page. An unknown documentation path must say so instead of quietly rendering
// the home page, which would make a broken link look like a working one.

export function NotFoundPage({ path }) {
  return h(
    "div",
    null,
    h(PageHead, {
      eyebrow: "Not found",
      title: "That page does not exist",
      lead: `There is no page at ${path ?? "this address"}.`,
    }),
    h(
      "p",
      null,
      "If you followed a link into the documentation, the document may have been renamed. ",
      h("a", { href: hrefFor("/docs.html") }, "Browse the documentation index"),
      " or read the source on ",
      h("a", { href: DOC_INDEX_URL }, "GitHub"),
      ".",
    ),
  );
}
