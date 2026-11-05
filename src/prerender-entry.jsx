// SSR entry: renders the static routes to strings. `vite build --ssr` compiles this, so the
// prerender step uses exactly the same JSX transform and module graph as the client build.
//
// Documentation pages are deliberately NOT prerendered with content. Their Markdown lives
// in Oqthara/oqthara and is fetched at request time (ADR-0012), so this module only emits
// their route shells. Prerendering a copy would reintroduce the drift this design removes.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App, ROUTES } from "./App.jsx";
import { PAGE_META } from "./data/meta.js";

const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const TITLE_SUFFIX = " — Oqthara";

/** Keeps page titles inside the 70-character limit html-validate enforces. */
function pageTitle(text) {
  const full = `${text}${TITLE_SUFFIX}`;
  if (full.length <= 70) return full;
  const room = 70 - TITLE_SUFFIX.length - 1;
  const cut = text.slice(0, room);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 30 ? cut.slice(0, boundary) : cut).trimEnd()}…${TITLE_SUFFIX}`;
}

/** Serialises JSON for a script element without letting its content close the element. */
const embedJson = (value) =>
  JSON.stringify(value ?? null).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028");

function page({ title, description, body, script, stylesheet }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="stylesheet" href="${stylesheet}">
</head>
<body>
<div id="root">${body}</div>
  <script type="module" src="${script}"></script>
</body>
</html>
`;
}

export function renderAll(assets) {
  return ROUTES.map((route) => {
    const meta = PAGE_META[route.path] ?? PAGE_META["/"];
    const body = renderToStaticMarkup(h(App, { path: route.path, search: "" }));
    return {
      file: route.file,
      html: page({
        title: meta.title,
        description: meta.description,
        body,
        script: assets.script,
        stylesheet: assets.stylesheet,
      }),
    };
  });
}

/**
 * Emits a shell for one documentation route.
 *
 * The shell renders the real application chrome so the page has navigation, landmarks and
 * a skip link the moment it loads, and so hydration matches the client tree exactly. It
 * contains no Markdown: the document itself is fetched from GitHub after hydration, and a
 * `<noscript>` block still gives a reader without JavaScript a direct link to the source.
 */
export function renderDocShell({ path, title, sourceUrl, assets }) {
  const route = `/${String(path).replace(/\.md$/, ".html")}`;
  const body = renderToStaticMarkup(h(App, { path: route, search: "" })).replace(
    "</main>",
    `<noscript><p>JavaScript is disabled. Read this document at <a href="${escapeHtml(
      sourceUrl,
    )}">${escapeHtml(sourceUrl)}</a>.</p></noscript></main>`,
  );
  return {
    file: `${path.replace(/\.md$/, "")}.html`,
    html: page({
      title: pageTitle(title),
      description: `${title} from the Oqthara documentation, rendered from GitHub.`,
      body,
      script: assets.script,
      stylesheet: assets.stylesheet,
    }),
  };
}

/** Emits the 404 shell GitHub Pages serves for unknown paths. */
export function render404(assets) {
  const body = renderToStaticMarkup(h(App, { path: "/this-page-does-not-exist", search: "" }));
  return {
    file: "404.html",
    html: page({
      title: "Page not found — Oqthara",
      description: "There is no page at this address.",
      body,
      script: assets.script,
      stylesheet: assets.stylesheet,
    }),
  };
}

export { embedJson };
