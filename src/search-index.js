// The client-side search index and its lifecycle.
//
// Kept apart from `components/Search.jsx` so the cache policy and the republish behaviour can be
// tested without a DOM. The component owns React state and the DOM; this module owns one
// question: when may a built index be reused, when must it be discarded, and how does a component
// learn that the index it is showing has been superseded?

/** ref -> promise of entries. Keyed by ref so a pinned manual searches only its own documents. */
const cache = new Map();

/** Registered `onRebuild` callbacks, one per mounted search surface. */
const listeners = new Set();

/**
 * The search index for `ref`, building it at most once per ref until `invalidate()` is called.
 *
 * `build` is called only on a miss. A rejected build is evicted so a transient failure does not
 * make search permanently unavailable.
 */
export function ensureIndex(ref, build) {
  const existing = cache.get(ref);
  if (existing) return existing;

  const promise = Promise.resolve().then(() => build(ref));
  // Evict by identity, not by key: an invalidation clears the cache and a replacement build may
  // already hold this slot by the time this one settles, and it must not be thrown away.
  const evictIfCurrent = () => {
    if (cache.get(ref) === promise) cache.delete(ref);
  };

  cache.set(ref, promise);
  promise.catch(evictIfCurrent);
  return promise;
}

/**
 * Forgets every built index so the next search reads the current mirror.
 *
 * The cache is cleared here rather than by whoever notices the republish, so an index cannot
 * outlive a republish just because no search surface happened to be mounted. Builds already in
 * flight are not cancelled — a caller awaiting one still receives its entries — but they are no
 * longer reachable from the cache, so they cannot be reused.
 */
export function invalidate() {
  cache.clear();
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One listener failing must not stop the others from rebuilding.
    }
  }
}

/**
 * Calls `callback` after every republish. Returns the unsubscribe function.
 *
 * The subscription is what makes a refresh automatic: previously the cache was invalidated by a
 * mounted component, and nothing told that component to rebuild, so an open panel went on
 * announcing a load that had finished.
 */
export function onRebuild(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Test seam: drop every cache entry and subscription. */
export function __resetIndexCacheForTests() {
  cache.clear();
  listeners.clear();
}
