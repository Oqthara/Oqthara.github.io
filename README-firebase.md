# Firebase: credentials, workflows and the rules boundary

This repository owns two Firebase jobs with deliberately separate credentials and separate
failure modes. Nothing here is a secret; the credential itself lives only in the
`FIREBASE_SERVICE_ACCOUNT` repository secret.

## What runs where

| Concern | Workflow | Writes | Needs |
| --- | --- | --- | --- |
| Content mirror (`documentation`, `examples`, `releases`, `stdlib`) | `.github/workflows/firebase-sync.yml` | Documents via the Admin SDK | `roles/datastore.user` |
| Security rules (`firestore.rules`) | `.github/workflows/firestore-rules.yml` | The `cloud.firestore` release | `roles/firebaserules.admin` |

The split is intentional. Before it, a single job mirrored content and then deployed rules, so
a missing Rules permission failed a sync that had already written successfully, and every
content run rewrote production security rules. Now a sync never calls the Firebase Rules API and
a rules deployment never writes documents.

## The service account

Production expects exactly one principal:

```
oqthara-github-sync@oqthara.iam.gserviceaccount.com   in project oqthara
```

Both workflows print `client_email` and `project_id` and stop when either differs. That is the
whole diagnostic: a mismatch is reported, never papered over by granting a role to whatever
principal happened to be configured.

### Required roles

Grant these at the **project** level on `oqthara`, and verify them rather than assuming:

```bash
gcloud projects add-iam-policy-binding oqthara \
  --member="serviceAccount:oqthara-github-sync@oqthara.iam.gserviceaccount.com" \
  --role="roles/datastore.user" --condition=None

gcloud projects add-iam-policy-binding oqthara \
  --member="serviceAccount:oqthara-github-sync@oqthara.iam.gserviceaccount.com" \
  --role="roles/firebaserules.admin" --condition=None
```

then confirm what is actually bound:

```bash
gcloud projects get-iam-policy oqthara \
  --flatten="bindings[].members" \
  --filter="bindings.members:oqthara-github-sync@oqthara.iam.gserviceaccount.com" \
  --format="table(bindings.role)"
```

`roles/firebaserules.viewer` is **not** sufficient: it omits `firebaserules.rulesets.test`, which
is the first call `firebase deploy --only firestore:rules` makes. Owner and Editor also work and
are not used: they are broader than the deployment needs, and a 403 is a reason to narrow the
question, not widen the grant.

### Verifying without deploying

`scripts/check-firebase-access.mjs` inspects the credential and stops. It prints only
`client_email` and `project_id`, lists which deployment permissions are actually granted, and
compiles `firestore.rules` through `projects/oqthara:test` — the same non-destructive call the
CLI makes before it uploads anything. It creates no ruleset and no release.

```bash
FIREBASE_SERVICE_ACCOUNT="$(cat key.json)" node scripts/check-firebase-access.mjs
```

Exit codes: `0` ok, `1` usage, `2` unusable credential, `5` permission denied, `6` API disabled,
`7` identity mismatch, `8` rules failed to compile. `--identity-only` skips every network call,
which is what the content sync runs; `--report-only` warns instead of failing.

The private key, the signed assertion and the access token are never printed, and no request
body is echoed.

## Deploying rules

`.github/workflows/firestore-rules.yml` runs only on `main`. A manual dispatch defaults to
`validate`, which compiles the rules and stops; choosing `deploy` is the explicit request to
change production. A push that changes `firestore.rules` or `firebase.json` deploys after the
same validation. There is no `pull_request` trigger, so a fork cannot reach the credential.

A content sync **cannot** deploy rules, and a dry run cannot either.

## The rules are the boundary, not the queries

`firestore.rules` allows reads only when a document carries the literal boolean `published:
true`, denies every client write, hides `sync` and `metadata`, and closes everything unmatched.
The `where('published', '==', true)` filter in `src/repositories/*.repository.js` is defence in
depth for the UI, not a permission: Firestore rules are filters on individual documents, not a
`WHERE` clause, so a client list query must constrain `published` itself. `npm run test:rules`
asserts both halves against the emulator, including that an unfiltered query never returns a
draft.

## Syncing content

`scripts/sync-firestore.mjs` mirrors the canonical repository. A missing or unpublished source
document is written with `published: false` rather than deleted, and content at or above 900 KB
is skipped whole and recorded as `oversized` — never truncated.

Exit codes: `0` ok, `1` usage, `2` missing credentials, `3` GitHub failure, `4` Firestore
failure. `--dry-run` reads GitHub, prints the plan and writes nothing; it needs no credential at
all.
