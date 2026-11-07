import { createElement as h } from "react";
import { commitUrl, shortCommit } from "../repositories/catalog.repository.js";

// Which revision of the canonical repository the mirrored content came from.
//
// The site mirrors `main`, which is a moving branch, so "current documentation" would otherwise
// mean nothing precise: the same page can describe a different revision an hour later. The sync
// script records the commit it reconciled, and this states it. It is deliberately not a claim
// about freshness - only about provenance - so a mirror that has never been reconciled, or whose
// catalogue could not be read, says so instead of showing a commit it cannot prove.
//
// `data-commit` carries the raw value for tests; the visible text is shortened for reading.

/** Renders the commit the mirror was last reconciled from, or an honest absence. */
export function MirrorProvenance({ catalog, status = "ready" }) {
  if (status === "loading") {
    return h("span", { className: "provenance", "data-commit": "" }, "Checking the mirror's commit…");
  }

  const commit = shortCommit(catalog?.sourceCommit);
  if (!commit) {
    return h(
      "span",
      {
        className: "provenance",
        "data-commit": "",
        title: "The mirror has not recorded which commit it was reconciled from.",
      },
      "Mirror revision not recorded",
    );
  }

  const href = commitUrl(catalog.sourceCommit);
  return h(
    "span",
    { className: "provenance", "data-commit": catalog.sourceCommit },
    "Mirrored from ",
    h("code", null, catalog.sourceRef || "main"),
    " at ",
    href
      ? h("a", { href, rel: "noreferrer" }, h("code", null, commit))
      : h("code", null, commit),
  );
}
