#!/usr/bin/env node
/**
 * Proves that `firestore.rules` enforces the boundary the site depends on.
 *
 * The emulator is the only place the rules can be exercised without administrative
 * credentials, and it is the same rules file that `firebase-sync.yml` deploys. The Admin SDK
 * bypasses rules, so it seeds documents; the Web SDK is rules-enforced, so it probes them.
 * Every assertion below is a claim the security review makes in prose.
 *
 * Run through the emulator so the rules are loaded from `firestore.rules`:
 *   npm run test:rules
 */
import { initializeApp as initAdminApp, deleteApp as deleteAdminApp } from "firebase-admin/app";
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import { initializeApp, deleteApp } from "firebase/app";
import {
  initializeFirestore,
  connectFirestoreEmulator,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  addDoc,
  setDoc,
} from "firebase/firestore";

const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT ?? "oqthara-rules-test";

// The emulator also needs the env var for the Admin SDK to redirect.
process.env.FIRESTORE_EMULATOR_HOST = HOST;

// Document ids mirror `docIdFor()` in `src/firebase/collections.js`: the repo path with `/`
// replaced by `__`. Using the real shape keeps the fixture honest.
const PUBLISHED = "docs__guide__getting-started.md";
const DRAFT = "docs__guide__draft.md";
const NO_FLAG = "docs__guide__no-flag.md";
const EXAMPLE = "examples__hello.oq";

const results = [];

function record(name, expected, actual) {
  results.push({ name, expected, actual, ok: expected === actual });
}

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, code: error?.code ?? "unknown" };
  }
}

/** Maps a probe to the exact outcome the rules must produce. */
function expect(read, allowed) {
  if (allowed) return read.ok ? "allowed" : read.code;
  return read.ok ? "allowed" : read.code;
}

async function seed() {
  // `FIRESTORE_EMULATOR_HOST` already redirects the Admin SDK; calling `settings()` on top of
  // it would point at a second, unrelated connection.
  const adminApp = initAdminApp({ projectId: PROJECT }, "rules-seed");
  const db = getAdminFirestore(adminApp);

  const documents = [
    ["documentation", PUBLISHED, { path: "docs/guide/getting-started.md", title: "Getting started", content: "# Getting started", published: true }],
    ["documentation", DRAFT, { path: "docs/guide/draft.md", title: "Draft", content: "# Draft", published: false }],
    ["documentation", NO_FLAG, { path: "docs/guide/no-flag.md", title: "No flag", content: "# No flag" }],
    ["examples", EXAMPLE, { path: "examples/hello.oq", title: "Hello", content: 'print "Hello, World!"', published: true }],
    ["sync", `documentation__${PUBLISHED}`, { published: true }],
    ["metadata", "site", { title: "Oqthara", published: true }],
  ];

  for (const [name, id, data] of documents) {
    await db.collection(name).doc(id).set(data);
  }
  await deleteAdminApp(adminApp);
}

function clientDb() {
  const app = initializeApp({ projectId: PROJECT, apiKey: "rules-test" }, "rules-client");
  // Long polling avoids gRPC stream teardown noise in short-lived Node processes.
  const db = initializeFirestore(app, { experimentalForceLongPolling: true });
  const [host, port] = HOST.split(":");
  connectFirestoreEmulator(db, host, Number(port));
  return { app, db };
}

await seed();
const { app, db } = clientDb();

// Reads: only documents carrying the literal `published: true` are visible.
const publishedRead = await attempt(() => getDoc(doc(db, "documentation", PUBLISHED)));
record("published doc is readable", "allowed", expect(publishedRead, true));

const draftRead = await attempt(() => getDoc(doc(db, "documentation", DRAFT)));
record("unpublished doc is denied", "permission-denied", expect(draftRead, false));

const noFlagRead = await attempt(() => getDoc(doc(db, "documentation", NO_FLAG)));
record("doc without published flag is denied", "permission-denied", expect(noFlagRead, false));

const exampleRead = await attempt(() => getDoc(doc(db, "examples", EXAMPLE)));
record("published example is readable", "allowed", expect(exampleRead, true));

// The query the site actually runs. `where('published','==',true)` is defence in depth;
// the rule is the permission, so the result set must also contain nothing else.
const filtered = await attempt(() =>
  getDocs(query(collection(db, "documentation"), where("published", "==", true)))
);
record("published-filtered query is allowed", "allowed", expect(filtered, true));
if (filtered.ok) {
  record(
    "filtered query returns only published docs",
    PUBLISHED,
    filtered.value.docs.map((d) => d.id).join(",")
  );
}

// An unfiltered listing is not filtered by the rules engine, so it either fails or comes back
// short. The invariant that matters is that a draft id never appears.
const unfiltered = await attempt(() => getDocs(collection(db, "documentation")));
record(
  "unfiltered query never leaks a draft",
  "safe",
  unfiltered.ok
    ? unfiltered.value.docs.some((d) => d.id === DRAFT || d.id === NO_FLAG)
      ? "leaked"
      : "safe"
    : "safe"
);

// Operational collections are never public, even when a record says `published: true`.
const syncRead = await attempt(() => getDoc(doc(db, "sync", `documentation__${PUBLISHED}`)));
record("sync collection is denied", "permission-denied", expect(syncRead, false));

const metadataRead = await attempt(() => getDoc(doc(db, "metadata", "site")));
record("metadata collection is denied", "permission-denied", expect(metadataRead, false));

// Writes: there is no client write path for published content.
const create = await attempt(() => setDoc(doc(db, "documentation", "docs__guide__evil.md"), { published: true }));
record("client create is denied", "permission-denied", expect(create, false));

const update = await attempt(() => setDoc(doc(db, "documentation", PUBLISHED), { published: true }));
record("client update is denied", "permission-denied", expect(update, false));

const add = await attempt(() => addDoc(collection(db, "examples"), { published: true }));
record("client add is denied", "permission-denied", expect(add, false));

// Anything unnamed falls to the catch-all deny.
const unknown = await attempt(() => getDoc(doc(db, "secrets", "x")));
record("unknown collection is denied", "permission-denied", expect(unknown, false));

await deleteApp(app);

let failed = 0;
for (const result of results) {
  if (!result.ok) failed++;
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`${status}  ${result.name}  (expected ${result.expected}, got ${result.actual})`);
}

console.log(`\n${results.length - failed}/${results.length} rule assertions passed`);
if (failed > 0) {
  console.error("\nfirestore.rules does not match the security contract.");
  process.exit(1);
}
console.log("firestore.rules matches the security contract.");
