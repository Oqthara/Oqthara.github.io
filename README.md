# Oqthara website

The website at <https://oqthara.github.io/>. A React 19 application, prerendered to static HTML
and served by GitHub Pages from the root of this repository.

Because the owning account is `Oqthara`, this is GitHub's *user site* repository: the site is
served from the domain root, not from an `/oqthara/` project path.

## Branch protection

`main` is protected by an active ruleset (`main-protection`). Pull requests are mandatory, direct
pushes and non-fast-forward pushes are rejected, review threads must be resolved before merging,
and `Build the static site` and `Cross-browser suite` are required with strict status checks (the
branch must be up to date before merging). There are no bypass actors.

`Deploy to GitHub Pages` runs only on `main`, so a required check on a pull request would never
report. The two checks above are the ones a pull request can actually satisfy; the deploy job
stays a post-merge step, and a failure there blocks the site, not the merge.

The required approving review count is **zero** under the project's documented solo-maintainer
exception: Oqthara has one human maintainer, and `JoaoGaValentim` is that same person's second
account rather than an independent reviewer. The exception is recorded in the language
repository's Alpha 3 closure report, and it must be reconsidered when a second human maintainer
joins.

## Content lives in the language repository

`Oqthara/oqthara` is the only source of everything the site displays. This repository holds no
copy of any document, example, changelog, release list or capability claim.

| What the site shows | Where it comes from |
| --- | --- |
| Documentation index | `docs/**/*.md`, discovered through the Git Tree API |
| Documentation body | the original Markdown file |
| Examples | `examples/**/*.oq`, discovered through the Git Tree API |
| Changelog | `CHANGELOG.md` |
| Standard library | `docs/stdlib/reference.md` |
| Philosophy | `docs/spec/design.md` |
| Status | `docs/spec/backend.md` |
| Release channels | the GitHub Releases API |

The consequence is the maintenance rule this site is built around: **a new document, example,
directory or release appears with no change to this repository.** Website changes are only for
visual design, navigation structure or actual functionality.

Nothing is copied into this repository. The build is still deterministic and offline, and every
content request happens in the reader's browser: the mirror is read from Firestore through the
public read rules, and GitHub is the fallback.

## Routes

There is one static HTML file per page. Content is addressed by query string, because GitHub
Pages cannot rewrite an arbitrary path to a file:

```
/                     home
/philosophy.html      philosophy, from docs/spec/design.md
/tour.html            guided tour
/docs.html            documentation index, discovered from docs/
/document.html        any document:   ?path=docs/spec/language.md&ref=main
/examples.html        examples index, discovered from examples/
/example.html         any example:    ?path=examples/anagrams.oq&ref=main
/stdlib.html          generated standard library reference
/changelog.html       CHANGELOG.md
/status.html          docs/spec/backend.md
/404.html             not found, and the redirect for legacy content links
```

A document added to GitHub tomorrow opens at `/document.html?path=…` immediately. No route
entry, no shell, no deploy.

Old `/docs/**.html` links still work: GitHub Pages serves `404.html`, which redirects them to
the canonical route with the ref preserved. That redirect is the only reason 404.html carries a
script.

## Caching and propagation

Three request kinds are made when the mirror cannot answer:

1. `raw.githubusercontent.com` for file contents;
2. the **Git Tree API** for discovery and example listings;
3. the **Releases API** for the channel selector.

All three share one cache in `src/github-docs.js`:

- the cached value is the *promise*, so two components asking for the same file make one
  request, and concurrent renders cannot stampede GitHub;
- entries are fresh for five minutes (`CACHE_TTL_MS`);
- after that the previous value is returned immediately while a refresh runs in the background
  (stale-while-revalidate), so a refresh never blanks a page the reader is already reading;
- a failed first load is not cached, so **Try again** genuinely retries;
- a failed background refresh leaves the last good content on screen with a note saying so.

GitHub's raw CDN adds `cache-control: max-age=300` independently.

### The mirror is the preferred source, and it announces itself

Content is read from Cloud Firestore first (`src/services/content.service.js`), falling back to
GitHub per collection and per document when the mirror is incomplete, unavailable or still
pinned to another ref. `firestore.rules` makes the mirrored content collections client-readable
only when `published == true`, and never client-writable. Two collections are not readable at
all: `sync` holds operator bookkeeping, and everything under `metadata` is deny-all except the
single `metadata/catalog` document described below.

That mirror stays current in two ways:

- **A dispatched event.** A push to `main` upstream dispatches `content-updated` here, and a
  published release dispatches `alpha-release-published`. `firebase-sync.yml` and
  `alpha-release-sync.yml` already listen for those types. Each dispatch is a *signal to look*,
  not an instruction: the release workflow still asks GitHub which release is newest and resolves
  the tag to a commit itself, so a forged or stale payload cannot make the mirror publish
  something upstream never published.
- **Recovery schedules.** Both workflows also run on a timer — daily for `main`, every 15 minutes
  for releases. A lost dispatch therefore costs latency, never correctness; the next tick
  computes the same difference and acts on it.

### Freshness in a page that is already open

Every successful sync rewrites `metadata/catalog` with the exact upstream commit it reconciled
and a digest of the content it stored. The single readable document in `metadata`, it is what
makes a provenance claim checkable rather than asserted. `src/freshness.js` subscribes to it
(`onSnapshot`) for the life of the app:

- the first snapshot is a **baseline**, not a change — otherwise every page load would trigger a
  refresh burst for no new information;
- a new content digest clears both caches and re-reads the data behind every mounted hook. The
  commit alone is not enough to decide this: publishing a release pushes a tag, so the mirror
  gains a release document while `main` never moves, and a commit-only comparison would report
  "unchanged" for content that had changed. The digest is derived from the set of documents the
  run reconciled, so it moves for an added, edited or removed document and stays put for a run
  that reconciles identical content. It is not a read-back of Firestore: a document edited
  outside the sync is recorded as `unchanged` on an incremental run and only repaired, and only
  reflected in the digest, by a `--full` run. Records written before the digest existed fall back to
  `sourceCommit`, then to the publish time and count shape;
- the URL is never touched. The reader keeps their route, query string, release channel and
  scroll position; only the content changes. A reload would have been easier and would have
  thrown away exactly the state the reader was using;
- a listener failure is reported once and is not retried in a loop. Cached content stays readable,
  so losing the live signal degrades to the timer path above.

**Propagation delay: a minute or two, not "about ten".** A documentation change merged into
`main` reaches the mirror within one dispatch latency and the open page within one snapshot. If
the dispatch fails, the daily schedule bounds the delay instead. A release channel reads its own
tag and never follows `main`, so a published manual is stable indefinitely.

Only discovery and the release list consume API quota, and both are cached. Document bodies come
from the raw CDN, which has no API quota, and from Firestore when mirrored, which does not either.
A `403` or `429` is surfaced as a typed error with `rateLimited: true`, and the UI says the limit
was reached instead of showing a generic failure.

### Turning production synchronization on

Mirror writes are gated on a repository variable, so nothing is written to production until
someone decides it should be:

```bash
# Enable writes.
gh variable set OQTHARA_PRODUCTION_SYNC --repo Oqthara/Oqthara.github.io --body true

# Return to read-only: the mirror stays readable, it simply stops being refreshed.
gh variable delete OQTHARA_PRODUCTION_SYNC --repo Oqthara/Oqthara.github.io
```

The gate compares against the literal `true`, so `1`, `yes` and an empty value all mean *off*. A
scheduled run with the variable unset does not plan: `firebase-sync.yml` fails closed when the
credential is missing, and skips the sync step when the gate is closed, so nothing is written and
no plan is printed. To see a plan, dispatch the workflow manually with `dry_run=true`, which needs
no credential.

### The first full reconciliation

Enabling the variable does not change what a run considers: it only lifts the write gate. An
incremental run still synchronizes the difference rather than the whole set, so against an empty
mirror every document is new and the first run writes everything anyway. Use a full pass when the
mirror already holds content that needs rewriting — after an out-of-band edit, or when it was
populated by an older version of the sync script:

```bash
# Plan only. No credential is needed and nothing is written.
gh workflow run firebase-sync.yml --repo Oqthara/Oqthara.github.io \
  -f full=true -f dry_run=true

# Apply, once the plan looks right.
gh workflow run firebase-sync.yml --repo Oqthara/Oqthara.github.io \
  -f full=true -f dry_run=false
```

Inspect the reported counts (`written`, `unchanged`, `unpublished`, `oversized`) and confirm
`metadata/catalog.sourceCommit` equals `main` at the moment the run started. Read that SHA from
the repository during the run; do not compare against a value copied earlier.

### What a documentation change does and does not rebuild

A change to the **content** — documentation, examples, a release — is a data change that the
mirror carries. It needs no website build and no Pages deployment: the page that is open picks it
up, and a page loaded afterwards reads the new content from the mirror or GitHub.

A change to the **website's own code** is different and does need one. GitHub Pages serves static
files built by `pages.yml`, so a change to `src/`, a route, a style or a dependency has no effect
until that workflow builds and publishes a new artifact. It runs automatically on any push to
`main`; a content change does not trigger it, because there is nothing to rebuild.

## Rendering

Markdown is rendered to React elements through `react-markdown`, so no Markdown is ever inserted
with `dangerouslySetInnerHTML`. The pipeline is:

```
remark-gfm → rehype-raw → rehype-sanitize(schema) → rehype-slug
```

`rehype-raw` parses embedded HTML and `rehype-sanitize` then removes everything not explicitly
allowed. `href` and `src` are restricted to `http`, `https` and `mailto`, which removes
`javascript:`, `data:` and `vbscript:` before a link is created. Relative links and images are
resolved against the document that contains them, so a link written for GitHub lands correctly
here. Heading ids come from `rehype-slug`, which is what the table of contents and `#anchors`
use.

## Trade-off, stated plainly

Rendering documentation in the browser is **not** server rendering. A documentation page arrives
as a shell with navigation and a loading state; the text appears after the fetch. Search engines
and readers without JavaScript get the shell and a direct link to the canonical GitHub file, not
the rendered document. That is the price of keeping exactly one source of truth without a build
that reads another repository.

## Development

```bash
npm ci
npm run dev            # local server
npm run build          # prerender the static routes into _site/
node verify.mjs        # structural checks over _site/
npm test               # unit and integration tests (no network)
npm run test:live      # real GitHub: discovery, a document, a pinned tag
npm run test:browser   # Playwright against the built site (needs `npm run build`)
```

The browser suite serves `_site` on `127.0.0.1:8811` and drives real Chromium. `e2e/mocked.spec.js`
stubs the GitHub API for deterministic cases; `e2e/site.spec.js` uses the real API.

## Deployment

`.github/workflows/pages.yml` runs the unit tests, builds, verifies the output, validates the
HTML, runs the browser suite and the live source tests, then publishes `_site` with GitHub
Actions Pages and smoke-tests every route over the network.

Publishing requires Pages to be configured with **GitHub Actions** as its source, not a branch.

## Structure

```
src/source.js             routes, GitHub URLs, link resolution, URL safety
src/github-docs.js        discovery, fetching, validation, caching
src/firebase/             Firestore client, cached reads, live catalogue subscription
src/services/             mirror-preferred content reads with a GitHub fallback
src/freshness.js          republish detection and cache invalidation
src/use-docs.js           React data hooks
src/markdown-pipeline.js  remark/rehype configuration and sanitizer schema
src/components/           chrome, Markdown, code blocks, search
src/pages/                one component per route
scripts/                  Firestore sync, upstream release detection, audits
prerender.mjs             writes the static routes and 404.html
verify.mjs                structural verification of _site/
```

## License

MIT, matching the language repository.
