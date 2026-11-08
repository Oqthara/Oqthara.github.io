# Firebase: credentials, workflows and the rules boundary

This repository owns three Firebase jobs with deliberately separate triggers and separate
failure modes. Nothing here is a secret; the credential itself lives only in the
`FIREBASE_SERVICE_ACCOUNT` repository secret.

## What runs where

| Concern | Workflow | Writes | Needs |
| --- | --- | --- | --- |
| Content mirror (`documentation`, `examples`, `releases`, `stdlib`) | `.github/workflows/firebase-sync.yml` | Documents via the Admin SDK | `roles/datastore.user` |
| Alpha release detection | `.github/workflows/alpha-release-sync.yml` | The mirror, plus `sync/upstream-release` | `roles/datastore.user` |
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

All three workflows print `client_email` and `project_id` and stop when either differs. That is the
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

## Watching for Alpha releases

`scripts/check-upstream-release.mjs` answers one question per run: *does the mirror reflect the
newest published upstream release?*

Upstream announces the moment. `Oqthara/oqthara` sends a `repository_dispatch` of type
`alpha-release-published` when a release is published, which is what makes a new channel appear
within seconds. The `*/15 * * * *` schedule is a **recovery mechanism**, not the propagation
path: GitHub runs scheduled work on a best-effort basis and can delay or skip a run, and a
dispatch can be dropped, so the poll recomputes the same difference and catches up. Nothing is
queued, so a missed run costs latency, never correctness.

That replaced an earlier design in which polling *was* the mechanism. Polling still needs no
trust: a dispatch is treated as a signal to look, never as an instruction, so a forged, replayed
or stale one causes a re-read and cannot publish anything by itself.

One run does three things:

1. Reads the newest **published, non-draft** release from upstream, ordered by `published_at`
   rather than by tag name or id, so an older release re-published later still wins.
2. Resolves the tag to a commit with `/commits/{tag}`. `/git/ref/tags/{tag}` is wrong here: for an
   annotated tag it returns the tag object's SHA, not the commit's.
3. Compares that against `sync/upstream-release` in Firestore, the record of the last release this
   repository actually synchronized.

The decision matrix:

| recorded state | upstream | result |
| --- | --- | --- |
| none | any | synchronize (first run) |
| same tag, same commit | unchanged | no action |
| newer tag | newer commit | synchronize |
| same tag, **different** commit | tag re-pointed | synchronize |
| same tag, same commit, body edited | content hash changed | synchronize |
| same tag, `lastAttempt.result: failed` | unchanged | synchronize (retry) |
| any | tag not an ancestor of `main` | fail the run |

Only a successful sync advances the record. A failed attempt writes
`lastAttempt: { result: "failed", detail }` and leaves `tag`/`commitSha` alone, so the next run
retries rather than believing the mirror is current.

The ancestry gate exists because the mirror follows `main`. A tag cut from a side branch is not
reachable from `main`, so mirroring `main` and labelling it with that tag would publish the wrong
bytes under a release name. When `compare/{tag}...main` reports `diverged`, the run fails with an
explicit error instead.

Exit codes: `0` ok, `1` usage, `2` missing credentials, `3` upstream lookup or ancestry failure,
`4` Firestore read/write failure. Unlike the sync script, this one **fails closed** without a
credential during a normal run: detection reads the recorded state to decide, and reporting "no
change" over an unread state would be a guess. `--dry-run` is the credential-free escape hatch.

`--record=ok` and `--record=failed` are the writers the workflow calls after the sync step, with
`OQ_RELEASE_TAG`, `OQ_RELEASE_SHA`, and (for success) `OQ_RELEASE_HASH` in the environment.

### The state document

`sync/upstream-release`, in the collection the rules make unreadable from a browser:

```
tag, commitSha, hash, name, url, publishedAt, prerelease  // last successful sync
syncedAt                                                  // when it succeeded
lastCheckedAt, observed: { tag, commitSha, hash }         // every run, success or not
lastAttempt: { result, tag, commitSha, detail, at }       // most recent attempt
```

It is bookkeeping, not content: the site never reads it, and no browser can.

