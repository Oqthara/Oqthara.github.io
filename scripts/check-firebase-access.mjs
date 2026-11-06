// Diagnose the credential used by the Firebase workflows without changing anything.
//
// The question a 403 from `firebaserules.googleapis.com` raises is not "is the key valid" but
// "who is this, and may it do this". This script answers that in three steps and stops:
//
//   1. Identity — print only `client_email` and `project_id`, and compare them with the
//      expected values. A mismatch is reported, never compensated for by granting a role.
//   2. Token — sign a JWT with the key and exchange it for a Cloud Platform access token. A
//      failure here means the key itself is unusable, which is a different problem from IAM.
//   3. Authorization — ask `projects/{project}:testIamPermissions` which deployment
//      permissions are granted, then call `projects/{project}:test`, the exact non-destructive
//      call `firebase deploy --only firestore:rules` makes before it writes anything.
//
// The private key, the signed assertion and the access token are never printed, and no request
// body is echoed. The compile call only compiles: it creates no ruleset and no release.
//
// Exit codes: 0 ok, 1 usage, 2 unusable credential, 5 permission denied, 6 API disabled,
//             7 identity mismatch, 8 rules failed to compile.

import { createPrivateKey, createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadCredentials } from "./sync-firestore.mjs";

/** The identity the repository is provisioned for. Anything else is a discrepancy, not a fix. */
export const EXPECTED_EMAIL = "oqthara-github-sync@oqthara.iam.gserviceaccount.com";
export const EXPECTED_PROJECT = "oqthara";

/** The Cloud Platform scope every Google client library requests. */
export const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const RULES_ENDPOINT = "https://firebaserules.googleapis.com";
const RESOURCE_MANAGER_ENDPOINT = "https://cloudresourcemanager.googleapis.com";

/** Exactly what `firebase deploy --only firestore:rules` needs, and nothing else. */
export const DEPLOY_PERMISSIONS = Object.freeze([
  "firebaserules.rulesets.test",
  "firebaserules.rulesets.create",
  "firebaserules.rulesets.get",
  "firebaserules.releases.get",
  "firebaserules.releases.list",
  "firebaserules.releases.update",
  "firebaserules.releases.create",
]);

export const EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  credential: 2,
  permissionDenied: 5,
  apiDisabled: 6,
  identityMismatch: 7,
  compileFailed: 8,
});

/** The two fields that may be printed. Nothing else leaves the parsed key. */
export function identityOf(serviceAccount) {
  return {
    clientEmail: typeof serviceAccount?.client_email === "string" ? serviceAccount.client_email : "",
    projectId: typeof serviceAccount?.project_id === "string" ? serviceAccount.project_id : "",
  };
}

/** Returns human-readable problems; an empty list means the identity is the expected one. */
export function assertIdentity(identity, { expectedEmail = EXPECTED_EMAIL, expectedProject = EXPECTED_PROJECT } = {}) {
  const problems = [];
  if (identity.clientEmail !== expectedEmail) {
    problems.push(`client_email is "${identity.clientEmail || "(missing)"}", expected "${expectedEmail}"`);
  }
  if (identity.projectId !== expectedProject) {
    problems.push(`project_id is "${identity.projectId || "(missing)"}", expected "${expectedProject}"`);
  }
  return problems;
}

/** Signs a JWT assertion and exchanges it for an access token. Never returns the assertion. */
export async function mintAccessToken(serviceAccount, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const email = identityOf(serviceAccount).clientEmail;
  const pem = serviceAccount?.private_key;
  if (!email || !pem) {
    return { ok: false, reason: "the credential has no client_email or private_key" };
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    return { ok: false, reason: "private_key is not a readable private key" };
  }

  const issuedAt = Math.floor(now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: email,
      scope: SCOPE,
      aud: serviceAccount.token_uri || TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  ).toString("base64url");
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(privateKey, "base64url");
  const assertion = `${header}.${claims}.${signature}`;

  let response;
  try {
    response = await fetchImpl(serviceAccount.token_uri || TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
  } catch (cause) {
    return { ok: false, reason: `the token endpoint was unreachable (${cause?.code ?? cause?.message ?? "network error"})` };
  }
  const body = await readJson(response);
  if (!response.ok || typeof body?.access_token !== "string") {
    return { ok: false, reason: `${response.status} ${body?.error ?? "token exchange failed"}` };
  }
  return { ok: true, token: body.access_token, expiresIn: body.expires_in };
}

/** POST `projects/{project}:test`. Compiles the rules; creates no ruleset and no release. */
export async function testRuleset(projectId, { token, rulesText, fetchImpl = globalThis.fetch }) {
  const url = `${RULES_ENDPOINT}/v1/projects/${encodeURIComponent(projectId)}:test`;
  const files = [{ name: "firestore.rules", content: rulesText }];
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ source: { files } }),
  });
  return describe(response, `${url}`);
}

/** POST `projects/{project}:testIamPermissions`. Reports granted permissions only. */
export async function probePermissions(projectId, { token, fetchImpl = globalThis.fetch }) {
  const url = `${RESOURCE_MANAGER_ENDPOINT}/v1/projects/${encodeURIComponent(projectId)}:testIamPermissions`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ permissions: DEPLOY_PERMISSIONS }),
  });
  const body = await readJson(response);
  if (!response.ok) return { ok: false, status: response.status, unreachable: true };
  const granted = new Set(Array.isArray(body?.permissions) ? body.permissions : []);
  return {
    ok: true,
    granted: DEPLOY_PERMISSIONS.filter((permission) => granted.has(permission)),
    missing: DEPLOY_PERMISSIONS.filter((permission) => !granted.has(permission)),
  };
}

/**
 * Runs the checks and prints only safe fields. Returns an exit code, so tests can call it and
 * so the workflows can gate on it.
 */
export async function runDiagnostics({
  serviceAccount,
  rulesText = "",
  expectedEmail = EXPECTED_EMAIL,
  expectedProject = EXPECTED_PROJECT,
  identityOnly = false,
  reportOnly = false,
  fetchImpl = globalThis.fetch,
  log = () => {},
  error = () => {},
  now = Date.now,
} = {}) {
  // Empty output on the success path is a feature: a caller that forgets to pass a logger must
  // never end up writing a credential to stdout.
  const announce = (...args) => log(...args);
  const report = (message) => error(`${reportOnly ? "::warning::" : "::error::"}${message}`);

  const identity = identityOf(serviceAccount);
  announce(`client_email: ${identity.clientEmail || "(missing)"}`);
  announce(`project_id: ${identity.projectId || "(missing)"}`);

  const problems = assertIdentity(identity, { expectedEmail, expectedProject });
  for (const problem of problems) report(`service account identity mismatch: ${problem}`);
  if (problems.length && !reportOnly) return EXIT.identityMismatch;
  if (identityOnly) return EXIT.ok;

  const projectId = identity.projectId || expectedProject;

  const minted = await mintAccessToken(serviceAccount, { fetchImpl, now });
  if (!minted.ok) {
    report(`could not mint an access token: ${minted.reason}`);
    return EXIT.credential;
  }
  announce("access token: minted for scope " + SCOPE);

  const iam = await probePermissions(projectId, { token: minted.token, fetchImpl });
  if (!iam.ok) {
    announce(
      `IAM probe: unavailable (HTTP ${iam.status}); the compile call below is the authoritative check`,
    );
  } else if (iam.missing.length) {
    report(
      `project ${projectId} does not grant ${iam.missing.join(", ")} — ` +
        `grant roles/firebaserules.admin to ${identity.clientEmail} on project ${projectId}`,
    );
  } else {
    announce(`IAM probe: all ${DEPLOY_PERMISSIONS.length} deployment permissions granted`);
  }

  const compiled = await testRuleset(projectId, { token: minted.token, rulesText, fetchImpl });
  if (compiled.ok) {
    announce(`compile: accepted — projects/${projectId}:test returned ${compiled.status}; rules compile`);
    return EXIT.ok;
  }

  if (compiled.kind === "disabled") {
    report(
      `${compiled.status} from projects/${projectId}:test — firebaserules.googleapis.com is not ` +
        `enabled on project ${projectId}: ${compiled.message}`,
    );
    return EXIT.apiDisabled;
  }
  if (compiled.status === 403 || compiled.kind === "denied") {
    report(
      `${compiled.status} from projects/${projectId}:test — ${identity.clientEmail} may not ` +
        `compile rules on project ${projectId}. Grant roles/firebaserules.admin to that principal ` +
        `at the project level. ${compiled.message}`,
    );
    return EXIT.permissionDenied;
  }
  if (compiled.status >= 500) {
    report(`${compiled.status} from projects/${projectId}:test — ${compiled.message}`);
    return EXIT.permissionDenied;
  }
  report(`rules did not compile (HTTP ${compiled.status}): ${compiled.message}`);
  return EXIT.compileFailed;
}

export const USAGE = `Usage: node scripts/check-firebase-access.mjs [options]

  --identity-only         Print and check the identity without calling Google.
  --report-only           Never fail on a mismatch or a permission denial; warn instead.
  --expect-email=EMAIL    Expected client_email. Defaults to ${EXPECTED_EMAIL}.
  --expect-project=ID     Expected project_id. Defaults to ${EXPECTED_PROJECT}.
  --rules=PATH            Rules file to compile. Defaults to firestore.rules.

Reads FIREBASE_SERVICE_ACCOUNT (inline JSON) or GOOGLE_APPLICATION_CREDENTIALS (a path).
Exit codes: 0 ok, 1 usage, 2 unusable credential, 5 permission denied, 6 API disabled,
7 identity mismatch, 8 rules failed to compile.`;

export function parseArgs(argv = []) {
  const options = {
    identityOnly: false,
    reportOnly: false,
    help: false,
    expectedEmail: EXPECTED_EMAIL,
    expectedProject: EXPECTED_PROJECT,
    rulesPath: "",
  };
  const unknown = [];
  for (const arg of argv) {
    if (arg === "--identity-only") options.identityOnly = true;
    else if (arg === "--report-only") options.reportOnly = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--expect-email=")) options.expectedEmail = arg.slice("--expect-email=".length).trim();
    else if (arg.startsWith("--expect-project=")) options.expectedProject = arg.slice("--expect-project=".length).trim();
    else if (arg.startsWith("--rules=")) options.rulesPath = arg.slice("--rules=".length).trim();
    else unknown.push(arg);
  }
  return { options, unknown };
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log, error = console.error, fetchImpl = globalThis.fetch } = {}) {
  const { options, unknown } = parseArgs(argv);
  if (options.help) {
    log(USAGE);
    return EXIT.ok;
  }
  if (unknown.length) {
    error(`Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
    error(USAGE);
    return EXIT.usage;
  }

  const resolved = await loadCredentials(env);
  if (!resolved.ok) {
    error(`::error::${resolved.reason}`);
    return EXIT.credential;
  }
  log(`credential source: ${resolved.source}`);

  let rulesText = "";
  if (!options.identityOnly) {
    const rulesPath = options.rulesPath || join(repoRoot, "firestore.rules");
    try {
      rulesText = await readFile(rulesPath, "utf8");
      log(`rules file: ${rulesPath}`);
    } catch (cause) {
      error(`::error::could not read ${rulesPath}: ${cause?.code ?? cause?.message ?? cause}`);
      return EXIT.credential;
    }
  }

  return runDiagnostics({
    serviceAccount: resolved.serviceAccount,
    rulesText,
    expectedEmail: options.expectedEmail,
    expectedProject: options.expectedProject,
    identityOnly: options.identityOnly,
    reportOnly: options.reportOnly,
    fetchImpl,
    log,
    error,
  });
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Normalizes a response to status + a short, non-sensitive message. */
function describe(response, url) {
  return readJson(response).then((body) => {
    const detail = body?.error ?? {};
    const reason = Array.isArray(detail.details)
      ? detail.details.find((entry) => entry && typeof entry.reason === "string")?.reason ?? ""
      : "";
    const message = typeof detail.message === "string" ? detail.message : "";
    return {
      ok: response.ok,
      status: response.status,
      url,
      kind: classify(response.status, reason, message),
      message: clip(message || (response.ok ? "" : "no error detail returned")),
    };
  });
}

function classify(status, reason, message) {
  if (reason === "SERVICE_DISABLED" || /has not been used in project|is disabled/i.test(message)) return "disabled";
  if (status === 403) return "denied";
  if (status === 401) return "unauthenticated";
  return "";
}

/** Rules messages quote the author's own rules file; they never carry credentials. */
function clip(text, limit = 400) {
  const single = String(text).replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(new URL(`file://${entry.replace(/\\/g, "/")}`)) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (cause) => {
      console.error(`::error::${cause?.message ?? cause}`);
      process.exit(1);
    },
  );
}
