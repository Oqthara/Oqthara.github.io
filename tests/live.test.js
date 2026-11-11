import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  __resetCacheForTests,
  __setFetchForTests,
  loadDocument,
  loadReleases,
  loadTree,
} from "../src/github-docs.js";
import { isDocumentPath, isExamplePath, isPublishedDocument } from "../src/source.js";

const live = process.env.OQ_LIVE_DOCS === "1";

// The live suite talks to the real GitHub API. Unauthenticated callers share an hourly
// quota of 60 requests per IP, which a CI runner or a busy machine can exhaust. When a
// token is available in the environment, or from an already-authenticated `gh` CLI on a
// developer machine, attach it to the real fetch so the suite tests GitHub rather than the
// local quota. No token is ever read from a file, logged or committed; without one the
// suite runs unauthenticated exactly as before.
function localToken() {
  if (process.env.OQ_GITHUB_TOKEN) return process.env.OQ_GITHUB_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return String(
      execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }),
    ).trim();
  } catch {
    return "";
  }
}

const token = live ? localToken() : "";
if (live && token) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) =>
    realFetch(input, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
}

test("live: main exposes at least 15 Markdown docs and 30 examples", { skip: !live }, async () => {
  __resetCacheForTests();
  __setFetchForTests(null);

  const tree = await loadTree("main");
  assert.ok(Array.isArray(tree));

  const docs = tree.filter((entry) => isDocumentPath(entry.path));
  const examples = tree.filter((entry) => isExamplePath(entry.path));

  assert.ok(docs.length >= 15, `expected >= 15 docs, got ${docs.length}`);
  assert.ok(examples.length >= 30, `expected >= 30 examples, got ${examples.length}`);
  assert.ok(docs.every((entry) => entry.path.startsWith("docs/")));
  assert.ok(examples.every((entry) => entry.path.startsWith("examples/")));
});

// The published set is an allowlist, so a directory renamed upstream with no edit here would
// quietly empty the site rather than fail. This pins the guarantee that the allowlist still names
// real directories in the language repository: a small published set is a signal, an empty one is
// a mistake.
test("live: the publication allowlist still matches the upstream tree", { skip: !live }, async () => {
  __resetCacheForTests();
  __setFetchForTests(null);

  const tree = await loadTree("main");
  const docs = tree.filter((entry) => isDocumentPath(entry.path));
  const published = docs.filter((entry) => isPublishedDocument(entry.path));

  assert.ok(published.length >= 8, `expected >= 8 published docs, got ${published.length}`);
  assert.ok(
    published.length < docs.length,
    "development documentation should be excluded, so published must be a strict subset",
  );
  for (const section of ["spec", "reference", "stdlib"]) {
    assert.ok(
      published.some((entry) => entry.path.startsWith(`docs/${section}/`)),
      `expected a published document under docs/${section}/`,
    );
  }
  assert.ok(
    !published.some((entry) => /^docs\/(adr|governance)\//.test(entry.path)),
    "decision records and governance documents must stay on GitHub",
  );
});

test("live: docs/spec/language.md at main has an h1 and a table", { skip: !live }, async () => {
  __resetCacheForTests();
  __setFetchForTests(null);

  const document = await loadDocument("main", "docs/spec/language.md");
  assert.ok(document.markdown.length > 0);
  assert.match(document.markdown, /^#\s+\S/m, "the language spec must have a level-one heading");
  assert.match(document.markdown, /^\|.*\|/m, "the language spec must contain a Markdown table");
  assert.match(document.markdown, /^\|\s*-{3,}/m, "the table must have a delimiter row");
});

test("live: both pinned tags serve the spec and their bytes differ", { skip: !live }, async () => {
  const tags = ["v0.1.0-alpha.1", "v0.1.0-alpha.2"];
  const bodies = [];

  __resetCacheForTests();
  for (const tag of tags) {
    // Exercises the real loader: it throws unless GitHub served the document with a 200.
    const document = await loadDocument(tag, "docs/spec/language.md");
    assert.equal(document.ref, tag);
    assert.equal(document.path, "docs/spec/language.md");
    assert.ok(document.markdown.length > 0, `${tag} document must not be empty`);
    bodies.push(Buffer.from(document.markdown, "utf8"));
  }

  assert.notEqual(
    bodies[0].length,
    bodies[1].length,
    "the spec must differ in byte length between v0.1.0-alpha.1 and v0.1.0-alpha.2",
  );
});

test("live: the releases API has a non-draft v-prefixed tag", { skip: !live }, async () => {
  __resetCacheForTests();
  __setFetchForTests(null);

  const channels = await loadReleases();
  assert.ok(Array.isArray(channels));
  assert.equal(channels[0].ref, "main", "development is always the first channel");

  const releases = channels.slice(1);
  assert.ok(releases.length >= 1, "expected at least one non-draft release");
  assert.ok(
    releases.some((channel) => channel.ref.startsWith("v")),
    "expected a release whose tag_name starts with v",
  );
  assert.ok(releases.every((channel) => channel.ref.startsWith("v")));
  assert.ok(releases.every((channel) => !/^v$/.test(channel.ref)));
});
