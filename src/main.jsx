import { createElement as h, StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App, ROUTES, routeFor } from "./App.jsx";
import { BASE_PATH } from "./data/meta.js";
import { isLegacyContentRoute, legacyRouteToCanonical } from "./source.js";
import "../assets/site.css";

// Client entry.
//
// GitHub Pages serves one real HTML file per route, so this hydrates the markup that file
// already contains rather than replacing it. The previous version treated every
// `/docs/**.html` address as a known document and hydrated a document tree over the
// NotFoundPage markup that 404.html had served, which is a hydration mismatch by construction.
//
// The rule now: hydrate only the exact static route that was prerendered. A legacy content
// URL is not a prerendered page, so it is redirected rather than hydrated. Anything else is an
// unknown path, and 404.html renders NotFoundPage both in that file and on the client, so the
// two agree.

/** Maps the current location onto a route, tolerating `/tour` as well as `/tour.html`. */
function currentPath() {
  let path = window.location.pathname;
  if (BASE_PATH !== "/" && path.startsWith(BASE_PATH)) {
    path = path.slice(BASE_PATH.length - 1);
  }
  path = path.replace(/\/{2,}/g, "/") || "/";
  if (!path.endsWith(".html") && path !== "/") {
    path = path.replace(/\/+$/, "") || "/";
    // `/tour` and `/tour.html` are the same page.
    if (routeFor(`${path}.html`)) path = `${path}.html`;
  }
  return path;
}

const path = currentPath();

// A legacy `/docs/**` or `/examples/**` address is a valid piece of content on a URL this
// site no longer generates. Send it to the canonical route instead of rendering 404 over it.
if (isLegacyContentRoute(path)) {
  const canonical = legacyRouteToCanonical(path, window.location.search);
  if (canonical) {
    window.location.replace(canonical);
  }
}

const container = document.getElementById("root");
const prerendered = Boolean(routeFor(path));
const tree = h(StrictMode, null, h(App, { path, search: window.location.search }));

if (prerendered && container && container.hasChildNodes()) {
  hydrateRoot(container, tree);
} else {
  // 404.html and any unknown address: the file already contains NotFoundPage, so replacing the
  // tree is correct and cannot mismatch.
  createRoot(container).render(tree);
}
