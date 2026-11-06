#!/usr/bin/env node
/**
 * Seeds the Firestore emulator with the real mirrored content from a canonical checkout.
 *
 * This exists so the site can be exercised against a *working* mirror without holding an
 * administrative credential for the production project. It is a verification tool: the
 * production mirror is written only by `.github/workflows/firebase-sync.yml`.
 *
 * The records are built by `collectDesired` in `scripts/sync-firestore.mjs` with the network
 * functions replaced by local file reads, so the shapes written here are byte-identical to the
 * ones the real sync produces. `sync` bookkeeping records are written too, so `--full` and the
 * incremental plan behave the same way against the emulator.
 *
 * Usage, with the emulator already running:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=oqthara-rules-test \
 *     node scripts/seed-emulator.mjs --root=..
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { FIELDS, MIRRORED_REF, SYNC_STATUS } from "../src/firebase/collections.js";
import { normalizeRepoPath } from "../src/source.js";
import { BATCH_SIZE, buildSyncRecord, classifyPath, collectDesired } from "./sync-firestore.mjs";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = ""] = arg.replace(/^--/, "").split("=");
    return [key, value];
  }),
);

const root = args.get("root") ?? "..";
const project = process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT ?? "oqthara-rules-test";
const host = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";

// The Admin SDK reads this variable itself; setting it here keeps a shell that forgot to export
// it from silently seeding the production project.
process.env.FIRESTORE_EMULATOR_HOST = host;

/** Every mirrored path under `root`, in the same shape the GitHub tree walker returns. */
async function walk(directory, accumulator = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(full, accumulator);
    } else if (entry.isFile()) {
      accumulator.push(normalizeRepoPath(relative(root, full).split(sep).join("/")));
    }
  }
  return accumulator;
}

async function listFiles() {
  const candidates = await walk(root);
  const wanted = candidates.filter((path) => classifyPath(path) !== null);
  return wanted.sort();
}

async function readText(path) {
  return readFile(join(root, path), "utf8");
}

const desired = await collectDesired({
  ref: MIRRORED_REF,
  now: new Date().toISOString(),
  listFiles,
  readFile: readText,
  // Releases are read from the GitHub API in production. The emulator has none, and the
  // development channel is synthesized by the site, so an empty list is the honest fixture.
  releases: async () => [],
});

if (!desired.length) {
  console.error(`no mirrored files found under ${root}`);
  process.exit(1);
}

const app = initializeApp({ projectId: project }, "seed-emulator");
const db = getFirestore(app);

for (let index = 0; index < desired.length; index += BATCH_SIZE) {
  const batch = db.batch();
  for (const record of desired.slice(index, index + BATCH_SIZE)) {
    batch.set(db.collection(record.collection).doc(record.id), record.data);
    const sync = buildSyncRecord({
      collection: record.collection,
      path: record.data[FIELDS.path],
      status: SYNC_STATUS.published,
      contentHash: record.data[FIELDS.contentHash],
      bytes: Buffer.byteLength(String(record.data[FIELDS.content] ?? ""), "utf8"),
      now: record.data[FIELDS.updatedAt],
    });
    batch.set(db.collection(sync.collection).doc(sync.id), sync.data);
  }
  await batch.commit();
}

const counts = desired.reduce((accumulator, record) => {
  accumulator[record.collection] = (accumulator[record.collection] ?? 0) + 1;
  return accumulator;
}, {});

console.log(`seeded ${desired.length} records into ${project} at ${host}`);
for (const [collection, count] of Object.entries(counts).sort()) {
  console.log(`  ${collection}: ${count}`);
}
