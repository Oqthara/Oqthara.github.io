// Tests for the Firebase access diagnostic.
//
// The point of this script is what it does *not* reveal, so most of these tests assert an
// absence: the private key, the signed assertion and the access token must never reach a log
// line. The rest classify the failure modes the 403 investigation has to tell apart —
// identity mismatch, unusable key, missing permission, disabled API, broken rules.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  DEPLOY_PERMISSIONS,
  EXIT,
  EXPECTED_EMAIL,
  EXPECTED_PROJECT,
  assertIdentity,
  identityOf,
  mintAccessToken,
  parseArgs,
  runDiagnostics,
  testRuleset,
} from "../scripts/check-firebase-access.mjs";

const PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const SERVICE_ACCOUNT = {
  type: "service_account",
  project_id: EXPECTED_PROJECT,
  client_email: EXPECTED_EMAIL,
  private_key: PRIVATE_KEY,
  token_uri: "https://oauth2.googleapis.com/token",
};

const MINTED = "ya29.fake-access-token";

/** A fetch stand-in keyed by URL fragment. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [fragment, handler] of Object.entries(routes)) {
      if (String(url).includes(fragment)) return handler(String(url), init);
    }
    throw new Error(`unexpected request to ${url}`);
  };
  impl.calls = calls;
  return impl;
}

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

const tokenRoute = () => json({ access_token: MINTED, expires_in: 3600 });

function collector() {
  const lines = [];
  return {
    lines,
    log: (...args) => lines.push(args.join(" ")),
    error: (...args) => lines.push(args.join(" ")),
    text: () => lines.join("\n"),
  };
}

async function diagnose({ routes, ...overrides } = {}) {
  const out = collector();
  const fetchImpl = fakeFetch({
    "oauth2.googleapis.com/token": tokenRoute,
    ":testIamPermissions": () => json({ permissions: DEPLOY_PERMISSIONS }),
    ":test": () => json({ issues: [] }),
    ...routes,
  });
  const code = await runDiagnostics({
    serviceAccount: SERVICE_ACCOUNT,
    rulesText: "rules_version = '2';",
    fetchImpl,
    log: out.log,
    error: out.error,
    ...overrides,
  });
  return { code, out, fetchImpl };
}

test("identityOf exposes only the two public fields", () => {
  assert.deepEqual(identityOf(SERVICE_ACCOUNT), {
    clientEmail: EXPECTED_EMAIL,
    projectId: EXPECTED_PROJECT,
  });
});

test("assertIdentity accepts the provisioned identity", () => {
  assert.deepEqual(assertIdentity({ clientEmail: EXPECTED_EMAIL, projectId: EXPECTED_PROJECT }), []);
});

test("assertIdentity reports a different principal instead of accepting it", () => {
  const problems = assertIdentity({ clientEmail: "someone@example.com", projectId: "other-project" });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /client_email/);
  assert.match(problems[1], /project_id/);
});

test("a mismatched identity stops before any Google call", async () => {
  const fetchImpl = fakeFetch({});
  const out = collector();
  const code = await runDiagnostics({
    serviceAccount: { ...SERVICE_ACCOUNT, client_email: "impostor@example.com" },
    fetchImpl,
    log: out.log,
    error: out.error,
  });
  assert.equal(code, EXIT.identityMismatch);
  assert.equal(fetchImpl.calls.length, 0);
  assert.match(out.text(), /identity mismatch/);
});

test("--report-only downgrades a mismatch to a warning", async () => {
  const out = collector();
  const fetchImpl = fakeFetch({
    "oauth2.googleapis.com/token": tokenRoute,
    ":testIamPermissions": () => json({ permissions: DEPLOY_PERMISSIONS }),
    ":test": () => json({ issues: [] }),
  });
  const code = await runDiagnostics({
    serviceAccount: { ...SERVICE_ACCOUNT, project_id: "elsewhere" },
    reportOnly: true,
    fetchImpl,
    log: out.log,
    error: out.error,
  });
  assert.equal(code, EXIT.ok);
  assert.match(out.text(), /::warning::service account identity mismatch/);
});

test("a successful run prints no secret material", async () => {
  const { code, out } = await diagnose();
  assert.equal(code, EXIT.ok);
  const text = out.text();
  assert.match(text, new RegExp(EXPECTED_EMAIL));
  assert.ok(text.includes(EXPECTED_PROJECT));
  assert.ok(!text.includes(MINTED), "the access token must never be logged");
  assert.ok(!text.includes("PRIVATE KEY"), "the private key must never be logged");
  assert.ok(!text.includes(PRIVATE_KEY.split("\n")[1] ?? "unlikely"), "no key body may be logged");
});

test("the compile call sends the local rules file and no credential in the body", async () => {
  const { fetchImpl } = await diagnose();
  const compile = fetchImpl.calls.find((call) => call.url.endsWith(":test"));
  assert.ok(compile, "projects/oqthara:test must be called");
  const payload = JSON.parse(compile.init.body);
  assert.equal(payload.source.files[0].name, "firestore.rules");
  assert.match(payload.source.files[0].content, /rules_version/);
  assert.equal(compile.init.headers.authorization, `Bearer ${MINTED}`);
  assert.ok(!compile.init.body.includes(PRIVATE_KEY));
});

test("the rules deploy probes exactly the deployment permissions", async () => {
  const { fetchImpl } = await diagnose();
  const probe = fetchImpl.calls.find((call) => call.url.includes(":testIamPermissions"));
  const requested = JSON.parse(probe.init.body).permissions;
  assert.deepEqual(requested, [...DEPLOY_PERMISSIONS]);
  assert.ok(requested.includes("firebaserules.rulesets.test"));
});

test("a 403 from :test is reported as a permission problem with the least-privilege role", async () => {
  const { code, out } = await diagnose({
    routes: {
      ":test": () =>
        json(
          {
            error: {
              code: 403,
              message: "The caller does not have permission",
              status: "PERMISSION_DENIED",
            },
          },
          403,
        ),
    },
  });
  assert.equal(code, EXIT.permissionDenied);
  const text = out.text();
  assert.match(text, /roles\/firebaserules\.admin/);
  assert.match(text, new RegExp(EXPECTED_EMAIL));
  assert.ok(!text.includes(MINTED));
});

test("a missing permission is named from the IAM probe", async () => {
  const { code, out } = await diagnose({
    routes: {
      ":testIamPermissions": () => json({ permissions: ["firebaserules.releases.get"] }),
      ":test": () => json({ error: { code: 403, message: "denied" } }, 403),
    },
  });
  assert.equal(code, EXIT.permissionDenied);
  assert.match(out.text(), /firebaserules\.rulesets\.test/);
});

test("a disabled Rules API is distinguished from a missing permission", async () => {
  const { code, out } = await diagnose({
    routes: {
      ":test": () =>
        json(
          {
            error: {
              code: 403,
              message:
                "Firebase Rules API has not been used in project oqthara before or it is disabled.",
              status: "PERMISSION_DENIED",
              details: [{ reason: "SERVICE_DISABLED" }],
            },
          },
          403,
        ),
    },
  });
  assert.equal(code, EXIT.apiDisabled);
  assert.match(out.text(), /not enabled/);
});

test("rules that do not compile are reported separately from authorization", async () => {
  const { code, out } = await diagnose({
    routes: {
      ":test": () => json({ issues: [{ severity: "ERROR", description: "unexpected token" }] }, 400),
    },
  });
  assert.equal(code, EXIT.compileFailed);
  assert.match(out.text(), /did not compile/);
  assert.ok(!out.text().includes("firebaserules.admin"));
});

test("an unusable key fails as a credential problem, not a permission problem", async () => {
  const out = collector();
  const fetchImpl = fakeFetch({});
  const result = await mintAccessToken({ ...SERVICE_ACCOUNT, private_key: "not a key" }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /private key/);
  assert.equal(fetchImpl.calls.length, 0);

  const code = await runDiagnostics({
    serviceAccount: { ...SERVICE_ACCOUNT, private_key: "not a key" },
    rulesText: "",
    fetchImpl,
    log: out.log,
    error: out.error,
  });
  assert.equal(code, EXIT.credential);
  assert.match(out.text(), /could not mint an access token/);
});

test("--identity-only never reaches the network", async () => {
  const fetchImpl = fakeFetch({});
  const out = collector();
  const code = await runDiagnostics({
    serviceAccount: SERVICE_ACCOUNT,
    identityOnly: true,
    fetchImpl,
    log: out.log,
    error: out.error,
  });
  assert.equal(code, EXIT.ok);
  assert.equal(fetchImpl.calls.length, 0);
});

test("testRuleset builds the exact URL the Firebase CLI uses", async () => {
  const fetchImpl = fakeFetch({ ":test": () => json({ issues: [] }) });
  const result = await testRuleset(EXPECTED_PROJECT, { token: MINTED, rulesText: "x", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(
    fetchImpl.calls[0].url,
    "https://firebaserules.googleapis.com/v1/projects/oqthara:test",
  );
});

test("parseArgs accepts the documented flags and rejects unknown ones", () => {
  const { options, unknown } = parseArgs(["--identity-only", "--report-only", "--rules=firestore.rules"]);
  assert.equal(options.identityOnly, true);
  assert.equal(options.reportOnly, true);
  assert.equal(options.rulesPath, "firestore.rules");
  assert.deepEqual(unknown, []);
  assert.deepEqual(parseArgs(["--nope"]).unknown, ["--nope"]);
});

test("parseArgs defaults to the provisioned identity", () => {
  const { options } = parseArgs([]);
  assert.equal(options.expectedEmail, EXPECTED_EMAIL);
  assert.equal(options.expectedProject, EXPECTED_PROJECT);
  assert.equal(options.identityOnly, false);
});
