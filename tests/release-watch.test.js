// Tests for the upstream release watcher.
//
// No network and no Firebase project: `listReleases`, `resolveTagCommit`, the ancestry
// comparison and the Firestore handle are all injected, so every decision runs as a plain
// function call. What is being tested is the decision, not GitHub.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTEMPT_RESULT,
  EXIT,
  STATE_DOC_ID,
  buildStateUpdate,
  decideSync,
  formatOutputs,
  isAncestorOfBranch,
  listAllReleases,
  main,
  parseArgs,
  releaseHashOf,
  resolveTagCommit,
  selectLatestRelease,
  summarizeRelease,
} from "../scripts/check-upstream-release.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function release(overrides = {}) {
  return {
    id: 1,
    tag_name: "v0.1.0-alpha.2",
    name: "Oqthara 0.1.0-alpha.2",
    body: "Notes",
    draft: false,
    prerelease: true,
    published_at: "2026-11-05T22:18:00Z",
    html_url: "https://github.com/Oqthara/oqthara/releases/tag/v0.1.0-alpha.2",
    ...overrides,
  };
}

/** A Firestore stub: one document, `merge` honoured, reads reflect writes. */
function fakeDb(initial = null) {
  const documents = new Map();
  if (initial) documents.set(STATE_DOC_ID, initial);
  const writes = [];
  return {
    writes,
    documents,
    collection(name) {
      assert.equal(name, "sync", "state belongs in the sync collection");
      return {
        doc(id) {
          return {
            async get() {
              const data = documents.get(id) ?? null;
              return { exists: data !== null, data: () => data };
            },
            async set(data, options) {
              if (options?.merge) documents.set(id, { ...(documents.get(id) ?? {}), ...data });
              else documents.set(id, { ...data });
              writes.push(data);
            },
          };
        },
      };
    },
  };
}

function fakeCredentials(present = true) {
  return async () => (present ? { ok: true, serviceAccount: {} } : { ok: false, reason: "no credential" });
}

/** Runs `main` with the given stubs, capturing logging and the emitted workflow outputs. */
async function run(argv, overrides = {}) {
  const lines = [];
  const errors = [];
  const outputs = [];
  const code = await main(argv, {
    env: { GITHUB_TOKEN: "test" },
    log: (...args) => lines.push(args.join(" ")),
    error: (...args) => errors.push(args.join(" ")),
    output: (text) => outputs.push(text),
    listReleases: async () => [release()],
    resolveCommit: async () => SHA_A,
    compare: async () => ({ ancestor: true, status: "ahead" }),
    credentials: fakeCredentials(),
    openDb: async () => fakeDb(),
    ...overrides,
  });
  const text = outputs.join("\n");
  const parsed = {};
  for (const match of text.matchAll(/^(\w+)<<OQ_EOF\n([\s\S]*?)\nOQ_EOF$/gm)) parsed[match[1]] = match[2];
  return { code, lines, errors, outputs: parsed, raw: text };
}

// --- release selection --------------------------------------------------------------------

test("the newest release is chosen by publication time, not list order", () => {
  const older = release({ tag_name: "v0.1.0-alpha.10", published_at: "2026-11-04T00:00:00Z", id: 10 });
  const newer = release({ tag_name: "v0.1.0-alpha.9", published_at: "2026-11-05T00:00:00Z", id: 9 });
  // Tag string order would pick alpha.10; publication time must pick alpha.9.
  assert.equal(selectLatestRelease([older, newer]).tag_name, "v0.1.0-alpha.9");
  assert.equal(selectLatestRelease([newer, older]).tag_name, "v0.1.0-alpha.9");
});

test("drafts, malformed entries and missing tags are never selected", () => {
  assert.equal(selectLatestRelease([release({ draft: true })]), null);
  assert.equal(selectLatestRelease([release({ tag_name: "" })]), null);
  assert.equal(selectLatestRelease([release({ tag_name: 42 })]), null);
  assert.equal(selectLatestRelease([null, "x", 5]), null);
  assert.equal(selectLatestRelease([]), null);
  assert.equal(selectLatestRelease(undefined), null);
  // A draft newer than a published release does not win.
  const draft = release({ tag_name: "v0.2.0", draft: true, published_at: "2026-12-01T00:00:00Z", id: 99 });
  assert.equal(selectLatestRelease([draft, release()]).tag_name, "v0.1.0-alpha.2");
});

test("an identical publication instant falls back to the higher release id", () => {
  const low = release({ tag_name: "v0.1", id: 1 });
  const high = release({ tag_name: "v0.2", id: 2 });
  assert.equal(selectLatestRelease([low, high]).tag_name, "v0.2");
  assert.equal(selectLatestRelease([high, low]).tag_name, "v0.2");
});

test("summarizeRelease copies the rendered fields and hashes them", () => {
  const summary = summarizeRelease(release());
  assert.equal(summary.tag, "v0.1.0-alpha.2");
  assert.equal(summary.prerelease, true);
  assert.match(summary.hash, /^[0-9a-f]{64}$/);
  assert.equal(summarizeRelease({ name: "no tag" }), null);
  assert.equal(summarizeRelease(null), null);
});

test("the release hash changes when a rendered field changes, and is stable otherwise", () => {
  const base = releaseHashOf(release());
  assert.equal(base, releaseHashOf(release()));
  assert.notEqual(base, releaseHashOf(release({ body: "Edited" })));
  assert.notEqual(base, releaseHashOf(release({ name: "Renamed" })));
  assert.notEqual(base, releaseHashOf(release({ prerelease: false })));
  // Fields the site does not render must not cause a needless resync.
  assert.equal(base, releaseHashOf(release({ id: 77, html_url: "https://example.test/x" })));
});

// --- the decision -------------------------------------------------------------------------

test("a first run synchronizes", () => {
  const latest = { ...summarizeRelease(release()), commitSha: SHA_A };
  const decision = decideSync({ latest, recorded: null });
  assert.equal(decision.shouldSync, true);
  assert.equal(decision.changed, true);
});

test("an already synchronized release is a no-op, so a re-run is safe", () => {
  const latest = { ...summarizeRelease(release()), commitSha: SHA_A };
  const recorded = buildStateUpdate({ release: latest, result: ATTEMPT_RESULT.ok });
  assert.equal(decideSync({ latest, recorded }).shouldSync, false);
  // Running the decision twice with the same inputs must not change its answer.
  assert.equal(decideSync({ latest, recorded }).shouldSync, false);
});

test("a new tag synchronizes", () => {
  const first = { ...summarizeRelease(release()), commitSha: SHA_A };
  const recorded = buildStateUpdate({ release: first, result: ATTEMPT_RESULT.ok });
  const next = { ...summarizeRelease(release({ tag_name: "v0.1.0-alpha.3" })), commitSha: SHA_B };
  const decision = decideSync({ latest: next, recorded });
  assert.equal(decision.shouldSync, true);
  assert.match(decision.reason, /v0\.1\.0-alpha\.2 -> v0\.1\.0-alpha\.3/);
});

test("a tag re-pointed at another commit synchronizes even though the tag is unchanged", () => {
  const latest = { ...summarizeRelease(release()), commitSha: SHA_A };
  const recorded = buildStateUpdate({ release: latest, result: ATTEMPT_RESULT.ok });
  const moved = { ...latest, commitSha: SHA_B };
  const decision = decideSync({ latest: moved, recorded });
  assert.equal(decision.shouldSync, true);
  assert.match(decision.reason, /moved/);
});

test("an edited release body synchronizes", () => {
  const latest = { ...summarizeRelease(release()), commitSha: SHA_A };
  const recorded = buildStateUpdate({ release: latest, result: ATTEMPT_RESULT.ok });
  const edited = { ...summarizeRelease(release({ body: "Rewritten notes" })), commitSha: SHA_A };
  assert.equal(decideSync({ latest: edited, recorded }).shouldSync, true);
});

test("a failed attempt is retried instead of being treated as synchronized", () => {
  const latest = { ...summarizeRelease(release()), commitSha: SHA_A };
  const success = buildStateUpdate({ release: latest, result: ATTEMPT_RESULT.ok });
  // A later attempt failed; the recorded release still describes the last success.
  const failed = { ...success, ...buildStateUpdate({ release: latest, result: ATTEMPT_RESULT.failed }) };
  const decision = decideSync({ latest, recorded: failed });
  assert.equal(decision.shouldSync, true);
  assert.equal(decision.changed, false);
  assert.match(decision.reason, /retrying/);
});

test("a recorded release without an attempt record is retried, not assumed current", () => {
  const latest = { ...summarizeRelease(release()), commitSha: SHA_A };
  const recorded = { tag: latest.tag, commitSha: SHA_A, releaseHash: latest.hash };
  assert.equal(decideSync({ latest, recorded }).shouldSync, true);
});

test("a recorded release with a malformed SHA is repaired rather than trusted", () => {
  const latest = { ...summarizeRelease(release()), commitSha: SHA_A };
  const recorded = { tag: latest.tag, commitSha: "not-a-sha", releaseHash: latest.hash };
  assert.equal(decideSync({ latest, recorded }).shouldSync, true);
});

test("no upstream release means no sync and no error", () => {
  const decision = decideSync({ latest: null, recorded: null });
  assert.equal(decision.shouldSync, false);
  assert.equal(decision.changed, false);
});

// --- recorded state -----------------------------------------------------------------------

test("a successful attempt advances the recorded release", () => {
  const release_ = { ...summarizeRelease(release()), commitSha: SHA_A };
  const now = "2026-11-06T00:00:00.000Z";
  const update = buildStateUpdate({ release: release_, result: ATTEMPT_RESULT.ok, syncedAt: now });
  assert.equal(update.tag, "v0.1.0-alpha.2");
  assert.equal(update.commitSha, SHA_A);
  assert.equal(update.releaseHash, release_.hash);
  assert.equal(update.syncedAt, now);
  assert.equal(update.status, ATTEMPT_RESULT.ok);
  assert.equal(update.lastAttempt.result, ATTEMPT_RESULT.ok);
});

test("a failed attempt never advances the recorded release", () => {
  const release_ = { ...summarizeRelease(release()), commitSha: SHA_A };
  const update = buildStateUpdate({ release: release_, result: ATTEMPT_RESULT.failed, detail: "Firestore 503" });
  assert.equal(update.tag, undefined, "a failure must not record the release as synchronized");
  assert.equal(update.commitSha, undefined);
  assert.equal(update.releaseHash, undefined);
  assert.equal(update.status, ATTEMPT_RESULT.failed);
  assert.equal(update.lastAttempt.result, ATTEMPT_RESULT.failed);
  assert.equal(update.lastAttempt.detail, "Firestore 503");
});

test("recording rejects an unknown result and a missing commit", () => {
  const release_ = { ...summarizeRelease(release()), commitSha: SHA_A };
  assert.throws(() => buildStateUpdate({ release: release_, result: "maybe" }), /unknown attempt result/);
  assert.throws(() => buildStateUpdate({ release: { tag: "v1" }, result: ATTEMPT_RESULT.ok }), /commit SHA/);
  assert.throws(() => buildStateUpdate({ release: null, result: ATTEMPT_RESULT.ok }), /release is required/);
});

// --- GitHub lookups -----------------------------------------------------------------------

test("resolveTagCommit returns the commit SHA GitHub reports", async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /\/commits\/v0\.1\.0-alpha\.2$/);
    return { ok: true, json: async () => ({ sha: SHA_A.toUpperCase() }) };
  };
  assert.equal(await resolveTagCommit({ tag: "v0.1.0-alpha.2", fetchImpl }), SHA_A);
});

test("resolveTagCommit rejects a response without a commit SHA", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ sha: "short" }) });
  await assert.rejects(() => resolveTagCommit({ tag: "v1", fetchImpl }), /no commit SHA/);
});

test("resolveTagCommit surfaces an HTTP failure", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(() => resolveTagCommit({ tag: "v1", fetchImpl }), /404/);
});

test("ancestry is read from the comparison status", async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /\/compare\/v1\.\.\.main$/);
    return { ok: true, json: async () => ({ status: "ahead" }) };
  };
  assert.deepEqual(await isAncestorOfBranch({ tag: "v1", fetchImpl }), { ancestor: true, status: "ahead" });

  const identical = async () => ({ ok: true, json: async () => ({ status: "identical" }) });
  assert.equal((await isAncestorOfBranch({ tag: "v1", fetchImpl: identical })).ancestor, true);

  const diverged = async () => ({ ok: true, json: async () => ({ status: "diverged" }) });
  assert.equal((await isAncestorOfBranch({ tag: "v1", fetchImpl: diverged })).ancestor, false);
});

// --- CLI ----------------------------------------------------------------------------------

test("the output protocol round-trips a multi-line value", () => {
  const text = formatOutputs({ changed: "true", reason: "line one\nline two" });
  const parsed = {};
  for (const match of text.matchAll(/^(\w+)<<OQ_EOF\n([\s\S]*?)\nOQ_EOF$/gm)) parsed[match[1]] = match[2];
  assert.equal(parsed.changed, "true");
  assert.equal(parsed.reason, "line one\nline two");
});

test("parseArgs rejects unknown flags and accepts the documented ones", () => {
  assert.deepEqual(parseArgs([]).options, { dryRun: false, help: false, record: "" });
  assert.equal(parseArgs(["--dry-run"]).options.dryRun, true);
  assert.equal(parseArgs(["--record=ok"]).options.record, "ok");
  assert.deepEqual(parseArgs(["--nope"]).unknown, ["--nope"]);
});

test("a first run emits changed=true and records only the observation", async () => {
  const db = fakeDb();
  const result = await run([], { openDb: async () => db });
  assert.equal(result.code, EXIT.ok);
  assert.equal(result.outputs.changed, "true");
  assert.equal(result.outputs.sha, SHA_A);
  assert.equal(result.outputs.tag, "v0.1.0-alpha.2");
  // Detection must not claim the release is synchronized.
  const stored = db.documents.get(STATE_DOC_ID);
  assert.equal(stored.tag, undefined);
  assert.equal(stored.observed.tag, "v0.1.0-alpha.2");
});

test("a second run over recorded state emits changed=false and writes no release", async () => {
  const latest = { ...summarizeRelease(release()), commitSha: SHA_A };
  const db = fakeDb(buildStateUpdate({ release: latest, result: ATTEMPT_RESULT.ok }));
  const result = await run([], { openDb: async () => db });
  assert.equal(result.code, EXIT.ok);
  assert.equal(result.outputs.changed, "false");
  assert.match(result.outputs.reason, /already synchronized/);
  assert.equal(db.documents.get(STATE_DOC_ID).tag, "v0.1.0-alpha.2");
});

test("a release that is not an ancestor of main fails loudly instead of mirroring main", async () => {
  const result = await run([], { compare: async () => ({ ancestor: false, status: "diverged" }) });
  assert.equal(result.code, EXIT.sourceFailed);
  assert.equal(result.outputs.changed, undefined);
  assert.match(result.errors.join("\n"), /not an ancestor of main/);
});

test("a GitHub failure is reported as a source failure, not a clean run", async () => {
  const result = await run([], {
    listReleases: async () => {
      throw new Error("GitHub returned 502");
    },
  });
  assert.equal(result.code, EXIT.sourceFailed);
  assert.match(result.errors.join("\n"), /502/);
});

test("a missing credential fails closed unless it is a dry run", async () => {
  const live = await run([], { credentials: fakeCredentials(false) });
  assert.equal(live.code, EXIT.missingCredentials);

  const db = fakeDb();
  const dry = await run(["--dry-run"], {
    credentials: fakeCredentials(false),
    openDb: async () => {
      throw new Error("a dry run must not open Firestore");
    },
  });
  assert.equal(dry.code, EXIT.ok);
  assert.equal(dry.outputs.changed, "true", "a dry run over unusable state reports what it would do");
  assert.equal(db.writes.length, 0);
});

test("a Firestore read failure stops the run instead of guessing", async () => {
  const result = await run([], {
    openDb: async () => {
      throw new Error("permission denied");
    },
  });
  assert.equal(result.code, EXIT.writeFailed);
  assert.match(result.errors.join("\n"), /permission denied/);
});

test("--record=ok writes the release, and --record=failed does not", async () => {
  const okDb = fakeDb();
  const ok = await run(["--record=ok"], {
    env: { OQ_RELEASE_TAG: "v0.1.0-alpha.2", OQ_RELEASE_SHA: SHA_A, OQ_RELEASE_HASH: "hash" },
    openDb: async () => okDb,
  });
  assert.equal(ok.code, EXIT.ok);
  assert.equal(okDb.documents.get(STATE_DOC_ID).tag, "v0.1.0-alpha.2");
  assert.equal(okDb.documents.get(STATE_DOC_ID).status, "ok");

  const failedDb = fakeDb(buildStateUpdate({ release: { ...summarizeRelease(release()), commitSha: SHA_A }, result: ATTEMPT_RESULT.ok }));
  const failed = await run(["--record=failed"], {
    env: { OQ_RELEASE_TAG: "v0.1.0-alpha.3", OQ_RELEASE_SHA: SHA_B, OQ_RELEASE_DETAIL: "Firestore 503" },
    openDb: async () => failedDb,
  });
  assert.equal(failed.code, EXIT.ok);
  const stored = failedDb.documents.get(STATE_DOC_ID);
  assert.equal(stored.tag, "v0.1.0-alpha.2", "a failure must not advance the recorded release");
  assert.equal(stored.lastAttempt.result, "failed");
  assert.equal(stored.lastAttempt.detail, "Firestore 503");
});

test("--record rejects a bad result, a missing tag and a malformed SHA", async () => {
  assert.equal((await run(["--record=maybe"], { env: {} })).code, EXIT.usage);
  assert.equal((await run(["--record=ok"], { env: {} })).code, EXIT.usage);
  assert.equal(
    (await run(["--record=ok"], { env: { OQ_RELEASE_TAG: "v1", OQ_RELEASE_SHA: "abc" } })).code,
    EXIT.usage,
  );
});

test("--record without a credential is a credential error, not a silent success", async () => {
  const result = await run(["--record=ok"], {
    env: { OQ_RELEASE_TAG: "v1", OQ_RELEASE_SHA: SHA_A },
    credentials: fakeCredentials(false),
  });
  assert.equal(result.code, EXIT.missingCredentials);
});

test("no upstream release is a clean no-op with changed=false", async () => {
  const result = await run([], { listReleases: async () => [] });
  assert.equal(result.code, EXIT.ok);
  assert.equal(result.outputs.changed, "false");
  assert.match(result.lines.join("\n"), /no published release/);
});

test("an unknown flag is a usage error", async () => {
  assert.equal((await run(["--verbose"])).code, EXIT.usage);
  assert.equal((await run(["--help"])).code, EXIT.ok);
});

test("a hostile release tag is refused at the boundary", () => {
  // The tag is the only untrusted value here that is chosen by whoever can write to the mirrored
  // repository. It reaches shell source through the workflow, so it is constrained once, here.
  assert.equal(summarizeRelease({ tag_name: "v0.1.0-alpha.2" })?.tag, "v0.1.0-alpha.2");
  for (const tag of ["v1.0.0", "release/1.2.3", "v1.0.0+build.7", "v2.0.0-rc_1"]) {
    assert.equal(summarizeRelease({ tag_name: tag })?.tag, tag, `${tag} was refused`);
  }
  for (const tag of ["v1$(id)", "v1`id`", "v1;id", "v1&&id", "v1|id", "v1\nid", "v1\r\nid", "v1'id", 'v1"id']) {
    assert.equal(summarizeRelease({ tag_name: tag }), null, `${JSON.stringify(tag)} was accepted`);
  }
  assert.equal(summarizeRelease({ tag_name: "v" + "9".repeat(200) }), null, "an overlong tag was accepted");
});

test("GITHUB_OUTPUT values cannot terminate their block early", () => {
  // Parses the file the way the Actions runner does: a heredoc delimiter chosen by the writer,
  // closed by the first line that matches it exactly. If a value can contain the delimiter, the
  // value ends early and the remainder is read as further outputs.
  const parse = (text) => {
    const out = {};
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\w+)<<(.+)$/.exec(lines[i]);
      if (!m) continue;
      const body = [];
      for (i++; i < lines.length && lines[i] !== m[2]; i++) body.push(lines[i]);
      out[m[1]] = body.join("\n");
    }
    return out;
  };

  const hostile = "x\nOQ_EOF\nchanged<<OQ_EOF\nfalse\nOQ_EOF";
  const parsed = parse(formatOutputs({ reason: hostile, changed: "true", tag: "v1.0.0" }));
  assert.deepEqual(Object.keys(parsed).sort(), ["changed", "reason", "tag"], "an injected key appeared");
  assert.equal(parsed.changed, "true", "an injected value overwrote a real output");
  assert.equal(parsed.reason, hostile, "a value did not survive the round trip");
  assert.equal(parsed.tag, "v1.0.0");
});

// --- reading the release list --------------------------------------------------------------

test("every page is read, so a release past the hundredth still counts", async () => {
  // The defect: one request, `per_page=100`. GitHub returns the hundred newest *by creation*, so
  // on a repository past that line an older-but-newer-by-publication release was invisible and the
  // detector would record a superseded release as current - or report no change at all.
  const pages = [
    Array.from({ length: 100 }, (_, i) => release({ id: i + 1, tag_name: `v1.0.${i}` })),
    [release({ id: 999, tag_name: "v2.0.0", published_at: "2027-01-01T00:00:00Z" })],
  ];
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const page = Number(new URL(url).searchParams.get("page") ?? 1);
    return { ok: true, json: async () => pages[page - 1] ?? [] };
  };

  const releases = await listAllReleases({ fetchImpl });
  assert.equal(releases.length, 101, "the second page must be included");
  assert.ok(releases.some((r) => r.tag_name === "v2.0.0"));
  assert.equal(requested.length, 2, "a full page must be followed by another request");

  const latest = selectLatestRelease(releases);
  assert.equal(latest.tag_name, "v2.0.0", "publication time decides, not page position");
});

test("a short page ends the read without an extra request", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return { ok: true, json: async () => [release()] };
  };
  assert.equal((await listAllReleases({ fetchImpl })).length, 1);
  assert.equal(requested.length, 1, "a short page proves there is no next page");
});

test("an endless list is a refusal, not a partial answer", async () => {
  // Reaching the bound means the set is not provably complete, and an incomplete set is how the
  // recorded state concludes a release was never published - which unpublishes mirrored content.
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => Array.from({ length: 100 }, () => release()) };
  };
  await assert.rejects(() => listAllReleases({ fetchImpl }), /not provably complete/);
  assert.equal(calls, 20, "the bound must be what stops the loop");
});

test("a malformed release list is refused", async () => {
  await assert.rejects(
    () => listAllReleases({ fetchImpl: async () => ({ ok: true, json: async () => ({ releases: [] }) }) }),
    /could not read/,
  );
});

test("drafts and malformed entries never win, whatever their timestamp", () => {
  const newest = release({ id: 9, tag_name: "v3.0.0", published_at: "2027-06-01T00:00:00Z" });
  const chosen = selectLatestRelease([
    release({ id: 1, published_at: "2026-01-01T00:00:00Z" }),
    { ...newest, draft: true },
    { ...newest, id: 10, tag_name: "" },
    { ...newest, id: 11, published_at: "not a date" },
    { ...newest, id: 12, tag_name: "v2.5.0" },
  ]);
  assert.equal(chosen.tag_name, "v2.5.0", "a draft or an unusable entry must not be selected");
});

test("the default release reader is the paginated one, not a single request", async () => {
  // The earlier tests drive `listAllReleases` directly, so they would still pass if `main`
  // defaulted back to `fetchJson(releasesApiUrl(100))` - which is exactly the defect. Drive the
  // real default path with a stubbed global fetch and assert the second page is requested.
  const requests = [];
  const pages = [
    Array.from({ length: 100 }, (_, i) => release({ id: i + 1, tag_name: `v1.0.${i}` })),
    [release({ id: 500, tag_name: "v9.9.9", published_at: "2027-01-01T00:00:00Z" })],
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push(String(url));
    const page = Number(new URL(url).searchParams.get("page") ?? 1);
    return { ok: true, status: 200, json: async () => pages[page - 1] ?? [] };
  };
  try {
    // `listReleases` is deliberately NOT overridden: the default is the thing under test.
    const db = fakeDb();
    const code = await main([], {
      env: { GITHUB_TOKEN: "test" },
      log: () => {},
      error: () => {},
      output: () => {},
      resolveCommit: async () => SHA_A,
      compare: async () => ({ ancestor: true, status: "ahead" }),
      credentials: fakeCredentials(),
      openDb: async () => db,
      now: "2026-11-06T00:00:00.000Z",
    });
    assert.equal(code, EXIT.ok);
    assert.ok(requests.length >= 2, "the run must page past the first response");
    assert.equal(db.documents.get(STATE_DOC_ID)?.observed?.tag, "v9.9.9",
      "a release on the second page must be able to become the observed release");
  } finally {
    globalThis.fetch = realFetch;
  }
});
