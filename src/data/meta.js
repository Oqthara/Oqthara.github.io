// Site-wide navigation and page metadata.
//
// This file deliberately contains no version number and no release list: both change without
// a website change, so they are read from GitHub at runtime (see github-docs.js).

export const BASE_PATH = "/";

/** The header navigation. These are the site's own pages, not repository content. */
export const NAV = [
  { href: "/", label: "Home" },
  { href: "/philosophy.html", label: "Philosophy" },
  { href: "/tour.html", label: "Tour" },
  { href: "/docs.html", label: "Docs" },
  { href: "/examples.html", label: "Examples" },
  { href: "/stdlib.html", label: "Reference" },
  { href: "/changelog.html", label: "Changelog" },
  { href: "/status.html", label: "Status" },
];

export const PAGE_META = {
  "/": {
    title: "Oqthara — a small language for the JVM",
    description:
      "Oqthara is a small language for the JVM that reads like pseudocode: no ceremony, real Java interop, and one semantic contract shared by the interpreter and the compiler.",
  },
  "/philosophy.html": {
    title: "Philosophy — Oqthara",
    description:
      "The design principles behind Oqthara: readability first, a small surface, fast feedback, errors that explain themselves and no accidental complexity.",
  },
  "/tour.html": {
    title: "Tour — Oqthara",
    description:
      "Learn Oqthara in one sitting: values, text, control flow, functions, collections, data types, errors, concurrency and Java interop.",
  },
  "/docs.html": {
    title: "Documentation — Oqthara",
    description:
      "Language reference, standard library, compiler notes and decision records, read directly from the repository.",
  },
  "/document.html": {
    title: "Documentation — Oqthara",
    description: "A document from the Oqthara repository, rendered from its canonical source.",
  },
  "/examples.html": {
    title: "Examples — Oqthara",
    description: "Complete, runnable Oqthara programs discovered from the examples directory.",
  },
  "/example.html": {
    title: "Example — Oqthara",
    description: "A complete Oqthara program, read from the repository.",
  },
  "/stdlib.html": {
    title: "Standard library — Oqthara",
    description: "The generated Oqthara standard library reference.",
  },
  "/changelog.html": {
    title: "Changelog — Oqthara",
    description: "Every notable change to Oqthara, read from the repository changelog.",
  },
  "/status.html": {
    title: "Status — Oqthara",
    description: "The current, documented status of the Oqthara compiler and backend.",
  },
  "/404.html": {
    title: "Page not found — Oqthara",
    description: "There is no page at this address.",
  },
};

/** The page title for a route, with the site suffix already applied. */
export function titleFor(route) {
  return (PAGE_META[route] ?? PAGE_META["/"]).title;
}

export function descriptionFor(route) {
  return (PAGE_META[route] ?? PAGE_META["/"]).description;
}
