#!/usr/bin/env node
/**
 * Releases `firestore.rules` to project oqthara through the Firebase Rules API.
 *
 * Why this exists instead of `firebase deploy --only firestore:rules`
 * ------------------------------------------------------------------
 * The CLI performs an enablement precheck through Service Usage
 * (`GET projects/oqthara/services/firestore.googleapis.com`) before it touches the Rules API.
 * That call needs `serviceusage.services.get`, which the deployment service account does not
 * hold. The documented remediation is to grant a broader role to the account that mirrors
 * content, which trades a real security boundary for a permission the deployment does not use.
 *
 * The Rules API needs none of it. Releasing rules is two documented calls:
 *
 *   POST  projects/{project}/rulesets            -> a new ruleset id
 *   PATCH projects/{project}/releases/cloud.firestore -> point the release at it
 *   (POST .../releases if the release does not exist yet)
 *
 * Both are covered by the seven permissions `check-firebase-access.mjs` already verifies.
 * Nothing here enables an API, reads or writes Firestore documents, or changes IAM.
 *
 * Safety
 * ------
 *   * The rules are compiled with `projects/{project}:test` first. A ruleset that does not
 *     compile is never created, so an invalid release cannot be staged.
 *   * The release is updated, never deleted. `updateMask` names only `rulesetName`, so no other
 *     field of the release can change.
 *   * `--dry-run` performs the compile and stops.
 *   * The caller's identity and project are checked before any write, when a service account
 *     key is supplied, for the same reason the sync does it.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createHash } from "node:crypto";

import { EXPECTED_EMAIL, EXPECTED_PROJECT, identityOf, mintAccessToken } from "./check-firebase-access.mjs";
import { loadCredentials } from "./sync-firestore.mjs";

const RULES_ENDPOINT = "https://firebaserules.googleapis.com";
const RULES_FILE_NAME = "firestore.rules";
const RELEASE_ID = "cloud.firestore";

export const EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  credential: 2,
  compileFailed: 3,
  deployFailed: 4,
});

export const USAGE = `Usage: node scripts/deploy-firestore-rules.mjs [options]

Releases firestore.rules to project ${EXPECTED_PROJECT} through the Firebase Rules API.

Options:
  --dry-run    Compile the rules and stop; create no ruleset and change no release
  --file=PATH  Rules file to deploy (default: ${RULES_FILE_NAME})
  --help       Show this message

Credential: FIREBASE_SERVICE_ACCOUNT, the service account key JSON. The
identity must be ${EXPECTED_EMAIL}.`;

function describe(response, url) {
  return response.text().then((text) => {
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, url, body, text };
  });
}

/** Compiles the rules with `projects/{project}:test`. Creates no ruleset. */
export async function compileRules(projectId, { token, rulesText, fetchImpl = globalThis.fetch }) {
  const url = `${RULES_ENDPOINT}/v1/projects/${encodeURIComponent(projectId)}:test`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ source: { files: [{ name: RULES_FILE_NAME, content: rulesText }] } }),
  });
  const result = await describe(response, url);
  return { ...result, issues: result.body?.issues ?? [] };
}

/** Creates an immutable ruleset. Returns its generated id. */
export async function createRuleset(projectId, { token, rulesText, fetchImpl = globalThis.fetch }) {
  const url = `${RULES_ENDPOINT}/v1/projects/${encodeURIComponent(projectId)}/rulesets`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ source: { files: [{ name: RULES_FILE_NAME, content: rulesText }] } }),
  });
  const result = await describe(response, url);
  if (!result.ok) return result;
  const name = result.body?.name ?? "";
  return { ...result, rulesetName: name, rulesetId: name.split("/").pop() ?? "" };
}

/**
 * Points the `cloud.firestore` release at a ruleset, creating the release when absent.
 *
 * `updateMask` is restricted to `rulesetName` so no other release field can be altered by this
 * call. A 404 means the release does not exist yet, which is the only case that creates one.
 */
export async function releaseRuleset(projectId, rulesetName, { token, fetchImpl = globalThis.fetch }) {
  const base = `${RULES_ENDPOINT}/v1/projects/${encodeURIComponent(projectId)}/releases`;
  const updateUrl = `${base}/${encodeURIComponent(RELEASE_ID)}?updateMask=rulesetName`;
  const updated = await fetchImpl(updateUrl, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: `projects/${projectId}/releases/${RELEASE_ID}`, rulesetName }),
  });
  const update = await describe(updated, updateUrl);
  if (update.ok) return { ...update, created: false };
  if (update.status !== 404) return update;

  const createUrl = base;
  const created = await fetchImpl(createUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: `projects/${projectId}/releases/${RELEASE_ID}`, rulesetName }),
  });
  return { ...(await describe(created, createUrl)), created: true };
}

/** The active release and the rules text it serves, for a before/after comparison. */
export async function readActiveRules(projectId, { token, fetchImpl = globalThis.fetch }) {
  const url = `${RULES_ENDPOINT}/v1/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(RELEASE_ID)}`;
  const release = await describe(await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } }), url);
  if (!release.ok) return { ok: false, status: release.status, reason: `could not read the active release (${release.status})` };
  const rulesetName = release.body?.rulesetName ?? "";
  if (!rulesetName) return { ok: false, reason: "the active release names no ruleset" };

  const rulesetUrl = `${RULES_ENDPOINT}/v1/${rulesetName}`;
  const ruleset = await describe(await fetchImpl(rulesetUrl, { headers: { authorization: `Bearer ${token}` } }), rulesetUrl);
  if (!ruleset.ok) return { ok: false, status: ruleset.status, reason: `could not read ruleset ${rulesetName} (${ruleset.status})` };

  const content = (ruleset.body?.source?.files ?? []).map((file) => file.content ?? "").join("");
  return {
    ok: true,
    rulesetName,
    rulesetId: rulesetName.split("/").pop() ?? "",
    updateTime: release.body?.updateTime ?? "",
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

export function parseArgs(argv = []) {
  const options = { dryRun: false, file: RULES_FILE_NAME, help: false };
  const unknown = [];
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--file=")) options.file = arg.slice("--file=".length);
    else unknown.push(arg);
  }
  return { options, unknown };
}

export async function main(
  argv = process.argv.slice(2),
  { env = process.env, fetchImpl = globalThis.fetch, log = console.log, error = console.error } = {},
) {
  const { options, unknown } = parseArgs(argv);
  if (options.help) {
    log(USAGE);
    return EXIT.ok;
  }
  if (unknown.length) {
    error(`Unknown argument(s): ${unknown.join(" ")}\n\n${USAGE}`);
    return EXIT.usage;
  }

  let rulesText;
  try {
    rulesText = await readFile(options.file, "utf8");
  } catch (cause) {
    error(`Could not read ${options.file}: ${cause?.message ?? cause}`);
    return EXIT.usage;
  }

  const credentials = await loadCredentials(env);
  if (!credentials.ok) {
    error(credentials.reason);
    return EXIT.credential;
  }

  const identity = identityOf(credentials.serviceAccount);
  log(`client_email: ${identity.clientEmail}`);
  log(`project_id: ${identity.projectId}`);
  if (identity.clientEmail !== EXPECTED_EMAIL) {
    error(`Refusing to deploy: expected ${EXPECTED_EMAIL}, got ${identity.clientEmail}`);
    return EXIT.credential;
  }
  if (identity.projectId !== EXPECTED_PROJECT) {
    error(`Refusing to deploy: expected project ${EXPECTED_PROJECT}, got ${identity.projectId}`);
    return EXIT.credential;
  }

  const minted = await mintAccessToken(credentials.serviceAccount, { fetchImpl });
  if (!minted.ok) {
    error(`Could not mint an access token: ${minted.reason}`);
    return EXIT.credential;
  }
  const token = minted.token;
  const localSha = createHash("sha256").update(rulesText, "utf8").digest("hex");
  log(`local rules: ${Buffer.byteLength(rulesText, "utf8")} bytes, sha256 ${localSha}`);

  const before = await readActiveRules(identity.projectId, { token, fetchImpl });
  if (before.ok) {
    log(`active ruleset: ${before.rulesetId} (${before.bytes} bytes, sha256 ${before.sha256}, updated ${before.updateTime})`);
    log(`metadata/catalog block present: ${before.content.includes("match /metadata/catalog")}`);
  } else {
    log(`active ruleset: unknown (${before.reason})`);
  }
  if (before.ok && before.sha256 === localSha) {
    log("the active release already serves these exact rules; nothing to deploy");
    return EXIT.ok;
  }

  const compiled = await compileRules(identity.projectId, { token, rulesText, fetchImpl });
  if (!compiled.ok) {
    error(`compile failed: ${compiled.status} ${compiled.text?.slice(0, 600) ?? ""}`);
    return EXIT.compileFailed;
  }
  const errors = (compiled.issues ?? []).filter((issue) => issue.severity === "ERROR");
  if (errors.length) {
    for (const issue of errors) error(`compile error: ${issue.sourcePosition?.line ?? "?"}: ${issue.description}`);
    return EXIT.compileFailed;
  }
  log("compile: accepted");

  if (options.dryRun) {
    log("dry run: no ruleset was created and the release is unchanged");
    return EXIT.ok;
  }

  const created = await createRuleset(identity.projectId, { token, rulesText, fetchImpl });
  if (!created.ok) {
    error(`could not create a ruleset: ${created.status} ${created.text?.slice(0, 600) ?? ""}`);
    return EXIT.deployFailed;
  }
  log(`ruleset created: ${created.rulesetId}`);

  const released = await releaseRuleset(identity.projectId, created.rulesetName, { token, fetchImpl });
  if (!released.ok) {
    error(`could not release the ruleset: ${released.status} ${released.text?.slice(0, 600) ?? ""}`);
    error(`ruleset ${created.rulesetId} was created but is not serving traffic`);
    return EXIT.deployFailed;
  }
  log(`release ${RELEASE_ID} ${released.created ? "created" : "updated"} -> ${created.rulesetId}`);

  const after = await readActiveRules(identity.projectId, { token, fetchImpl });
  if (!after.ok) {
    error(`released, but could not read back the active rules: ${after.reason}`);
    return EXIT.deployFailed;
  }
  log(`active ruleset now: ${after.rulesetId} (${after.bytes} bytes, sha256 ${after.sha256}, updated ${after.updateTime})`);
  log(`metadata/catalog block present: ${after.content.includes("match /metadata/catalog")}`);
  if (after.sha256 !== localSha) {
    error(`the active rules do not match the local file: expected sha256 ${localSha}, read back ${after.sha256}`);
    return EXIT.deployFailed;
  }
  log("read-back confirms the deployed rules match the local file byte for byte");
  return EXIT.ok;
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (cause) => {
      console.error(`deploy-firestore-rules failed: ${cause?.message ?? cause}`);
      process.exitCode = EXIT.deployFailed;
    },
  );
}
