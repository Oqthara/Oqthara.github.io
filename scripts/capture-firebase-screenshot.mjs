#!/usr/bin/env node
/**
 * Captures the one screenshot that needs Firestore content, against a local emulator.
 *
 * The ordinary capture run has no database behind it, so `firebase-content-loaded.png` is gated
 * behind `OQ_AUDIT_FIREBASE=1`. Producing it by hand was error-prone enough that the committed
 * copy went stale: nothing recorded which build, which data, or which theme it came from.
 *
 * This script makes the whole chain reproducible in one command. It
 *
 *   1. builds the site with `VITE_FIREBASE_EMULATOR_HOST` pointing at a local emulator,
 *   2. seeds that emulator from a canonical content checkout (`scripts/seed-emulator.mjs`), so
 *      the content comes from local files and never from production, and
 *   3. runs the capture with `OQ_AUDIT_ONLY=firebase-content-loaded` so no other screenshot in
 *      `artifacts/visual-audit/` is touched.
 *
 *   node scripts/capture-firebase-screenshot.mjs
 *   OQ_SEED_ROOT=../oqthara node scripts/capture-firebase-screenshot.mjs
 *
 * `OQ_SEED_ROOT` must point at a checkout that contains the mirrored sources (`docs/**.md`,
 * `examples/**.oq`). This repository only carries a stub `language.md`, so seeding from it
 * produces one record and the page never renders Firestore content. That failure is loud on
 * purpose: a capture with no data behind it is exactly the stale artifact this replaces.
 *
 * The emulator is started by `firebase emulators:exec`, which shuts it down again on exit. This
 * never reads or writes a production project: the project id is a throwaway rules-test id.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// A rules-test project id, not a deployment target. Reusing it keeps this script independent of
// any real project configuration and matches what `npm run test:rules` already uses.
const PROJECT = "oqthara-rules-test";
const HOST = "127.0.0.1:8080";
// Defaults to the parent directory, which is where a worktree layout usually keeps the
// canonical checkout. Override it rather than pointing the seed at this repository.
const SEED_ROOT = (process.env.OQ_SEED_ROOT || "..").trim();

const inner = [
  `node scripts/seed-emulator.mjs --root=${SEED_ROOT}`,
  "npm run build",
  "node scripts/capture-screenshots.mjs",
]
  .map((command) => `echo '--- ${command}' && ${command}`)
  .join(" && ");

const env = {
  ...process.env,
  FIRESTORE_EMULATOR_HOST: HOST,
  GCLOUD_PROJECT: PROJECT,
  VITE_FIREBASE_EMULATOR_HOST: HOST,
  // The emulator namespaces data by project id. Without this the built app asks for its
  // default project (`oqthara`) while the seed wrote into `oqthara-rules-test`, so every read
  // finds nothing and the page quietly falls back to GitHub. Pinning both to the same throwaway
  // id is what makes the seeded content reachable.
  VITE_FIREBASE_PROJECT_ID: PROJECT,
  OQ_AUDIT_FIREBASE: "1",
  // Only this one file is captured, so a build pointed at an emulator cannot replace the
  // ordinary screenshots with output produced under different conditions.
  OQ_AUDIT_ONLY: "firebase-content-loaded",
};

console.log(`capturing firebase-content-loaded.png against ${HOST} (project ${PROJECT})`);
execFileSync(
  "npx",
  ["--no-install", "firebase", "emulators:exec", "--only", "firestore", "--project", PROJECT, inner],
  { cwd: root, env, stdio: "inherit" },
);
