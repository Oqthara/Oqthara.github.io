import { createElement as h, useEffect, useRef, useState } from "react";
import { BASE_PATH, FOOTER_GROUPS, NAV } from "../data/meta.js";
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
 *
 * `adopted` keeps the apply-and-persist effect from running before the stored value has been
 * read. Both effects run in the same commit, so without it the second one would still see the
 * initial "auto" and remove the attribute the head script had already set, painting one white
 * frame for a reader who chose dark. Waiting costs nothing: the head script has the correct
 * appearance on screen already, and this effect only re-applies it.
 */
function ThemeToggle() {
  const [theme, setTheme] = useState("auto");
  const [adopted, setAdopted] = useState(false);

  useEffect(() => {
    setTheme(storedTheme());
    setAdopted(true);
  }, []);

  useEffect(() => {
    if (!adopted) return;
    applyTheme(theme);
    try {
      if (theme === "auto") window.localStorage.removeItem("oq-theme");
      else window.localStorage.setItem("oq-theme", theme);
    } catch {
      // Persisting is a convenience, not a requirement.
    }
  }, [theme, adopted]);

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
  const toggleRef = useRef(null);
  const navRef = useRef(null);

  // Close the mobile menu on navigation and on Escape, so it never traps the reader.
  useEffect(() => {
    setMenuOpen(false);
  }, [current]);

  // Focus follows the menu: opening moves into the nav so a keyboard user is not left behind on
  // the toggle, and closing returns them to it.
  useEffect(() => {
    if (!menuOpen) return;
    const first = navRef.current?.querySelector("a");
    if (first) first.focus();
    const onKey = (event) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        toggleRef.current?.focus();
      }
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
        ),
        h(
          "nav",
          {
            className: "site-nav",
            "aria-label": "Main",
            id: "site-nav",
            ref: navRef,
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
              ref: toggleRef,
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
    h("main", { id: "main", tabIndex: -1 }, children),
    h(
      "footer",
      { className: "site-footer" },
      h(
        "div",
        { className: "content" },
        h(
          "div",
          { className: "site-footer-inner" },
          h(
            "div",
            { className: "footer-brand" },
            h("span", { className: "footer-mark" }, "Oqthara"),
            h(
              "p",
              { className: "footer-note" },
              "A small language for the JVM that reads like the idea. MIT licensed, Java 21 or newer, and every page here is built from the repository it describes.",
            ),
          ),
          h(
            "nav",
            { className: "footer-groups", "aria-label": "Footer" },
            FOOTER_GROUPS.map((group) =>
              h(
                "div",
                { className: "footer-group", key: group.title },
                h("h2", null, group.title),
                h(
                  "ul",
                  null,
                  group.links.map((link) =>
                    h(
                      "li",
                      { key: link.label },
                      h(
                        "a",
                        link.href.startsWith("http")
                          ? { href: link.href, rel: "noreferrer" }
                          : { href: hrefFor(link.href) },
                        link.label,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        h(
          "div",
          { className: "footer-legal" },
          h("span", null, "MIT licensed. Built on the JVM."),
          h("span", null, "Documentation is read from the repository at request time."),
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

/** A card. `href` makes the whole card a link. `featured` raises it one step. */
export function Card({ title, kicker, href, featured = false, children }) {
  const body = [
    kicker ? h("p", { className: "card-kicker", key: "k" }, kicker) : null,
    h("h3", { key: "t" }, title),
    children ? h("p", { key: "c" }, children) : null,
  ];
  const className = featured ? "card card-featured" : "card";
  return href
    ? h("a", { className, href }, body)
    : h("div", { className }, body);
}

export function Grid({ children, two = false }) {
  return h("div", { className: two ? "grid grid-2" : "grid" }, children);
}

/** A responsive data table. Wide content scrolls instead of breaking the layout. */
export function Table({ head, rows }) {
  return h(
    "div",
    { className: "table-wrap", tabIndex: 0, role: "region", "aria-label": "Table" },
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
