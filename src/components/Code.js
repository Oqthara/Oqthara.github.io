import { createElement as h, useCallback, useEffect, useRef, useState } from "react";

// A code block with a copy control.
//
// The label is optional and is not part of the text that gets copied. The button announces
// the result politely, so a screen reader hears "Copied" instead of nothing happening.

export function CodeBlock({ code, label, children, className }) {
  const text = String(code ?? children ?? "");
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

  return h(
    "div",
    { className: className ? `code-block ${className}` : "code-block" },
    h(
      "div",
      { className: "code-label" },
      h("span", null, label ?? "code"),
      h(
        "button",
        {
          type: "button",
          className: "copy-button",
          onClick: copy,
          "data-copied": state === "copied" ? "true" : "false",
          "aria-label": label ? `Copy ${label}` : "Copy code",
        },
        state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy",
      ),
    ),
    h("pre", null, h("code", null, text)),
    // The live region is separate from the button label so the button does not change width
    // mid-interaction, which would move the pointer target.
    h("span", { className: "visually-hidden", role: "status", "aria-live": "polite" },
      state === "copied" ? "Copied to clipboard" : state === "failed" ? "Copy failed" : ""),
  );
}

/** Plain code without a header, for inline examples inside prose. */
export function Code({ children }) {
  return h("div", { className: "code-block" }, h("pre", null, h("code", null, String(children ?? ""))));
}

/** The inline launch command shown on the homepage and documentation. */
export const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/Oqthara/oqthara/main/scripts/install.sh | bash";
export const INSTALL_COMMAND_WINDOWS = "irm https://raw.githubusercontent.com/Oqthara/oqthara/main/scripts/install.ps1 | iex";
