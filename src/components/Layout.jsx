import { createElement as h, useEffect, useState } from "react";
import { BASE_PATH, NAV } from "../data/meta.js";
import { Search } from "./Search.jsx";

/**
 * Site links are written root-relative so the routes read clearly. The site is served from the
 * domain root, so the base is `/`; keeping the join in one place means a future move to a
 * subpath is a single change.
 */
export function hrefFor(path) {
  if (path === "/") return BASE_PATH;
  return BASE_PATH.replace(/\/$/, "") + path;
}

function storedTheme() {
  if (typeof window === "undefined") return "auto";
  try {
    const stored = window.localStorage.getItem("oq-theme");
    return stored === "light" || stored === "dark" ? stored : "auto";
  } catch {
    // Private browsing can throw on localStorage access; the OS preference still works.
    return "auto";
  }
}

function applyTheme(theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/**
 * Light / dark / system appearance. The choice survives a reload.
 *
 * The first render must be "auto" because the prerendered HTML says "auto": the server cannot
 * read localStorage, so starting from the stored value produced a React #418 text mismatch on
 * every page for anyone who had ever chosen an appearance. The stored value is adopted in the
 * effect below, after hydration, which is also when it is applied.
 */
function ThemeToggle() {
  const [theme, setTheme] = useState("auto");

  useEffect(() => {
    const stored = storedTheme();
    if (stored !== "auto") {
      setTheme(stored);
      applyTheme(stored);
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);
    try {
      if (theme === "auto") window.localStorage.removeItem("oq-theme");
      else window.localStorage.setItem("oq-theme", theme);
    } catch {
      // Persisting is a convenience, not a requirement.
    }
  }, [theme]);

  const next = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
  const label =
    theme === "auto" ? "Appearance: follow system" : theme === "light" ? "Appearance: light" : "Appearance: dark";

  return h(
    "button",
    {
      type: "button",
      className: "icon-button",
      onClick: () => setTheme(next),
      title: `${label}. Switch to ${next}.`,
      "aria-label": `${label}. Switch appearance.`,
      "data-theme-state": theme,
    },
    theme === "dark" ? "◑" : theme === "light" ? "◐" : "◒",
  );
}

/** Shared page chrome: skip link, header, navigation, main landmark and footer. */
export function Layout({ current, children }) {
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile menu on navigation and on Escape, so it never traps the reader.
  useEffect(() => {
    setMenuOpen(false);
  }, [current]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return h(
    "div",
    { className: "site-root" },
    h("a", { className: "skip-link", href: "#main" }, "Skip to content"),
    h(
      "header",
      { className: "site-header" },
      h(
        "div",
        { className: "content site-header-inner" },
        h(
          "a",
          { className: "brand", href: hrefFor("/"), "aria-label": "Oqthara home" },
          h("span", { className: "brand-mark" }, "oq"),
          "thara",
          h("span", { className: "brand-tag" }, "a small language for the JVM"),
        ),
        h(
          "nav",
          {
            className: "site-nav",
            "aria-label": "Main",
            id: "site-nav",
            "data-open": menuOpen ? "true" : "false",
          },
          NAV.map((item) =>
            h(
              "a",
              {
                key: item.href,
                href: hrefFor(item.href),
                "aria-current": item.href === current ? "page" : undefined,
              },
              item.label,
            ),
          ),
        ),
        h(
          "div",
          { className: "header-actions" },
          h(Search, null),
          h(ThemeToggle, null),
          h(
            "button",
            {
              type: "button",
              className: "icon-button nav-toggle",
              onClick: () => setMenuOpen((open) => !open),
              "aria-expanded": menuOpen ? "true" : "false",
              "aria-controls": "site-nav",
              "aria-label": menuOpen ? "Close navigation" : "Open navigation",
            },
            menuOpen ? "✕" : "☰",
          ),
        ),
      ),
    ),
    h("main", { id: "main" }, children),
    h(
      "footer",
      { className: "site-footer" },
      h(
        "div",
        { className: "content site-footer-inner" },
        h("span", null, "Oqthara · MIT · built on the JVM"),
        h(
          "span",
          { className: "footer-links" },
          h("a", { href: hrefFor("/philosophy.html") }, "Philosophy"),
          h("a", { href: hrefFor("/docs.html") }, "Documentation"),
          h("a", { href: "https://github.com/Oqthara/oqthara" }, "GitHub"),
          h("a", { href: "https://github.com/Oqthara/oqthara/releases" }, "Releases"),
        ),
      ),
    ),
  );
}

/** Consistent page header: eyebrow, headline and lead paragraph. */
export function PageHead({ eyebrow, title, lead, children }) {
  return h(
    "section",
    { className: "page-head" },
    eyebrow ? h("p", { className: "eyebrow" }, eyebrow) : null,
    h("h1", null, title),
    lead ? h("p", { className: "lead" }, lead) : null,
    children,
  );
}

/** A bordered remark that supports a claim rather than decorating the page. */
export function Note({ children }) {
  return h("div", { className: "note" }, children);
}

/** A card. `href` makes the whole card a link. */
export function Card({ title, kicker, href, children }) {
  const body = [
    kicker ? h("p", { className: "card-kicker", key: "k" }, kicker) : null,
    h("h3", { key: "t" }, title),
    children ? h("p", { key: "c" }, children) : null,
  ];
  return href ? h("a", { className: "card", href }, body) : h("div", { className: "card" }, body);
}

export function Grid({ children, two = false }) {
  return h("div", { className: two ? "grid grid-2" : "grid" }, children);
}

/** A responsive data table. Wide content scrolls instead of breaking the layout. */
export function Table({ head, rows }) {
  return h(
    "div",
    { className: "table-wrap" },
    h(
      "table",
      null,
      h("thead", null, h("tr", null, head.map((cell, index) => h("th", { key: index, scope: "col" }, cell)))),
      h(
        "tbody",
        null,
        rows.map((row, rowIndex) =>
          h(
            "tr",
            { key: rowIndex },
            row.map((cell, cellIndex) => h("td", { key: cellIndex }, cell)),
          ),
        ),
      ),
    ),
  );
}
