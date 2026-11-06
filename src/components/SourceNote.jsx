import { createElement as h } from "react";

// Which backend answered the read, shown next to the source file it came from.
//
// The site prefers the Firestore mirror and falls back to the GitHub API, so two identical
// looking pages can have very different latency and freshness guarantees. Saying which one
// answered is the difference between a page that merely renders and a page that can be
// trusted while the mirror is being reconciled.
//
// The label is presentation only: both paths render the same canonical file, and neither is
// privileged for correctness. `data-source` carries the raw value so tests can assert the
// backend without depending on copy.

const LABELS = {
  firestore: { text: "read from Cloud Firestore", title: "Served from the Firestore content mirror." },
  cache: { text: "read from a cached Firestore response", title: "Served from the Firestore content mirror, cached." },
  github: { text: "read from GitHub", title: "The mirror did not answer, so GitHub was read directly." },
};

/** Renders a provenance label for `source`, or nothing when the source is unknown. */
export function SourceNote({ source }) {
  const label = LABELS[source];
  if (!label) return null;
  return h("span", { className: "badge content-source", "data-source": source, title: label.title }, label.text);
}
