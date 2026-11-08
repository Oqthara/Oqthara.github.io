// Live content freshness.
//
// The mirror publishes a new `metadata/catalog` document after every successful sync, and that
// document carries the exact upstream commit the content was reconciled from. Watching it turns
// "a change merged into the language repository" into an event this site can see, instead of
// something a reader discovers when a five-minute cache happens to expire.
//
// Three rules:
//
//   1. The catalogue is the *signal*, never the content. It says which commit is being served;
//      the documents themselves still come from the mirror. Nothing here trusts the signal to
//      describe content it has not read.
//   2. The first snapshot is not a change. `onSnapshot` fires immediately with whatever is
//      already stored, so treating that as an update would refresh every page on load and cost
//      a burst of reads for no new information.
//   3. A refresh never touches the URL. The reader keeps their route, query string, channel and
//      scroll position; the data behind the page is simply re-read. Reloading the document here
//      would be the easy answer and the wrong one.
//
// A failed subscription is not fatal. The site keeps serving cached content and then GitHub, and
// the failure is reported once rather than retried in a loop.

import { COLLECTION_CATALOG_ID, COLLECTIONS, FIELDS } from "./firebase/collections.js";
import { invalidateReadCache, subscribeDoc } from "./firebase/firestore.js";
import { invalidateCache as invalidateGitHubCache } from "./github-docs.js";
import { hexDigest as validDigest, validCommit } from "./repositories/catalog.repository.js";

/**
 * A comparable identity for one published revision of the mirror.
 *
 * The content digest is preferred, because it is the only field that answers the question the
 * reader is actually asking: *is what I am showing still what is stored?* The commit alone
 * cannot answer it. A release is published by pushing a tag, and that adds a release document
 * while `main` stays exactly where it was, so a commit-only fingerprint reports "unchanged" for
 * a mirror that newly contains a release. The digest moves in that case and does not move when a
 * scheduled run reconciles identical content.
 *
 * The commit is the fallback for a catalogue written before the digest existed, then the publish
 * time with the counts. Both are weaker signals and are treated as such: they only decide what
 * to do when the stronger field is absent. The publish-time fallback is the weakest of the three,
 * because `updatedAt` moves on every run and so refreshes an open page even when nothing changed.
 * It is kept only for a record that proves neither a digest nor a commit, which in practice means
 * a catalogue written by an older sync script; such a record is rewritten with both fields by the
 * next run, so the imprecision lasts for at most one sync. An empty record matches an empty record
 * and triggers nothing.
 */
export function revisionFingerprint(record) {
  const digest = validDigest(record?.[FIELDS.contentDigest]);
  if (digest) return `content:${digest}`;
  const commit = validCommit(record?.[FIELDS.sourceCommit]);
  if (commit) return `commit:${commit}`;
  const updatedAt = typeof record?.[FIELDS.updatedAt] === "string" ? record[FIELDS.updatedAt].trim() : "";
  if (updatedAt) {
    const counts = record?.counts ?? {};
    const shape = ["written", "unchanged", "unpublished", "oversized"]
      .map((key) => (Number.isFinite(counts[key]) ? counts[key] : 0))
      .join(".");
    return `publish:${updatedAt}:${shape}`;
  }
  return "";
}

const listeners = new Set();

/**
 * Registers a handler to run after content has been republished. Returns an unsubscribe.
 *
 * A Set for the same reason the refresh-error listeners are one: a page mounts several hooks at
 * once and a single slot would let the last mount silently replace the first.
 */
export function onContentChange(handler) {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

/**
 * Drops every cached value the site could otherwise keep serving after a republish.
 *
 * Both caches are cleared because a page can be served from either: the Firestore mirror when it
 * is available, the GitHub fallback when it is not. Clearing only one leaves the other free to
 * answer an expired read with pre-republish content.
 */
export function invalidateContentCaches() {
  invalidateReadCache();
  invalidateGitHubCache();
}

/** Announces a republish to every live hook and clears the caches behind them. */
export function announceContentChange(fingerprint = "") {
  invalidateContentCaches();
  for (const listener of listeners) {
    try {
      listener(fingerprint);
    } catch {
      // One broken subscriber must not stop the others from refreshing.
    }
  }
}

/**
 * Starts watching the mirror catalogue.
 *
 * Returns `{ stop }`. Calling it twice returns the existing watch rather than opening a second
 * listener, so a hot reload or a second import cannot double the socket count.
 *
 * The watch is shared, not reference-counted: the first caller's `stop()` closes it for every
 * caller. That is deliberate while `App.jsx` is the only caller and mounts it once for the life of
 * the app - a refcount here would be machinery with no user. A second concurrent caller would need
 * one, so if this ever gains another, count the holders instead of handing out the same handle.
 */
let activeWatch = null;

export function startContentFreshness(options = {}) {
  if (activeWatch) return activeWatch;

  let baseline = null;
  let stopped = false;

  const unsubscribe = subscribeDoc(
    COLLECTIONS.metadata,
    COLLECTION_CATALOG_ID,
    {
      onValue: (record) => {
        if (stopped) return;
        const fingerprint = revisionFingerprint(record);
        // The first snapshot describes what is already on screen; it is the baseline, not news.
        if (baseline === null) {
          baseline = fingerprint;
          return;
        }
        if (fingerprint === baseline) return;
        baseline = fingerprint;
        announceContentChange(fingerprint);
      },
      onError: (error) => {
        // Reported once and then left alone: a live subscription that cannot connect must not
        // turn into a retry loop, and cached content is still readable.
        options.onError?.(error);
      },
    },
    options,
  );

  const handle = {
    stop() {
      // Idempotent. Without the `stopped` guard, a second `stop()` (React StrictMode runs every
      // effect cleanup twice in development) unsubscribed again, and nulling `activeWatch`
      // unconditionally wiped the *next* watch's slot while its listener stayed open, so the
      // following `start()` opened another one and the previous socket leaked.
      // The identity check below is belt-and-braces: with the guard in place a handle can only
      // be stopped once, and a handle only ever becomes `activeWatch` by `start()` installing
      // it, so this cannot currently be false. It is kept so the slot is only cleared by the
      // watch that owns it if that ever changes.
      if (stopped) return;
      stopped = true;
      unsubscribe();
      if (activeWatch === handle) activeWatch = null;
    },
  };
  activeWatch = handle;
  return activeWatch;
}

/** Test seam: stop any watch that is running so cases cannot leak a listener into each other. */
export function __stopContentFreshnessForTests() {
  activeWatch?.stop();
  activeWatch = null;
  listeners.clear();
}
