// Client-side navigation for the pages that only change their query string.
//
// A channel switch used to assign `window.location.href`, which reloads the document and throws
// away every mounted hook. That made stale-while-revalidate unreachable: the page could never
// show "the last result is still on screen while a refresh runs", because there was no refresh,
// only a reload.
//
// Switching the channel now pushes a new history entry and notifies the app, so the data hooks
// stay mounted. They re-run for the new ref, keep the previous value while they do, and can
// report a failed refresh without destroying what the reader is looking at. Back and forward
// work because `popstate` is handled too.
//
// A plain `window.location.assign` is still correct for anything that changes the pathname: the
// server has to serve a different file.

export const NAVIGATE_EVENT = "oq:navigate";

/** Pushes a new URL without reloading, then tells the app to re-read the location. */
export function navigate(href) {
  if (typeof window === "undefined") return;
  const target = String(href ?? "");
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (target === current) return;
  window.history.pushState({}, "", target);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

/** Subscribes to in-app navigation and browser history changes. */
export function onNavigate(handler) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(NAVIGATE_EVENT, handler);
  window.addEventListener("popstate", handler);
  return () => {
    window.removeEventListener(NAVIGATE_EVENT, handler);
    window.removeEventListener("popstate", handler);
  };
}

/** The current location as the app sees it. */
export function currentLocation() {
  if (typeof window === "undefined") return { path: "/", search: "" };
  return { path: window.location.pathname, search: window.location.search };
}
