import { createElement as h } from "react";
import { Layout } from "./components/Layout.jsx";
import { HomePage } from "./pages/HomePage.jsx";
import { TourPage } from "./pages/TourPage.jsx";
import { DocsPage } from "./pages/DocsPage.jsx";
import { DocPage } from "./pages/DocPage.jsx";
import { ExamplesPage } from "./pages/ExamplesPage.jsx";
import { StdlibPage } from "./pages/StdlibPage.jsx";
import { StatusPage } from "./pages/StatusPage.jsx";
import { ChangelogPage } from "./pages/ChangelogPage.jsx";
import { NotFoundPage } from "./pages/NotFoundPage.jsx";
import { docPathFromRoute, isDocRoute } from "./source.js";

// The static routes. Each is emitted as a real HTML file by prerender.mjs, so GitHub Pages
// serves working content before any JavaScript runs.
//
// Documentation pages are NOT listed: `/docs/**.html` is matched below and the Markdown is
// fetched from GitHub when the page opens. Nothing is copied or prerendered from `docs/`,
// which is why a documentation change needs no site rebuild.
export const ROUTES = [
  { path: "/", file: "index.html", component: HomePage },
  { path: "/tour.html", file: "tour.html", component: TourPage },
  { path: "/docs.html", file: "docs.html", component: DocsPage },
  { path: "/examples.html", file: "examples.html", component: ExamplesPage },
  { path: "/stdlib.html", file: "stdlib.html", component: StdlibPage },
  { path: "/changelog.html", file: "changelog.html", component: ChangelogPage },
  { path: "/status.html", file: "status.html", component: StatusPage },
];

/** Reads the only query parameter this site uses: which documentation channel. */
export function queryFrom(search = "") {
  const params = new URLSearchParams(String(search ?? ""));
  const ref = params.get("ref");
  return ref ? { ref } : {};
}

export function App({ path, search = "" }) {
  const route = ROUTES.find((candidate) => candidate.path === path);
  const query = queryFrom(search);
  if (route) {
    const Page = route.component;
    return h(Layout, { current: route.path }, h(Page, { query }));
  }

  // `/docs/**.html` is a real route; the Markdown is fetched after hydration.
  if (isDocRoute(path)) {
    const docPath = docPathFromRoute(path);
    if (docPath) {
      return h(
        Layout,
        { current: "/docs.html" },
        h(DocPage, { path: docPath, query }),
      );
    }
  }

  return h(Layout, { current: "/" }, h(NotFoundPage, { path }));
}
