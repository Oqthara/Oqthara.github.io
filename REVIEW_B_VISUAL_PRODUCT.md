# Review B — Visual and product quality

Scope: the rendered pages themselves. Every finding below comes from a real Chromium render of
the built site, either a screenshot in `artifacts/visual-audit/` or a measurement taken from the
live DOM at one of the five required widths.

Viewports: 1440, 1024, 768, 390 and 320 CSS pixels.

---

## Findings

| # | Severity | Area | Finding | Status |
|---|----------|------|---------|--------|
| B1 | P1 | Documentation pages | `MarkdownWithToc` put `doc` and `doc-article` on **one** element, so `.doc-article .doc` — the selector the layout, three e2e specs and `assets/site.css` all rely on — matched nothing. The article lost its container and the table of contents did not sit beside the prose. | Fixed — `.doc` is nested inside `.doc-article`; the DOM contract is restored |
| B2 | P1 | Changelog | The page passed a document object where a Markdown string was expected, so the changelog rendered empty. | Fixed — `data.markdown` |
| B3 | P1 | Navigation | The mobile menu could not be opened reliably, and its closed state was still present in the accessibility tree and in computed-style scans. | Fixed — `aria-expanded` toggling, Escape to close, focus management, `display: none` when closed |
| B4 | P1 | Not Found | The shipped `not-found-desktop.png` was a capture of the local static server's own error page: white background, Times heading, no site chrome. The authentic 404 is dark, has 17 links, the site footer and a `<main>`. | Fixed — see Review A4; screenshot regenerated and visually confirmed |
| B5 | P2 | Documentation pages | Table-of-contents links were 16px tall with a 9.4px gap, below the WCAG 2.2 §2.5.8 minimum target size with no valid spacing exception. | Fixed — 25px tall, 4px gap, 0 target-circle overlaps |
| B6 | P2 | Code blocks | Oqthara fences were highlighted by a grammar that mis-tokenised the range operator (`1 to 5`) as a plain operator and broke on `**` exponentiation. | Fixed — `lookbehind` + `greedy` on the range operator; verified on the specification sample |

No P0 findings remain.

---

## What was inspected

Rendered pages: Home, Tour, Documentation index, a documentation page, Examples, an individual
example, Standard Library, Changelog, Status, Philosophy, and Not Found.

Screenshots reviewed at `artifacts/visual-audit/`: `home-desktop`, `home-mobile`,
`docs-desktop`, `docs-mobile`, `doc-page-code-highlighting`, `doc-page-mobile`,
`example-desktop`, `examples-desktop`, `stdlib-desktop`, `changelog-desktop`, `status-desktop`,
`philosophy-desktop`, `not-found-desktop`, `navigation-mobile-open`, `tour-desktop`, and
`firebase-content-loaded`.

---

## Verdict by area

**Navigation.** One header at every width. Below 768px the link list collapses behind a menu
button that reports `aria-expanded`, traps Escape, and returns focus. The open drawer is the only
element above the scrim, and the closed drawer is `display: none`, so it cannot receive focus or
be read by a screen reader. The skip link is the first focusable element on every page.

**Typography.** A single scale across all pages: an `h1` that is visibly larger and heavier than
`h2`, a prose measure that stays readable rather than spanning the full 1440px, and one body
face. Code uses a monospace stack at a consistent size, distinct from prose.

**Spacing and layout.** Every page shares the same outer container, gutter and vertical rhythm.
The documentation layout puts the table of contents beside the prose above 1024px and above the
prose below it, without a horizontal scrollbar at any width.

**Code readability.** Syntax highlighting is legible against both light surfaces and dark code
blocks. Token colours are distinguishable without relying on hue alone for structure. Code is
never reflowed — long lines scroll inside the block, so indentation is preserved exactly as
authored.

**Mobile usability.** At 390px and 320px there is no page-level horizontal overflow on any
route. Tap targets meet the 24px minimum. The longest unbreakable content — wide tables and long
code lines — scrolls within its own container.

**Page-to-page consistency.** Header, footer, focus ring, link colour, card treatment and code
styling are identical across the eleven pages. The 404 page is not an exception: it carries the
same header, footer and typography as the rest of the site, which is what made the original
capture obviously wrong.

---

## Residual notes

- The site is intentionally light-themed; there is no dark mode to audit.
- Content length varies with the canonical repository. Pages are designed to absorb that
  variation rather than to a fixed height, so the audit checks structure and overflow, not
  absolute page heights.
- `firebase-content-loaded.png` is a documentation page rendering from Firestore with the
  `data-source="firestore"` badge visible, which is the visual proof that the read path is not
  falling back to GitHub.
