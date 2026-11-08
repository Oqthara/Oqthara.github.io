import { createElement as h, useCallback, useEffect, useState } from "react";
import { Layout } from "./components/Layout.jsx";
import { HomePage } from "./pages/HomePage.jsx";
import { PhilosophyPage } from "./pages/PhilosophyPage.jsx";
import { TourPage } from "./pages/TourPage.jsx";
import { DocsPage } from "./pages/DocsPage.jsx";
import { DocumentPage } from "./pages/DocumentPage.jsx";
import { ExamplesPage } from "./pages/ExamplesPage.jsx";
import { ExamplePage } from "./pages/ExamplePage.jsx";
import { StdlibPage } from "./pages/StdlibPage.jsx";
import { StatusPage } from "./pages/StatusPage.jsx";
import { ChangelogPage } from "./pages/ChangelogPage.jsx";
import { NotFoundPage } from "./pages/NotFoundPage.jsx";
import { DEFAULT_REF, parseQuery } from "./source.js";
import { currentLocation, onNavigate } from "./navigation.js";
import { startContentFreshness } from "./freshness.js";

// The static routes. Each is one real file written by prerender.mjs, so GitHub Pages serves
// working HTML before any JavaScript runs.
//
// Content routes are deliberately not listed per item:
//
//   /document.html?path=…&ref=…   any documentation file
//   /example.html?path=…&ref=…    any example program
//
// A document or example that appears in GitHub therefore opens immediately, with no build, no
// route entry and no deploy. `pathListed` marks the routes that read their identity from the
// query string rather than from the path.
export const ROUTES = [
  { path: "/", file: "index.html", component: HomePage },
  { path: "/philosophy.html", file: "philosophy.html", component: PhilosophyPage },
  { path: "/tour.html", file: "tour.html", component: TourPage },
  { path: "/docs.html", file: "docs.html", component: DocsPage },
  { path: "/document.html", file: "document.html", component: DocumentPage, pathListed: true },
  { path: "/examples.html", file: "examples.html", component: ExamplesPage },
  { path: "/example.html", file: "example.html", component: ExamplePage, pathListed: true },
  { path: "/stdlib.html", file: "stdlib.html", component: StdlibPage },
  { path: "/changelog.html", file: "changelog.html", component: ChangelogPage },
  { path: "/status.html", file: "status.html", component: StatusPage },
];

/** The route a pathname names, or null. */
export function routeFor(path) {
  return ROUTES.find((candidate) => candidate.path === path) ?? null;
}

/** The ref this address asks for, or `main`. */
export function refFromSearch(search) {
  return parseQuery(search).ref || DEFAULT_REF;
}

/**
 * Resolves the query string only after mount.
 *
 * A static file cannot know its own query string, so a content route must render its
 * prerendered state first and settle afterwards. Doing this once here — rather than in each
 * page — means every query-driven route hydrates against the exact markup that shipped.
 */
function useDeferredQuery(search) {
  const [query, setQuery] = useState(() => parseQuery(""));
  const sync = useCallback(() => setQuery(parseQuery(currentLocation().search)), []);
  useEffect(() => {
    setQuery(parseQuery(search));
  }, [search]);
  // An in-app channel switch keeps this component mounted, so it has to re-read the query
  // itself rather than rely on a new `search` prop arriving from a reload.
  useEffect(() => onNavigate(sync), [sync]);
  return query;
}

/** Renders the app for a pathname and query string. */
export function App({ path, search = "" }) {
  const route = routeFor(path);
  const query = useDeferredQuery(search);

  // Watch the mirror catalogue for the whole life of the app, not per page: a reader who is
  // mid-document when a sync lands should get the new content, and a reader moving between pages
  // should not pay for a new subscription each time. Nothing happens during prerendering, where
  // there is no Firestore to watch.
  //
  // A subscription that fails is reported once and then left alone. It is not fatal - cached
  // content and the recovery schedules still apply - but it must not be silent either, or a page
  // that has stopped receiving live updates looks identical to a quiet one. Only a *failure* is
  // reported: a build with no Firebase configured never subscribes at all and stays quiet, since
  // reading from GitHub is the intended path there, not a fault.
  useEffect(() => {
    const watch = startContentFreshness({
      onError: (error) => {
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn("Live content updates are unavailable; showing cached content.", error);
        }
      },
    });
    return () => watch.stop();
  }, []);

  if (route) {
    const Page = route.component;
    // A document belongs to Docs and an example to Examples, so the header can mark where the
    // reader actually is instead of showing no current item on those two routes.
    const current =
      route.path === "/document.html"
        ? "/docs.html"
        : route.path === "/example.html"
          ? "/examples.html"
          : route.path;
    return h(Layout, { current }, h(Page, { query }));
  }

  return h(Layout, { current: "" }, h(NotFoundPage, { path }));
}
