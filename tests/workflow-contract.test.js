import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// The workflows are the deployment mechanism, so their shape is a contract worth pinning.
// Adding a YAML parser to the dev dependencies to assert six properties is not a good trade;
// these read the text and assert the exact lines that carry the guarantees.

const ROOT = new URL("../", import.meta.url);

const workflow = (name) =>
  readFile(new URL(`.github/workflows/${name}`, ROOT), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

const STEP = /^      - name: (.+)$/gm;
const stepNames = (text) => [...text.matchAll(STEP)].map((match) => match[1]);
const stepBody = (text, name) => {
  const names = [...text.matchAll(STEP)];
  const index = names.findIndex((match) => match[1] === name);
  assert.notEqual(index, -1, `no step named "${name}"`);
  const start = names[index].index;
  const end = names[index + 1]?.index ?? text.length;
  return text.slice(start, end);
};

describe("alpha-release-sync workflow", () => {
  const NAME = "alpha-release-sync.yml";

  it("polls on a 15-minute schedule, because upstream cannot dispatch here", async () => {
    const text = await workflow(NAME);
    assert.match(text, /^ {4}- cron: "\*\/15 \* \* \* \*"$/m);
    assert.doesNotMatch(text, /^\s+release:/m, "a release trigger would never fire for upstream releases");
  });

  it("offers manual dispatch with force and dry_run inputs", async () => {
    const text = await workflow(NAME);
    assert.match(text, /^ {2}workflow_dispatch:$/m);
    assert.match(stepBody(text, "Detect the newest upstream release"), /inputs\.dry_run && '--dry-run' \|\| ''/);
    assert.match(
      stepBody(text, "Decide"),
      /github\.event_name == 'workflow_dispatch' && inputs\.force/,
      "force repairs a mirror edited out of band",
    );
  });

  it("requests read-only GitHub permissions and never cancels a run mid-write", async () => {
    const text = await workflow(NAME);
    assert.match(text, /^permissions:\n {2}contents: read$/m);
    assert.doesNotMatch(text, /^\s+(contents|packages|id-token|actions): write$/m);
    assert.match(text, /cancel-in-progress: false/);
  });

  it("never deploys security rules", async () => {
    const text = await workflow(NAME);
    assert.doesNotMatch(text, /rules:release|deploy-rules|firestore\.rules/, "rules stay in firestore-rules.yml");
  });

  it("fails closed when the credential is absent, instead of guessing 'no change'", async () => {
    const text = await workflow(NAME);
    const report = stepBody(text, "Report a missing credential");
    assert.match(report, /::error::/);
    assert.match(report, /exit 1/);

    const detect = stepBody(text, "Detect the newest upstream release");
    assert.match(detect, /steps\.credential\.outputs\.present == 'true'/, "detection needs a readable state document");
  });

  it("records success only after the sync succeeds, and records failures without advancing", async () => {
    const text = await workflow(NAME);
    assert.match(stepBody(text, "Record a successful sync"), /if: steps\.sync\.outcome == 'success'/);
    const failed = stepBody(text, "Record a failed sync");
    assert.match(failed, /steps\.sync\.outcome != 'success'/);
    assert.match(failed, /--record=failed/);
  });

  it("forwards the detection outputs through GITHUB_OUTPUT, not through the log", async () => {
    const text = await workflow(NAME);
    const detect = stepBody(text, "Detect the newest upstream release");
    assert.doesNotMatch(detect, /awk|\/tmp\/detect\.log/, "parsing the log would break on any log line");
    assert.match(detect, /check-upstream-release\.mjs/);
  });

  it("summarizes the outcome even when an earlier step failed", async () => {
    const text = await workflow(NAME);
    assert.match(stepBody(text, "Summarize"), /if: always\(\)/);
    assert.match(text, /GITHUB_STEP_SUMMARY/);
  });
});

describe("workflow permissions across the repository", () => {
  const NAMES = ["alpha-release-sync.yml", "firebase-sync.yml", "firestore-rules.yml", "pages.yml"];

  it("every workflow declares an explicit permissions block", async () => {
    for (const name of NAMES) {
      const text = await workflow(name);
      assert.match(text, /^permissions:/m, `${name} must not inherit the repository default`);
    }
  });

  it("no workflow grants write access to repository contents", async () => {
    for (const name of NAMES) {
      const text = await workflow(name);
      assert.doesNotMatch(text, /contents: write/, `${name} does not need to push`);
    }
  });

  it("no workflow interpolates a secret into a shell script body", async () => {
    // `${{ secrets.X }}` inside `run:` is pasted into the script source, where quoting and
    // newlines in the value change the program. The `env:` indirection is the safe form.
    for (const name of NAMES) {
      const text = await workflow(name);
      for (const block of text.matchAll(/^ +run: \|\n((?: {8,}.*\n|\n)+)/gm)) {
        assert.doesNotMatch(block[1], /\$\{\{ secrets\./, `${name} interpolates a secret into a script`);
      }
    }
  });
});

describe("firestore rules deployment stays separate from content mirroring", () => {
  it("only firestore-rules.yml references the rules release target", async () => {
    const owners = [];
    for (const name of ["alpha-release-sync.yml", "firebase-sync.yml", "firestore-rules.yml", "pages.yml"]) {
      const text = await workflow(name);
      if (/firestore:rules|rules:release|tests\/firestore-rules/.test(text) || /scripts\/test-firestore-rules/.test(text)) {
        owners.push(name);
      }
    }
    assert.deepEqual(owners, ["firestore-rules.yml"]);
  });
});

describe("third-party code is pinned, not floating", () => {
  // A tag like `@v4` is a mutable pointer: whoever controls the action's repository can move it
  // to different code and the next run executes that code with this repository's token. A
  // commit SHA cannot be moved. The comment keeps the human-readable version discoverable so
  // the pin stays maintainable — a bare SHA with no comment is a puzzle, not a policy.
  it("every `uses:` is a full commit SHA with a readable version comment", async () => {
    for (const name of ["alpha-release-sync.yml", "firebase-sync.yml", "firestore-rules.yml", "pages.yml"]) {
      const text = await workflow(name);
      for (const line of text.split("\n")) {
        const match = /^\s*(?:- )?uses:\s*(\S+)(.*)$/.exec(line);
        if (!match) continue;
        const [, target, rest] = match;
        if (target.startsWith("./")) continue;
        assert.match(
          target,
          /@[0-9a-f]{40}$/,
          `${name}: ${target} is not pinned to a commit SHA`,
        );
        assert.match(rest, /#\s*v\d+/, `${name}: ${target} has no version comment`);
      }
    }
  });
});
