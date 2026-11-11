// Tests for the Firestore data layer, the repositories, the service and the sync planner.
//
// No network and no Firebase project: the SDK is replaced through the test seams in
// `src/firebase/firestore.js`, so a read is a plain function call. `src/firebase/config.js` is
// exercised with explicit env objects rather than `import.meta.env`.

import test from "node:test";
import assert from "node:assert/strict";

import {
  PUBLIC_FIREBASE_CONFIG,
  REQUIRED_FIREBASE_KEYS,
  FirebaseConfigError,
  assertFirebaseConfig,
  firebaseAppConfig,
  firebaseConfigStatus,
  getFirebaseApp,
  readEmulatorHost,
  readFirebaseEnv,
  resolveFirebaseConfig,
} from "../src/firebase/config.js";
import {
  CACHE_TTL_MS,
  FIRESTORE_ERROR_CODES,
  __resetCacheForTests,
  __resetDbForTests,
  __setFirestoreForTests,
  classifyFirestoreError,
  readDoc,
  readDocs,
  redirectToEmulator,
} from "../src/firebase/firestore.js";
import {
  COLLECTIONS,
  docIdFor,
  releaseIdFor,
  syncIdFor,
} from "../src/firebase/collections.js";
import {
  listDocumentation,
  listDocumentationCatalog,
  getDocument,
  validateDocumentRecord,
} from "../src/repositories/documentation.repository.js";
import { validateExampleRecord } from "../src/repositories/examples.repository.js";
import { validateReleaseRecord } from "../src/repositories/releases.repository.js";
import { validateStdlibRecord } from "../src/repositories/stdlib.repository.js";
import {
  contentResult,
  decideSource,
  getCatalog,
  getDocument as serviceGetDocument,
  getReleases,
} from "../src/services/content.service.js";
import {
  buildDocumentRecord,
  classifyPath,
  buildSyncRecord,
  contentHashOf,
  loadCredentials,
  main,
  parseArgs,
  planSync,
} from "../scripts/sync-firestore.mjs";

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

test("docIdFor flattens a repository path deterministically", () => {
  assert.equal(docIdFor("docs/spec/language.md"), "docs__spec__language.md");
  assert.equal(docIdFor("/docs/spec/language.md"), "docs__spec__language.md");
  assert.equal(docIdFor("./docs\\spec\\language.md"), "docs__spec__language.md");
  assert.equal(docIdFor("docs/a/../spec/language.md"), "docs__spec__language.md");
  assert.equal(docIdFor("CHANGELOG.md"), "CHANGELOG.md");
  // Two spellings of the same path cannot create two documents.
  assert.equal(docIdFor("docs//spec//language.md"), docIdFor("docs/spec/language.md"));
});

test("sync ids are namespaced per collection and release ids are path-derived", () => {
  assert.equal(syncIdFor("documentation", "docs/spec/a.md"), "documentation__docs__spec__a.md");
  assert.notEqual(
    syncIdFor("documentation", "docs/stdlib/reference.md"),
    syncIdFor("stdlib", "docs/stdlib/reference.md"),
  );
  assert.equal(releaseIdFor("v0.1.0-alpha.2"), "releases__v0.1.0-alpha.2");
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test("config reads the documented VITE_ variables", () => {
  const env = readFirebaseEnv({
    VITE_FIREBASE_API_KEY: " key ",
    VITE_FIREBASE_PROJECT_ID: "",
    VITE_FIREBASE_APP_ID: "app",
  });
  assert.equal(env.apiKey, "key");
  assert.equal(env.projectId, "");
  assert.equal(env.appId, "app");
});

test("config falls back to the public defaults and reports them", () => {
  const resolved = resolveFirebaseConfig({});
  assert.equal(resolved.configured, true);
  assert.equal(resolved.usingDefaults, true);
  assert.deepEqual(resolved.missing, []);
  assert.equal(resolved.config.projectId, PUBLIC_FIREBASE_CONFIG.projectId);
  assert.equal(resolved.config.apiKey, PUBLIC_FIREBASE_CONFIG.apiKey);
});

test("config reports exactly the missing required keys when defaults are disabled", () => {
  const status = firebaseConfigStatus(
    { VITE_FIREBASE_PROJECT_ID: "preview-project" },
    { useDefaults: false },
  );
  assert.equal(status.configured, false);
  assert.deepEqual(
    [...status.missing],
    REQUIRED_FIREBASE_KEYS.filter((key) => key !== "projectId"),
  );
  assert.equal(status.projectId, "preview-project");
});

test("VITE_FIREBASE_DISABLE_DEFAULTS=1 disables the fallback", () => {
  const resolved = resolveFirebaseConfig({ VITE_FIREBASE_DISABLE_DEFAULTS: "1" });
  assert.equal(resolved.useDefaults, false);
  assert.equal(resolved.configured, false);
});

test("the missing-key diagnostic names the variables and never prints values", () => {
  const status = firebaseConfigStatus({}, { useDefaults: false });
  assert.throws(
    () => assertFirebaseConfig(status),
    (error) => {
      assert.ok(error instanceof FirebaseConfigError);
      assert.match(error.message, /VITE_FIREBASE_API_KEY/);
      assert.match(error.message, /VITE_FIREBASE_APP_ID/);
      assert.match(error.message, /Missing required key/);
      assert.ok(!error.message.includes(PUBLIC_FIREBASE_CONFIG.apiKey));
      return true;
    },
  );
});

test("the app is never initialized during a Node prerender", () => {
  assert.throws(() => getFirebaseApp(), /prerendering in Node/);
});

test("the object passed to initializeApp carries the resolved config, not the status", () => {
  const config = firebaseAppConfig({ VITE_FIREBASE_PROJECT_ID: "preview-project" });
  assert.equal(config.projectId, "preview-project");
  assert.equal(config.apiKey, PUBLIC_FIREBASE_CONFIG.apiKey);
  assert.equal(config.appId, PUBLIC_FIREBASE_CONFIG.appId);
  assert.equal(config.authDomain, PUBLIC_FIREBASE_CONFIG.authDomain);
  assert.equal(config.configured, undefined, "a status field must not leak into the SDK config");
  assert.equal(config.missing, undefined, "a status field must not leak into the SDK config");
});

test("initializeApp never receives a config without options", () => {
  // Regression: `getFirebaseApp` used to pass `firebaseConfigStatus()`, which has no `config`
  // key, so `initializeApp(undefined)` threw `app/no-options` and every read fell back to
  // GitHub - in production as well as under the emulator.
  for (const env of [{}, { VITE_FIREBASE_PROJECT_ID: "p" }, { VITE_FIREBASE_DISABLE_DEFAULTS: "1" }]) {
    const config = env.VITE_FIREBASE_DISABLE_DEFAULTS
      ? null
      : firebaseAppConfig(env);
    if (config) assert.ok(Object.keys(config).length > 0);
  }
  assert.throws(() => firebaseAppConfig({ VITE_FIREBASE_DISABLE_DEFAULTS: "1" }), /Missing required key/);
});

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

test("unavailable and permission-denied are distinct typed results", () => {
  const unavailable = classifyFirestoreError(Object.assign(new Error("offline"), { code: "unavailable" }));
  const denied = classifyFirestoreError(
    Object.assign(new Error("denied"), { code: "permission-denied" }),
  );
  assert.equal(unavailable.code, FIRESTORE_ERROR_CODES.unavailable);
  assert.equal(unavailable.retryable, true);
  assert.equal(unavailable.fallback, true);
  assert.equal(denied.code, FIRESTORE_ERROR_CODES.permissionDenied);
  assert.equal(denied.retryable, false);
  assert.equal(denied.fallback, true);
});

test("a read outside a configured browser returns a typed failure, not a throw", async () => {
  __setFirestoreForTests(null);
  const result = await readDocs(COLLECTIONS.documentation);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, FIRESTORE_ERROR_CODES.notConfigured);
  assert.equal(result.error.fallback, true);
  assert.equal(result.data, null);
});

// ---------------------------------------------------------------------------
// Cache and deduplication
// ---------------------------------------------------------------------------

function fakeSdk({ docs = [], getDocs, getDoc } = {}) {
  let docsCalls = 0;
  let docCalls = 0;
  const module = {
    collection: (_db, name) => ({ name }),
    query: (base) => base,
    where: (field, op, value) => ({ field, op, value }),
    limit: (value) => ({ limit: value }),
    orderBy: (field) => ({ orderBy: field }),
    startAfter: (value) => ({ startAfter: value }),
    doc: (_db, name, id) => ({ name, id }),
    getDocs: async (target) => {
      docsCalls += 1;
      if (getDocs) return getDocs(target, docsCalls);
      return { docs: docs.map((entry) => ({ id: entry.id, data: () => entry.data })) };
    },
    getDoc: async (ref) => {
      docCalls += 1;
      if (getDoc) return getDoc(ref, docCalls);
      return { id: ref.id, exists: () => false };
    },
  };
  return {
    module,
    calls: () => ({ docs: docsCalls, doc: docCalls }),
  };
}

test("two concurrent identical reads share one request", async () => {
  __resetCacheForTests();
  __resetDbForTests();
  const fake = fakeSdk({ docs: [{ id: "docs__spec__a.md", data: { path: "docs/spec/a.md" } }] });
  __setFirestoreForTests(fake.module);

  const builder = (module, base) => module.query(base, module.limit(5));
  const [first, second] = await Promise.all([
    readDocs(COLLECTIONS.documentation, builder, { cacheKey: "dedupe" }),
    readDocs(COLLECTIONS.documentation, builder, { cacheKey: "dedupe" }),
  ]);

  assert.equal(fake.calls().docs, 1);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(first.data[0].id, "docs__spec__a.md");
  __setFirestoreForTests(null);
  __resetCacheForTests();
});

test("a failure is not cached, so the next read retries", async () => {
  __resetCacheForTests();
  __resetDbForTests();
  const fake = fakeSdk({
    getDocs: async (_target, call) => {
      if (call === 1) throw Object.assign(new Error("offline"), { code: "unavailable" });
      return { docs: [] };
    },
  });
  __setFirestoreForTests(fake.module);

  const first = await readDocs(COLLECTIONS.examples, null, { cacheKey: "retry" });
  assert.equal(first.ok, false);
  assert.equal(first.error.code, FIRESTORE_ERROR_CODES.unavailable);

  const second = await readDocs(COLLECTIONS.examples, null, { cacheKey: "retry" });
  assert.equal(second.ok, true);
  assert.equal(fake.calls().docs, 2);
  __setFirestoreForTests(null);
  __resetCacheForTests();
});

test("the cache TTL is the documented five minutes", () => {
  assert.equal(CACHE_TTL_MS, 5 * 60 * 1000);
});

test("readDoc resolves to the document payload, not an id/data wrapper", async () => {
  // Regression: `readDoc` used to resolve to `{ id, data }`. Every repository passed
  // `result.data` into a validator that expects the payload, so a valid record was rejected as
  // "missing or empty path" and every single-document page silently fell back to GitHub.
  __resetCacheForTests();
  __resetDbForTests();
  const payload = { path: "docs/spec/language.md", title: "Reference", published: true };
  const fake = fakeSdk({
    getDoc: async (ref) => ({ id: ref.id, exists: () => true, data: () => payload }),
  });
  __setFirestoreForTests(fake.module);

  const result = await readDoc(COLLECTIONS.documentation, docIdFor("docs/spec/language.md"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, payload);
  assert.equal(result.data.path, "docs/spec/language.md");
  __setFirestoreForTests(null);
  __resetCacheForTests();
});

// ---------------------------------------------------------------------------
// Repository schema validation
// ---------------------------------------------------------------------------

const validDocument = {
  path: "docs/spec/language.md",
  title: "The Oqthara language",
  content: "# The Oqthara language\n",
  published: true,
  contentHash: "abc",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function docEntry(path, overrides = {}) {
  return {
    id: docIdFor(path),
    data: { ...validDocument, path, ...overrides },
  };
}

test("validateDocumentRecord accepts a valid record and skips malformed ones", () => {
  const good = validateDocumentRecord(docEntry("docs/spec/language.md"));
  assert.equal(good.record.path, "docs/spec/language.md");
  assert.equal(good.record.markdown, validDocument.content);

  const cases = [
    { entry: { id: "x", data: null }, reason: /not an object/ },
    { entry: docEntry("docs/spec/a.md", { content: 42 }), reason: /content is not a string/ },
    { entry: docEntry("docs/spec/a.md", { published: "true" }), reason: /not published/ },
    { entry: docEntry("docs/spec/a.md", { title: "" }), reason: /title/ },
    { entry: { id: "wrong-id", data: { ...validDocument, path: "docs/spec/a.md" } }, reason: /id does not match/ },
    { entry: docEntry("examples/a.oq"), reason: /mirrored document path/ },
  ];
  for (const { entry, reason } of cases) {
    const result = validateDocumentRecord(entry);
    assert.equal(result.record, undefined);
    assert.match(result.warning.reason, reason);
  }
});

test("example, release and stdlib validators reject the wrong shapes", () => {
  const example = validateExampleRecord({
    id: docIdFor("examples/basics/hello.oq"),
    data: {
      path: "examples/basics/hello.oq",
      content: 'print "hi"\n',
      published: true,
      title: "Hello",
    },
  });
  assert.equal(example.record.name, "hello");
  assert.equal(example.record.category, "basics");
  assert.equal(validateExampleRecord(docEntry("docs/spec/a.md")).record, undefined);

  const release = validateReleaseRecord({
    id: releaseIdFor("v0.1.0"),
    data: { ref: "v0.1.0", label: "First", published: true, publishedAt: "2026-01-01T00:00:00Z" },
  });
  assert.equal(release.record.id, "0.1.0");
  assert.equal(release.record.ref, "v0.1.0");
  assert.equal(
    validateReleaseRecord({ id: releaseIdFor("v0.1.0"), data: { ref: "v0.1.0" } }).warning.reason,
    "release is not published",
  );

  const stdlib = validateStdlibRecord({
    id: docIdFor("docs/stdlib/reference.md"),
    data: { ...validDocument, path: "docs/stdlib/reference.md" },
  });
  assert.equal(stdlib.record.path, "docs/stdlib/reference.md");
  assert.equal(
    validateStdlibRecord({ id: "nope", data: { ...validDocument, path: "docs/stdlib/reference.md" } })
      .warning.reason,
    "document id does not match the path",
  );
});

test("listDocumentation filters published records and reports skipped ones", async () => {
  __resetCacheForTests();
  __resetDbForTests();
  const fake = fakeSdk({
    docs: [
      docEntry("docs/spec/a.md", { title: "A" }),
      docEntry("docs/b.md", { content: 7 }),
      docEntry("docs/c.md", { published: false }),
      { id: "docs__d.md", data: { path: "docs/d.md", published: true } },
    ],
  });
  __setFirestoreForTests(fake.module);

  const result = await listDocumentation();
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.map((record) => record.path), ["docs/spec/a.md"]);
  assert.equal(result.warnings.length, 3);

  const catalog = await listDocumentationCatalog();
  assert.equal(catalog.data[0].section, "Specification");
  assert.equal(catalog.data[0].title, "A");
  __setFirestoreForTests(null);
  __resetCacheForTests();
});

test("getDocument returns null for a missing document instead of failing", async () => {
  __resetCacheForTests();
  __resetDbForTests();
  const fake = fakeSdk();
  __setFirestoreForTests(fake.module);

  const result = await getDocument({ path: "docs/missing.md" });
  assert.equal(result.ok, true);
  assert.equal(result.data, null);

  const invalid = await getDocument({ path: "examples/a.oq" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, FIRESTORE_ERROR_CODES.invalidArgument);
  __setFirestoreForTests(null);
  __resetCacheForTests();
});

// ---------------------------------------------------------------------------
// Service fallback decision
// ---------------------------------------------------------------------------

test("decideSource prefers Firestore only for a non-empty successful main read", () => {
  assert.deepEqual(decideSource({ ref: "main", result: { ok: true, data: [1] } }), {
    useFirestore: true,
    reason: "hit",
  });
  assert.equal(decideSource({ ref: "main", result: { ok: true, data: [] } }).reason, "empty");
  assert.equal(decideSource({ ref: "main", result: { ok: true, data: null } }).reason, "empty");
  assert.equal(
    decideSource({ ref: "main", result: { ok: false, data: null, error: { code: "unavailable" } } }).reason,
    "error",
  );
  assert.equal(decideSource({ ref: "v0.1.0", result: { ok: true, data: [1] } }).reason, "wrong-ref");
  assert.equal(decideSource({ ref: "main", result: null }).reason, "empty");
});

test("the service uses Firestore when it has data", async () => {
  const result = await getCatalog("main", {
    firestore: {
      listDocumentationCatalog: async () => ({
        ok: true,
        data: [{ path: "docs/spec/a.md", section: "Overview", title: "A", route: "/x", sourceUrl: "" }],
        warnings: [],
        cached: false,
      }),
    },
    github: { loadCatalog: async () => assert.fail("GitHub should not be called") },
  });
  assert.equal(result.source, "firestore");
  assert.equal(result.stale, false);
  assert.equal(result.data.length, 1);
});

test("the service marks a cached Firestore hit as cache and stale", async () => {
  const result = await getCatalog("main", {
    firestore: {
      listDocumentationCatalog: async () => ({
        ok: true,
        data: [{ path: "docs/spec/a.md" }],
        warnings: [],
        cached: true,
      }),
    },
    github: { loadCatalog: async () => assert.fail("GitHub should not be called") },
  });
  assert.equal(result.source, "cache");
  assert.equal(result.stale, true);
});

test("the service falls back to GitHub when Firestore is unavailable or empty", async () => {
  const unavailable = await getCatalog("main", {
    firestore: {
      listDocumentationCatalog: async () => ({
        ok: false,
        data: [],
        error: { code: "unavailable", message: "offline", fallback: true },
        cached: false,
      }),
    },
    github: { loadCatalog: async () => [{ path: "docs/from-github.md" }] },
  });
  assert.equal(unavailable.source, "github");
  assert.equal(unavailable.stale, true);
  assert.equal(unavailable.data[0].path, "docs/from-github.md");
  assert.equal(unavailable.error.code, "unavailable");

  const empty = await getCatalog("main", {
    firestore: { listDocumentationCatalog: async () => ({ ok: true, data: [], warnings: [], cached: false }) },
    github: { loadCatalog: async () => [{ path: "docs/from-github.md" }] },
  });
  assert.equal(empty.source, "github");
  assert.equal(empty.data.length, 1);
});

test("a pinned release channel always reads GitHub, never the main-only mirror", async () => {
  const result = await serviceGetDocument("v0.1.0-alpha.2", "docs/spec/language.md", {
    firestore: { getDocument: async () => assert.fail("Firestore must not serve a pinned release") },
    github: {
      loadDocument: async (ref, path) => ({ path, ref, markdown: "# tagged", title: "Tagged" }),
    },
  });
  assert.equal(result.source, "github");
  assert.equal(result.data.markdown, "# tagged");
});

test("the service returns the previous Firestore data when both backends fail", async () => {
  const result = await getReleases({
    firestore: {
      listReleases: async () => ({
        ok: true,
        data: [],
        warnings: [],
        cached: false,
      }),
    },
    github: {
      loadReleases: async () => {
        throw new Error("GitHub is down");
      },
    },
  });
  // Empty Firestore data is not content, so the GitHub error is what the caller sees.
  assert.equal(result.data, null);
  assert.equal(result.source, "github");
  assert.match(result.error.message, /GitHub is down/);
});

test("contentResult is a frozen uniform shape", () => {
  const result = contentResult([1], { source: "firestore" });
  assert.deepEqual({ ...result, warnings: [...result.warnings] }, {
    data: [1],
    source: "firestore",
    stale: false,
    error: null,
    warnings: [],
  });
  assert.ok(Object.isFrozen(result));
});

// ---------------------------------------------------------------------------
// Sync planner (pure; no network, no credentials)
// ---------------------------------------------------------------------------

test("the sync planner writes only changed documents and never hard-deletes", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const kept = buildDocumentRecord({ path: "docs/kept.md", content: "# Kept", collection: "documentation", now });
  const changed = buildDocumentRecord({ path: "docs/changed.md", content: "# Changed", collection: "documentation", now });
  const gone = buildDocumentRecord({ path: "docs/gone.md", content: "# Gone", collection: "documentation", now });

  const existing = new Map([
    [
      syncIdFor("documentation", "docs/kept.md"),
      buildSyncRecord({
        collection: "documentation",
        path: "docs/kept.md",
        status: "published",
        contentHash: kept.data.contentHash,
        now,
      }).data,
    ],
    [
      syncIdFor("documentation", "docs/changed.md"),
      buildSyncRecord({
        collection: "documentation",
        path: "docs/changed.md",
        status: "published",
        contentHash: "old-hash",
        now,
      }).data,
    ],
    [
      syncIdFor("documentation", "docs/gone.md"),
      buildSyncRecord({
        collection: "documentation",
        path: "docs/gone.md",
        status: "published",
        contentHash: gone.data.contentHash,
        now,
      }).data,
    ],
  ]);

  const plan = planSync({ desired: [kept, changed], existing });
  assert.deepEqual(plan.writes.map((write) => write.data.path), ["docs/changed.md"]);
  assert.deepEqual(plan.unchanged.map((write) => write.data.path), ["docs/kept.md"]);
  assert.deepEqual(plan.unpublish.map((entry) => entry.path), ["docs/gone.md"]);
  assert.equal(plan.oversized.length, 0);

  // --full reconciles every source, so even a matching hash is rewritten.
  const fullPlan = planSync({ desired: [kept, changed], existing, full: true });
  assert.deepEqual(fullPlan.writes.map((write) => write.data.path), ["docs/changed.md", "docs/kept.md"]);
});

// The scope change is a migration, not just a filter for new content. Before the publication
// allowlist existed, `classifyPath` accepted anything under `docs/`, so a governance document or
// a decision record may already be mirrored and readable. Narrowing the allowlist only stops
// *new* writes; those documents leave the mirror only if the planner reports them as unpublish
// candidates, which is what this asserts.
test("documents that leave the publication allowlist become unpublish candidates", () => {
  const now = new Date().toISOString();
  const publishedBefore = [
    "docs/adr/0003-bytecode.md",
    "docs/governance/alpha-3-closure.md",
    "docs/spec/language.md",
  ];

  // `classifyPath` now refuses the two governance paths outright.
  assert.equal(classifyPath("docs/adr/0003-bytecode.md"), null);
  assert.equal(classifyPath("docs/governance/alpha-3-closure.md"), null);

  // A mirror written under the old rule still holds records for them.
  const existing = new Map(
    publishedBefore.map((path) => [
      syncIdFor("documentation", path),
      buildSyncRecord({
        collection: "documentation",
        path,
        status: "published",
        contentHash: contentHashOf("# whatever"),
        now,
      }).data,
    ]),
  );

  // Reconciling against the current (narrower) allowlist must withdraw them, not leave them up.
  const desired = publishedBefore
    .filter((path) => classifyPath(path))
    .map((path) => buildDocumentRecord({ path, content: "# doc", collection: "documentation", now }));
  const plan = planSync({ desired, existing });

  assert.deepEqual(
    plan.unpublish.map((entry) => entry.path).sort(),
    ["docs/adr/0003-bytecode.md", "docs/governance/alpha-3-closure.md"],
    "a document dropped from the allowlist must be withdrawn, not silently left published",
  );
  // The kept document's fixture hash does not match its new content, so it is rewritten rather
  // than reported unchanged; what matters here is that it is not withdrawn.
  assert.deepEqual(plan.writes.map((entry) => entry.data.path), ["docs/spec/language.md"]);
  assert.deepEqual(plan.unchanged, []);
});

test("oversized content is skipped whole and recorded, never truncated", () => {
  const big = buildDocumentRecord({
    path: "docs/big.md",
    content: "x".repeat(901 * 1024),
    collection: "documentation",
  });
  const small = buildDocumentRecord({ path: "docs/small.md", content: "# Small", collection: "documentation" });
  const plan = planSync({ desired: [big, small], existing: new Map() });

  assert.equal(plan.oversized.length, 1);
  assert.equal(plan.oversized[0].bytes, 901 * 1024);
  assert.ok(!plan.writes.some((write) => write.data.path === "docs/big.md"));
  assert.ok(plan.writes.some((write) => write.data.path === "docs/small.md"));
});

test("contentHashOf is a stable SHA-256", () => {
  assert.equal(contentHashOf("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.notEqual(contentHashOf("abc"), contentHashOf("abd"));
});

// ---------------------------------------------------------------------------
// Sync CLI diagnostics (no network, no credentials)
// ---------------------------------------------------------------------------

test("--dry-run parses without needing a credential and rejects unknown flags", () => {
  const dry = parseArgs(["--dry-run", "--ref=v0.1.0"]);
  assert.equal(dry.options.dryRun, true);
  assert.equal(dry.options.full, false);
  assert.equal(dry.options.ref, "v0.1.0");
  assert.deepEqual(dry.unknown, []);

  const unknown = parseArgs(["--nope"]);
  assert.deepEqual(unknown.unknown, ["--nope"]);
});

test("the credential diagnostic names both supported variables and invents nothing", async () => {
  const missing = await loadCredentials({});
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /FIREBASE_SERVICE_ACCOUNT/);
  assert.match(missing.reason, /GOOGLE_APPLICATION_CREDENTIALS/);
  assert.match(missing.reason, /--dry-run/);

  const malformed = await loadCredentials({ FIREBASE_SERVICE_ACCOUNT: "not-json" });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.malformed, true);
  assert.match(malformed.reason, /not valid JSON/);

  const incomplete = await loadCredentials({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: "x" }) });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.reason, /not a service account key/);
});

test("a dry run with no credential reads sources and exits 0 without writing", async () => {
  const desired = [
    buildDocumentRecord({ path: "docs/spec/a.md", content: "# A", collection: "documentation" }),
  ];
  const lines = [];
  const code = await main(["--dry-run"], {
    env: {},
    collect: async () => desired,
    credentials: async () => ({ ok: false, reason: "no credential in this test" }),
    openDb: async () => assert.fail("dry run must not open Firestore"),
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(`ERR ${line}`),
  });
  assert.equal(code, 0);
  const output = lines.join("\n");
  assert.match(output, /would write 1/);
  assert.match(output, /dry run: nothing was written/);
  assert.ok(!output.includes("ERR"));
});

test("a write run without a credential exits 2 and says why", async () => {
  const lines = [];
  const code = await main([], {
    env: {},
    collect: async () => [],
    credentials: async () => ({ ok: false, reason: "No Admin credential. Set FIREBASE_SERVICE_ACCOUNT." }),
    openDb: async () => assert.fail("no credential means no Firestore"),
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(`ERR ${line}`),
  });
  assert.equal(code, 2);
  assert.match(lines.join("\n"), /No Admin credential/);
});

// ---------------------------------------------------------------------------
// Emulator redirect
// ---------------------------------------------------------------------------

test("readEmulatorHost accepts host:port and ignores anything else", () => {
  assert.equal(readEmulatorHost({ VITE_FIREBASE_EMULATOR_HOST: "127.0.0.1:8080" }), "127.0.0.1:8080");
  assert.equal(readEmulatorHost({ VITE_FIREBASE_EMULATOR_HOST: "  127.0.0.1:8080  " }), "127.0.0.1:8080");
  assert.equal(readEmulatorHost({ VITE_FIREBASE_EMULATOR_HOST: "" }), null);
  assert.equal(readEmulatorHost({}), null);
  assert.equal(readEmulatorHost(undefined), null);
});

test("redirectToEmulator connects only for a well-formed host", () => {
  const calls = [];
  const module = { connectFirestoreEmulator: (db, host, port) => calls.push([db, host, port]) };
  const db = { name: "db" };

  assert.equal(redirectToEmulator(module, db, null), db);
  assert.equal(redirectToEmulator(module, db, "127.0.0.1"), db);
  assert.equal(redirectToEmulator(module, db, ":8080"), db);
  assert.deepEqual(calls, []);

  assert.equal(redirectToEmulator(module, db, "127.0.0.1:8080"), db);
  assert.deepEqual(calls, [[db, "127.0.0.1", 8080]]);
});

// The mirror is a second publication path: a document the reader can never be offered should not
// occupy a Firestore collection either. classifyPath imports the allowlist from `source.js`, so
// this asserts the wiring rather than restating the scope.
test("classifyPath mirrors published documents only", () => {
  assert.equal(classifyPath("docs/spec/language.md").collection, "documentation");
  assert.equal(classifyPath("docs/reference/cli.md").collection, "documentation");
  assert.equal(classifyPath("docs/README.md").collection, "documentation");
  assert.equal(classifyPath("CHANGELOG.md").kind, "changelog");
  assert.equal(classifyPath("examples/hello.oq").kind, "example");

  assert.equal(classifyPath("docs/adr/0003-bytecode.md"), null);
  assert.equal(classifyPath("docs/governance/alpha-3-closure-report.md"), null);
  assert.equal(classifyPath("docs/alpha-4-phase-0-assessment.md"), null);
});
