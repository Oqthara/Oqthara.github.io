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

  it("accepts an upstream release dispatch and keeps the poll as a safety net", async () => {
    const text = await workflow(NAME);
    assert.match(
      text,
      /^ {2}repository_dispatch:\n(?: {4}.*\n)*? {4}types: \[alpha-release-published\]$/m,
      "upstream sends `alpha-release-published` when it publishes a release",
    );
    assert.match(text, /^ {4}- cron: "\*\/15 \* \* \* \*"$/m, "the poll is retained so a lost dispatch still converges");
    assert.doesNotMatch(text, /^\s+release:/m, "a local release trigger would never fire for upstream releases");
  });

  it("treats the dispatch payload as a signal to look, never as an instruction", async () => {
    const text = await workflow(NAME);
    // The detection step must re-read upstream. If it trusted `client_payload`, a forged dispatch
    // could make the mirror publish a release that upstream never made.
    assert.doesNotMatch(
      text,
      /client_payload/,
      "the payload is not read anywhere: check-upstream-release.mjs asks GitHub what was published",
    );
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
    assert.match(
      stepBody(text, "Record a successful sync"),
      /if: \$\{\{ !cancelled\(\) && steps\.sync\.outcome == 'success' && steps\.gate\.outputs\.enabled == 'true' \}\}/,
    );
    const failed = stepBody(text, "Record a failed sync");
    assert.match(failed, /steps\.sync\.outcome != 'success'/);
    assert.match(failed, /--record=failed/);
  });

  it("a failed sync is recorded rather than skipped by an implicit success()", async () => {
    // SECURITY/CORRECTNESS: an `if:` with no status function gets an implicit `success()`, which is
    // false as soon as an earlier step fails. The step whose job is to describe a failure would
    // therefore never run when there was one to describe, the state document would keep the last
    // success, and the next poll would believe the failed release had already been mirrored.
    const failed = stepBody(await workflow(NAME), "Record a failed sync");
    assert.match(failed, /!cancelled\(\)/, "must run through a failed sync");
    assert.doesNotMatch(failed, /^\s+if: (?!.*!cancelled)/m, "a bare if: is implicitly success()-gated");
    assert.doesNotMatch(failed, /--record=ok/, "a failure must never advance the success pointer");
  });

  it("a forced dispatch reconciles every document instead of trusting hashes", async () => {
    // The defect: `force` reran the incremental pass, whose hash comparison cannot see an edit
    // made directly in Firestore - the bookkeeping hash still matches, so the damaged document is
    // skipped. `force` is exactly the repair path for that damage, so it must select --full.
    const text = await workflow(NAME);
    const decide = stepBody(text, "Decide");
    assert.match(decide, /mode=full/, "force must select a full reconciliation");
    assert.match(decide, /inputs\.force/, "the mode must depend on the force input");

    const sync = stepBody(text, "Synchronize the mirror");
    assert.match(sync, /sync-firestore\.mjs --full/, "the full mode must reach the script");
    assert.match(sync, /SYNC_MODE/);
    assert.match(sync, /sync-firestore\.mjs\n/, "the incremental path must survive for scheduled polls");
  });

  it("scheduled polls stay incremental, so the 15-minute cadence is not a full rewrite", async () => {
    const decide = stepBody(await workflow(NAME), "Decide");
    assert.match(decide, /mode=incremental/);
    // `full` must never be the default branch of the decision.
    const modeBlock = decide.slice(decide.indexOf("FORCE"));
    assert.ok(
      modeBlock.indexOf("mode=full") < modeBlock.indexOf("mode=incremental"),
      "full must be the guarded branch, not the fallback",
    );
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

describe("production writes are opt-in, not a consequence of merging", () => {
  // AUTHORIZATION BOUNDARY: `alpha-release-sync.yml` polls every 15 minutes on `main`, and
  // `firebase-sync.yml` and `firestore-rules.yml` are scheduled/push-triggered too. Every one of
  // them writes production. Merging a branch therefore used to mean "and now production is
  // written, immediately, on a timer" - an irreversible act performed by a merge that nobody
  // called a deployment. These tests pin the switch that makes that opt-in.
  //
  // The default must be *off*. A gate that defaults on is not a gate, so the assertion that
  // matters most is the negative one: absent configuration, nothing writes.

  const GATE_VAR = "OQTHARA_PRODUCTION_SYNC";
  const RULES_VAR = "OQTHARA_DEPLOY_FIRESTORE_RULES";

  const GATED_STEPS = {
    "alpha-release-sync.yml": ["Synchronize the mirror", "Record a successful sync", "Record a failed sync"],
    "firebase-sync.yml": ["Sync"],
    "firestore-rules.yml": ["Deploy Firestore security rules"],
  };

  const gateStepName = (text) =>
    text.includes("Check the rules-deployment activation gate")
      ? "Check the rules-deployment activation gate"
      : "Check the production-sync activation gate";
  const gateBody = async (name) => {
    const text = await workflow(name);
    return stepBody(text, gateStepName(text));
  };

  it("every workflow that can write production consults a repository variable", async () => {
    const expected = [
      ["alpha-release-sync.yml", GATE_VAR],
      ["firebase-sync.yml", GATE_VAR],
      ["firestore-rules.yml", RULES_VAR],
    ];
    for (const [name, variable] of expected) {
      assert.match(
        await gateBody(name),
        new RegExp(`\\$\\{\\{ vars\\.${variable} \\}\\}`),
        `${name} must read ${variable}`,
      );
    }
  });

  it("an absent variable is read as disabled, and only the literal string \"true\" enables writes", async () => {
    // The default has to survive the variable not existing at all. `${ENABLED:-}` with the `:-`
    // default is what makes an unset variable an empty string instead of a `unbound variable`
    // crash, and the comparison is against the exact lowercase literal so "TRUE", "yes", "1",
    // and the empty string all fail closed.
    for (const name of Object.keys(GATED_STEPS)) {
      const gate = await gateBody(name);
      assert.match(gate, /\$\{ENABLED:-\}/, `${name} must not crash on an unset variable`);
      assert.match(gate, /\[ "\$\{ENABLED:-\}" = "true" \]/, `${name} must compare exactly against "true"`);
      assert.match(gate, /enabled=false/, `${name} must have an explicit disabled branch`);
    }
  });

  it("every step that writes production is guarded by the gate", async () => {
    // A guard on the obvious write step is not enough. `--record=ok` advances the pointer that
    // makes the next poll decide "no action", and `--record=failed` writes a failure record - both
    // are production writes, and either one running while the mirror write is refused would put
    // the recorded state ahead of the actual mirror.
    for (const [name, steps] of Object.entries(GATED_STEPS)) {
      const text = await workflow(name);
      for (const step of steps) {
        assert.match(
          stepBody(text, step),
          /steps\.gate\.outputs\.enabled == 'true'/,
          `${name}: "${step}" can write production without passing the gate`,
        );
      }
    }
  });

  it("a forced dispatch cannot bypass the gate", async () => {
    // `force` exists to repair a mirror that was edited out of band, and it selects `--full`. That
    // makes it the most destructive manual path in the repository, and the one a maintainer is
    // most likely to reach for. It shares the same `if:` as the incremental path, so the gate
    // covers it - this test fails if anyone ever splits them.
    const sync = stepBody(await workflow("alpha-release-sync.yml"), "Synchronize the mirror");
    assert.match(sync, /steps\.gate\.outputs\.enabled == 'true'/);
    assert.match(sync, /sync-firestore\.mjs --full/);
  });

  it("detection still runs while writes are disabled, so a disabled repo can report intent", async () => {
    // The point of the gate is to withhold the write, not to make the workflow silent. A disabled
    // repository should still be able to answer "what is the newest upstream release, and what
    // would a sync do?" - that is what makes the first authorized run a confirmation rather than
    // an experiment.
    const detect = stepBody(await workflow("alpha-release-sync.yml"), "Detect the newest upstream release");
    assert.doesNotMatch(detect, /steps\.gate\.outputs\.enabled/, "detection must not be gated");
  });

  it("a run refused by the gate is reported as disabled rather than as a success", async () => {
    const text = await workflow("alpha-release-sync.yml");
    assert.match(stepBody(text, "Summarize"), /production writes/);
    assert.match(text, /::notice::Production synchronization is DISABLED/);
  });

  it("the gate exposes no credential to an unreviewed ref", async () => {
    // The gate is an `if:` on the write steps, not a new way to reach them. The job that holds the
    // key is still pinned to main, so this control cannot be used to widen that boundary.
    for (const name of Object.keys(GATED_STEPS)) {
      const gate = await gateBody(name);
      assert.doesNotMatch(gate, /secrets\./, `${name}: the gate step itself must not touch a secret`);
    }
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

  it("a value interpolated into a command line is quoted", async () => {
    // `run: node script.mjs $FULL` splits and globs on whitespace. The value here is a workflow
    // input, so it is operator-supplied, and shellcheck flags it (SC2086) for good reason.
    // `${V:+"$V"}` passes an argument only when the variable is set and non-empty.
    for (const name of NAMES) {
      const text = await workflow(name);
      for (const line of text.split("\n")) {
        const bare = line.match(/run:.*\s(\$[A-Z][A-Z0-9_]*)\s*$/);
        if (!bare) continue;
        assert.ok(
          line.includes('${' + bare[1].slice(1) + ':+"'),
          `${name} interpolates an unquoted variable: ${line.trim()}`,
        );
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

describe("a credential-bearing job only ever runs reviewed code", () => {
  // SECURITY: `workflow_dispatch` accepts a `--ref`, so a maintainer (or anything holding a token
  // that can dispatch) can start this workflow against a branch that has not been reviewed. Without
  // a guard the `sync` job checks that branch out and runs its `scripts/*.mjs` with
  // FIREBASE_SERVICE_ACCOUNT in scope - so a pull request could exfiltrate a production admin key
  // by editing a single script. A comment is not a control; these assertions are.
  const SECRET_JOB_INPUTS = ["force", "dry_run"];

  const jobs = async () => YAML.parse(await workflow("alpha-release-sync.yml"), { uniqueKeys: true, version: "1.2" }).jobs;

  const jobUsingSecret = async () => {
    const parsed = await jobs();
    const found = Object.entries(parsed).filter(([, job]) =>
      JSON.stringify(job).includes("secrets.FIREBASE_SERVICE_ACCOUNT"));
    assert.equal(found.length, 1, "expected exactly one job to reach for the service account");
    return found[0];
  };

  it("the job that reads FIREBASE_SERVICE_ACCOUNT is restricted to refs/heads/main", async () => {
    const [name, job] = await jobUsingSecret();
    assert.equal(job.if, "github.ref == 'refs/heads/main'", `${name} may run on an unreviewed ref`);
  });

  it("that job checks out main explicitly rather than the dispatching ref", async () => {
    const [name, job] = await jobUsingSecret();
    const checkout = job.steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    assert.ok(checkout, `${name} has no checkout step`);
    // `actions/checkout` defaults to github.ref for workflow_dispatch, which is the branch under
    // test. Anything other than a literal `main` reintroduces the defect.
    assert.equal(checkout.with?.ref, "main", `${name} checks out the dispatching ref`);
    assert.notEqual(checkout.with?.["persist-credentials"], true);
  });

  it("a dispatch from another ref fails with an explanation instead of silently doing nothing", async () => {
    const parsed = await jobs();
    const refusers = Object.entries(parsed).filter(([, job]) =>
      typeof job.if === "string" && /github\.ref\s*!=\s*'refs\/heads\/main'/.test(job.if));
    assert.equal(refusers.length, 1, "expected one job whose whole purpose is refusing other refs");
    const [, refuser] = refusers[0];

    const script = JSON.stringify(refuser);
    assert.match(script, /::error::/, "the refusal must be visible as an annotation");
    assert.match(script, /exit 1/, "a refusal must fail the run, not pass it");
    assert.match(script, /--ref main/, "the message must say how to run it correctly");

    // The refusal job runs the explanation, not the credentialed work.
    assert.doesNotMatch(script, /secrets\.|sync-firestore\.mjs/);
  });

  it("scheduled runs are unaffected, because they are already on the default branch", async () => {
    const parsed = await jobs();
    const [name, job] = await jobUsingSecret();
    // `github.ref` for a schedule event is the default branch, so an equality guard is satisfied
    // there. Asserting the negative keeps someone from "fixing" the guard into something that
    // only matches workflow_dispatch.
    assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
    assert.doesNotMatch(job.if, /github\.event_name/, `${name} must not special-case the trigger`);
    assert.ok(parsed.sync, "the guarded job should be the sync job");
  });

  it("the credential reaches scripts through env, never through argv or the log", async () => {
    const [name, job] = await jobUsingSecret();
    for (const step of job.steps) {
      if (typeof step.run !== "string") continue;
      assert.doesNotMatch(step.run, /\$\{\{/, `${name}: ${step.name} interpolates an expression into shell source`);
      assert.doesNotMatch(step.run, /echo\s+\$\{?FIREBASE_SERVICE_ACCOUNT/, `${name}: ${step.name} echoes the key`);
      assert.doesNotMatch(step.run, />>?\s*\S*\.json/, `${name}: ${step.name} writes a file next to the key`);
    }
    const env = job.env ?? {};
    assert.equal(env.FIREBASE_SERVICE_ACCOUNT, undefined,
      "a job-level env would put the key in scope of every step including third-party actions");
  });

  it("still exposes exactly the manual inputs the recovery path needs", async () => {
    const parsed = YAML.parse(await workflow("alpha-release-sync.yml"), { uniqueKeys: true, version: "1.2" });
    const dispatch = parsed.on.workflow_dispatch;
    const declared = Object.keys(dispatch.inputs ?? {});
    assert.deepEqual(declared.sort(), [...SECRET_JOB_INPUTS].sort());
  });
});

describe("every job that checks out has read access to contents", () => {
  // SECURITY: job-level `permissions:` REPLACE the workflow-level block instead of merging with
  // it. A job that declares only `pages: write` therefore has no `contents: read`, and its
  // `actions/checkout` fails - or, worse, silently produces an empty tree if the token behaviour
  // ever changes. Rather than trust each job, pin the invariant: checkout implies contents: read.
  const NAMES = ["alpha-release-sync.yml", "firebase-sync.yml", "firestore-rules.yml", "pages.yml"];

  const parsedWorkflow = async (name) =>
    YAML.parse(await workflow(name), { uniqueKeys: true, version: "1.2" });

  const checkouts = (job) => (job.steps ?? []).filter((step) =>
    String(step.uses ?? "").startsWith("actions/checkout@"));

  it("no job runs actions/checkout without contents: read in scope", async () => {
    for (const name of NAMES) {
      const document = await parsedWorkflow(name);
      const workflowPermissions = document.permissions ?? {};
      for (const [jobName, job] of Object.entries(document.jobs)) {
        if (checkouts(job).length === 0) continue;
        const effective = job.permissions ?? workflowPermissions;
        assert.equal(effective.contents, "read",
          `${name}:${jobName} checks out with contents=${effective.contents}; job permissions replace the workflow block`);
      }
    }
  });

  it("the Pages deploy job publishes without checking anything out", async () => {
    // The site arrives as a build artifact. A checkout there would need `contents: read`, which
    // would widen the publishing job's token for no reason.
    const document = await parsedWorkflow("pages.yml");
    const deploy = document.jobs.deploy;
    assert.ok(deploy, "pages.yml has no deploy job");
    assert.equal(checkouts(deploy).length, 0, "the deploy job checks out the repository");
    assert.equal(deploy.permissions.pages, "write");
    assert.equal(deploy.permissions["id-token"], "write");
    assert.equal(deploy.permissions.contents, undefined,
      "granting contents to a job that never checks out is unnecessary privilege");
    assert.equal(deploy.needs, "build");
  });

  it("a pull request can never cancel the run that deploys production", async () => {
    // Observed on 56eccac: the push run deployed successfully, but its `Cross-browser suite` was
    // cancelled by a pull-request run that had joined the same `pages` group. The commit that
    // went to production was therefore published with its browser suite cut short, and the run
    // still reported success overall. The group must be keyed by ref so that only a newer run of
    // the same ref supersedes an older one.
    const document = await parsedWorkflow("pages.yml");
    assert.equal(document.concurrency.group, "pages-${{ github.ref }}",
      "a shared concurrency group lets a pull request cancel a main run");
    assert.equal(document.concurrency["cancel-in-progress"], true,
      "superseding an older run of the same ref is still wanted");
  });

  it("the deploy job still runs after the artifact it publishes", async () => {
    const document = await parsedWorkflow("pages.yml");
    const build = document.jobs.build;
    assert.ok(
      build.steps.some((step) => String(step.uses ?? "").startsWith("actions/upload-pages-artifact@")),
      "the build job no longer produces the artifact the deploy job needs",
    );
    const deploy = document.jobs.deploy;
    const names = deploy.steps.map((step) => step.name ?? step.uses ?? "");
    assert.ok(names.some((n) => n.includes("deploy-pages")), "the deploy job lost its deploy step");
    assert.ok(names.some((n) => /smoke/i.test(n)), "the deploy job lost its post-deploy smoke test");
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

describe("the emulator's Java requirement is met by CI", () => {
  // `firebase-tools` 15 hard-fails the emulator on a JRE below 21 (`controller.js`), and the
  // ubuntu runner does not ship one. Without an explicit JDK the rules gate fails with an
  // error that reads like a rules problem, and Pages stops deploying. Pin the coupling: every
  // workflow that runs `test:rules` must first install a JDK, and it must be 21 or newer.
  const RULES_WORKFLOWS = ["pages.yml", "firestore-rules.yml"];

  it("every workflow that runs the rules suite installs a JDK first", async () => {
    for (const name of RULES_WORKFLOWS) {
      const text = await workflow(name);
      assert.ok(text.includes("test:rules"), `${name} no longer runs test:rules; update this test`);

      const jdkAt = text.indexOf("actions/setup-java@");
      assert.ok(jdkAt !== -1, `${name} runs test:rules without actions/setup-java`);

      // Order matters: the JDK has to exist before the emulator starts.
      assert.ok(jdkAt < text.indexOf("test:rules"), `${name} installs the JDK after running test:rules`);

      const version = /java-version:\s*"?(\d+)"?/.exec(text);
      assert.ok(version, `${name} does not pin java-version`);
      assert.ok(
        Number(version[1]) >= 21,
        `${name} pins Java ${version[1]}, but firebase-tools needs 21 or newer`
      );
    }
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

describe("firebase-sync schedule", () => {
  // The Firestore free tier meters reads per Pacific day and resets at midnight Pacific, which is
  // 08:00 UTC under PST and 07:00 UTC under PDT. A run scheduled before the reset spends its whole
  // window against the previous day's exhausted allowance: that is exactly what happened on
  // 2026-11-07, when the 03:17 UTC run died at 8 RESOURCE_EXHAUSTED before writing anything.
  it("runs after the Pacific quota reset in both PST and PDT", async () => {
    const text = await workflow("firebase-sync.yml");
    const match = text.match(/^ {4}- cron: "(\d+) (\d+) \* \* \*"$/m);
    assert.ok(match, "firebase-sync.yml must have a single daily cron entry");
    const [, minute, hour] = match.map(Number);
    assert.equal(match[1], "17", "a fixed odd minute avoids the top-of-hour runner spike");
    // 08:00 UTC is the latest reset instant (midnight PST). Any hour strictly below 8 would run
    // before the reset during standard time.
    assert.ok(hour >= 8, `cron hour ${hour} runs before the midnight-Pacific reset under PST`);
    assert.ok(hour <= 10, `cron hour ${hour} drifts needlessly far from the reset`);
    assert.ok(minute >= 0 && minute < 60);
  });

  it("keeps the shared concurrency group so a sync never races the rules job", async () => {
    const text = await workflow("firebase-sync.yml");
    assert.match(text, /^\s+group: firestore-mirror$/m);
    assert.match(text, /cancel-in-progress: false/, "cancelling mid-write would leave a partial batch");
  });
});

describe("firestore-audit workflow", () => {
  // The audit exists to produce the evidence a reconciliation is judged by. Two properties make
  // that evidence trustworthy, and both are easy to lose by accident: it must not be able to
  // write, and it must not be gated on the write switch — an audit that only runs after writes
  // are enabled could never capture the "before" state it is supposed to be compared against.
  const NAME = "firestore-audit.yml";

  it("runs only the read-only audit and never the sync", async () => {
    const text = await workflow(NAME);
    assert.match(text, /node scripts\/audit-production\.mjs/);
    assert.doesNotMatch(text, /sync-firestore\.mjs/, "the sync writes; the audit must not");
    assert.doesNotMatch(text, /firebase\s+deploy|deploy-firestore-rules\.mjs|:commit\b/);
  });

  it("is not gated on the production-sync variable", async () => {
    const text = await workflow(NAME);
    assert.doesNotMatch(text, /vars\.OQTHARA_PRODUCTION_SYNC/,
      "reading is not writing; gating the audit would prevent capturing the pre-change inventory");
    assert.doesNotMatch(text, /vars\.OQTHARA_DEPLOY_FIRESTORE_RULES/);
  });

  it("shares the mirror concurrency group and never cancels a run", async () => {
    const text = await workflow(NAME);
    assert.match(text, /^\s+group: firestore-mirror$/m);
    assert.match(text, /cancel-in-progress: false/);
  });

  it("requests read-only permissions", async () => {
    const text = await workflow(NAME);
    assert.match(text, /^permissions:\n {2}contents: read$/m);
    assert.doesNotMatch(text, /^\s+(contents|packages|id-token|actions): write$/m);
  });

  it("keeps the inventory as an artifact even when the audit fails", async () => {
    const text = await workflow(NAME);
    const upload = stepBody(text, "Upload the inventory");
    assert.match(upload, /if: always\(\)/,
      "a quota failure still leaves a partial report that a reviewer needs to see");
    assert.match(upload, /actions\/upload-artifact@/);
  });

  it("runs on a schedule, so the mirror is audited without anyone remembering to start it", async () => {
    const text = await workflow(NAME);
    // Drift detection that a human has to trigger is not drift detection: the report describes
    // whichever day someone last ran it, and the twenty-nine days in between are unobserved.
    const cron = text.match(/^\s+- cron: "([^"]+)"$/m);
    assert.ok(cron, "a schedule is required; workflow_dispatch alone leaves the mirror unaudited");
    const [minute, hour, day, month, weekday] = cron[1].split(/\s+/);
    assert.equal(weekday, "*", "a daily audit, not a weekly one");
    assert.equal(month, "*");
    assert.equal(day, "*");
    // An on-the-hour time is where GitHub's scheduler is busiest and most likely to delay or drop
    // the run, which for an audit is indistinguishable from a day with nothing to report.
    assert.notEqual(minute, "0", "off the hour, so the cron is not competing with every other job");
    assert.ok(Number(hour) >= 0 && Number(hour) <= 23);
  });

  it("records the run in the job summary so the artifact is traceable to a commit", async () => {
    const text = await workflow(NAME);
    const summary = stepBody(text, "Summarise the outcome");
    assert.match(summary, /GITHUB_STEP_SUMMARY/);
    assert.match(summary, /GITHUB_SHA/);
  });
});

describe("firestore-audit invocation", () => {
  // A workflow contract test that only greps for a script name will happily pass while the
  // command line is wrong: an earlier version of this test did exactly that, and CI failed with
  // "Unknown argument(s): --out <path>" because `--out` requires `=`. Extract the real command
  // and run it through the real parser, so the workflow and the CLI cannot drift apart.
  it("passes arguments the audit's own parser accepts", async () => {
    const { parseArgs } = await import("../scripts/audit-production.mjs");
    const text = await workflow("firestore-audit.yml");
    const match = text.match(/node scripts\/audit-production\.mjs (.*)$/m);
    assert.ok(match, "the workflow must invoke the audit");

    // Stop at the first shell operator: `| tee` and `&&` are the shell's, not node's.
    // Quoted segments become a placeholder, since the shell resolves them before node sees them.
    const argv = match[1]
      .split(/[|&;]/)[0]
      .trim()
      .replace(/"[^"]*"/g, "PLACEHOLDER")
      .split(/\s+/)
      .filter(Boolean);

    const { unknown, options } = parseArgs(argv);
    assert.deepEqual(unknown, [], `the audit would exit on these arguments: ${unknown.join(" ")}`);
    assert.equal(typeof options.out, "string");
    assert.notEqual(options.out, "", "--out must be passed; the artifact is the point of the run");
  });

  it("writes the inventory to a .json file the artifact upload can collect", async () => {
    const text = await workflow("firestore-audit.yml");
    // The path is a shell variable, so the parser check above sees a placeholder instead. Assert
    // the assignment directly: an artifact holding a non-JSON path would be silently useless.
    assert.match(text, /^\s*out="artifacts\/production\/audit-[^"]*\.json"$/m);
  });

  it("never passes --token, which would bypass the service-account identity check", async () => {
    const text = await workflow("firestore-audit.yml");
    assert.doesNotMatch(text, /--token\b/,
      "the service-account path verifies the expected identity; --token would skip that");
  });
});
