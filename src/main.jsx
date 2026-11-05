import { createElement as h, StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App, ROUTES } from "./App.jsx";
import { isDocRoute } from "./source.js";
import { BASE_PATH } from "./data/meta.js";
import "../assets/site.css";
import "./docs.css";

// GitHub Pages serves a real HTML file per static route, so this hydrates rather than
// replacing the DOM. Documentation pages are fetched from GitHub after hydration; their
// prerendered shell only contains a link to the source, which is why they hydrate safely
// whether or not the fetch has completed.

/** Maps the current location onto a route, tolerating both `/tour` and `/tour.html`. */
function currentPath() {
  let path = window.location.pathname;
  if (path.startsWith(BASE_PATH)) path = path.slice(BASE_PATH.length - 1);
  return path.replace(/\/{2,}/g, "/") || "/";
}

let route = currentPath();
if (!route.endsWith(".html") && route !== "/") route = route.replace(/\/+$/, "") || "/";

const container = document.getElementById("root");
const tree = h(
  StrictMode,
  null,
  h(App, { path: route, search: window.location.search }),
);

const known = ROUTES.some((candidate) => candidate.path === route) || isDocRoute(route);

if (known && container.hasChildNodes()) {
  hydrateRoot(container, tree);
} else {
  // Unknown paths are rendered by NotFoundPage on the client; a prerendered 404 shell is
  // not hydrated because it is served for arbitrary URLs.
  createRoot(container).render(tree);
}
