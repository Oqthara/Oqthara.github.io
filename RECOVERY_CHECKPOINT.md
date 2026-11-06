# RECOVERY CHECKPOINT — Oqthara website visual and UI repair

Updated: 2026-11-06 (mission in progress)

## Repository and branch

- Mission repository: `Oqthara/Oqthara.github.io`, checked out at `.site-repo/`
- Branch: `main`
- Integration HEAD: `5f05ae4` — `feat(site): highlight Oqthara code and repair code blocks`
- Working tree at checkpoint time: clean (the `.gitignore` entry for `.worktrees/` is part of
  the agent setup and is committed with the agent work)
- Language repository `Oqthara/oqthara` is READ-ONLY and untouched (`7ffb675`, clean)

## Verified defect root causes

1. **Code blocks rendered as white pills.** `src/markdown-pipeline.js` passed the whole
   `pre` children array into `CodeBlock`, which wrapped the already-highlighted `code`
   element in a second `code`. The inner element was therefore not a direct child of `pre`
   and matched the global `:not(pre) > code` rule, painting the inline-chip background on the
   dark surface. Fixed by passing the tokenised `code` element through unchanged.

2. **No syntax highlighting at all.** Two causes:
   - The canonical documents fence most samples with no language: 84 of 96 blocks across
     `docs/**` are bare. Prism had nothing to tokenise.
   - The Oqthara grammar listed `elseif`, `raise`, `is` and `until` as keywords, which the
     lexer does not define, and used anchored `inside` patterns that can never match, so
     `data`/`fun` declarations were never coloured.
   Fixed by conservative content inference (`src/lib/infer-language.js`), correcting the
   keyword list to the canonical 20 from `Lexer.KEYWORDS`, adding contextual range operators
   and statement built-ins, and fixing the declaration rules.

3. **Tour page full-bleed.** `src/pages/TourPage.jsx` is the only page that renders its root
   without the shared `content` container, so text and code touch the viewport edge.

4. **Header overflow.** Measured 1097px of header in a 1024px viewport and 370px in a 320px
   viewport before the earlier breakpoint work; the nav must collapse earlier and the search
   field must shrink rather than push controls off-screen.

## Agent worktrees and ownership

| Agent | Worktree | Owns | Status |
|---|---|---|---|
| A — navigation and global CSS | `.site-repo/.worktrees/site-nav` | `assets/site.css`, `src/components/Layout.jsx`, `src/data/meta.js`, `src/pages/TourPage.jsx`, `src/pages/NotFoundPage.jsx`, `scripts/audit-visual.mjs` | running |
| B — highlighting and Markdown | `.site-repo/.worktrees/site-hl` | `src/lib/*`, `src/components/Code.js`, `src/markdown-pipeline.js`, `tests/highlight.test.js`, `tests/inference.test.js` | running |
| C — Firebase and content | `.site-repo/.worktrees/site-firebase` | `src/firebase/*`, `src/repositories/*`, `src/services/*`, `firestore.rules`, `firebase.json`, `.firebaserc`, `.env.example`, `scripts/sync-firestore.mjs`, `.github/workflows/firebase-sync.yml`, `tests/firebase.test.js`, `README-firebase.md`, `package.json` dependency additions | running |
| D — independent QA | `.site-repo/.worktrees/site-qa` | `artifacts/qa-report-*.md`, `artifacts/visual-audit/*.png`, `scripts/qa-audit.mjs` | running |

No two agents write the same files. The main agent owns integration, page-level wiring of the
Firebase service, final acceptance and the final report.

## Completed work (committed)

- `dfa963d` discover content from GitHub and fix the deployed runtime crash
- `a5c8889` verify the new routes and stop publishing stale output
- `f176ec7` raise small-text contrast to WCAG AA in light appearance
- `1a1ab6b` cover dynamic discovery, routing and sanitization
- `e5a4955` keep content on screen across reloads, channel switches and failures
- `ce71310` correct the defects found in the first independent review
- `771ad79` address the second independent review
- `5f05ae4` highlight Oqthara code and repair code blocks

## Pending integrations

1. Agent A commit into `main` (CSS, layout, tour, 404, audit script).
2. Agent B commit into `main` (grammar hardening plus two new test files).
3. Agent C commit into `main` (Firebase data layer, rules, sync, workflow).
4. Main agent: wire `src/services/content.service.js` into the page data hooks if Agent C
   reports that page changes are required.
5. Main agent: integrate one workstream at a time, rerunning `npm run build` and `npm test`
   after each merge.
6. Agent D reports are advisory and must NOT be merged as fixes; confirmed P0/P1 defects are
   fixed by the owner agent, then re-verified.

## Acceptance criteria still unmet

- No horizontal overflow at 1440/1024/768/390/320 on every route, proven by a run.
- Navigation correct and accessible at every width, proven by a run.
- Oqthara highlighting proven in a browser with token spans and distinct colours.
- Firebase read layer implemented with rules denying client writes; live sync blocked by the
  missing `FIREBASE_SERVICE_ACCOUNT` secret, documented rather than faked.
- Playwright suite green.
- Mandatory screenshots present under `artifacts/visual-audit/`.
- Both independent reviews recorded, with P0/P1 fixed and re-verified.
- Final report with commit IDs, commands and results.

## Exact next actions

1. Wait for agent completions; do not duplicate their files.
2. Review each returned commit: `git log --stat`, read the diff, reject claims without output.
3. Integrate A, then B, then C, building and testing after each.
4. Wire the Firebase service into the data hooks if required, keeping the GitHub fallback.
5. Re-run the browser suite and capture the mandatory screenshots from the integrated build.
6. Fix confirmed P0/P1 review findings, re-verify, then write the final report.
7. Push `main` and confirm the Pages deployment.

## Known environmental constraints

- Unauthenticated GitHub API quota is 60 requests/hour per IP; audits authenticate through a
  `Bearer` header from `gh auth token` at the network layer only. No token is written to any
  file that ships.
- No Firebase service account is available. The Firestore sync can only be verified with
  `--dry-run`; live writes and rules deployment remain blocked and must be reported as such.
