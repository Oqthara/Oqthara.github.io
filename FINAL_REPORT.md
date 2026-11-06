# Oqthara website — recovery report

Repository: `Oqthara/Oqthara.github.io` (checked out at `.site-repo/` inside the canonical
language repository `Oqthara/oqthara`, which was **not modified**).

Branch `main`. Base `origin/main` was `dfa963d`; the delivered work is `4bdc4ad`, deployed
green by Pages run `42168174018`.

---

## 1. Recovery findings

The working tree carried three sessions of unfinished work. Nothing was reset or discarded.

Preserved and completed: the GitHub content-discovery runtime, the routing and sanitisation
suite, the contrast fixes, the Oqthara grammar, the header budget rework, and two partially
applied independent reviews.

Discarded only after being proven obsolete: four agent worktrees under `.worktrees/`, every one
of whose commits was already reachable from `main`.

Root causes found and fixed, in the order they blocked the release:

1. **Scripts in `_site` were served with the wrong type** — the deployed page crashed at runtime
   before rendering anything.
2. **`getFirebaseApp()` received a diagnostics object** instead of a configuration, so the SDK
   threw `app/no-options`. The error was swallowed by the Firestore→GitHub fallback, so every
   page silently read from GitHub in production while appearing healthy.
3. **`readDoc()` returned an `{id, data}` wrapper** that every repository passed to a validator
   expecting the bare payload. Every single-document read was rejected as "missing or empty
   path" and fell back to GitHub. Catalogs were unaffected, which is why the failure looked
   partial.
4. **`MarkdownWithToc` emitted `.doc` and `.doc-article` on one element**, so `.doc-article .doc`
   matched nothing and documentation pages lost their article container and side-by-side table
   of contents.
5. **`ChangelogPage` passed a document object** where a Markdown string was expected, so the
   changelog rendered empty.
6. **The static server had no `404.html` fallback.** Python's `http.server` answered unknown
   paths with its own error page, so the mandatory 404 screenshot was a capture of Python's
   page, and a Playwright route shim injected `_site/404.html` behind the test's back. Both
   surfaces are now served by `scripts/lib/serve-site.mjs`, which mirrors GitHub Pages.

---

## 2. Local development servers

Five obsolete `python3 -m http.server` processes were identified by port and confirmed by
reading `/proc`-equivalent working directories, then stopped individually by PID. A manual
Firestore emulator was stopped the same way (exit 143 = SIGTERM, normal).

No process was killed by name pattern, and no unrelated Node.js process was touched. The
production GitHub Pages deployment was never disabled — stopping local servers and publishing the
site are unrelated.

---

## 3. Visual and CSS repair

The defects were fixed at their cause, not by stacking overrides. The `.toc` fix, for example,
sets a 25px minimum height with a 4px gap on the link itself, rather than adding padding to the
list to hide the problem.

Verified across 11 routes × 5 viewports = 55 page loads, plus the mobile menu interaction:

| Viewport | Routes checked | Horizontal overflow | Uncaught errors |
|----------|----------------|---------------------|-----------------|
| 1440×900 | 11 | 0 | 0 |
| 1024×768 | 11 | 0 | 0 |
| 768×1024 | 11 | 0 | 0 |
| 390×844 | 11 | 0 | 0 |
| 320×640 | 11 | 0 | 0 |

The only console output in the entire run is the five legitimate `404` responses for
`/no-such-page`, one per viewport, which is the correct behaviour for a 404 route.

**Mobile navigation** opens and closes via a button that reports `aria-expanded`, closes on
Escape, and returns focus to the trigger. When closed the drawer is `display: none`, so it is
neither focusable nor exposed to assistive technology.

---

## 4. Syntax highlighting

`refractor/core` with nine explicitly registered grammars (python, java, json, bash, javascript,
typescript, yaml, markdown, diff) plus a hand-written Oqthara grammar derived from the canonical
language specification. Using the core build instead of the full bundle keeps the shipped
JavaScript small.

A probe against real specification syntax confirmed 14 distinct token classes, including
`keyword`, `builtin`, `function-definition`, `data-declaration`, `range-operator`, `boolean`,
`number`, `string`, `operator`, `punctuation`, `variable` and `class-name`. Python, Java, JSON
and Bash all report `registered: true`.

Inline code, indentation and copy behaviour are preserved. Markdown still passes through
`rehypeSanitize` after `rehypeRaw`.

---

## 5. Firebase integration

`firebase` is a runtime dependency; `firebase-admin` is a devDependency used only by build-time
and CI scripts.

```
src/firebase/{config,firestore,collections}.js
src/repositories/{documentation,examples,releases,stdlib}.repository.js
src/services/content.service.js
```

Configuration is read exclusively from `VITE_FIREBASE_*` environment variables, validated at
initialisation with a specific diagnostic listing exactly which keys are missing. A single lazy
`initializeApp` reuses an existing app, so the SDK is never initialised twice. No credential,
service account, private key or admin token exists under `src/`.

**Read path.** Firestore → GitHub → stale cache. A Firestore failure never blanks a page: content
that is already on screen stays, and `.stale-note` reports the degraded source. Queries filter
on `published == true` and paginate; results are cached with a 5-minute memory TTL and a
30-minute session TTL.

---

## 6. Security

`firestore.rules` is the boundary. Client-side filtering is defence in depth, not a permission.

- Read on `documentation`, `examples`, `releases` and `stdlib` requires
  `resource.data.published == true`, with a null guard so a missing document denies instead of
  throwing.
- `write` is `false` on all four content collections.
- `sync` and `metadata` are denied for both read and write.
- A `/{document=**}` catch-all denies anything unnamed, so a collection added to the sync script
  without a matching rule fails closed.

Proven by `scripts/test-firestore-rules.mjs`, which runs the rules in the Firestore emulator
against 13 assertions covering published reads, unpublished reads, client writes on every
collection, and unmatched paths: **13/13 pass**. The same command runs in `pages.yml`, so the
rules cannot regress unnoticed.

---

## 7. Content synchronisation

`scripts/sync-firestore.mjs` plus `.github/workflows/firebase-sync.yml`.

Discovery classifies documentation, examples, standard-library references, the changelog and
release metadata; computes a SHA-256 hash per document; writes only documents whose hash changed;
batches at 400 operations; refuses content over 900 KiB with a recorded reason; converts
deletions into `published: false` rather than dropping records; aborts on a truncated directory
listing instead of publishing an incomplete mirror; and records bookkeeping in `sync`. A
scheduled run performs a full reconciliation.

Administrative writes happen only in the trusted Actions environment, using the
`FIREBASE_SERVICE_ACCOUNT` secret. That secret is never `VITE_`-prefixed and never reaches the
browser bundle.

### Blocker (honest status)

**`FIREBASE_SERVICE_ACCOUNT` is not configured for this repository.** `gh secret list -R
Oqthara/Oqthara.github.io` returns an empty list. Without it no live synchronisation can run,
and I will not invent credentials or weaken the rules to make the site appear functional.

Evidence gathered:

```
$ gh secret list -R Oqthara/Oqthara.github.io
(empty)

$ curl -o /dev/null -w "%{http_code}" …/documents/<collection>?key=<public web key>
documentation -> 403
examples      -> 403
releases      -> 403
stdlib        -> 403
metadata      -> 403
sync          -> 403
```

A 403 on an unwritten project is the correct response, not a rules failure.

**Substitute evidence that the read path works:** the 57-record emulator seed, the 13/13 rules
proof, and `artifacts/visual-audit/firebase-content-loaded.png` — a real browser capture of a
documentation page whose `data-source` is `firestore`, taken from a build pointed at the
emulator. Together they demonstrate the full read path without a production credential.

**To close:** add the JSON key of a service account holding `Cloud Datastore User` on project
`oqthara` as the `FIREBASE_SERVICE_ACCOUNT` secret, then dispatch `firebase-sync` with
`dry_run=false`. The workflow validates the JSON, masks the value, and writes it to a temporary
credentials file that is deleted on exit.

---

## 8. Commands and results

Every command below was executed in `.site-repo/`.

| Command | Result |
|---------|--------|
| `npm test` | **145 tests, 141 pass, 0 fail, 4 skipped** |
| `npm run test:rules` | **13/13 rule assertions passed** |
| `npm run build` | 10 static routes + `404.html` prerendered into `_site` |
| `npm run verify` | **11 HTML files verified** |
| `npx --yes html-validate@9 --formatter stylish _site/*.html` | **0 problems, exit 0** |
| `npx playwright test` | **34 passed, 2 skipped, 0 failed** |
| `npm run audit:visual` | **57/57 checks passed** |
| `npm run screenshots` | **15 screenshots captured**, exit 0 |

The visual audit takes approximately twelve minutes because it performs 55 real page loads with
a settle step each.

### Continuous integration

`.github/workflows/pages.yml` runs `npm ci`, `npm test`, `npm run test:rules`, `npm run build`,
`node verify.mjs`, `html-validate`, `npx playwright test`, `npm run test:live`, then uploads and
deploys to Pages.

`html-validate` only runs in CI, so it is not covered by `npm test` or `npm run verify`. The
first push of this work (`4a96c30`) went red there: six `no-inline-style` errors, because four
page components were still emitting `style` objects from `React.createElement`. The style
objects were replaced with classes in `assets/site.css` — `.flow-sm`, `.flow-md`, `.flow-lg` for
vertical rhythm and `.block-gap-sm` for a spacer — and a repository-wide search now returns no
`style: {` or `style="` occurrence in `src/`. Regenerated screenshots are byte-identical, so the
classes render exactly as the inline styles did.

Final run: **`42168174018`, conclusion `success`, on `4bdc4ad`.** Every step passed:

| Step | Result |
|------|--------|
| Install | success |
| Unit and integration tests | success |
| Firestore security rules | success |
| Build | success |
| Verify the prerendered output | success |
| Validate HTML | success |
| Install Playwright Chromium | success |
| Browser tests | success |
| Live source tests | success |
| Upload Pages artifact | success |
| Deploy to GitHub Pages | success |
| Smoke test the deployed site | success |

The deployed site was then checked directly: nine routes returned `200` with no `style`
attribute anywhere in the DOM, no horizontal overflow at 1440, 1024, 768, 390 or 320 px, real
Prism tokens on the tour, status, philosophy and language-reference pages, the mobile drawer
opening to 390×443 px with 25 visible links and closing on Escape with focus returned to the
toggle, and `data-source="github"` on the content routes — the intended fallback, since no
service-account secret exists yet.

---

## 9. Screenshots

`artifacts/visual-audit/` — all genuine Chromium captures of the built site.

| File | Viewport | Route |
|------|----------|-------|
| `home-desktop.png` | 1440×1000 | `/` |
| `home-mobile.png` | 390×844 | `/` |
| `docs-desktop.png` | 1440×1000 | `/docs.html` |
| `docs-mobile.png` | 390×844 | `/docs.html` |
| `doc-page-code-highlighting.png` | 1440×1000 | `/document.html?path=docs/spec/language.md` |
| `doc-page-mobile.png` | 390×844 | `/document.html?path=docs/spec/language.md` |
| `examples-desktop.png` | 1440×1000 | `/examples.html` |
| `example-desktop.png` | 1440×1000 | `/example.html?path=examples/anagrams.oq` |
| `stdlib-desktop.png` | 1440×1000 | `/stdlib.html` |
| `changelog-desktop.png` | 1440×1000 | `/changelog.html` |
| `status-desktop.png` | 1440×1000 | `/status.html` |
| `philosophy-desktop.png` | 1440×1000 | `/philosophy.html` |
| `tour-desktop.png` | 1440×1000 | `/tour.html` |
| `not-found-desktop.png` | 1440×1000 | `/no-such-page.html` (status 404) |
| `navigation-mobile-open.png` | 390×844 | `/` with the menu open |
| `firebase-content-loaded.png` | 1440×1000 | `/document.html?path=docs/spec/language.md`, `data-source="firestore"` |

`not-found-desktop.png` was confirmed programmatically and visually to be the site's own 404 —
dark theme, site header and footer, `<main>` present, heading "That page does not exist", 17
links, Inter typeface — not the static server's error page.

---

## 10. Reviews

- [`REVIEW_A_ENGINEERING_SECURITY.md`](./REVIEW_A_ENGINEERING_SECURITY.md) — 6 findings (2 P1,
  3 P2, 1 P3), all fixed. No P0.
- [`REVIEW_B_VISUAL_PRODUCT.md`](./REVIEW_B_VISUAL_PRODUCT.md) — 6 findings (4 P1, 2 P2), all
  fixed. No P0.

---

## 11. Acceptance

| Criterion | Status |
|-----------|--------|
| Website visually repaired | Met — 57/57 audit checks |
| Navigation works desktop and mobile | Met — with ARIA, Escape and focus return |
| Oqthara syntax highlighting | Met — real grammar, 14 token classes verified |
| Firestore reads work | Met — proven against the emulator; production blocked on the secret |
| Public access restricted to published content | Met — 13/13 rules assertions |
| Client writes denied | Met — `write: if false` everywhere, asserted |
| Sync implemented or blocker documented | Met — implemented; blocker documented with evidence |
| Dynamic content remains automatic | Met — no hand-maintained content introduced |
| Existing content not silently lost | Met — deletions unpublish, never drop |
| Playwright passes | Met — 34 passed |
| Both reviews documented | Met |
| Screenshots produced | Met — 16 files |
| CI green and deployed | Met — run `42168174018` succeeded end to end |

One criterion is met with a documented external blocker rather than a green production run: live
synchronisation needs a credential only the repository owner can provide.

---

## Stop

The mission is finite and complete. No further features, redesign or refactoring were started.
