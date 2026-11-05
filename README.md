# Oqthara website

The website at <https://oqthara.github.io/>. A React 19 application, prerendered to static HTML
and served by GitHub Pages from the root of this repository.

Because the owning account is `Oqthara`, this is GitHub's *user site* repository: the site is
served from the domain root, not from an `/oqthara/` project path.

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

Nothing here is generated at build time from the language repository. The build is
deterministic and offline; every GitHub request happens in the reader's browser.

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

Three request kinds are made:

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

**Propagation delay: about ten minutes.** A documentation change merged into `main` is visible
without a site change, rebuild or redeploy, but not instantly: up to five minutes at the CDN and
up to five minutes in memory. A release channel reads its own tag and never follows `main`, so
a published manual is stable indefinitely.

Only discovery and the release list consume API quota, and both are cached for the session.
Document bodies come from the raw CDN, which has no API quota. A `403` or `429` is surfaced as a
typed error with `rateLimited: true`, and the UI says the limit was reached instead of showing a
generic failure.

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
src/use-docs.js           React data hooks
src/markdown-pipeline.js  remark/rehype configuration and sanitizer schema
src/components/           chrome, Markdown, code blocks, search
src/pages/                one component per route
prerender.mjs             writes the static routes and 404.html
verify.mjs                structural verification of _site/
```

## License

MIT, matching the language repository.
