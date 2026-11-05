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
 * A legacy `/docs/**.html` link is served by 404.html. This script turns it into the canonical
 * document route instead of 404, which is what lets old documentation links keep working with
 * no generated file per document.
 *
 * Both the document and the example forms are handled, and the ref is preserved.
 */
const REDIRECT_SCRIPT = `
<script>
(function () {
  var path = window.location.pathname;
  var params = new URLSearchParams(window.location.search);
  var ref = params.get("ref") || "main";
  var doc = /^\\/docs\\/(.+?)\\.html?$/.exec(path);
  var example = /^\\/examples\\/(.+?)\\.html?$/.exec(path);
  var target = null;
  if (doc) target = "/document.html?path=" + encodeURIComponent("docs/" + doc[1] + ".md") + "&ref=" + encodeURIComponent(ref);
  else if (example) target = "/example.html?path=" + encodeURIComponent("examples/" + example[1] + ".oq") + "&ref=" + encodeURIComponent(ref);
  if (target) window.location.replace(target);
})();
</script>`;

function page({ title, description, body, script, stylesheet, extraHead = "", extraBody = "" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="stylesheet" href="${stylesheet}">
  <link rel="preconnect" href="https://raw.githubusercontent.com">
  <link rel="preconnect" href="https://api.github.com">${extraHead}
</head>
<body>
<div id="root">${body}</div>
${extraBody}  <script type="module" src="${script}"></script>
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
      extraBody: REDIRECT_SCRIPT,
    }),
  };
}
