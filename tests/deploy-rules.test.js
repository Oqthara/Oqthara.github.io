import test from "node:test";
import assert from "node:assert/strict";

import {
  EXIT,
  compileRules,
  createRuleset,
  parseArgs,
  readActiveRules,
  releaseRuleset,
} from "../scripts/deploy-firestore-rules.mjs";

// Releasing rules is the one write this repository performs against project-level
// configuration, so each call is pinned to the exact request it must produce. The cases below
// exist because the failure they prevent is silent: a release that points at an older ruleset
// keeps serving traffic and looks like success unless the response is inspected.

const PROJECT = "oqthara";
const RELEASE = "cloud.firestore";
const BASE = "https://firebaserules.googleapis.com/v1";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const RULES = "service cloud.firestore {\n  match /databases/{db}/documents {\n  }\n}\n";

test("compile sends the rules to projects/{project}:test and creates nothing", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ issues: [] });
  };
  const result = await compileRules(PROJECT, { token: "t", rulesText: RULES, fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/projects/oqthara:test`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body).source.files, [
    { name: "firestore.rules", content: RULES },
  ]);
});

test("compile surfaces a rules error rather than reporting success", async () => {
  const fetchImpl = async () =>
    jsonResponse({ issues: [{ severity: "ERROR", description: "unexpected token", sourcePosition: { line: 7 } }] });
  const result = await compileRules(PROJECT, { token: "t", rulesText: RULES, fetchImpl });
  assert.equal(result.issues[0].severity, "ERROR");
  assert.equal(result.issues[0].sourcePosition.line, 7);
});

test("createRuleset posts the source and returns the generated id", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ name: "projects/oqthara/rulesets/abc-123" });
  };
  const result = await createRuleset(PROJECT, { token: "t", rulesText: RULES, fetchImpl });

  assert.equal(result.rulesetId, "abc-123");
  assert.equal(result.rulesetName, "projects/oqthara/rulesets/abc-123");
  assert.equal(calls[0].url, `${BASE}/projects/oqthara/rulesets`);
  assert.equal(calls[0].init.method, "POST");
});

test("release updates the existing release and restricts the mask to rulesetName", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ name: `projects/${PROJECT}/releases/${RELEASE}` });
  };
  const result = await releaseRuleset(PROJECT, "projects/oqthara/rulesets/abc-123", { token: "t", fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/releases\/cloud\.firestore\?updateMask=rulesetName$/);
  assert.equal(calls[0].init.method, "PATCH");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.rulesetName, "projects/oqthara/rulesets/abc-123");
  // No other release field may travel in the body.
  assert.deepEqual(Object.keys(body).sort(), ["name", "rulesetName"]);
});

test("release creates the release only when the update reports 404", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === "PATCH") return jsonResponse({ error: { code: 404 } }, 404);
    return jsonResponse({ name: `projects/${PROJECT}/releases/${RELEASE}` });
  };
  const result = await releaseRuleset(PROJECT, "projects/oqthara/rulesets/abc-123", { token: "t", fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, "PATCH");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].url, `${BASE}/projects/oqthara/releases`);
});

test("release reports a non-404 failure without attempting to create a duplicate", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ error: { code: 403 } }, 403);
  };
  const result = await releaseRuleset(PROJECT, "projects/oqthara/rulesets/abc-123", { token: "t", fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(calls.length, 1);
});

test("readActiveRules reports the serving ruleset and its content digest", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/releases/cloud.firestore")) {
      return jsonResponse({
        rulesetName: "projects/oqthara/rulesets/xyz-789",
        updateTime: "2026-11-07T01:02:03.000Z",
      });
    }
    return jsonResponse({ source: { files: [{ name: "firestore.rules", content: "hello" }] } });
  };
  const result = await readActiveRules(PROJECT, { token: "t", fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.rulesetId, "xyz-789");
  assert.equal(result.bytes, 5);
  assert.equal(result.content, "hello");
  assert.equal(result.updateTime, "2026-11-07T01:02:03.000Z");
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test("readActiveRules fails closed when the release names no ruleset", async () => {
  const fetchImpl = async () => jsonResponse({});
  const result = await readActiveRules(PROJECT, { token: "t", fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /names no ruleset/);
});

test("parseArgs accepts the documented flags and reports unknown ones", () => {
  assert.deepEqual(parseArgs([]).options, { dryRun: false, file: "firestore.rules", help: false });
  assert.equal(parseArgs(["--dry-run"]).options.dryRun, true);
  assert.equal(parseArgs(["--file=rules.prod"]).options.file, "rules.prod");
  assert.equal(parseArgs(["--help"]).options.help, true);
  assert.deepEqual(parseArgs(["--nope"]).unknown, ["--nope"]);
  assert.equal(EXIT.ok, 0);
});
