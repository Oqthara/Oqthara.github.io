// SSR entry: renders the static routes to strings. `vite build --ssr` compiles this, so the
// prerender step uses exactly the same JSX transform and module graph as the client build.
//
// Documentation and examples are NOT rendered with content here. Their text lives in
// Oqthara/oqthara and is fetched at request time, so this module emits those two routes as
// frames. Prerendering their content would reintroduce the drift the architecture removes.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App, ROUTES } from "./App.jsx";
import { PAGE_META, titleFor, descriptionFor } from "./data/meta.js";

const escapeHtml = (text) =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Applies a stored appearance before first paint.
 *
 * Without this a reader who chose light sees a dark flash on every navigation. It only sets the
 * attribute: React still renders the "auto" state first, so hydration matches the prerendered
 * button, and the component adopts the stored value in an effect.
 */
const THEME_SCRIPT = `
<script>
(function () {
  try {
    var stored = localStorage.getItem("oq-theme");
    if (stored === "light" || stored === "dark") document.documentElement.setAttribute("data-theme", stored);
  } catch (e) {}
})();
</script>`;

/**
 * 404.html is served by GitHub Pages for every unknown address, including legacy
 * `/docs/**.html` links. The redirect is performed by `main.jsx` through
 * `legacyRouteToCanonical`, so there is exactly one implementation of that rule and it cannot
 * drift from the router. Without JavaScript the page simply shows "not found", which is the
 * honest result.
 */

function page({ title, description, body, script, stylesheet, extraHead = "" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="stylesheet" href="${stylesheet}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://raw.githubusercontent.com">
  <link rel="preconnect" href="https://api.github.com">${THEME_SCRIPT}${extraHead}
</head>
<body>
<div id="root">${body}</div>
  <script type="module" src="${script}"></script>
</body>
</html>
`;
}

/** Body content of the prerendered static routes, in file order. */
export function renderAll(assets) {
  return ROUTES.map((route) => {
    const body = renderToStaticMarkup(h(App, { path: route.path, search: "" }));
    return {
      file: route.file,
      html: page({
        title: titleFor(route.path),
        description: descriptionFor(route.path),
        body,
        script: assets.script,
        stylesheet: assets.stylesheet,
      }),
    };
  });
}

/**
 * 404.html. It contains the real NotFound page, so an unknown address renders correctly both
 * before and after hydration, and it redirects legacy content links to the canonical route.
 */
export function render404(assets) {
  const body = renderToStaticMarkup(h(App, { path: "/this-page-does-not-exist", search: "" }));
  return {
    file: "404.html",
    html: page({
      title: PAGE_META["/404.html"].title,
      description: PAGE_META["/404.html"].description,
      body,
      script: assets.script,
      stylesheet: assets.stylesheet,
    }),
  };
}
