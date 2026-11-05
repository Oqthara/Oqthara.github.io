// The single place that knows where documentation lives.
//
// Every URL the site builds for Markdown, images, source links and channels goes through
// this module. It is deliberately free of React and of `fetch`, which keeps the routing
// rules testable in plain Node and stops a component from inventing its own GitHub URL.

import { CHANNELS, DEFAULT_CHANNEL, channelById, channelForRef } from "./releases.js";

export { CHANNELS, DEFAULT_CHANNEL, channelById, channelForRef };

/** The GitHub tree URL for a repository path, used by failure states. */
export const DOC_INDEX_URL = "https://github.com/Oqthara/oqthara/tree/main/docs";

export const REPO = "Oqthara/oqthara";
export const DEFAULT_REF = "main";

const CONTROL_OR_SPACE = /^[\u0000-\u0020]+/;
const ANY_CONTROL_OR_SPACE = /[\u0000-\u0020]+/g;
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/** Repository-relative path without a leading slash or `./`. */
export function normalizeRepoPath(path) {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^\.\//, "");
}

function encodePath(path) {
  return normalizeRepoPath(path)
    .split("/")
    .filter((part) => part !== "")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/** `https://raw.githubusercontent.com/Oqthara/oqthara/<ref>/<path>` */
export function rawUrl(path, ref = DEFAULT_REF) {
  return `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(ref)}/${encodePath(path)}`;
}

/** `https://github.com/Oqthara/oqthara/blob/<ref>/<path>` (the "view the original" link). */
export function blobUrl(path, ref = DEFAULT_REF) {
  return `https://github.com/${REPO}/blob/${encodeURIComponent(ref)}/${encodePath(path)}`;
}

/** `https://github.com/Oqthara/oqthara/tree/<ref>/<dir>` for a directory fallback. */
export function treeUrl(path = "docs", ref = DEFAULT_REF) {
  return `https://github.com/${REPO}/tree/${encodeURIComponent(ref)}/${encodePath(path)}`;
}

/** The site route for a repository Markdown file. `CHANGELOG.md` has its own page. */
export function routeForDocPath(path) {
  const repoPath = normalizeRepoPath(path);
  if (repoPath === "CHANGELOG.md" || repoPath === "changelog.md") return "/changelog.html";
  return `/${repoPath.replace(/\.md$/i, ".html")}`;
}

/** `/_site` file name for a site route. */
export function fileForRoute(route) {
  return String(route).replace(/^\/+/, "");
}

/** A catalog entry or raw path turned into the site page that renders it. */
export function routeForDoc(entryOrPath) {
  if (entryOrPath && typeof entryOrPath === "object" && typeof entryOrPath.path === "string") {
    return routeForDocPath(entryOrPath.path);
  }
  return routeForDocPath(entryOrPath);
}

/** Adds the channel query parameter when the channel is not `main`. */
export function withChannel(route, ref = DEFAULT_REF) {
  if (!ref || ref === DEFAULT_REF) return route;
  const join = route.includes("?") ? "&" : "?";
  return `${route}${join}ref=${encodeURIComponent(ref)}`;
}

/** The documentation path a site route names, or null when it is not a document route. */
export function docPathFromRoute(route) {
  let path = String(route ?? "").split("?")[0].split("#")[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (path === "/changelog.html") return "CHANGELOG.md";
  if (!path.startsWith("/docs/") || path === "/docs/") return null;
  const relative = path.slice(1).replace(/\.html?$/i, "");
  if (!relative || relative.endsWith("/")) return null;
  const normalized = relative
    .split("/")
    .reduce((parts, part) => {
      if (part === "" || part === ".") return parts;
      if (part === "..") parts.pop();
      else parts.push(part);
      return parts;
    }, []);
  if (normalized[0] !== "docs" || normalized.length < 2) return null;
  return `${normalized.join("/")}.md`;
}

/** True for any `/docs/...` route, including an unknown one that must become a real 404. */
export function isDocRoute(route) {
  const path = String(route ?? "").split("?")[0].split("#")[0];
  return path.startsWith("/docs/") && path !== "/docs/" && !path.endsWith("/");
}

/** `a/./b/../c` -> `a/c`, without Node's path module so the browser bundle shares it. */
export function normalizePath(path) {
  const parts = [];
  for (const part of String(path ?? "").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function dirname(path) {
  const parts = normalizeRepoPath(path).split("/");
  parts.pop();
  return parts.join("/");
}

function schemeOf(value) {
  const leading = String(value ?? "").replace(CONTROL_OR_SPACE, "");
  // Browsers ignore tabs and newlines inside a scheme (`java\tscript:`), so normalise the
  // probe too. The returned value is only used for the allow/deny decision.
  const probe = leading.replace(ANY_CONTROL_OR_SPACE, "");
  const match = SCHEME.exec(probe);
  return match ? match[1].toLowerCase() : null;
}

/** A URL that survives the allowlist, or null when it must be dropped. */
export function safeUrl(value) {
  const href = String(value ?? "").trim();
  if (!href) return null;
  if (href.startsWith("#")) return href;
  if (href.startsWith("?")) return href;
  const scheme = schemeOf(href);
  if (scheme === null) return href;
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return href;
  return null;
}

/**
 * Resolves a link written inside `fromPath` (a repository-relative Markdown path).
 *
 * - absolute http(s) and mailto URLs are returned unchanged;
 * - a relative `.md` file becomes its site route (with the channel query preserved);
 * - a relative non-Markdown file becomes its GitHub blob URL;
 * - any other scheme, including `javascript:`, `data:` and `vbscript:`, is dropped.
 */
export function resolveRelative(fromPath, href, ref = DEFAULT_REF) {
  const safe = safeUrl(href);
  if (safe === null) return null;
  if (/^https?:/i.test(safe) || /^mailto:/i.test(safe) || safe.startsWith("//")) return safe;
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
  if (resolved.toLowerCase().endsWith(".md")) {
    if (resolved.startsWith("docs/")) return withChannel(routeForDocPath(resolved), ref) + suffix;
    if (resolved === "CHANGELOG.md") return withChannel("/changelog.html", ref) + suffix;
    return blobUrl(resolved, ref) + suffix;
  }
  return blobUrl(resolved, ref) + suffix;
}

/** Resolves an image source: relative images come from raw.githubusercontent.com. */
export function resolveImage(fromPath, src, ref = DEFAULT_REF) {
  const safe = safeUrl(src);
  if (safe === null) return null;
  if (/^https?:/i.test(safe) || safe.startsWith("//")) return safe;
  if (safe.startsWith("#") || safe.startsWith("?")) return safe;
  if (/^mailto:/i.test(safe)) return null;
  const target = safe.split(/[?#]/)[0];
  if (!target) return null;
  return rawUrl(normalizePath(`${dirname(fromPath)}/${target}`), ref);
}

/** Short human label for a catalog section; unknown sections are title-cased. */
export function sectionTitle(section) {
  const known = {
    "": "Guides",
    spec: "Specification",
    adr: "Decision records",
    reference: "Reference",
    stdlib: "Standard library",
  };
  if (Object.hasOwn(known, section ?? "")) return known[section ?? ""];
  const value = String(section ?? "").replace(/[-_]+/g, " ").trim();
  return value ? value[0].toUpperCase() + value.slice(1) : "Documentation";
}
