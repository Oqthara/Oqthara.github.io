import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import YAML from "yaml";

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

  it("no workflow interpolates any step output into a shell script body", async () => {
    // The same paste-into-source hazard applies to step outputs, and those are attacker-reachable:
    // an upstream release tag is chosen by anyone who can write to the mirrored repository.
    // A tag named `v1$(id)` runs on the runner if it is interpolated here. Only `env:` is allowed.
    for (const name of NAMES) {
      const text = await workflow(name);
      const bodies = [
        ...text.matchAll(/^ +run: \|\n((?: {8,}.*\n|\n)+)/gm),
        ...text.matchAll(/^ +run: (?!\|)(.*)$/gm),
      ];
      for (const block of bodies) {
        const body = block[1] ?? "";
        assert.doesNotMatch(body, /\$\{\{/,
          `${name} interpolates a workflow expression into a shell script body; pass it via env:`);
      }
    }
  });

  it("publishing scopes stay on the job that publishes", async () => {
    // `pages: write` and `id-token: write` are workflow-wide by default, which would hand them to
    // the build job as well — the job that runs `npm ci`, an emulator and a browser suite.
    const text = await workflow("pages.yml");
    const topLevel = text.slice(0, text.indexOf("jobs:"));
    assert.doesNotMatch(topLevel, /pages: write/, "pages: write is granted workflow-wide");
    assert.doesNotMatch(topLevel, /id-token: write/, "id-token: write is granted workflow-wide");
    const deployJob = text.slice(text.indexOf("\n  deploy:"));
    assert.match(deployJob, /^ +permissions:\n +pages: write\n +id-token: write/m,
      "the deploy job must hold the publishing scopes");
  });

  it("third-party CLIs are installed from the lockfile, not fetched ad hoc", async () => {
    // `npx --yes pkg@13` downloads and runs whatever `pkg@13` resolves to at build time, next to
    // FIREBASE_SERVICE_ACCOUNT in the rules workflow. The pinned devDependency is the same CLI
    // with a lockfile hash behind it.
    for (const name of NAMES) {
      const text = await workflow(name);
      for (const line of text.split("\n")) {
        if (!line.includes("npx ")) continue;
        assert.doesNotMatch(line, /npx +--yes/, `${name} fetches a CLI at run time: ${line.trim()}`);
        assert.doesNotMatch(line, /@[0-9]/, `${name} resolves a CLI by range: ${line.trim()}`);
      }
    }
  });

  it("every workflow that writes the mirror shares one concurrency group", async () => {
    // Two workflows that each serialize only themselves still race: both read the mirror state at
    // the start and commit later, so one can publish an unpublish set computed before the other
    // created those documents.
    const writers = [];
    for (const name of NAMES) {
      const text = await workflow(name);
      if (text.includes("scripts/sync-firestore.mjs")) writers.push([name, text]);
    }
    assert.ok(writers.length >= 2, "expected more than one workflow to run the mirror sync");
    for (const [name, text] of writers) {
      const group = text.match(/^concurrency:\n +group: (.+)$/m);
      assert.ok(group, `${name} writes the mirror without a concurrency group`);
      assert.equal(group[1].trim(), "firestore-mirror", `${name} is not in the shared mirror group`);
    }
  });

  it("checkout does not persist the job token into the working tree", async () => {
    // `actions/checkout` defaults to leaving GITHUB_TOKEN in `.git/config`, where anything that can
    // read files can use it. No job here pushes, so none of them needs it.
    for (const name of NAMES) {
      const text = await workflow(name);
      for (const block of text.matchAll(/^ +- uses: actions\/checkout@.*$/gm)) {
        assert.match(text.slice(block.index, block.index + 400), /persist-credentials: false/,
          `${name} leaves GITHUB_TOKEN in .git/config`);
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

describe("repository hygiene", () => {
  // A service-account key is the one accidental commit that would matter most: it grants full
  // project access, and removing it from history does not un-leak it. The rule is cheap, so it
  // is pinned rather than trusted to memory.
  it(".gitignore refuses every service-account key and dotenv file the console produces", async () => {
    const text = await readFile(new URL(".gitignore", ROOT), "utf8");
    const rules = new Set(text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")));

    for (const pattern of ["*firebase-adminsdk*.json", "service-account*.json", "*-credentials.json", ".env", ".env.local"]) {
      assert.ok(rules.has(pattern), `.gitignore does not ignore ${pattern}`);
    }
    // `.env.example` documents the variables and must stay committable.
    assert.ok(!rules.has(".env.*"), ".env.example would be ignored");
  });
});

describe("workflow files are valid YAML", () => {
  // A duplicate key is the quietest way to break a workflow: the file is syntactically
  // plausible, `git diff` looks fine, and GitHub rejects the run before any step starts —
  // so a scheduled sync simply never happens and nothing in the log says why. Text-level
  // assertions cannot catch it, and a permissive parser hides it, so parse strictly.
  it("every workflow parses with unique keys and a jobs mapping", async () => {
    for (const name of ["alpha-release-sync.yml", "firebase-sync.yml", "firestore-rules.yml", "pages.yml"]) {
      const text = await workflow(name);
      let document;
      assert.doesNotThrow(() => {
        document = YAML.parse(text, { uniqueKeys: true });
      }, `${name} is not valid YAML`);
      assert.equal(typeof document, "object", `${name} did not parse to a mapping`);
      assert.ok(document.jobs && typeof document.jobs === "object", `${name} has no jobs mapping`);
      assert.ok(!text.includes("\ton"), `${name} must not use tabs`);
    }
  });

  // `yaml` reads `on:` as the boolean `true` unless the 1.2 core schema is used, which is the
  // classic way to lose a trigger list. Assert the triggers survive the parse.
  it("keeps the `on:` trigger block as written rather than a boolean key", async () => {
    for (const name of ["alpha-release-sync.yml", "firebase-sync.yml", "firestore-rules.yml", "pages.yml"]) {
      const document = YAML.parse(await workflow(name), { uniqueKeys: true, version: "1.2" });
      const triggers = document.on;
      assert.ok(triggers && typeof triggers === "object", `${name}: on: did not parse to a mapping`);
      assert.ok(Object.keys(triggers).length > 0, `${name}: on: has no triggers`);
    }
  });
});
