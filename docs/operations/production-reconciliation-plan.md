# Production Firestore reconciliation plan

Status: **AWAITING MAINTAINER APPROVAL**. Nothing in this document has been applied.

This plan compares the live Firestore database in project `oqthara` against the canonical content in
`Oqthara/oqthara`. It is a read-only result: the audit that produced it has no write path, and every
activation gate remains unset.

| Fact | Value |
| --- | --- |
| Audit generated at | 2026-11-07T17:19:44.453Z |
| Canonical source | `Oqthara/oqthara@7ffb6755847f30a1300d3201ff9d16a96fda26bb` |
| Desired records | 59 |
| Root collections found | `documentation`, `examples`, `releases`, `stdlib`, `sync` |
| Unexpected collections | none |
| Content documents in production | 59 |
| Bookkeeping records in production | 60 |
| Production writes performed | **none** |
| Firestore rules deployed | **none** |

Reproduce with:

```bash
GITHUB_TOKEN=$(gh auth token) \
OQ_AUDIT_TOKEN=$(gcloud auth print-access-token --quiet) \
  npm run audit:production -- --token --out=/tmp/firestore-audit.json
```

`--token` reads `OQ_AUDIT_TOKEN` and never touches a key file, so the command above sends a
short-lived access token that the shell discards. Without `--token` the script looks for
`FIREBASE_SERVICE_ACCOUNT` or `GOOGLE_APPLICATION_CREDENTIALS` and mints its own token; that path
was broken when this plan was first written and is fixed, with tests, in the same branch. The
script refuses to run if the credential's identity is not the expected service account.

---

## 1. Summary of dispositions

All 59 desired records were classified. Every field of every document was compared; a record is
`MATCH` only when nothing differs.

| Status | Count | Meaning |
| --- | --- | --- |
| `MATCH` | 57 | production equals the canonical source field for field |
| `UPDATE` | 2 | a stored hash differs from the one the current builder would write |
| `MISSING` | 0 | no canonical record is absent from production |
| `UNPUBLISH CANDIDATE` | 0 | no production document lacks a canonical source |

Per collection, production holds exactly what the canonical source produces:

| Collection | Documents | Assessment |
| --- | --- | --- |
| `documentation` | 19 | all `MATCH` |
| `examples` | 37 | all `MATCH` |
| `stdlib` | 1 | `MATCH` |
| `releases` | 2 | both `UPDATE`, hash-only (§2) |
| `sync` | 60 | all consistent with the content they describe (§3) |

There are no orphans and no true gaps, so the mirror is complete. What follows is not a repair of
missing content; it is a record of three defects in the *provenance* the mirror publishes.

---

## 2. The two release records differ only in their hash

Both releases report a hash difference. This is **not** content drift and **not** an out-of-band
edit. The bodies, titles, tags, prerelease flags, publication timestamps, and URLs in production
match the canonical releases exactly.

The cause is that `releaseHashOf` changed. The writing run used the older formula:

```js
contentHashOf(`${ref}\n${name}\n${body}`)
```

The current builder hashes six fields, JSON-encoded:

```js
releaseHashOf({ ref, name, body, prerelease, publishedAt, url })
```

The stored values reproduce the old formula exactly, and the new formula reproduces the canonical
hashes exactly — both verified against the live documents:

| Document | Recorded hash | Matches old formula | Matches new formula |
| --- | --- | --- | --- |
| `releases/releases__v0.1.0-alpha.1` | `7e4d59317bb6…` | yes | no |
| `releases/releases__v0.1.0-alpha.2` | `49d578a36ff2…` | yes | no |

| Collection | Document ID | Source path | Current state | Desired state | Difference | Proposed action | Reason | Risk | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `releases` | `releases__v0.1.0-alpha.1` | `releases/v0.1.0-alpha.1` | all rendered fields match; `contentHash` from the old formula | `contentHash` `816aa36bd08c…` | hash field only | upsert (restamp) | the formula gained fields after this document was written | none; no rendered field changes | read back and confirm `contentHash` is `816aa36bd08c367105e28d4a9e9364def9af91885d7e803693e11f7f0c6fdf03` |
| `releases` | `releases__v0.1.0-alpha.2` | `releases/v0.1.0-alpha.2` | all rendered fields match; `contentHash` from the old formula | `contentHash` `cb6681d432ee…` | hash field only | upsert (restamp) | same | none; no rendered field changes | read back and confirm `contentHash` is `cb6681d432ee1c3aff8b27b7b1687e9ab766f43686043deb37880339d6c616dc` |

Leaving these alone is safe. The site renders both releases correctly today; only the internal
digest is stale, and a future scheduled sync that uses the current formula will restamp them as a
side effect.

---

## 3. Bookkeeping agrees with content, but records no source commit

All 60 `sync/*` records agree with the content they describe: recorded hash and recorded byte count
match the stored document for every one. No bookkeeping record claims a document is `published`
when the document is absent.

Two provenance facts are nevertheless wrong or missing:

1. **`sync/catalog.sourceCommit` does not exist.** The catalogue records `sourceRef: "main"` and
   `updatedAt: 2026-11-06T12:55:29.224Z`, but no commit. The writing run predates the code that
   writes `sourceCommit`, so the mirror cannot currently answer *which* `main` it was built from.
   This is the single fact that makes a mirror auditable.
2. **`metadata/catalog` does not exist.** The collection is absent from the database entirely (§4).

| Collection | Document ID | Source path | Current state | Desired state | Difference | Proposed action | Reason | Risk | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sync` | `catalog` | n/a (derived) | present; no `sourceCommit`; counts from the writing run | same, plus `sourceCommit` naming the commit the content came from | missing field | rewrite catalogue on the next authorized sync | the field did not exist when the only writing run executed | none; the document is operator-facing and not world-readable | read `sync/catalog` and confirm `sourceCommit` is a 40-character SHA |
| `metadata` | `catalog` | n/a (derived) | **collection absent** | `metadata/catalog` mirroring `sync/catalog` | whole document absent | create on the next authorized sync | it has never been written: the code that writes it postdates the only writing run | low, but **blocked**: the deployed rules deny reading it (§4) | read `metadata/catalog` and confirm the same `sourceCommit` |

---

## 4. Blocking defect: the deployed rules deny the document the site reads

This is the one finding that is a live user-visible defect rather than a provenance gap.

`src/repositories/catalog.repository.js` reads `metadata/catalog` in the browser to show where the
mirrored content came from. The ruleset deployed in production does not permit that read.

| Artifact | Value |
| --- | --- |
| Deployed ruleset | `projects/oqthara/rulesets/b9a97879-6727-4274-9c4e-e31b5a7eb7df` |
| Release | `projects/oqthara/releases/cloud.firestore` |
| Released at | 2026-11-06T13:30:10.553608Z |
| Rule file | `firestore.rules`, 2431 bytes |
| SHA-256 | `f04838aa00b8440a5ec63b66ee79abc8da2b3cbea97f38c29a61fde221860f6a` |
| Matches in this repository | `firestore.rules` at commit `5cdc02d` |
| Repository `main` SHA-256 | `095758f5e447b1476172bac9a91ca0bcb0517ce381a6f50d49c62ef4b6fabd55` (2961 bytes) |

The deployed ruleset is **one revision behind `main`**. The difference is exactly the block that
would allow the read:

```
match /metadata/catalog {
  allow read: if isPublished();
  allow write: if false;
}
```

Without it, `metadata/catalog` falls through to `match /metadata/{docId} { allow read: if false; }`.
So even a perfectly written `metadata/catalog` would be unreadable from the browser.

The reason it was never deployed is recorded in the workflow itself. Run `42379205818` shows
`Deploy Firestore security rules` **skipped**, with the log line:

> DISABLED. Set the repository variable `OQTHARA_DEPLOY_FIRESTORE_RULES` to true…

Deploying the rules is **not authorized** by this task, and the gate stays unset. Recording the
defect is the permitted outcome.

| Collection | Document ID | Source path | Current state | Desired state | Difference | Proposed action | Reason | Risk | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| n/a (rules) | `projects/oqthara/rulesets/b9a97879…` | `firestore.rules` on `main` | deployed release predates `main`; denies `metadata/catalog` | the `main` revision | missing `match /metadata/catalog` read rule | **none in this task** — requires separate authorization to deploy | deployment gate `OQTHARA_DEPLOY_FIRESTORE_RULES` is unset by instruction | public read access to one derived document | confirm the release's `rulesetName` changes after an authorized deploy, then read `metadata/catalog` from a browser |

---

## 5. Why the earlier "dry run" was not a reconciliation

Run `42224994749` reported `would write 59` and was cited as evidence that production held nothing.
It does not support that conclusion. Its own log states:

- `sync state: unavailable (no credentials) — assuming nothing is mirrored yet`
- `would write: 59`
- `dry run: nothing was written`

With no credentials it could not read production, so it assumed an empty mirror and therefore
predicted 59 writes regardless of the real state. It also ran on `e271a61` (branch
`fix/firebase-rules-iam`), which is not an ancestor of `main`. The live audit above is the first
comparison actually made against the real database.

Likewise, the writing run's reported **118 operations** is not 118 documents. It is 59 content
documents plus 59 bookkeeping records. The two catalogue writes are not counted in that total, and
of those two, only `sync/catalog` was written at all — `metadata/catalog` did not yet exist in the
script.

---

## 6. Proposed sequence, if approved

Ordered so that nothing becomes publicly readable before the rules allow it.

1. **Approve the rules deployment separately.** Read `firestore.rules` from `main`, diff it against
   the deployed ruleset, and deploy only after explicit authorization. This is the gate that has
   been unset since it was introduced.
2. **Run one authorized full sync** (`npm run sync -- --full`) with `OQTHARA_PRODUCTION_SYNC`
   enabled for that run only. This restamps both release hashes, writes `sourceCommit` into
   `sync/catalog`, and creates `metadata/catalog`.
3. **Read back independently** — the audit tool, rerun, should report 59 `MATCH`, 0 `UPDATE`,
   `metadata.exists: true`, and a `sourceCommit` equal to the canonical commit.
4. **Disable the gate again** immediately after the run.

Step 1 must precede step 2. Writing `metadata/catalog` first would produce a document nobody can
read, which is a worse state than its current absence because it would look reconciled.

Each step needs its own authorization. None is implied by approving this document.

---

## 7. What this plan does not do

- It does not write, delete, unpublish, or overwrite any production document.
- It does not deploy Firestore rules.
- It does not enable `OQTHARA_PRODUCTION_SYNC` or `OQTHARA_DEPLOY_FIRESTORE_RULES`.
- It does not propose a delete. Unpublishing is the strongest action available, and no document
  needs one.
- It does not modify the `Oqthara/oqthara` source repository.
- It does not treat a successful build as a completed deployment.
