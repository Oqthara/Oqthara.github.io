// Detects a new upstream Oqthara release and records the outcome of each sync attempt.
//
// Why a poll and not a `release` event
// ------------------------------------
// A GitHub `release` trigger fires only for releases published in *this* repository. Oqthara
// releases are published in `Oqthara/oqthara`, and that repository cannot dispatch an event
// here without a token committed over there. So this polls.
//
// Fifteen minutes is the cadence. It is far below a human's reaction time to a stale site and
// far above GitHub's scheduling noise: `schedule` runs are best-effort and can be delayed or
// dropped under load.
//
// Catch-up is not a separate mechanism
// ------------------------------------
// Every run compares upstream's newest published release with the last release this repository
// *successfully* synchronized. A skipped or delayed schedule therefore costs nothing: the next
// run sees the same difference and acts on it. Nothing is queued, so nothing can be lost.
//
// Only a successful sync advances the record
// ------------------------------------------
// The state document holds the last successful tag/commit SHA and, separately, the last
// attempt. Advancing on detection would mark a release as synchronized before the mirror
// contained it, and a failed run would then never retry. `decideSync` retries whenever the
// recorded attempt did not succeed.
//
// Idempotence
// -----------
// The decision is a comparison, so a re-run after success decides "no action". The mirror is
// itself hash-based, so even a double-triggered run only rewrites identical bytes.
//
// Usage
//   node scripts/check-upstream-release.mjs                    detect, emit GITHUB_OUTPUT
//   node scripts/check-upstream-release.mjs --dry-run           detect, write no state
//   node scripts/check-upstream-release.mjs --record=ok         record a successful sync
//   node scripts/check-upstream-release.mjs --record=failed     record a failed sync
//
// `--record` reads OQ_RELEASE_TAG / OQ_RELEASE_SHA / OQ_RELEASE_HASH / OQ_RELEASE_DETAIL,
// which the workflow passes through from the detection step.
//
// Exit codes: 0 ok, 1 usage, 2 missing credentials, 3 GitHub failure, 4 Firestore failure.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { REPO, releasesApiUrl } from "../src/source.js";
import { COLLECTIONS, MIRRORED_REF, isNonEmptyString, isPlainObject } from "../src/firebase/collections.js";
import { loadCredentials, openFirestore } from "./sync-firestore.mjs";

export const EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  missingCredentials: 2,
  sourceFailed: 3,
  writeFailed: 4,
});

/** Recorded under `sync/`, which the security rules keep unreadable from a browser. */
export const STATE_COLLECTION = COLLECTIONS.sync;
export const STATE_DOC_ID = "upstream-release";

/** Attempt results. Only `ok` advances the recorded release. */
export const ATTEMPT_RESULT = Object.freeze({ ok: "ok", failed: "failed" });

const FETCH_TIMEOUT_MS = 30 * 1000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "oqthara-site-release-watch",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchJson(url, { token = "", fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: githubHeaders(token) });
    if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function publishedTime(release) {
  const parsed = Date.parse(String(release?.published_at ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The newest published release.
 *
 * `published_at` decides, not list order and not tag order: `v0.1.0-alpha.10` sorts before
 * `v0.1.0-alpha.9` as a string, and the API's order is by creation, not publication. Drafts are
 * skipped because they are not public; a release without a tag cannot be resolved, so it is
 * skipped rather than guessed at.
 */
export function selectLatestRelease(releases) {
  if (!Array.isArray(releases)) return null;
  let latest = null;
  for (const release of releases) {
    if (!isPlainObject(release) || release.draft === true) continue;
    if (!isNonEmptyString(release.tag_name)) continue;
    if (!latest) {
      latest = release;
      continue;
    }
    const candidate = publishedTime(release);
    const best = publishedTime(latest);
    if (candidate > best) latest = release;
    // Same instant: the higher release id wins, which is monotonic in practice.
    else if (candidate === best && Number(release.id ?? 0) > Number(latest.id ?? 0)) latest = release;
  }
  return latest;
}

/** A stable hash of the release fields the site renders, so an edited release body is noticed. */
export function releaseHashOf(release) {
  const fields = [
    String(release?.tag_name ?? "").trim(),
    String(release?.name ?? ""),
    String(release?.body ?? ""),
    String(release?.published_at ?? ""),
    release?.prerelease === true ? "prerelease" : "stable",
  ];
  return createHash("sha256").update(fields.join("\u0000"), "utf8").digest("hex");
}

/** The fields copied out of a raw release, so no untrusted payload is passed around wholesale. */
export function summarizeRelease(release) {
  if (!isPlainObject(release) || !isNonEmptyString(release.tag_name)) return null;
  const tag = release.tag_name.trim();
  return {
    tag,
    releaseId: Number.isFinite(Number(release.id)) ? Number(release.id) : 0,
    name: isNonEmptyString(release.name) ? release.name.trim() : tag,
    publishedAt: isNonEmptyString(release.published_at) ? release.published_at : "",
    prerelease: release.prerelease === true,
    url: isNonEmptyString(release.html_url) ? release.html_url : "",
    hash: releaseHashOf(release),
  };
}

/**
 * Resolves a tag to the commit it points at.
 *
 * `/git/ref/tags/{tag}` returns the *tag object* for an annotated tag, and that object's SHA is
 * not the commit. `/commits/{tag}` resolves either form to the commit, so it is used here. The
 * commit is what makes the record meaningful: a tag can be deleted and re-pointed at different
 * content, and only the SHA identifies the bytes that were mirrored.
 */
export async function resolveTagCommit({ tag, token = "", fetchImpl = fetch } = {}) {
  const name = String(tag ?? "").trim();
  if (!name) throw new Error("a tag is required");
  const url = `https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(name)}`;
  const payload = await fetchJson(url, { token, fetchImpl });
  const sha = typeof payload?.sha === "string" ? payload.sha.trim().toLowerCase() : "";
  if (!SHA_PATTERN.test(sha)) throw new Error(`GitHub returned no commit SHA for ${name}`);
  return sha;
}

/**
 * Whether a release tag is reachable from the branch the mirror follows.
 *
 * The mirror holds `main` and nothing else, so it can only represent a release faithfully when
 * that release was cut from `main`. A tag cut from a side branch points at content `main` never
 * had; mirroring `main` and calling it "the release" would publish different bytes under the
 * release's name. This reports that instead of pretending.
 *
 * `compare/{tag}...main` reports `status` from the tag's perspective: `ahead` or `identical`
 * means `main` is the tag plus later work, so the tag is an ancestor. `diverged` means it is not.
 */
export async function isAncestorOfBranch({ tag, branch = MIRRORED_REF, token = "", fetchImpl = fetch } = {}) {
  const name = String(tag ?? "").trim();
  const base = String(branch ?? MIRRORED_REF).trim() || MIRRORED_REF;
  if (!name) throw new Error("a tag is required");
  const url = `https://api.github.com/repos/${REPO}/compare/${encodeURIComponent(name)}...${encodeURIComponent(base)}`;
  const payload = await fetchJson(url, { token, fetchImpl });
  const status = typeof payload?.status === "string" ? payload.status : "";
  if (!status) throw new Error(`GitHub returned no comparison status for ${name}`);
  return { ancestor: status === "ahead" || status === "identical", status };
}

/**
 * Whether the mirror needs to run. Pure: no I/O, no clock.
 *
 * `recorded` is the state document, or `null` when nothing was recorded yet.
 */
export function decideSync({ latest, recorded } = {}) {
  if (!latest) return { shouldSync: false, changed: false, reason: "upstream has no published release" };
  if (!isPlainObject(recorded)) {
    return { shouldSync: true, changed: true, reason: "no previous sync recorded" };
  }

  const syncedTag = String(recorded.tag ?? "").trim();
  const syncedSha = String(recorded.commitSha ?? "").trim().toLowerCase();
  const syncedHash = String(recorded.releaseHash ?? "").trim();
  const attempt = isPlainObject(recorded.lastAttempt) ? recorded.lastAttempt : null;

  if (syncedTag !== latest.tag) {
    return { shouldSync: true, changed: true, reason: `${syncedTag || "none"} -> ${latest.tag}` };
  }
  if (!SHA_PATTERN.test(syncedSha)) {
    return { shouldSync: true, changed: true, reason: `no commit SHA recorded for ${latest.tag}` };
  }
  if (syncedSha !== String(latest.commitSha ?? "").toLowerCase()) {
    return {
      shouldSync: true,
      changed: true,
      reason: `tag ${latest.tag} moved from ${syncedSha.slice(0, 7)} to ${String(latest.commitSha ?? "").slice(0, 7)}`,
    };
  }
  if (syncedHash && syncedHash !== latest.hash) {
    return { shouldSync: true, changed: true, reason: `release ${latest.tag} changed` };
  }
  // The recorded release matches upstream, but the last attempt at it did not succeed, so the
  // mirror may still be missing it. Retry rather than reporting a freshness the site does not have.
  if (!attempt) {
    return { shouldSync: true, changed: false, reason: `no attempt recorded for ${latest.tag}` };
  }
  if (attempt.result !== ATTEMPT_RESULT.ok) {
    return { shouldSync: true, changed: false, reason: `retrying ${latest.tag} after a failed attempt` };
  }
  if (String(attempt.commitSha ?? "").toLowerCase() !== syncedSha) {
    return { shouldSync: true, changed: false, reason: `retrying ${latest.tag}; last attempt recorded another commit` };
  }
  return { shouldSync: false, changed: false, reason: `already synchronized ${latest.tag}` };
}

/** Reads the state document. `null` means "nothing recorded yet", not a failure. */
export async function readState(db) {
  const snapshot = await db.collection(STATE_COLLECTION).doc(STATE_DOC_ID).get();
  if (!snapshot || typeof snapshot.exists !== "boolean") {
    throw new Error("the Firestore state document could not be read");
  }
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  return isPlainObject(data) ? data : null;
}

/**
 * The fields to merge into `sync/upstream-release`.
 *
 * A successful attempt advances `tag`/`commitSha`/`releaseHash`/`syncedAt`. A failed attempt
 * leaves those alone — they describe the last *successful* sync — and records only what was
 * tried, so the next run retries instead of believing the mirror is current.
 */
export function buildStateUpdate({ release, result, detail = "", syncedAt = new Date().toISOString() }) {
  if (!isPlainObject(release) || !isNonEmptyString(release.tag)) {
    throw new Error("a release is required to record state");
  }
  if (result !== ATTEMPT_RESULT.ok && result !== ATTEMPT_RESULT.failed) {
    throw new Error(`unknown attempt result: ${String(result)}`);
  }
  const commitSha = String(release.commitSha ?? "").toLowerCase();
  if (!SHA_PATTERN.test(commitSha)) throw new Error(`release ${release.tag} has no commit SHA`);

  const lastAttempt = {
    tag: release.tag,
    commitSha,
    result,
    detail: String(detail ?? "").slice(0, 400),
    finishedAt: syncedAt,
  };
  if (result === ATTEMPT_RESULT.failed) {
    return { status: ATTEMPT_RESULT.failed, lastAttempt, lastCheckedAt: syncedAt };
  }
  return {
    tag: release.tag,
    commitSha,
    releaseHash: String(release.hash ?? ""),
    releaseId: Number(release.releaseId ?? 0),
    publishedAt: String(release.publishedAt ?? ""),
    prerelease: release.prerelease === true,
    url: String(release.url ?? ""),
    syncedAt,
    lastCheckedAt: syncedAt,
    lastAttempt,
    status: ATTEMPT_RESULT.ok,
  };
}

/** The `GITHUB_OUTPUT` key=value protocol, without the Actions runtime. */
export function formatOutputs(outputs) {
  const lines = [];
  for (const [key, value] of Object.entries(outputs ?? {})) {
    lines.push(`${key}<<OQ_EOF`, String(value ?? ""), "OQ_EOF");
  }
  return lines.join("\n");
}

/**
 * Where workflow outputs go: the file Actions names in `GITHUB_OUTPUT`, or stdout when the
 * script runs locally. Writing the file directly avoids a shell step having to re-parse the
 * protocol out of the log, which would silently drop anything the log line-wraps.
 */
export function outputWriter(env = process.env, stream = process.stdout) {
  const file = String(env.GITHUB_OUTPUT ?? "").trim();
  if (!file) return (text) => stream.write(`${text}\n`);
  return async (text) => {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, `${text}\n`, "utf8");
  };
}

/** Parses the supported flags. Unknown flags are a usage error, not a silent no-op. */
export function parseArgs(argv = []) {
  const options = { dryRun: false, help: false, record: "" };
  const unknown = [];
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--record=")) options.record = arg.slice("--record=".length).trim();
    else unknown.push(arg);
  }
  return { options, unknown };
}

export const USAGE = `Usage: node scripts/check-upstream-release.mjs [--dry-run] [--record=ok|failed]

  (no flag)         Detect the newest upstream release and emit workflow outputs.
  --dry-run         Detect and print, writing no Firestore state.
  --record=RESULT   Record a sync outcome. Reads OQ_RELEASE_TAG, OQ_RELEASE_SHA,
                    OQ_RELEASE_HASH and OQ_RELEASE_DETAIL.

Exit codes: 0 ok, 1 usage, 2 missing credentials, 3 GitHub failure, 4 Firestore failure.`;

export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    log = (...args) => console.log(...args),
    error = (...args) => console.error(...args),
    output = outputWriter(env),
    listReleases = ({ token }) => fetchJson(releasesApiUrl(100), { token }),
    resolveCommit = resolveTagCommit,
    compare = isAncestorOfBranch,
    credentials = loadCredentials,
    openDb = openFirestore,
    now = new Date().toISOString(),
  } = {},
) {
  const { options, unknown } = parseArgs(argv);
  if (options.help) {
    log(USAGE);
    return EXIT.ok;
  }
  if (unknown.length) {
    error(`Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
    error(USAGE);
    return EXIT.usage;
  }

  const resolved = await credentials(env);

  if (options.record) {
    if (options.record !== ATTEMPT_RESULT.ok && options.record !== ATTEMPT_RESULT.failed) {
      error(`--record must be "ok" or "failed", not "${options.record}"`);
      return EXIT.usage;
    }
    const release = {
      tag: String(env.OQ_RELEASE_TAG ?? "").trim(),
      commitSha: String(env.OQ_RELEASE_SHA ?? "").trim(),
      hash: String(env.OQ_RELEASE_HASH ?? "").trim(),
    };
    if (!release.tag || !SHA_PATTERN.test(release.commitSha.toLowerCase())) {
      error("--record needs OQ_RELEASE_TAG and a 40-character OQ_RELEASE_SHA");
      return EXIT.usage;
    }
    if (!resolved.ok) {
      error(resolved.reason);
      return EXIT.missingCredentials;
    }
    let update;
    try {
      update = buildStateUpdate({ release, result: options.record, detail: env.OQ_RELEASE_DETAIL ?? "", syncedAt: now });
    } catch (cause) {
      error(cause.message);
      return EXIT.usage;
    }
    try {
      const db = await openDb(resolved.serviceAccount);
      await db.collection(STATE_COLLECTION).doc(STATE_DOC_ID).set(update, { merge: true });
    } catch (cause) {
      error(`Could not record the sync result: ${cause?.message ?? cause}`);
      return EXIT.writeFailed;
    }
    log(`recorded ${options.record} for ${release.tag} (${release.commitSha.slice(0, 7)})`);
    return EXIT.ok;
  }

  // Detection needs no credential to read GitHub, but it needs one to know what was already
  // synchronized. Without it the comparison cannot be made, so this fails closed instead of
  // reporting "no change" over an unread state.
  if (!resolved.ok && !options.dryRun) {
    error(resolved.reason);
    return EXIT.missingCredentials;
  }

  const token = String(env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "").trim();
  let raw;
  try {
    raw = await listReleases({ token });
  } catch (cause) {
    error(`Could not read upstream releases: ${cause?.message ?? cause}`);
    return EXIT.sourceFailed;
  }

  const latest = summarizeRelease(selectLatestRelease(raw));
  if (!latest) {
    log("upstream has no published release; nothing to synchronize");
    await output(formatOutputs({ changed: "false", tag: "", sha: "", hash: "", reason: "no published upstream release" }));
    return EXIT.ok;
  }

  try {
    latest.commitSha = await resolveCommit({ tag: latest.tag, token });
  } catch (cause) {
    error(`Could not resolve ${latest.tag} to a commit: ${cause?.message ?? cause}`);
    return EXIT.sourceFailed;
  }

  // The mirror holds `main` only. A tag cut from a side branch cannot be represented by
  // mirroring `main`, so say so instead of publishing different content under its name.
  try {
    const ancestry = await compare({ tag: latest.tag, token });
    if (!ancestry.ancestor) {
      error(
        `::error::${latest.tag} is not an ancestor of ${MIRRORED_REF} (comparison: ${ancestry.status}). ` +
          "The mirror follows main, so it cannot represent this release. Merge the release into main first.",
      );
      return EXIT.sourceFailed;
    }
  } catch (cause) {
    error(`Could not compare ${latest.tag} with ${MIRRORED_REF}: ${cause?.message ?? cause}`);
    return EXIT.sourceFailed;
  }

  let recorded = null;
  let db = null;
  if (resolved.ok) {
    try {
      db = await openDb(resolved.serviceAccount);
      recorded = await readState(db);
    } catch (cause) {
      error(`Could not read the recorded sync state: ${cause?.message ?? cause}`);
      return EXIT.writeFailed;
    }
  }

  const decision = decideSync({ latest, recorded });
  log(`upstream latest release: ${latest.tag} at ${latest.commitSha}`);
  log(`decision: ${decision.shouldSync ? "synchronize" : "no action"} — ${decision.reason}`);

  if (options.dryRun) {
    log("dry run: nothing was written");
  } else {
    try {
      await db.collection(STATE_COLLECTION).doc(STATE_DOC_ID).set(
        { lastCheckedAt: now, observed: { tag: latest.tag, commitSha: latest.commitSha, hash: latest.hash } },
        { merge: true },
      );
    } catch (cause) {
      error(`Could not record the observation: ${cause?.message ?? cause}`);
      return EXIT.writeFailed;
    }
  }

  await output(
    formatOutputs({
      changed: String(decision.shouldSync),
      reason: decision.reason,
      tag: latest.tag,
      sha: latest.commitSha,
      hash: latest.hash,
      name: latest.name,
      url: latest.url,
      prerelease: String(latest.prerelease),
      published_at: latest.publishedAt,
    }),
  );
  return EXIT.ok;
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (cause) => {
      console.error(`check-upstream-release failed: ${cause?.message ?? cause}`);
      process.exitCode = EXIT.writeFailed;
    },
  );
}
