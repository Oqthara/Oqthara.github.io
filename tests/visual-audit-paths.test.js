import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Two scripts write screenshots of the same routes into two directories on purpose:
//
//   `scripts/audit-visual.mjs`     -> `artifacts/visual-audit-routes/`  (transient, git-ignored)
//   `scripts/capture-screenshots.mjs` -> `artifacts/visual-audit/`      (committed, reviewed)
//
// They differ in deviceScaleFactor and in whether the capture is full-page, so the same route
// produces different pixels. When both wrote to one directory the second run silently overwrote
// the first, and the result read as a nondeterministic screenshot rather than as one script
// clobbering another. Nothing in a normal test run would notice the paths converging again, so
// the guard has to be here.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

function sourceOf(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

test("the audit and the capture script write to different directories", () => {
  const audit = sourceOf("scripts/audit-visual.mjs");
  const capture = sourceOf("scripts/capture-screenshots.mjs");

  assert.match(audit, /artifacts",\s*"visual-audit-routes"/, "audit-visual.mjs must write to artifacts/visual-audit-routes");
  assert.match(capture, /artifacts",\s*"visual-audit"/, "capture-screenshots.mjs must write to artifacts/visual-audit");

  // The dangerous form is the audit writing to the committed directory, which is exactly what
  // happened before. A bare mention in a comment is fine; a path expression is not.
  assert.doesNotMatch(
    audit,
    /join\([^)]*"artifacts",\s*"visual-audit"\s*\)/,
    "audit-visual.mjs must never resolve the committed screenshot directory",
  );
});

test("the generated audit screenshots are not tracked by git", () => {
  const ignore = sourceOf(".gitignore");
  const rules = ignore.split("\n").map((line) => line.trim());
  assert.ok(
    rules.some((line) => line === "artifacts/visual-audit-routes/" || line === "artifacts/visual-audit-routes"),
    `.gitignore must ignore artifacts/visual-audit-routes/, found:\n${rules.filter(Boolean).join("\n")}`,
  );
});

test("the committed screenshots are tracked, so the audit cannot replace reviewed evidence", () => {
  const ignore = sourceOf(".gitignore");
  const rules = ignore.split("\n").map((line) => line.trim());
  assert.ok(
    !rules.some((line) => line === "artifacts/visual-audit/" || line === "artifacts/visual-audit"),
    "artifacts/visual-audit/ must stay committed, so it must not be git-ignored",
  );
});
