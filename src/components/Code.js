import { createElement as h, useCallback, useEffect, useRef, useState } from "react";
import { highlightToReact } from "../lib/highlight.js";

// A code block with a copy control.
//
// Two callers exist and they hand over different shapes:
//
//   * Markdown fenced blocks arrive already highlighted by `rehype-prism-plus`, which wraps the
//     source in a `pre > code` tree. `highlighted` is that `code` element, kept as React
//     children. Wrapping it again produced `pre > code > code`, and the inner element then
//     matched the inline-code rule and was painted as a white pill on the dark surface.
//   * Hand-written samples (homepage, tour, example pages) arrive as plain text and are
//     highlighted here, so they use the same grammars and colours as the documentation.
//
// The label is optional and is not part of the copied text. The button announces the result
// politely, so a screen reader hears "Copied" instead of nothing happening.

export function CodeBlock({ code, label, language, children, highlighted, className }) {
  const text = String(code ?? children ?? "");
  // `label` is what the reader sees; `language` is the grammar to apply. They are separate
  // props because a label is prose ("macOS and Linux") and a grammar name is an identifier.
  // Conflating them produced class="language-macOS and Linux".
  const grammar = language ?? null;
  const [state, setState] = useState("idle");
  const timer = useRef(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for browsers or contexts without the async clipboard API.
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      setState("copied");
    } catch {
      setState("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }, [text]);

  // Highlighting the already-highlighted tree would double the work; only plain text is
  // tokenised here. Without an explicit grammar the language is inferred from the content,
  // which is what makes an untagged install command render as shell.
  const rendered = highlighted ?? highlightToReact(text, grammar);
  const shown = label ?? grammar ?? "code";

  return h(
    "div",
    { className: className ? `code-block ${className}` : "code-block" },
    h(
      "div",
      { className: "code-label" },
      h("span", null, shown),
      h(
        "button",
        {
          type: "button",
          className: "copy-button",
          onClick: copy,
          "data-copied": state === "copied" ? "true" : "false",
          "aria-label": shown ? `Copy ${shown}` : "Copy code",
        },
        state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy",
      ),
    ),
    // `highlighted` is already the `code` element for Markdown blocks. For plain text the
    // tokens are inline spans, so this branch supplies the wrapping `code` itself.
    // The block scrolls when a line is wider than the column, so it takes a tab stop: without
    // one the overflowed text is unreachable by keyboard (WCAG 2.2 AA). Only the block that
    // actually overflows needs it, but that is a layout question, not a render-time one, so it
    // is always focusable rather than focusable-when-overflowing.
    h(
      "pre",
      { tabIndex: 0 },
      highlighted
        ? rendered
        : h("code", { className: grammar ? `language-${grammar}` : undefined }, rendered ?? text),
    ),
    // The live region is separate from the button label so the button does not change width
    // mid-interaction, which would move the pointer target.
    h(
      "span",
      { className: "visually-hidden", role: "status", "aria-live": "polite" },
      state === "copied" ? "Copied to clipboard" : state === "failed" ? "Copy failed" : "",
    ),
  );
}

/** Plain code without a header, for inline examples inside prose. */
export function Code({ children, language }) {
  const text = String(children ?? "");
  const tokens = highlightToReact(text, language);
  return h(
    "div",
    { className: "code-block" },
    h("pre", { tabIndex: 0 }, h("code", { className: language ? `language-${language}` : undefined }, tokens ?? text)),
  );
}

/** The inline launch command shown on the homepage and documentation. */
export const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/Oqthara/oqthara/main/scripts/install.sh | bash";
export const INSTALL_COMMAND_WINDOWS = "irm https://raw.githubusercontent.com/Oqthara/oqthara/main/scripts/install.ps1 | iex";
