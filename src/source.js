// The single place that knows how this site maps repository content onto URLs.
//
// Everything here is pure: no React, no fetch. That keeps routing rules testable in plain
// Node and stops a component from inventing its own GitHub URL or query format.
//
// Route model
// -----------
// GitHub Pages is static hosting with no rewrite rules, so a route that has to serve an
// arbitrary number of documents must resolve to one real file. `/document.html` is that
// file: the document and the channel travel in the query string.
//
//   /document.html?path=docs/spec/language.md&ref=main
//
// Consequently a document that appears in GitHub tomorrow opens today, with no site change
// and no build. There is no per-document HTML file and no list of document paths anywhere.
//
// The old friendly form `/docs/spec/language.html` is still understood. It is not a file,
// so GitHub Pages serves 404.html, which redirects it here (see prerender.mjs).

export const REPO = "Oqthara/oqthara";
export const DEFAULT_REF = "main";

/** Canonical document page. One file serves every document. */
export const DOCUMENT_ROUTE = "/document.html";

/** Canonical example page. One file serves every example. */
export const EXAMPLE_ROUTE = "/example.html";

/** Paths the site will render. Anything else is rejected before a request is made. */
const DOC_PATH = /^docs\/.+\.md$/i;
const EXAMPLE_PATH = /^examples\/.+\.oq$/i;
export const CHANGELOG_PATH = "CHANGELOG.md";

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const CONTROL_OR_SPACE = /^[\u0000-\u0020]+/;
const ANY_CONTROL_OR_SPACE = /[\u0000-\u0020]+/g;

/** Repository-relative path without a leading slash, backslashes or `./`. */
export function normalizeRepoPath(path) {
  return String(path ?? "")
    // A NUL or other control character cannot occur in a repository path; strip it here so the
    // allowlist never accepts a path that could not exist.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^\.\//, "");
}

/**
 * `a/./b/../c` -> `a/c`.
 *
 * Used on every path that arrives from a query string or a Markdown link, so `..` can never
 * climb out of the directory it belongs to and turn into a request for something else.
 */
export function normalizePath(path) {
  const parts = [];
  for (const part of String(path ?? "").replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** True when the resolved path is a documentation file the site is allowed to fetch. */
export function isDocumentPath(path) {
  const normalized = normalizePath(normalizeRepoPath(path));
  return DOC_PATH.test(normalized);
}

/** True when the resolved path is an example file the site is allowed to fetch. */
export function isExamplePath(path) {
  const normalized = normalizePath(normalizeRepoPath(path));
  return EXAMPLE_PATH.test(normalized);
}

/** True when a repository file may be rendered by this site at all. */
export function isRenderablePath(path) {
  const normalized = normalizePath(normalizeRepoPath(path));
  return normalized === CHANGELOG_PATH || isDocumentPath(normalized) || isExamplePath(normalized);
}

function encodePath(path) {
  return normalizePath(normalizeRepoPath(path))
    .split("/")
    .filter((part) => part !== "")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function encodeRef(ref) {
  return encodeURIComponent(String(ref ?? DEFAULT_REF).trim() || DEFAULT_REF);
}

/** `https://raw.githubusercontent.com/Oqthara/oqthara/<ref>/<path>` */
export function rawUrl(path, ref = DEFAULT_REF) {
  return `https://raw.githubusercontent.com/${REPO}/${encodeRef(ref)}/${encodePath(path)}`;
}

/** `https://github.com/Oqthara/oqthara/blob/<ref>/<path>` — the exact source of a page. */
export function blobUrl(path, ref = DEFAULT_REF) {
  return `https://github.com/${REPO}/blob/${encodeRef(ref)}/${encodePath(path)}`;
}

/** `https://github.com/Oqthara/oqthara/tree/<ref>/<dir>` */
export function treeUrl(path = "docs", ref = DEFAULT_REF) {
  return `https://github.com/${REPO}/tree/${encodeRef(ref)}/${encodePath(path)}`;
}

/** The recursive tree of a branch or tag. Document discovery uses this, not the API catalog. */
export function treeApiUrl(ref = DEFAULT_REF) {
  return `https://api.github.com/repos/${REPO}/git/trees/${encodeRef(ref)}?recursive=1`;
}

/** Published releases, drafts included in the raw response and filtered by the caller. */
export function releasesApiUrl(perPage = 30) {
  return `https://api.github.com/repos/${REPO}/releases?per_page=${perPage}`;
}

/**
 * The canonical site URL for a document at a ref.
 *
 * `ref` is always explicit, so a link copied from a released manual keeps pointing at that
 * release instead of silently following `main` later.
 */
export function documentRoute(path, ref = DEFAULT_REF) {
  return `${DOCUMENT_ROUTE}?path=${encodeURIComponent(normalizeRepoPath(path))}&ref=${encodeRef(ref)}`;
}

/** The canonical site URL for an example at a ref. */
export function exampleRoute(path, ref = DEFAULT_REF) {
  return `${EXAMPLE_ROUTE}?path=${encodeURIComponent(normalizeRepoPath(path))}&ref=${encodeRef(ref)}`;
}

/** Reads `path` and `ref` out of a query string without trusting either. */
export function parseQuery(search) {
  const params = new URLSearchParams(String(search ?? "").replace(/^\?/, ""));
  const path = params.get("path") ?? "";
  const ref = params.get("ref") ?? "";
  return {
    path: normalizeRepoPath(path),
    ref: ref.trim() || DEFAULT_REF,
  };
}

/**
 * Maps a legacy `/docs/**.html` or `/examples/**.html` URL onto the canonical route.
 *
 * This is what keeps old links working without a generated file per document. It returns
 * null for anything that is not a plausible repository path.
 */
export function legacyRouteToCanonical(pathname, search = "") {
  let path = String(pathname ?? "");
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  path = path.split("#")[0];
  const { ref } = parseQuery(search);

  const doc = /^\/docs\/(.+?)\.html?$/i.exec(path);
  if (doc) {
    const candidate = normalizePath(`docs/${doc[1]}.md`);
    return isDocumentPath(candidate) ? documentRoute(candidate, ref) : null;
  }
  const example = /^\/examples\/(.+?)\.html?$/i.exec(path);
  if (example) {
    const candidate = normalizePath(`examples/${example[1]}.oq`);
    return isExamplePath(candidate) ? exampleRoute(candidate, ref) : null;
  }
  return null;
}

/** True for any `/docs/**` or `/examples/**` path, known or not. */
export function isLegacyContentRoute(pathname) {
  const path = String(pathname ?? "");
  return /^\/(docs|examples)\/.+/i.test(path);
}

/** Human-readable section name from a `docs/` path. Never hard-coded per file. */
export function sectionForPath(path) {
  const parts = normalizeRepoPath(path).split("/");
  if (parts[0] !== "docs") return "Other";
  // docs/README.md sits at the root of the tree.
  if (parts.length <= 2) return "Overview";
  return sectionTitle(parts[1]);
}

/** A readable, title-cased label for a directory or section slug. */
export function sectionTitle(slug) {
  const known = {
    "": "Overview",
    spec: "Specification",
    adr: "Decision records",
    reference: "Reference",
    stdlib: "Standard library",
    guides: "Guides",
  };
  const key = String(slug ?? "").toLowerCase();
  if (Object.hasOwn(known, key)) return known[key];
  const words = key.replace(/[-_]+/g, " ").trim();
  if (!words) return "Documentation";
  return words[0].toUpperCase() + words.slice(1);
}

/** The name a document shows before its Markdown is read: `0003-bytecode.md` -> `Bytecode`. */
export function titleFromPath(path) {
  const parts = normalizeRepoPath(path).split("/");
  const file = parts[parts.length - 1] ?? path;
  if (file.toLowerCase() === "readme.md") {
    return parts.length > 1 ? `${sectionTitle(parts[parts.length - 2])} overview` : "Overview";
  }
  const base = file
    .replace(/\.md$/i, "")
    .replace(/\.oq$/i, "")
    // Leading ADR/mission numbers are noise in a title.
    .replace(/^\d+[-_]/, "");
  const words = base.replace(/[-_]+/g, " ").trim();
  if (!words) return file;
  return words[0].toUpperCase() + words.slice(1);
}

/** The first level-one heading in a Markdown document, ignoring fenced code. */
export function titleFromMarkdown(markdown) {
  let fence = null;
  for (const line of String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      const text = match[1].replace(/[*_`]/g, "").trim();
      if (text) return text;
    }
  }
  return "";
}

function dirname(path) {
  const parts = normalizeRepoPath(path).split("/");
  parts.pop();
  return parts.join("/");
}

function schemeOf(value) {
  const leading = String(value ?? "").replace(CONTROL_OR_SPACE, "");
  // Browsers ignore tabs and newlines inside a scheme (`java\tscript:`), so normalise the
  // probe too. The result is only used for the allow/deny decision, never as a URL.
  const probe = leading.replace(ANY_CONTROL_OR_SPACE, "");
  const match = SCHEME.exec(probe);
  return match ? match[1].toLowerCase() : null;
}

/** A URL that survives the allowlist, or null when it must be dropped. */
export function safeUrl(value) {
  const href = String(value ?? "").trim();
  if (!href) return null;
  if (href.startsWith("#") || href.startsWith("?")) return href;
  const scheme = schemeOf(href);
  if (scheme === null) return href;
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return href;
  return null;
}

/**
 * Resolves a link written inside a Markdown document.
 *
 * Relative targets resolve against the document that contains them, exactly as GitHub does,
 * so `../spec/language.md` in `docs/adr/` opens the language specification page instead of
 * depending on where the site happens to be mounted.
 */
export function resolveRelative(fromPath, href, ref = DEFAULT_REF) {
  const safe = safeUrl(href);
  if (safe === null) return null;
  // A protocol-relative URL inherits the page's scheme and points at whatever host it names.
  // It is resolved explicitly as https so a document cannot produce an ambiguous link.
  if (safe.startsWith("//")) return `https:${safe}`;
  if (/^https?:/i.test(safe) || /^mailto:/i.test(safe)) return safe;
  if (safe.startsWith("#") || safe.startsWith("?")) return safe;

  const hashAt = safe.indexOf("#");
  const queryAt = safe.indexOf("?");
  let cut = safe.length;
  if (hashAt !== -1) cut = Math.min(cut, hashAt);
  if (queryAt !== -1) cut = Math.min(cut, queryAt);
  const target = safe.slice(0, cut);
  const suffix = safe.slice(cut);
  if (!target) return safe;

  const resolved = normalizePath(`${dirname(fromPath)}/${target}`);
  if (isDocumentPath(resolved)) return documentRoute(resolved, ref) + suffix;
  if (resolved === CHANGELOG_PATH) return "/changelog.html" + suffix;
  if (isExamplePath(resolved)) return exampleRoute(resolved, ref) + suffix;
  // Anything else stays a GitHub link at the same ref rather than a broken site route.
  return blobUrl(resolved, ref) + suffix;
}

/** Resolves an image source: relative images come from raw.githubusercontent.com. */
export function resolveImage(fromPath, src, ref = DEFAULT_REF) {
  const safe = safeUrl(src);
  if (safe === null) return null;
  if (safe.startsWith("//")) return `https:${safe}`;
  if (/^https?:/i.test(safe)) return safe;
  if (safe.startsWith("#") || safe.startsWith("?")) return safe;
  if (/^mailto:/i.test(safe)) return null;
  const target = safe.split(/[?#]/)[0];
  if (!target) return null;
  return rawUrl(normalizePath(`${dirname(fromPath)}/${target}`), ref);
}

/** The GitHub tree URL for the documentation root, used by failure states. */
export function docsIndexUrl(ref = DEFAULT_REF) {
  return treeUrl("docs", ref);
}
