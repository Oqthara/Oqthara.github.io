// The only module in `src/` that talks to Firestore.
//
// Two rules shape it:
//
//   1. Nothing initializes or imports the Firebase SDK at module load. The site is prerendered
//      in Node, and a prerender must never open a socket. Every SDK touch goes through
//      `sdk()`, which dynamically imports `firebase/firestore` on first use. `firebase/app` is
//      imported statically by `config.js`, so it lives in the main chunk and must not be
//      imported dynamically here: Rollup cannot split it a second time and warns.
//   2. A read never throws into React. `readDocs` / `readDoc` resolve to a typed result, so a
//      caller can tell "unavailable" (fall back to GitHub) from "permission-denied" (the rules
//      say no) from "timeout" without parsing an exception message.
//
// Caching is per-process: one Map keyed by the caller's cache key. The cached value is the
// *promise*, so two concurrent identical reads share one request. Successful results stay fresh
// for `CACHE_TTL_MS`; failures are dropped immediately so a retry really retries.

import {
  firebaseConfigStatus,
  getFirebaseApp,
  isBrowserRuntime,
  readEmulatorHost,
} from "./config.js";

/** Successful reads are reused for five minutes, matching the GitHub layer. */
export const CACHE_TTL_MS = 5 * 60 * 1000;
/** A read that has not settled in eight seconds is reported as a timeout, not awaited forever. */
export const REQUEST_TIMEOUT_MS = 8 * 1000;

export const FIRESTORE_ERROR_CODES = Object.freeze({
  notConfigured: "not-configured",
  unavailable: "unavailable",
  permissionDenied: "permission-denied",
  timeout: "timeout",
  invalidArgument: "invalid-argument",
  unknown: "unknown",
});

/** Codes after which a GitHub fallback is the right answer. */
const FALLBACK_CODES = new Set([
  FIRESTORE_ERROR_CODES.notConfigured,
  FIRESTORE_ERROR_CODES.unavailable,
  FIRESTORE_ERROR_CODES.timeout,
  FIRESTORE_ERROR_CODES.permissionDenied,
  FIRESTORE_ERROR_CODES.unknown,
]);

/** A typed, non-throwing failure. */
export function firestoreError(code, message, { cause = null, retryable = true } = {}) {
  return Object.freeze({
    code,
    message,
    retryable,
    fallback: FALLBACK_CODES.has(code),
    cause: cause ?? null,
  });
}

/** A successful read. `source` is always `"firestore"`; `cached` says it came from the TTL cache. */
export function firestoreOk(data, { cached = false } = {}) {
  return Object.freeze({ ok: true, data, error: null, source: "firestore", cached });
}

/** A failed read. `error.fallback` tells the service whether GitHub should take over. */
export function firestoreFailure(error, { cached = false } = {}) {
  return Object.freeze({ ok: false, data: null, error, source: "firestore", cached });
}

/**
 * Maps a thrown Firebase error onto the typed codes.
 *
 * The SDK reports `unavailable` for a network or backend outage and `permission-denied` when
 * the security rules refuse the read. They are deliberately distinct: the first is transient,
 * the second is a deployment mistake and must not be retried in a loop.
 */
export function classifyFirestoreError(error) {
  const code = String(error?.code ?? "").toLowerCase();
  const name = String(error?.name ?? "").toLowerCase();
  const probe = `${code} ${name}`;
  if (probe.includes("permission-denied") || probe.includes("permission_denied")) {
    return firestoreError(
      FIRESTORE_ERROR_CODES.permissionDenied,
      "Firestore refused the read: the security rules allow published content only.",
      { cause: error, retryable: false },
    );
  }
  if (probe.includes("unavailable")) {
    return firestoreError(
      FIRESTORE_ERROR_CODES.unavailable,
      "Firestore is unavailable. The site will read from GitHub instead.",
      { cause: error },
    );
  }
  if (probe.includes("invalid-argument")) {
    return firestoreError(
      FIRESTORE_ERROR_CODES.invalidArgument,
      "Firestore rejected a query argument.",
      { cause: error, retryable: false },
    );
  }
  return firestoreError(
    FIRESTORE_ERROR_CODES.unknown,
    "Firestore returned an unexpected error. The site will read from GitHub instead.",
    { cause: error },
  );
}

/** Resolves after `ms`, or rejects with a typed timeout so the race can be identified. */
function timeoutError(ms) {
  return firestoreError(
    FIRESTORE_ERROR_CODES.timeout,
    `Firestore did not answer in ${Math.round(ms / 1000)}s. The site will read from GitHub instead.`,
  );
}

function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// SDK loading and test seam
// ---------------------------------------------------------------------------

let sdkPromise = null;
let testSdk = null;

/** Test seam: a fake `firebase/firestore` module; pass null to restore the real one. */
export function __setFirestoreForTests(fake = null) {
  testSdk = fake;
  sdkPromise = null;
  cache.clear();
}

/** Test seam: forget cached reads between cases. */
export function __resetCacheForTests() {
  cache.clear();
}

/**
 * Drops every cached read so the next one asks Firestore again.
 *
 * This is the cache-invalidation half of content freshness. The mirror writes a new catalogue
 * document after a sync, and without this the reader would keep being served the pre-sync
 * document bodies for up to `CACHE_TTL_MS` — the freshness signal would arrive and change
 * nothing on screen. Dropping the whole map rather than one key is deliberate: a sync rewrites
 * many collections at once and the catalogue does not say which, so any narrower eviction
 * would be a guess.
 */
export function invalidateReadCache() {
  cache.clear();
}

async function sdk() {
  if (testSdk) return testSdk;
  if (!sdkPromise) {
    sdkPromise = import("firebase/firestore").catch((error) => {
      sdkPromise = null;
      throw error;
    });
  }
  return sdkPromise;
}

let dbInstance = null;

/**
 * The Firestore database singleton. Lazy: the SDK and the app are created on the first read,
 * never at import time, so prerendering in Node touches nothing.
 *
 * When `VITE_FIREBASE_EMULATOR_HOST` is set the connection is redirected to that emulator
 * before the first request. That variable is absent from every production build, so this is a
 * verification path, not a deployment mode.
 */
export async function getDb() {
  if (testSdk) return { __fake: true };
  if (dbInstance) return dbInstance;
  const module = await sdk();
  const app = getFirebaseApp();
  dbInstance = module.getFirestore(app);
  redirectToEmulator(module, dbInstance, readEmulatorHost());
  return dbInstance;
}

/**
 * Points `db` at an emulator when `host` is a `hostname:port` pair.
 *
 * Split out so the redirect is testable without a project or a running emulator. A malformed
 * value is ignored rather than thrown: a verification build that names a bad emulator should
 * fail on the request, not on startup.
 */
export function redirectToEmulator(module, db, host) {
  if (!host) return db;
  const [hostname, port] = String(host).split(":");
  if (!hostname || !port) return db;
  module.connectFirestoreEmulator(db, hostname, Number(port));
  return db;
}

/** Test seam: forget the database singleton. */
export function __resetDbForTests() {
  dbInstance = null;
}

/**
 * True when a read has any chance of succeeding: a browser runtime with a complete public
 * config, or a test seam. It does not initialize anything and makes no request.
 */
export function isFirebaseAvailable(env = import.meta.env ?? {}) {
  if (testSdk) return true;
  if (!isBrowserRuntime()) return false;
  return firebaseConfigStatus(env).configured;
}

// ---------------------------------------------------------------------------
// Thin wrappers over the modular SDK
// ---------------------------------------------------------------------------

/** Thin wrapper: `getDocs` from the modular SDK. */
export async function getDocs(...args) {
  return (await sdk()).getDocs(...args);
}

/** Thin wrapper: `getDoc` from the modular SDK. */
export async function getDoc(...args) {
  return (await sdk()).getDoc(...args);
}

/** Thin wrapper: `query` from the modular SDK. */
export async function query(...args) {
  return (await sdk()).query(...args);
}

/** Thin wrapper: `where` from the modular SDK. */
export async function where(...args) {
  return (await sdk()).where(...args);
}

/** Thin wrapper: `limit` from the modular SDK. */
export async function limit(...args) {
  return (await sdk()).limit(...args);
}

/** Thin wrapper: `orderBy` from the modular SDK. */
export async function orderBy(...args) {
  return (await sdk()).orderBy(...args);
}

/** Thin wrapper: `startAfter` from the modular SDK. */
export async function startAfter(...args) {
  return (await sdk()).startAfter(...args);
}

/** Thin wrapper: `collection` from the modular SDK. */
export async function collection(...args) {
  return (await sdk()).collection(...args);
}

/** Thin wrapper: `doc` from the modular SDK. */
export async function doc(...args) {
  return (await sdk()).doc(...args);
}

// ---------------------------------------------------------------------------
// Cached typed reads
// ---------------------------------------------------------------------------

/** cacheKey -> { promise, at } */
const cache = new Map();

function cacheKeyFor(kind, name, extra) {
  return `${kind}:${name}:${extra}`;
}

/**
 * Runs `load` once per cache key inside the TTL, sharing the promise between concurrent
 * callers. Successes are cached; failures are removed so the next call retries.
 */
function cachedRead(key, load, { ttlMs = CACHE_TTL_MS } = {}) {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && now - existing.at < ttlMs) {
    return existing.promise.then((result) => ({ ...result, cached: true }));
  }
  const promise = load();
  // Evict by identity so a read that fails after `invalidateReadCache` and a replacement have
  // already moved on does not drop the newer entry and force a second fetch.
  const evictIfCurrent = () => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  };
  cache.set(key, { promise, at: now });
  promise.then(
    (result) => {
      if (!result?.ok) evictIfCurrent();
    },
    evictIfCurrent,
  );
  return promise;
}

function snapshotToPlain(snapshot) {
  const data = typeof snapshot?.data === "function" ? snapshot.data() : null;
  return {
    id: typeof snapshot?.id === "string" ? snapshot.id : "",
    data: data && typeof data === "object" ? data : null,
  };
}

/**
 * Reads a collection, optionally constrained and ordered, and returns a typed result.
 *
 * `buildQuery(module, baseCollection)` receives the loaded SDK and must return a Query; this
 * keeps every SDK detail (where/limit/orderBy) inside this module while letting repositories
 * describe their own filters.
 */
export async function readDocs(name, buildQuery = null, options = {}) {
  const {
    cacheKey = "",
    ttlMs = CACHE_TTL_MS,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = options;

  if (!isFirebaseAvailable(options.env)) {
    return firestoreFailure(
      firestoreError(
        FIRESTORE_ERROR_CODES.notConfigured,
        "Firebase is not configured in this runtime; reads fall back to GitHub.",
        { retryable: false },
      ),
    );
  }

  const key = cacheKeyFor("docs", name, cacheKey);
  return cachedRead(
    key,
    async () => {
      try {
        const module = await withTimeout(sdk(), timeoutMs);
        const db = await withTimeout(getDb(), timeoutMs);
        const base = module.collection(db, name);
        const target = buildQuery ? buildQuery(module, base) : base;
        const snapshot = await withTimeout(module.getDocs(target), timeoutMs);
        const docs = Array.isArray(snapshot?.docs)
          ? snapshot.docs.map(snapshotToPlain)
          : [];
        return firestoreOk(docs);
      } catch (error) {
        // A timeout is already typed; anything else is mapped from the SDK error.
        const typed =
          error?.code === FIRESTORE_ERROR_CODES.timeout ? error : classifyFirestoreError(error);
        return firestoreFailure(typed);
      }
    },
    { ttlMs },
  );
}

/**
 * Reads one document by id. A missing document is `ok` with `data: null`.
 *
 * `data` is the document payload, not an `{ id, data }` wrapper: the id is the caller's own
 * argument, so every repository validates `result.data` directly. Returning the wrapper here
 * made each validator reject a well-formed record as "missing or empty path", which turned
 * every single-document read into a silent GitHub fallback.
 */
export async function readDoc(name, id, options = {}) {
  const {
    cacheKey = "",
    ttlMs = CACHE_TTL_MS,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = options;

  if (!isFirebaseAvailable(options.env)) {
    return firestoreFailure(
      firestoreError(
        FIRESTORE_ERROR_CODES.notConfigured,
        "Firebase is not configured in this runtime; reads fall back to GitHub.",
        { retryable: false },
      ),
    );
  }

  const key = cacheKeyFor("doc", `${name}/${id}`, cacheKey);
  return cachedRead(
    key,
    async () => {
      try {
        const module = await withTimeout(sdk(), timeoutMs);
        const db = await withTimeout(getDb(), timeoutMs);
        const snapshot = await withTimeout(
          module.getDoc(module.doc(db, name, id)),
          timeoutMs,
        );
        if (!snapshot || snapshot.exists?.() === false) return firestoreOk(null);
        return firestoreOk(snapshotToPlain(snapshot).data);
      } catch (error) {
        const typed =
          error?.code === FIRESTORE_ERROR_CODES.timeout ? error : classifyFirestoreError(error);
        return firestoreFailure(typed);
      }
    },
    { ttlMs },
  );
}

// ---------------------------------------------------------------------------
// Live catalogue subscription
// ---------------------------------------------------------------------------

/**
 * Watches one document and reports every server-confirmed value.
 *
 * `onSnapshot` is a listener rather than a request, so it cannot return a typed result the way
 * a read does: it stays open until it is unsubscribed. The callback therefore receives a plain
 * `{ data }` for a value and `{ error }` for a failure, and the caller decides what a failure
 * means. A failure is never fatal here: the site keeps reading through the cached path and the
 * subscription reports the problem once rather than retrying in a loop.
 *
 * Returns an unsubscribe function. A caller that never unsubscribes leaks a listener and a
 * socket, so every subscription here is paired with an effect cleanup.
 */
export function subscribeDoc(name, id, { onValue, onError } = {}, options = {}) {
  if (!isFirebaseAvailable(options.env)) return () => {};
  let stopped = false;
  let unsubscribe = null;
  let cancelled = false;

  (async () => {
    try {
      const module = await sdk();
      const db = await getDb();
      if (stopped) return;
      const handle = module.onSnapshot(
        module.doc(db, name, id),
        (snapshot) => {
          if (stopped) return;
          const exists = snapshot?.exists?.() !== false;
          onValue?.(exists ? snapshotToPlain(snapshot).data : null);
        },
        (error) => {
          if (stopped) return;
          onError?.(classifyFirestoreError(error));
        },
      );
      // The subscription may have been cancelled while the SDK was loading. Closing the
      // handle immediately is what keeps a fast unmount from leaking a live listener.
      if (cancelled) handle?.();
      else unsubscribe = handle;
    } catch (error) {
      if (!stopped) onError?.(classifyFirestoreError(error));
    }
  })();

  return () => {
    stopped = true;
    cancelled = true;
    unsubscribe?.();
    unsubscribe = null;
  };
}
