// Caching for the client-side search index.
//
// Kept apart from `components/Search.jsx` so the cache policy can be tested without a DOM. The
// component owns the React state and the DOM; this module owns one question: when may a built
// index be reused, and when must it be discarded?

/** ref -> promise of entries. Keyed by ref so a pinned manual searches only its own documents. */
const cache = new Map();

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
  // Evict by identity, not by key: a republish clears the cache and the replacement build may
  // already hold this slot by the time this one settles, and it must not be thrown away.
  const evictIfCurrent = () => {
    if (cache.get(ref) === promise) cache.delete(ref);
  };

  cache.set(ref, promise);
  promise.catch(evictIfCurrent);
  return promise;
}

/**
 * Forgets every built index, and any build still in flight, so the next search reads the current
 * mirror. Called on a republish, and by tests between cases.
 */
export function invalidate() {
  cache.clear();
}
