# Visual review package — PR #2

This file exists so a human can judge the rendered pages. Aesthetic acceptance was
**NOT VERIFIED** while the package was prepared; the maintainer then reviewed it and recorded
**APPROVED** in §6 on 2026-11-07.

## 1. What is under review

| Fact | Value |
| --- | --- |
| Repository | `Oqthara/Oqthara.github.io` |
| Pull request | [#2](https://github.com/Oqthara/Oqthara.github.io/pull/2) |
| Branch | `feat/alpha-automation-and-hardening` |
| Branch HEAD when the captures were made | `e43d418` |
| Merge state | **merged into `main` as `9d9a41a`**, by the maintainer, after the captures |
| Commit under review | `9d9a41a` — the squash of this branch, and what the links below resolve against |
| Screenshots captured in | `4ed134a` for the 29 original files; the V1 recapture and the tablet set are newer (this pull request) |
| Screenshot count | 38 files, 0 duplicates |

**Gallery:** https://github.com/Oqthara/Oqthara.github.io/tree/main/artifacts/visual-audit

Every image below is linked individually against `main`. GitHub renders PNGs in the browser,
so the links open the actual pixels.

**Two generations of capture are in this set, and the difference matters for review.** The
30 files the maintainer approved were captured at `e43d418` and are byte-identical on `main`.
The pull request that carries this file adds 8 tablet captures and replaces
`firebase-content-loaded.png`; the other 29 are untouched, byte for byte. So 29 of the 38
images are exactly what was approved, 8 are new coverage, and 1 is a corrected replacement —
which has been verified but not individually approved (§5 V1, §6).

## 2. Inventory

Dimensions are the real PNG pixel dimensions, read from each file header, with the CSS
viewport they correspond to. Captures use `deviceScaleFactor: 2`, so a 1440×1000 CSS
viewport is stored as 2880×2000 pixels — the doubled numbers are not a different viewport.

Theme is not taken from the filename. Each file was decoded and its mean luminance
measured; a mean below 90/255 is recorded as dark. All 30 filenames agree with their own
pixels — the recorded theme is a measurement, not a restatement of the name.

What that check cannot see is *age*. It classifies `firebase-content-loaded.png` as light,
correctly, while the image still shows a retired palette. Age was caught by reading its
background colour instead: pure `#ffffff` against `#fbfaf7` on every other light page (§5).

| # | File | Page | Viewport | Theme | Pixels | CSS | Size |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | [`home-desktop.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/home-desktop.png) | / | desktop | light | 2880×2000 | 1440×1000 | 518.9 KB |
| 2 | [`home-desktop-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/home-desktop-dark.png) | / | desktop | dark | 2880×2000 | 1440×1000 | 540.8 KB |
| 3 | [`home-tablet.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/home-tablet.png) | / | tablet | light | 1536×2048 | 768×1024 | 364.2 KB |
| 4 | [`home-tablet-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/home-tablet-dark.png) | / | tablet | dark | 1536×2048 | 768×1024 | 424.5 KB |
| 5 | [`home-mobile.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/home-mobile.png) | / | mobile | light | 780×1688 | 390×844 | 267.2 KB |
| 6 | [`home-mobile-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/home-mobile-dark.png) | / | mobile | dark | 780×1688 | 390×844 | 311.7 KB |
| 7 | [`navigation-tablet-open.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/navigation-tablet-open.png) | / (menu expanded) | tablet | light | 1536×2048 | 768×1024 | 113.0 KB |
| 8 | [`navigation-tablet-open-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/navigation-tablet-open-dark.png) | / (menu expanded) | tablet | dark | 1536×2048 | 768×1024 | 99.8 KB |
| 9 | [`navigation-mobile-open.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/navigation-mobile-open.png) | / (menu expanded) | mobile | light | 780×1688 | 390×844 | 82.7 KB |
| 10 | [`navigation-mobile-open-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/navigation-mobile-open-dark.png) | / (menu expanded) | mobile | dark | 780×1688 | 390×844 | 77.2 KB |
| 11 | [`changelog-desktop.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/changelog-desktop.png) | /changelog.html | desktop | light | 2880×2000 | 1440×1000 | 287.2 KB |
| 12 | [`changelog-desktop-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/changelog-desktop-dark.png) | /changelog.html | desktop | dark | 2880×2000 | 1440×1000 | 288.2 KB |
| 13 | [`docs-desktop.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/docs-desktop.png) | /docs.html | desktop | light | 2880×2000 | 1440×1000 | 234.8 KB |
| 14 | [`docs-desktop-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/docs-desktop-dark.png) | /docs.html | desktop | dark | 2880×2000 | 1440×1000 | 235.1 KB |
| 15 | [`docs-tablet.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/docs-tablet.png) | /docs.html | tablet | light | 1536×2048 | 768×1024 | 207.9 KB |
| 16 | [`docs-tablet-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/docs-tablet-dark.png) | /docs.html | tablet | dark | 1536×2048 | 768×1024 | 208.3 KB |
| 17 | [`docs-mobile.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/docs-mobile.png) | /docs.html | mobile | light | 780×1688 | 390×844 | 150.7 KB |
| 18 | [`docs-mobile-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/docs-mobile-dark.png) | /docs.html | mobile | dark | 780×1688 | 390×844 | 151.6 KB |
| 19 | [`doc-page-code-highlighting.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/doc-page-code-highlighting.png) | /document.html?path=docs/spec/language.md | desktop | light | 2880×2000 | 1440×1000 | 294.2 KB |
| 20 | [`doc-page-code-highlighting-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/doc-page-code-highlighting-dark.png) | /document.html?path=docs/spec/language.md | desktop | dark | 2880×2000 | 1440×1000 | 293.7 KB |
| 21 | [`doc-page-tablet.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/doc-page-tablet.png) | /document.html?path=docs/spec/language.md | tablet | light | 1536×2048 | 768×1024 | 143.2 KB |
| 22 | [`doc-page-tablet-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/doc-page-tablet-dark.png) | /document.html?path=docs/spec/language.md | tablet | dark | 1536×2048 | 768×1024 | 142.6 KB |
| 23 | [`doc-page-mobile.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/doc-page-mobile.png) | /document.html?path=docs/spec/language.md | mobile | light | 780×1688 | 390×844 | 107.2 KB |
| 24 | [`doc-page-mobile-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/doc-page-mobile-dark.png) | /document.html?path=docs/spec/language.md | mobile | dark | 780×1688 | 390×844 | 106.8 KB |
| 25 | [`firebase-content-loaded.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/firebase-content-loaded.png) | /document.html?path=docs/spec/language.md (emulator build) | desktop | light | 2880×2000 | 1440×1000 | 294.1 KB |
| 26 | [`example-desktop.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/example-desktop.png) | /example.html?path=examples/anagrams.oq | desktop | light | 2880×2000 | 1440×1000 | 216.7 KB |
| 27 | [`example-desktop-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/example-desktop-dark.png) | /example.html?path=examples/anagrams.oq | desktop | dark | 2880×2000 | 1440×1000 | 215.7 KB |
| 28 | [`examples-desktop.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/examples-desktop.png) | /examples.html | desktop | light | 2880×2000 | 1440×1000 | 252.3 KB |
| 29 | [`examples-desktop-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/examples-desktop-dark.png) | /examples.html | desktop | dark | 2880×2000 | 1440×1000 | 252.7 KB |
| 30 | [`not-found-desktop.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/not-found-desktop.png) | /no-such-page.html | desktop | light | 2880×2000 | 1440×1000 | 231.5 KB |
| 31 | [`philosophy-desktop.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/philosophy-desktop.png) | /philosophy.html | desktop | light | 2880×2000 | 1440×1000 | 325.4 KB |
| 32 | [`philosophy-desktop-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/philosophy-desktop-dark.png) | /philosophy.html | desktop | dark | 2880×2000 | 1440×1000 | 329.5 KB |
| 33 | [`status-desktop.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/status-desktop.png) | /status.html | desktop | light | 2880×2000 | 1440×1000 | 290.3 KB |
| 34 | [`status-desktop-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/status-desktop-dark.png) | /status.html | desktop | dark | 2880×2000 | 1440×1000 | 292.0 KB |
| 35 | [`stdlib-desktop.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/stdlib-desktop.png) | /stdlib.html | desktop | light | 2880×2000 | 1440×1000 | 276.2 KB |
| 36 | [`stdlib-desktop-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/stdlib-desktop-dark.png) | /stdlib.html | desktop | dark | 2880×2000 | 1440×1000 | 276.0 KB |
| 37 | [`tour-desktop.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/tour-desktop.png) | /tour.html | desktop | light | 2880×2000 | 1440×1000 | 278.4 KB |
| 38 | [`tour-desktop-dark.png`](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/tour-desktop-dark.png) | /tour.html | desktop | dark | 2880×2000 | 1440×1000 | 277.6 KB |

**38 files across 13 page groups.** Viewports present: **desktop 1440×1000** (22 captures),
**tablet 768×1024** (8 captures) and **mobile 390×844** (8 captures), with both themes at
every size. Pixel dimensions are double the CSS size because the capture context uses
`deviceScaleFactor: 2`; the CSS column is the layout size a browser reports.

Generated by `node scripts/capture-screenshots.mjs` at 37 shots, plus
`firebase-content-loaded.png` from `node scripts/capture-firebase-screenshot.mjs` against a
local Firestore emulator. Both are byte-reproducible; see §9.

## 3. Recommended inspection order

Judge the whole before the parts. A page can pass every per-element check and still look
wrong, so the first pass is impression only — no measuring, no counting.

| Pass | Look at | Question to answer |
| --- | --- | --- |
| 1. Impression | `home-desktop` then `home-desktop-dark` | Does this look like a site someone designed on purpose? |
| 2. Theme parity | Any light/dark pair, side by side | Does dark feel like the same design, or a second one? |
| 3. Reading | `doc-page-code-highlighting`, `philosophy-desktop`, `stdlib-desktop` | Can you read a paragraph without effort? |
| 4. Density | `stdlib-desktop`, `changelog-desktop` | Does volume break the rhythm or hold it? |
| 5. Narrow measure | `status-desktop` | Does 568px look deliberate in a wide column, or stranded? |
| 6. Rail geometry | `tour-desktop` | Do the prose and its contents rail read as one unit? |
| 7. Code | `doc-page-code-highlighting` (both), `example-desktop` | Are tokens distinguishable and is code legible? |
| 8. Mobile | `home-mobile`, `docs-mobile`, `doc-page-mobile` (both themes) | Does anything overflow, clip, or crowd? |
| 9. Navigation | `navigation-mobile-open` (both) | Are targets hittable and labels readable? |
| 10. Tablet | `home-tablet`, `docs-tablet`, `doc-page-tablet` (both themes) | Does the 768px band look like a layout, or like a desktop squeezed until it fits? |
| 11. Tablet navigation | `navigation-tablet-open` (both) | At the widest collapsed-nav size, is the panel comfortable or cramped? |
| 12. Edge states | `not-found-desktop`, `status-desktop` | Do error and degraded states still look designed? |

## 4. Checklist

Tick these against the images, not against this document. Each is a judgement call that
automation cannot make.

### Visual hierarchy

- [ ] Each page has one obvious focal point.
- [ ] Heading levels are distinguishable without reading the words.
- [ ] Interface type (nav, buttons, labels) is distinguishable from editorial type.
- [ ] Nothing competes with the primary action or the page title.

### Typography and readability

- [ ] Body text is comfortable, not merely legible.
- [ ] Line length invites reading rather than tracking back.
- [ ] Leading is generous enough that lines do not merge.
- [ ] Code is clearly monospace and clearly smaller than prose, but not squinting-small.
- [ ] Inline code sits on the baseline rather than disrupting it.

### Spacing and alignment

- [ ] Vertical rhythm is consistent between sections.
- [ ] Related items are visibly closer than unrelated ones.
- [ ] Left edges align across elements that should share an axis.
- [ ] No gap looks accidental, and no gap looks like a mistake left in.

### Colour and contrast

- [ ] Text is comfortable to read, not merely above the AA threshold.
- [ ] Borders and dividers are visible but not loud.
- [ ] The accent is used sparingly enough to still mean something.
- [ ] Syntax colours are distinguishable from each other, not just from the background.

### Theme consistency

- [ ] Dark is a translation of light, not a different design.
- [ ] Elevation is expressed in dark without relying on shadow alone.
- [ ] Images, badges and code plates do not glow or disappear in dark.
- [ ] Contrast holds in both directions.

### Responsive behaviour

- [ ] Nothing overflows horizontally at 390px, 768px or 1440px.
- [ ] Text does not clip or truncate unexpectedly.
- [ ] Tap targets are comfortably hittable.
- [ ] The mobile layout is a composition, not a collapsed desktop.
- [ ] At 768px, the collapsed navigation is usable and the body text keeps a readable measure.

### Navigation and footer

- [ ] The open mobile menu is clearly distinct from the page behind it.
- [ ] The same holds at 768px, the widest viewport that shows the collapsed menu.
- [ ] Labels are readable at menu size.
- [ ] Footer grouping reads as structure, not a link dump.

### Coherence

- [ ] Header, footer and body look like one system.
- [ ] Cards, notes, badges and buttons share a consistent shape language.
- [ ] The 404 page belongs to the same site as the homepage.

## 5. Findings from preparing this package

Two problems were found while verifying the artifacts. Neither was an aesthetic judgement,
and at the time this package was first written neither had been fixed. **Both are now closed**;
each section below keeps the original observation, then records what closed it and the
evidence. The closure changes are in the same pull request that carries this file.

### V1 — `firebase-content-loaded.png` was stale and could not be regenerated (CLOSED)

This image is **not** part of the current design. It was captured in `4a96c30`
(2026-11-06) and was not among the 17 files recaptured in `4ed134a`. Eight commits have
touched `assets/site.css` since, including the whole token-wiring pass and the
reading-measure fix.

The evidence is in the pixels, not in the timestamps. Its page background measures pure
`#ffffff`; every other light capture in the set measures `#fbfaf7`, which is the value
`--bg` has had since `956e4a5`. At `4a96c30` the light `--bg` was literally `#ffffff`, so
the image is a faithful capture of a palette the site no longer uses.

It also cannot currently be regenerated. Its `SHOTS` entry declares no `theme`, and the
capture loop now ends with a hard assertion:

```js
const applied = await page.locator("[data-theme-state]").first().getAttribute("data-theme-state");
if (applied !== shot.theme) {
  throw new Error(`expected the ${shot.theme} theme, but the toggle reported ${applied}`);
}
```

With `shot.theme` undefined, `applied` resolves to `"auto"` and this throws. Recapturing
needs `OQ_AUDIT_FIREBASE=1` against an emulator-seeded build **and** a `theme` value added
to that entry. Neither is done here.

![firebase-content-loaded](https://github.com/Oqthara/Oqthara.github.io/blob/main/artifacts/visual-audit/firebase-content-loaded.png)

**Effect at the time:** the 29 ordinary captures were current and this one was historical.

**Closed by recapture, not deletion.** The entry was made reproducible rather than dropped,
because the capability it documents and the image that proves it are both worth keeping:

- `theme: "light"` added to the `SHOTS` entry, so the capture goes through the same theme
  assertion as every other shot instead of throwing on an undefined theme.
- `scripts/capture-firebase-screenshot.mjs` added. It builds with
  `VITE_FIREBASE_EMULATOR_HOST` and `VITE_FIREBASE_PROJECT_ID` pinned to a throwaway
  `oqthara-rules-test` project, seeds the emulator from a canonical checkout, and captures
  only this one file via `OQ_AUDIT_ONLY`. One command, no production access.
- The new image measures `#fbfaf7`, the current light `--bg`, at 2880×2000 / 1440×1000 and
  294.1 KB. It is a faithful capture of the shipped palette.

Two traps found while making it reproducible, both now recorded in the script:

1. Seeding from *this* repository produces 1 record, because the mirrored sources live in
   `Oqthara/oqthara` and this repo carries only a stub `language.md`. Pointing `OQ_SEED_ROOT`
   at a checkout with `docs/**.md` and `examples/**.oq` produces 59 records (19 documentation,
   37 examples, 1 stdlib, 2 releases). Seeding from here alone leaves the page unable to render
   Firestore content at all, which is easy to misread as a build failure.
2. The emulator namespaces data by project id. The built app defaults to `oqthara` while
   the seed wrote `oqthara-rules-test`, so every read missed and the page silently fell back
   to `data-source="github"`. Pinning `VITE_FIREBASE_PROJECT_ID` to the seed project is what
   makes the content reachable. The `ready` selector is what catches this: with no data the
   capture fails loudly instead of committing a page that looks fine but proves nothing.

### V2 — no tablet captures existed (CLOSED)

The execution order asks for grouping by desktop, tablet and mobile "where applicable". No
tablet viewport is captured: the script defines exactly two, `DESKTOP` 1440×1000 and
`MOBILE` 390×844, and the files confirm it — 22 captures at 2880×2000 and 8 at 780×1688,
with no third size. This is a gap in the artifact set, not a wrong filename.

Responsive behaviour between 390 and 1440 was therefore **not covered by these images**. It
was covered by `npm run audit:visual`, which runs 11 routes across five viewports including
768px and checks for overflow programmatically — but that measures geometry, not looks.

**Closed by adding `TABLET = { width: 768, height: 1024 }`** to
`scripts/capture-screenshots.mjs` and capturing 8 tablet shots: home, docs, a documentation
page and the open navigation, each in both themes. 768×1024 is the standard tablet portrait
size and it lands in a band the site actually distinguishes — `assets/site.css` collapses the
navigation at `max-width: 960px`, so a tablet gets the collapsed-nav behaviour while keeping
width that a 390px phone drops. That is the band the audit had geometry for and no image of.

The open-navigation shots matter specifically at this size: the nav toggle exists only below
960px, so tablet is the widest viewport where the hamburger and its expanded panel are the
real navigation. Tablet captures are 1536×2048 pixels (double 768×1024).

### Distinction from the collision guard

Neither finding is the screenshot-collision defect. That guard is intact: the audit writes
to `artifacts/visual-audit-routes/`, the committed set stays in `artifacts/visual-audit/`,
and `tests/site.test.js` fails if the two paths converge. V1 and V2 are about whether the
committed images are current and complete, which nothing currently tests.

## 6. Maintainer decision

**Status: APPROVED.**

| Field | Value |
| --- | --- |
| Decision | **APPROVED** |
| Reviewer | the repository maintainer (`@Oqthara`), in the review conversation |
| Date | 2026-11-07, 11:14 -03:00 (14:14Z) |
| Images inspected | not stated. The maintainer replied `APPROVED` to a direct request for one of APPROVED / APPROVED WITH RESERVATIONS / REJECTED, without enumerating what was opened |
| Reservations | none recorded |

The decision is recorded verbatim. This file does not claim the maintainer opened all 30
images, or any particular subset — that was not stated, and inventing it would make the
record less trustworthy than the one-word answer it came from.

Before the decision, this section said NOT VERIFIED, because no amount of evidence generated
by the agent preparing the package substitutes for a person looking at the pixels. Capture
success, byte-identical reruns, geometry assertions, contrast ratios and browser results all
show the site renders as specified; none of them show that it looks right. The maintainer
supplied exactly the judgement the tooling could not.

### What the approval does not settle

Approval was given as `APPROVED`, not `APPROVED WITH RESERVATIONS`. That is a decision that
the visuals are acceptable. It was not a decision to close the two findings in §5, and it was
not needed to close them: neither was raised as a blocking reservation, so both were handled
as ordinary follow-up work in a later pull request.

| Finding | Status | Evidence |
| --- | --- | --- |
| V1 — stale `firebase-content-loaded.png` | **closed** | Recaptured against a local emulator; the image now measures `#fbfaf7`, the current light `--bg`, instead of the retired `#ffffff`. |
| V2 — no tablet captures | **closed** | 8 captures at 768×1024 added, both themes, including the open collapsed navigation. |

Neither was a defect in the shipped site. V1 was a stale artifact and V2 was a gap in the
image set, so approving the visuals neither resolved nor was blocked by them.

Note on scope: V1 was closed by recapture rather than by deleting the entry, which means the
image the maintainer approved in the 30-file set has been replaced by a different image of
the same page. The replacement is newer, uses the approved palette, and is byte-reproducible,
but it is not a pixel the maintainer has seen. That is stated rather than glossed: closing a
finding by changing an artifact always has this property, and the honest position is that the
new image is *verified* (correct theme, correct dimensions, reproducible) and *not*
individually *approved*.

**Neither is authorized by this file.** This package performs no production write, no merge
and no deploy.

### What was disclosed before the decision

These were on the record when the maintainer approved, so the approval covers them as
accepted-by-omission rather than as unseen surprises. V1 and V2 are detailed above; the
last four are judgement calls a reviewer could reasonably have rejected.

| Item | Why it matters |
| --- | --- |
| V1: stale `firebase-content-loaded.png` | One of 30 images shows a retired palette. Judging it as current would be wrong. |
| V2: no tablet captures | Behaviour at 768px has geometry coverage but no visual evidence. |
| Narrow measure on `/status.html` | Deliberately kept at 568px with no narrower token. A reviewer may disagree. |
| Tour rail geometry | Reproduced by an explicit `max-width` cap rather than inherited nesting; the numbers match, the structure differs. |
| Firefox | Not launchable on the review host. CI runs it green on Linux — 92 passed / 2 skipped in `42387062654`, Firefox 159.0. |
| Typography and spacing scope | The whole point of the branch. Approval says the scale reads correctly, not that every page was measured against every token. |

## 7. What visual approval does not authorize

Approving the visuals is a statement about how the site looks. It is not a release
authorization, and it does not unlock the blocked data work.

| Gate | State | Who can open it |
| --- | --- | --- |
| `OQTHARA_PRODUCTION_SYNC` | **unset — writes disabled** | maintainer, in repository settings |
| `OQTHARA_DEPLOY_FIRESTORE_RULES` | **unset — deploys disabled** | maintainer, in repository settings |
| Production Firestore writes | **NOT PERFORMED by this branch's tooling** | maintainer authorization required, separately |
| Document-level reconciliation plan | **NOT APPROVED** | maintainer review, separately |
| Merge of PR #2 | **DONE — merged by the maintainer as `9d9a41a`** | already happened, outside this review |
| Deploy | **DONE — GitHub Pages deployed `9d9a41a`** | already happened, outside this review |

The last two rows were false when this package was drafted and are corrected here. While the
review package was being assembled, the maintainer merged PR #2 (2026-11-07T13:55:59Z) and
the Pages workflow deployed the merge commit; `https://oqthara.github.io/` answers `200` and
serves the new palette (`--bg:#fbfaf7` light, `#070b0e` dark). Nothing in this branch did
either of those things, and no gate below was opened by the review.

Visual approval does not change the remaining rows:

- It does not authorize writing production records, and it opens no variable. Both activation
  variables remain unset, and `firebase-sync.yml` on `main` still runs its write step only
  when `steps.gate.outputs.enabled == 'true'`.
- **One correction to earlier reporting:** production reads are not currently blocked. When
  this package was drafted the data plane returned `429 RESOURCE_EXHAUSTED`, but a scheduled
  run afterwards read production successfully. Its log reports `read 59 source records` from
  GitHub and then `skip 59 unchanged` — and a record can only be classified unchanged by
  comparing its `contentHash` against the stored document, which means all 59 Firestore
  documents were read from the `oqthara` project. A fresh unauthenticated probe now answers
  `403`, not `429`. So the state *can* be read; what remains outstanding is the
  document-level reconciliation plan, which is still unapproved.
- It does not make the credential-free dry run meaningful. That run has no credential, sees
  an empty mirror, and reports a plan that understates the change by the entire dataset.

## 8. How this package was verified

| Check | Command or method | Result |
| --- | --- | --- |
| 38 files present | `ls artifacts/visual-audit/*.png \| wc -l` | 38 |
| Duplicate content | `shasum -a 256 \| uniq -d` | 0 duplicates |
| Real dimensions | PNG IHDR read from each file | 22 at 2880×2000, 8 at 1536×2048, 8 at 780×1688 |
| Theme per file | decoded pixels, mean luminance | 18 dark, 20 light; all 38 agree with their filenames, and no light capture measures the retired `#ffffff` |
| Manifest describes disk | `node --test tests/site.test.js` | no undeclared files, no missing files |
| Every entry names a theme | `node --test tests/site.test.js` | 38/38 declared; fails if one is removed |
| Three viewports present | `node --test tests/site.test.js` | desktop, tablet, mobile |
| Capture reproducibility | two full runs, `shasum -a 256` compared | all 38 byte-identical |
| Collision guard intact | `node --test tests/site.test.js` | pass; `audit:visual` wrote only to `artifacts/visual-audit-routes/` |

Validation for the pull request that carries these changes:

| Check | Result |
| --- | --- |
| `npm test` | 302 tests, 298 pass, 4 skipped, 0 fail |
| `npm run build` | success, 10 static routes plus `404.html` prerendered |
| `npx playwright test` | 184 passed, 4 skipped (Chromium, 4 projects) |
| `npm run audit:visual` | 57/57 checks passed across 11 routes and 5 viewports |
| `npx html-validate "_site/*.html"` | no errors |
| `actionlint` | no findings |

**Firefox is NOT VERIFIED on macOS, and PASSES on Linux CI.** It fails to launch on macOS in
this environment with "Could not find profile folder", which reproduces outside Playwright, so
the failure is environmental rather than a test failure. On the GitHub-hosted `ubuntu-latest`
runner, `cross-browser` run `42387062654` reports Firefox 159.0 (playwright build `1572`) at
**92 passed, 2 skipped, 0 failed** — the same tally as the other three engines, 368 passed and
8 skipped across 376 tests. The two skips per engine are `e2e/live.spec.js`, gated on
`OQ_LIVE_DOCS=1`.

The local run above is Chromium only and is reported as such rather than presented as
cross-browser proof. Cross-browser coverage comes from CI; it is not claimed for this host.

Nothing in the table above is an aesthetic judgement.
