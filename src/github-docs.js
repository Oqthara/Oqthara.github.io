// Everything the site reads from GitHub, with deliberate caching.
//
// Three kinds of request are made:
//
//   1. raw.githubusercontent.com for file contents (Markdown, example source, changelog);
//   2. api.github.com for the recursive git tree (document and example discovery);
//   3. api.github.com for published releases (the channel selector).
//
// Fixing the bug that broke the deployed site starts here: every loader has an explicit,
// documented return type. `loadTree` returns an array, `loadCatalog` returns an array,
// `loadReleases` returns an array. Nothing returns an object that a caller might iterate.
//
// Caching
// -------
// One Map keyed by request purpose. The cached value is the *promise*, so two components
// asking for the same file share one network round trip; concurrent callers cannot stampede.
// Entries are fresh for five minutes. After that the previous value is returned immediately
// while a refresh runs in the background (stale-while-revalidate), so a reader never loses
// a rendered page to a spinner. Failures are never cached, so Retry always retries.
//
// The raw CDN adds `cache-control: max-age=300` of its own, so a merged documentation change
// is visible within about ten minutes with no site change, rebuild or redeploy.
//
// Rate limits
// -----------
// Documents are read from the raw CDN, which has no API quota. Only the tree and the release
// list touch the API, and both are cached for the whole session. A 403 or 429 is surfaced as
// a typed error carrying `rateLimited: true`, so the UI can say "GitHub rate limit reached"
// instead of a generic failure.

import {
  CHANGELOG_PATH,
  DEFAULT_REF,
  blobUrl,
  documentRoute,
  isDocumentPath,
  isExamplePath,
  normalizePath,
  normalizeRepoPath,
  rawUrl,
  releasesApiUrl,
  sectionForPath,
  titleFromMarkdown,
  titleFromPath,
  treeApiUrl,
} from "./source.js";

export const CACHE_TTL_MS = 5 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 15 * 1000;
/** Titles are read one request per document; this keeps a cold index load civil. */
export const TITLE_CONCURRENCY = 6;

/**
 * A failure the UI can explain.
 *
 * `url` always points at a human-readable GitHub page so an error state can offer a way
 * forward instead of a dead end.
 */
export class GitHubError extends Error {
  constructor(message, { url = "", path = "", ref = DEFAULT_REF, status = 0, rateLimited = false, cause = null } = {}) {
    super(message);
    this.name = "GitHubError";
    this.url = url;
    this.path = path;
    this.ref = ref;
    this.status = status;
    this.rateLimited = rateLimited;
    if (cause) this.cause = cause;
  }
}

/** Alias kept so an existing import site cannot silently break. */
export const DocsError = GitHubError;

/** purpose-key -> { promise, at, value }. */
const cache = new Map();

/** Clears every cached promise. Tests call this between cases; nothing else does. */
export function __resetCacheForTests() {
  cache.clear();
}

/**
 * The API quota is 60 requests an hour for an unauthenticated browser, shared by everyone
 * behind the same address, so the two discovery responses are also persisted in
 * sessionStorage. A reload or a second tab then costs nothing, which is what keeps a normal
 * reading session inside the limit.
 *
 * Only discovery and the release list are persisted: they are small and they are the expensive
 * requests. File bodies come from the raw CDN, which has no quota, and stay in the memory
 * cache. Nothing here is secret, so there is nothing to leak.
 */
const PERSIST_PREFIX = "oq-cache:";
const PERSIST_TTL_MS = 30 * 60 * 1000;

function readPersistedEntry(key) {
  if (typeof window === "undefined" || !window.sessionStorage) return null;
  try {
    const raw = window.sessionStorage.getItem(PERSIST_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > PERSIST_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readPersisted(key) {
  return readPersistedEntry(key)?.value ?? null;
}

/**
 * A background revalidation that failed after a cached value was shown.
 *
 * The value on screen is still served, so the failure cannot be reported by rejecting the load
 * that already resolved. Instead every failure is published here and the data hooks subscribe,
 * which is what turns "this is the saved copy" into visible text instead of silence.
 */
const refreshErrorListeners = new Set();

/**
 * Registers a listener for failed background refreshes. Returns an unsubscribe function.
 *
 * A Set rather than one listener: a page can mount several hooks at once (a document and its
 * sidebar catalogue, for instance), and with a single slot the last mount would silently
 * replace the first and its failures would go unreported.
 */
export function setRefreshErrorListener(listener) {
  refreshErrorListeners.add(listener);
  return () => {
    refreshErrorListeners.delete(listener);
  };
}

/**
 * Serves a persisted value immediately and starts a background refresh.
 *
 * A value restored from a previous page load is shown at once — that is the point — but it is
 * also revalidated, so a source that has started failing produces a stale note instead of
 * silently looking current. The refresh never replaces what is on screen; the next reader of
 * the cache gets the newer value.
 */
function fromPersisted(key, load, { revalidate = true } = {}) {
  const entry = readPersistedEntry(key);
  if (!entry) return null;
  const value = entry.value;
  const immediate = Promise.resolve(value);
  cache.set(key, { promise: immediate, at: entry.at, value });
  if (revalidate) {
    // Deferred by a microtask so a hook that mounts in the same tick can subscribe before the
    // failure is published. Without this the very first reload after a failure reports nothing.
    const refresh = Promise.resolve().then(load);
    refresh.then(
      (fresh) => {
        cache.set(key, { promise: Promise.resolve(fresh), at: Date.now(), value: fresh });
        writePersisted(key, fresh);
      },
      (error) => {
        // Keep the persisted value and tell the UI the refresh failed.
        cache.set(key, { promise: immediate, at: entry.at, value });
        for (const listener of refreshErrorListeners) listener(error);
      },
    );
  }
  return immediate;
}

function writePersisted(key, value) {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(PERSIST_PREFIX + key, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // A full or disabled store is not a failure: the memory cache still works.
  }
}

/** The fetch implementation, replaceable in tests without touching the cache. */
let fetchImpl = (...args) => fetch(...args);

/** Test seam: install a stub fetch. Passing nothing restores the real one. */
export function __setFetchForTests(impl = null) {
  fetchImpl = impl ?? ((...args) => fetch(...args));
}

async function get(url, { path = "", ref = DEFAULT_REF, accept = "*/*" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      // Let the browser HTTP cache and the raw CDN participate.
      cache: "default",
      headers: { Accept: accept },
    });
  } catch (cause) {
    const aborted = cause?.name === "AbortError";
    throw new GitHubError(
      aborted
        ? "GitHub did not answer in time. Check the connection and try again."
        : "GitHub could not be reached. Check the connection and try again.",
      { url: blobUrl(path || "docs", ref), path, ref, cause },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const rateLimited =
      response.status === 403 || response.status === 429;
    const detail = rateLimited
      ? "GitHub's API rate limit was reached. This clears on its own; try again shortly."
      : `GitHub returned ${response.status}.`;
    throw new GitHubError(detail, {
      url: blobUrl(path || "docs", ref),
      path,
      ref,
      status: response.status,
      rateLimited,
    });
  }
  return response;
}

/**
 * Runs `load` for `key` with promise deduplication and stale-while-revalidate.
 *
 * While fresh, the cached promise is reused. Once stale, a new promise replaces the entry but
 * the previous value is still returned, so rendered content survives a slow refresh. A
 * failure on the very first load is not cached, so Retry refetches immediately.
 */
function cached(key, load) {
  const now = Date.now();
  const existing = cache.get(key);

  if (existing) {
    if (now - existing.at < CACHE_TTL_MS) return existing.promise;
    if (existing.value !== undefined) {
      const previous = existing;
      const promise = load();
      cache.set(key, { promise, at: now, value: previous.value });
      promise.then(
        (value) => {
          const entry = cache.get(key);
          if (entry && entry.promise === promise) cache.set(key, { promise, at: Date.now(), value });
        },
        () => {
          const entry = cache.get(key);
          if (entry && entry.promise === promise) cache.set(key, previous);
        },
      );
      return Promise.resolve(previous.value);
    }
  }

  const promise = load();
  const entry = { promise, at: now, value: undefined };
  cache.set(key, entry);
  promise.then(
    (value) => {
      const current = cache.get(key);
      if (current && current.promise === promise) cache.set(key, { promise, at: Date.now(), value });
    },
    () => {
      const current = cache.get(key);
      if (current && current.promise === promise) cache.delete(key);
    },
  );
  return promise;
}

/**
 * Reads a text file from the raw CDN.
 *
 * A document the reader has already opened is also held in sessionStorage, so a reload renders
 * the text immediately and a failed refresh shows the saved copy with a stale note instead of an
 * error page. This is the "last good value survives" rule, applied across a page load.
 */
export function loadText(ref, path) {
  const repoPath = normalizePath(normalizeRepoPath(path));
  const key = `text:${ref}:${repoPath}`;
  const loadTextOnce = async () => {
    const url = rawUrl(repoPath, ref);
    const response = await get(url, { path: repoPath, ref, accept: "text/plain, */*" });
    const text = await response.text();
    writePersisted(key, text);
    return text;
  };
  return fromPersisted(key, loadTextOnce) ?? cached(key, loadTextOnce);
}

/** Fetch helpers used only where a raw response body is required. */
async function getJson(url, { path = "", ref = DEFAULT_REF } = {}) {
  const response = await get(url, { path, ref, accept: "application/vnd.github+json" });
  try {
    return await response.json();
  } catch (cause) {
    throw new GitHubError("GitHub returned a response this site could not read.", {
      url: blobUrl(path || "docs", ref),
      path,
      ref,
      cause,
    });
  }
}

/**
 * Validates a Git Tree API response and returns the entries worth keeping.
 *
 * The API is not trusted: `tree` must be an array of objects with a string `path`, and only
 * `blob` entries (files) are considered. A malformed payload is an error, not an empty list,
 * because showing an empty documentation index would look like the docs had vanished.
 */
export function validateTree(payload, { ref = DEFAULT_REF } = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.tree)) {
    throw new GitHubError("GitHub returned a tree this site could not read.", {
      url: `https://github.com/Oqthara/oqthara/tree/${ref}`,
      ref,
    });
  }
  return payload.tree
    .filter((entry) => entry && typeof entry.path === "string" && entry.type === "blob")
    .map((entry) => ({ path: normalizeRepoPath(entry.path), size: Number(entry.size) || 0 }));
}

/** The recursive tree of a ref. Always an array. */
export function loadTree(ref = DEFAULT_REF) {
  const key = `tree:${ref}`;
  const loadTreeOnce = async () => {
    const tree = validateTree(await getJson(treeApiUrl(ref), { ref, path: "docs" }), { ref });
    writePersisted(key, tree);
    return tree;
  };
  return fromPersisted(key, loadTreeOnce) ?? cached(key, loadTreeOnce);
}

/**
 * Discovers every Markdown document under `docs/`, at any depth, for a ref.
 *
 * Returns an array of `{ path, section, title, route, sourceUrl }`, sorted by section then
 * path. `title` is derived from the file name here; `loadCatalog` upgrades it to the
 * document's real heading where it can.
 */
export async function loadDocumentIndex(ref = DEFAULT_REF) {
  const tree = await loadTree(ref);
  const docs = tree
    .filter((entry) => isDocumentPath(entry.path))
    .map((entry) => ({
      path: entry.path,
      section: sectionForPath(entry.path),
      title: titleFromPath(entry.path),
      route: documentRoute(entry.path, ref),
      sourceUrl: blobUrl(entry.path, ref),
    }))
    .sort((a, b) => a.section.localeCompare(b.section) || a.path.localeCompare(b.path));
  return docs;
}

/**
 * The documentation catalogue: discovered documents with their real Markdown titles.
 *
 * Titles come from each document's first heading, which is what a reader expects to see. The
 * requests are bounded so a cold load of forty documents does not open forty sockets at once.
 * A document whose title cannot be read keeps its path-derived title instead of failing the
 * whole index, because one unreadable file must not hide the rest of the manual.
 */
export function loadCatalog(ref = DEFAULT_REF) {
  const key = `catalog:${ref}`;
  return cached(key, async () => {
    const docs = await loadDocumentIndex(ref);
    const titled = new Array(docs.length);
    let next = 0;

    async function worker() {
      while (next < docs.length) {
        const index = next++;
        const doc = docs[index];
        try {
          const markdown = await loadText(ref, doc.path);
          titled[index] = { ...doc, title: titleFromMarkdown(markdown) || doc.title };
        } catch {
          // Keep the path-derived title: the document still belongs in the index.
          titled[index] = doc;
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(TITLE_CONCURRENCY, docs.length) }, worker),
    );
    return titled;
  });
}

/**
 * Discovers every `.oq` example for a ref.
 *
 * Returns an array of `{ path, name, category, route, sourceUrl }`. The category is the first
 * directory beneath `examples/`, so a new folder becomes a new group with no site change.
 * `name` is the file name without its extension, which is what the program calls itself.
 */
export async function loadExamples(ref = DEFAULT_REF) {
  const key = `examples:${ref}`;
  return cached(key, async () => {
    const tree = await loadTree(ref);
    return tree
      .filter((entry) => isExamplePath(entry.path))
      .map((entry) => {
        const parts = entry.path.split("/");
        const file = parts[parts.length - 1] ?? entry.path;
        return {
          path: entry.path,
          name: file.replace(/\.oq$/i, ""),
          category: parts.length > 2 ? parts[1] : "Examples",
          route: `/example.html?path=${encodeURIComponent(entry.path)}&ref=${encodeURIComponent(ref)}`,
          sourceUrl: blobUrl(entry.path, ref),
          size: entry.size,
        };
      })
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  });
}

/** Loads one Markdown document: `{ path, title, markdown, sourceUrl }`. */
export function loadDocument(ref, path) {
  const repoPath = normalizePath(normalizeRepoPath(path));
  if (!isDocumentPath(repoPath)) {
    return Promise.reject(
      new GitHubError(`Not a documentation path: ${String(path)}`, {
        url: blobUrl("docs", ref),
        path: repoPath,
        ref,
      }),
    );
  }
  const key = `doc:${ref}:${repoPath}`;
  return cached(key, async () => {
    const markdown = await loadText(ref, repoPath);
    return {
      path: repoPath,
      ref,
      title: titleFromMarkdown(markdown),
      markdown,
      sourceUrl: blobUrl(repoPath, ref),
    };
  });
}

/** Loads one example's source. */
export function loadExample(ref, path) {
  const repoPath = normalizePath(normalizeRepoPath(path));
  if (!isExamplePath(repoPath)) {
    return Promise.reject(
      new GitHubError(`Not an example path: ${String(path)}`, {
        url: `https://github.com/Oqthara/oqthara/tree/${ref}/examples`,
        path: repoPath,
        ref,
      }),
    );
  }
  const key = `example:${ref}:${repoPath}`;
  return cached(key, async () => ({
    path: repoPath,
    ref,
    source: await loadText(ref, repoPath),
    sourceUrl: blobUrl(repoPath, ref),
  }));
}

/** Loads the canonical changelog. */
export function loadChangelog(ref = DEFAULT_REF) {
  return loadText(ref, CHANGELOG_PATH);
}

/**
 * Validates the releases API payload into a channel list.
 *
 * Drafts are excluded; prereleases are included, because this project publishes prereleases
 * as its real releases. The development channel is always first. An entry whose `tag_name`
 * is missing is skipped rather than shown as a channel that cannot be read.
 */
export function validateReleases(payload, { includeDev = true } = {}) {
  if (!Array.isArray(payload)) {
    throw new GitHubError("GitHub returned a release list this site could not read.", {
      url: "https://github.com/Oqthara/oqthara/releases",
    });
  }
  const channels = includeDev
    ? [{ id: "main", label: "Development (main)", ref: "main", prerelease: false, dev: true }]
    : [];

  for (const release of payload) {
    if (!release || typeof release !== "object" || release.draft) continue;
    const ref = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
    if (!ref) continue;
    const published = typeof release.published_at === "string" ? release.published_at : "";
    channels.push({
      // The channel id is the readable version; the ref is the git tag that actually exists.
      id: ref.replace(/^v/, ""),
      label: release.name?.trim() || ref,
      ref,
      prerelease: Boolean(release.prerelease),
      published,
      url: typeof release.html_url === "string" ? release.html_url : "",
    });
  }

  const [dev, ...releases] = channels;
  releases.sort((a, b) => {
    const at = Date.parse(a.published) || 0;
    const bt = Date.parse(b.published) || 0;
    if (at !== bt) return bt - at;
    return b.ref.localeCompare(a.ref, undefined, { numeric: true });
  });
  return dev ? [dev, ...releases] : releases;
}

/** Published releases as channels. Always an array; development is always first. */
export function loadReleases() {
  const key = "releases";
  const loadReleasesOnce = async () => {
    const channels = validateReleases(await getJson(releasesApiUrl(), { path: "releases" }));
    writePersisted(key, channels);
    return channels;
  };
  return fromPersisted(key, loadReleasesOnce) ?? cached(key, loadReleasesOnce);
}

/** Finds the channel a URL named. Accepts either the channel id or the git ref. */
export function findChannel(channels, value) {
  const wanted = String(value ?? "").trim();
  if (!wanted) return channels[0] ?? null;
  return (
    channels.find((channel) => channel.ref === wanted) ??
    channels.find((channel) => channel.id === wanted) ??
    channels.find((channel) => channel.id === wanted.replace(/^v/, "")) ??
    channels[0] ??
    null
  );
}
