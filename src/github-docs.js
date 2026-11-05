// Reading documentation from GitHub at runtime.
//
// The site has no build step that knows about `docs/`. Every request goes to
// raw.githubusercontent.com, which serves `cache-control: max-age=300` and
// `access-control-allow-origin: *`, so the browser HTTP cache is part of the caching story.
// On top of that this module keeps an in-memory Map keyed by `<ref>:<path>`:
//
// - the promise itself is cached, so two components asking for the same file make one request;
// - entries are fresh for five minutes;
// - after that the previous value is returned immediately while a refresh runs in the
//   background, so a reader never loses the page they are on to a spinner.
//
// Combined with the raw CDN's five minutes, a merged documentation change is visible within
// about ten minutes without a site change, rebuild or redeploy.

import { DEFAULT_REF, blobUrl, rawUrl } from "./source.js";

export const CACHE_TTL_MS = 5 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 15 * 1000;
export const CATALOG_PATH = "docs/catalog.json";

/** A fetch or validation failure that the UI can explain and link back to GitHub. */
export class DocsError extends Error {
  constructor(message, { url, path = "", ref = DEFAULT_REF, status = 0, cause = null } = {}) {
    super(message);
    this.name = "DocsError";
    this.url = url;
    this.path = path;
    this.ref = ref;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/** `${ref}:${path}` -> { promise, at, value }. */
const cache = new Map();

/** Clears every cached promise. Tests call this between cases; nothing else does. */
export function __resetCacheForTests() {
  cache.clear();
}

async function requestJson(url, context) {
  const response = await get(url, context);
  try {
    return await response.json();
  } catch (cause) {
    throw new DocsError(`Invalid JSON from ${url}`, { ...context, url, cause });
  }
}

async function requestText(url, context) {
  const response = await get(url, context);
  return response.text();
}

async function get(url, context) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    // `cache: "default"` lets the browser HTTP cache (and the raw CDN's max-age) participate
    // instead of forcing a revalidation on every render.
    response = await fetch(url, {
      signal: controller.signal,
      cache: "default",
      headers: { Accept: "text/plain, application/json;q=0.9, */*;q=0.1" },
    });
  } catch (cause) {
    const reason = cause?.name === "AbortError" ? "timed out" : "could not be reached";
    throw new DocsError(
      `Documentation at ${url} ${reason}.`,
      { ...context, url, cause },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new DocsError(`GitHub returned ${response.status} for ${url}.`, {
      ...context,
      url: blobUrl(context.path || "", context.ref),
      status: response.status,
    });
  }
  return response;
}

/**
 * Runs `load` for `key` with promise deduplication and stale-while-revalidate.
 *
 * While fresh, the cached promise is reused. Once stale, a new promise replaces the entry
 * but the old value is still returned; the refresh result is used by the next reader.
 */
function cached(key, load) {
  const now = Date.now();
  const existing = cache.get(key);

  if (existing) {
    const age = now - existing.at;
    if (age < CACHE_TTL_MS) return existing.promise;
    if (existing.value !== undefined) {
      const promise = load();
      cache.set(key, { promise, at: now, value: existing.value });
      promise.then(
        (value) => {
          const entry = cache.get(key);
          if (entry && entry.promise === promise) cache.set(key, { promise, at: Date.now(), value });
        },
        () => {
          const entry = cache.get(key);
          // Keep serving the last good value if the background refresh failed.
          if (entry && entry.promise === promise) cache.set(key, { promise: existing.promise, at: existing.at, value: existing.value });
        },
      );
      return Promise.resolve(existing.value);
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
      // A failed first load is not cached, so Retry can try again immediately.
      if (current && current.promise === promise) cache.delete(key);
    },
  );
  return promise;
}

/** Validates the catalog written by `scripts/gen-docs-catalog.py`. */
export function validateCatalog(value, { url, ref } = {}) {
  const context = { url, ref, path: CATALOG_PATH };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DocsError("The documentation catalog is not an object.", context);
  }
  if (value.schema !== 1) {
    throw new DocsError(`Unsupported documentation catalog schema: ${String(value.schema)}`, context);
  }
  if (!Array.isArray(value.docs) || value.docs.length === 0) {
    throw new DocsError("The documentation catalog has no documents.", context);
  }
  const docs = value.docs.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new DocsError("The documentation catalog contains a malformed entry.", context);
    }
    const { path, title, section = "", slug = "" } = entry;
    if (typeof path !== "string" || !path.startsWith("docs/") || !path.endsWith(".md")) {
      throw new DocsError(`The documentation catalog has an invalid path: ${String(path)}`, context);
    }
    if (typeof title !== "string" || !title.trim()) {
      throw new DocsError(`The documentation catalog entry ${path} has no title.`, context);
    }
    return {
      path,
      title: title.trim(),
      section: typeof section === "string" ? section : "",
      slug: typeof slug === "string" ? slug : path.replace(/\.md$/, ""),
    };
  });
  return { schema: 1, docs };
}

/** Loads and validates `docs/catalog.json` for a channel. */
export function loadCatalog(ref = DEFAULT_REF) {
  const key = `${ref}:${CATALOG_PATH}`;
  const url = rawUrl(CATALOG_PATH, ref);
  return cached(key, async () => {
    const value = await requestJson(url, { url, path: CATALOG_PATH, ref });
    return validateCatalog(value, { url, ref });
  });
}

/** The first level-one heading in a Markdown document, or an empty string. */
export function titleFromMarkdown(markdown) {
  let fence = false;
  for (const line of String(markdown).split("\n")) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1].replace(/[*_`]/g, "").trim();
  }
  return "";
}

/**
 * Loads one Markdown document for a channel.
 * Returns `{ path, title, markdown, sourceUrl }`; failures are typed `DocsError`s.
 */
export function loadDocument(ref, path) {
  const repoPath = String(path ?? "").replace(/^\/+/, "");
  if (!repoPath || !repoPath.toLowerCase().endsWith(".md")) {
    return Promise.reject(
      new DocsError(`Not a documentation path: ${String(path)}`, {
        url: blobUrl(repoPath, ref),
        path: repoPath,
        ref,
      }),
    );
  }
  const key = `${ref}:${repoPath}`;
  const url = rawUrl(repoPath, ref);
  return cached(key, async () => {
    const markdown = await requestText(url, { url, path: repoPath, ref });
    return {
      path: repoPath,
      title: titleFromMarkdown(markdown),
      markdown,
      sourceUrl: blobUrl(repoPath, ref),
    };
  });
}

/** Loads a repository file such as `CHANGELOG.md` verbatim. */
export function loadText(ref, path) {
  const repoPath = String(path ?? "").replace(/^\/+/, "");
  const key = `${ref}:${repoPath}`;
  const url = rawUrl(repoPath, ref);
  return cached(key, () => requestText(url, { url, path: repoPath, ref }));
}
