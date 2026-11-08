# Release and documentation content model

**Status:** implemented
**Context:** PR #2 remediation, priority 4 (brief §6)

## Decision

The website has two independent content channels, and they are deliberately not the same
mechanism:

1. **Development documentation follows `main`, continuously.** The Firestore mirror copies
   `docs/`, `examples/`, `releases/` and the standard-library reference from `main`. It is
   reconciled when upstream announces a push to `main` (`repository_dispatch`, type
   `content-updated`), and the daily `08:17 UTC` schedule recovers anything a dispatch missed.
   It carries no version identity of its own.
2. **Release documentation is read from GitHub at the release's tag, on demand.** Nothing is
   copied into the mirror for a release channel.
3. **Release records are immutable once published.** A release document in the mirror is a
   normalized copy of a GitHub release: tag, name, notes, publication time, prerelease flag.
   Its content is a published artifact and does not change when `main` advances.

## The statements the brief requires

| Question | Answer |
| --- | --- |
| What does the site show as current documentation? | The `main` branch of `Oqthara/oqthara`, reconciled into the mirror, labelled "Development (main)". |
| What source commit does each document represent? | The commit in `metadata/catalog.sourceCommit` at the time the mirror last wrote that document. Documentation pages display it. |
| What release snapshot does each Alpha record represent? | The GitHub release for that tag. Its notes are the published release body; its code and docs are read live from GitHub at the tag, never from the mirror. |
| Can documentation be retrieved for an older Alpha? | Yes. Selecting an older channel reads `docs/` at that tag from the GitHub API. It does not depend on the mirror, so it keeps working however far `main` advances. |
| How does the site behave when `main` advances after a release? | The dev channel changes; every release channel does not. Nothing a release channel shows is derived from `main`. |

## Why not mirror each release tag

The obvious alternative - snapshot a release tag's `docs/` into the same collections - was
rejected for a concrete reason, not a stylistic one.

`planSync` treats "present in the mirror, absent from the source" as **unpublish**. A release
tag contains far fewer documents than `main`. Mirroring a tag would therefore retract every
document that exists only on `main`, for all readers, because the mirror is unversioned: there
is one `documentation` collection, so the last writer wins. The detector fires every 15
minutes, so this would have been a repeating, self-inflicted content outage.

Versioning the collection ids (`documentation@v0.1.0`) would avoid that, at the cost of
duplicating every document once per release and making `main`'s documents a special case in
every read path. The site already has a working release path - the channel selector reads
GitHub directly - so the duplication would buy nothing a reader can see.

## Why this is enforced structurally

The policy is not a comment. `alpha-release-sync.yml`'s secret-bearing job is pinned to
`refs/heads/main` and passes no `--ref`, so it cannot be pointed at a tag even by a manual
dispatch. `tests/catalog.test.js` asserts both properties, and asserts that only the
development channel is described as mirrored.

## What was added to make the claim checkable

Before this change, `sourceCommit` existed only in `sync/catalog`, which is not readable from a
client. The site's provenance claim was therefore unfalsifiable by a reader. Now:

- the sync script also writes the catalogue to `metadata/catalog`;
- `firestore.rules` allows reading exactly that one document when `published` is true, and
  never allows writing it;
- documentation pages render "Mirrored from main at `abc1234`", linked to the commit;
- a mirror with no recorded commit says "Mirror revision not recorded" rather than showing the
  branch name in place of a commit.

## Consequences

- A release channel's freshness depends on GitHub being reachable. This was already true and is
  unchanged; the fallback is the same one the site has always used.
- The mirror does not preserve a historical `main`. Documentation for a past state is available
  only through a release tag, which is the point.
- `metadata/catalog` is one document read per documentation page load, cached like any other
  mirror read. It carries no content and no identifiers beyond a public commit SHA.
