// The changelog page is rendered from a checked-in snapshot of the language repository's
// CHANGELOG.md. CI refreshes `content/changelog.md` from Oqthara/oqthara; the page labels the
// copy as a snapshot so it can never pass stale data off as live.
//
// These constants are the only place the route, file and source are named, so the app, the
// prerenderer and the tests cannot disagree about where the page lives or what it reads.

export const CHANGELOG_SOURCE = "content/changelog.md";
export const CHANGELOG_ROUTE = "/changelog.html";
export const CHANGELOG_FILE = "changelog.html";
