import { createElement as h } from "react";
import { DEFAULT_REF } from "../source.js";

// Documentation channel selector.
//
// Channels come from the GitHub releases API at runtime, so a new release appears here with
// no website change. The selected `ref` is the git tag that actually exists, and it is written
// into the URL so a link to a released manual keeps pointing at that release.

/** Rebuilds the current URL with a different ref, preserving every other parameter. */
export function withRef(href, ref) {
  const url = new URL(href, "https://oqthara.github.io");
  if (!ref || ref === DEFAULT_REF) url.searchParams.delete("ref");
  else url.searchParams.set("ref", ref);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function ChannelSelect({ channels = [], channel, label = "Documentation version" }) {
  if (!channels.length) {
    // Never render an empty select: say what is happening instead.
    return h(
      "p",
      { className: "channel-note" },
      "Release list unavailable. Showing the development documentation.",
    );
  }

  const current = channel?.ref ?? DEFAULT_REF;

  return h(
    "div",
    { className: "field" },
    h("label", { htmlFor: "channel-select" }, label),
    h(
      "select",
      {
        id: "channel-select",
        value: current,
        onChange: (event) => {
          window.location.href = withRef(window.location.href, event.target.value);
        },
      },
      channels.map((entry) =>
        h(
          "option",
          { key: entry.ref, value: entry.ref },
          entry.dev ? entry.label : `${entry.label}${entry.prerelease ? " (prerelease)" : ""}`,
        ),
      ),
    ),
  );
}

/** The whole band above a documentation page: selector plus what the selection means. */
export function ChannelBar({ channels, channel, label }) {
  return h(
    "div",
    { className: "channel-bar" },
    h(ChannelSelect, { channels, channel, label }),
    h(
      "p",
      { className: "channel-note" },
      channel?.dev || !channel?.ref || channel.ref === DEFAULT_REF
        ? "Following the main branch: documentation changes appear here after they are merged."
        : h(
            "span",
            null,
            "Pinned to ",
            h("code", null, channel.ref),
            ". This manual never follows ",
            h("code", null, "main"),
            ".",
          ),
    ),
  );
}
