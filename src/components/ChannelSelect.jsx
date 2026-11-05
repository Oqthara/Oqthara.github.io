import { createElement as h } from "react";
import { hrefFor } from "./Layout.jsx";
import { CHANNELS } from "../source.js";

// Documentation channel selector. A release channel is pinned to its tag: choosing it
// changes the git ref used for catalogs and raw files and never follows `main`.

export function ChannelSelect({ ref: current = "main", path = "/docs.html", label = "Documentation version" }) {
  return h(
    "div",
    { className: "channel-select" },
    h("label", { htmlFor: "channel-select", className: "visually-hidden" }, label),
    h(
      "select",
      {
        id: "channel-select",
        value: current,
        onChange: (event) => {
          const next = event.target.value;
          window.location.href = hrefFor(withChannelFor(path, next));
        },
      },
      CHANNELS.map((channel) =>
        h("option", { key: channel.id, value: channel.ref }, channel.label),
      ),
    ),
    current === "main"
      ? null
      : h(
          "p",
          { className: "version-hint" },
          "Pinned to ",
          h("code", null, current),
          ". This channel is a released tag and never follows ",
          h("code", null, "main"),
          ".",
        ),
  );
}

function withChannelFor(path, ref) {
  if (ref === "main") return path;
  return `${path}${path.includes("?") ? "&" : "?"}ref=${encodeURIComponent(ref)}`;
}
