# Review A — Engineering and security

Scope: the Firebase read path, Firestore security rules, the GitHub Actions content sync, the
CSS and Markdown pipeline, the syntax-highlighting implementation, and runtime behaviour.

Method: source inspection of every file under `src/`, `scripts/`, `.github/workflows/` and the
rules file, plus executed evidence — the emulator rules harness, the unit suite, the Playwright
suite, and the five-viewport visual audit.

---

## Findings

| # | Severity | Area | Finding | Status |
|---|----------|------|---------|--------|
| A1 | P1 | `src/firebase/config.js` | `getFirebaseApp()` passed `firebaseConfigStatus()` to `initializeApp()`. That object reports configuration *diagnostics* and has no `config` key, so the SDK received `undefined` and threw `app/no-options`. `preferFirestore` converts any thrown thunk into a GitHub fallback, so **every page silently read from GitHub in production** while appearing healthy. | Fixed — `firebaseAppConfig()` returns the resolved config; 2 regression tests |
| A2 | P1 | `src/firebase/firestore.js` | `readDoc()` returned an `{id, data}` wrapper, but every repository passes the result into a validator that expects the bare payload. Every single-document read was rejected as "missing or empty path" and fell back to GitHub. Catalogs worked because `readDocs` returns document entries by design. | Fixed — `readDoc` unwraps `.data`; regression test |
| A3 | P2 | `.github/workflows/firebase-sync.yml` | The fail-closed step excluded `workflow_dispatch`, so a manual run with `dry_run=false` and no `FIREBASE_SERVICE_ACCOUNT` finished green having written nothing. | Fixed — step now also covers manual non-dry-run dispatches |
| A4 | P2 | `scripts/capture-screenshots.mjs` | The script required an externally started `python3 -m http.server`, which has **no `404.html` fallback**. The mandatory `not-found-desktop.png` was a capture of Python's own error page, not the site's 404. A test shim (`serveBuilt404`) masked the same defect in the Playwright suite. | Fixed — shared `scripts/lib/serve-site.mjs`; scripts and Playwright now self-serve Pages-like responses |
| A5 | P3 | `assets/site.css` | `.toc a` links were 16px tall with a ~9.4px gap, so a 24px target circle overlapped its neighbour. WCAG 2.2 §2.5.8 spacing exception did not apply. | Fixed — 25px tall, 4px gap, 0 circle overlaps measured |
| A6 | P2 | `src/pages/*.jsx`, `.github/workflows/pages.yml` | Seven page components emitted `style` objects through `React.createElement`, so the prerendered HTML carried inline styles. `html-validate` rejects these (`no-inline-style`) and runs **only** in CI, so `npm test` and `npm run verify` reported green while the Pages run failed at validation. | Fixed — classes in `assets/site.css`; no `style: {` or `style="` left in `src/`; validator 0 problems |

No P0 findings.

---

## Verified clean

**Firebase initialisation.** A single lazy `initializeApp` that reuses `getApps()[0]`. No
repeated initialisation, no eager import-time side effect.

**Read-path error handling.** Typed errors are never thrown out of a read path. The cascade is
Firestore → GitHub → stale cache, and a failed refresh with content already on screen keeps the
page `ready` and surfaces `.stale-note` instead of blanking the document.

**Security rules.** `firestore.rules` gates each mirrored collection on
`resource.data.published == true` with a null guard, denies `write` on all four content
collections, denies `sync` and `metadata` entirely, and closes everything else with a
`/{document=**}` catch-all. Client-side filtering exists as defence in depth, never as the
boundary.

**Credential isolation.** No `firebase-admin`, service-account JSON, private key, or token
appears under `src/`. The Admin SDK is a devDependency imported only by `scripts/`. No `.env` is
tracked; only `.env.example`, which documents that `GOOGLE_APPLICATION_CREDENTIALS` and
`FIREBASE_SERVICE_ACCOUNT` must never be `VITE_`-prefixed.

**Sync workflow.** `pages.yml` uses no `pull_request_target` and is gated on `main`.
`sync-firestore.mjs` hashes with SHA-256, batches at 400 writes, refuses content over
900 KiB, merges deletions as `published: false` rather than dropping records, and aborts on a
truncated directory listing rather than publishing an incomplete mirror.

**Markdown security.** `rehypeSanitize` runs after `rehypeRaw`, with a protocol allowlist. No
`dangerouslySetInnerHTML` anywhere in the pipeline.

**Highlighting.** Grammars are assembled in one module and shared by every code surface.
`refractor/core` with nine explicit grammars replaces the full bundle. The Oqthara grammar was
written from the canonical specification and is verified to emit `keyword`, `builtin`,
`function-definition`, `data-declaration`, `range-operator`, `boolean`, `number`, `string`,
`operator`, `punctuation`, `variable` and `class-name` tokens on real specification syntax. No
grammar contains a pattern with catastrophic backtracking.

**Responsive behaviour.** 55 route/viewport combinations (11 routes × 5 widths) reported zero
page-level horizontal overflow and zero uncaught JavaScript errors. Apparent overflow from
`code`, `span.token` and `table` is contained in intentional `overflow-x: auto` scrollers.

---

## Executed evidence

| Command | Result |
|---------|--------|
| `npm test` | 145 tests, 141 pass, 0 fail, 4 skipped |
| `npm run test:rules` | 13/13 rule assertions passed |
| `npm run build` | 10 static routes + `404.html` prerendered into `_site` |
| `npm run verify` | 11 HTML files verified |
| `npx --yes html-validate@9 --formatter stylish _site/*.html` | 0 problems, exit 0 |
| `npx playwright test` | 34 passed, 2 skipped, 0 failed |
| `npm run audit:visual` | 57/57 checks passed |
| Pages run `42168174018` on `4bdc4ad` | success — all 12 build steps and the deploy

## Known blocker

`FIREBASE_SERVICE_ACCOUNT` is **not configured** (`gh secret list` is empty), so no live sync
can be executed. All six live collections return HTTP 403 with the public web key, which is the
correct response for an unwritten project rather than a rules failure. See
`FINAL_REPORT.md` for the substitute evidence and the exact steps to close it.

## Recommendation

Restrict the public API key to the site's own origins and enable Firebase App Check
(reCAPTCHA Enterprise or App Attest) so that even the read-only surface cannot be scripted from
third-party pages. Neither is required for correctness — the rules already deny every write and
every read of unpublished content.
