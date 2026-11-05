# Oqthara website

The website at <https://oqthara.github.io/>. A React 19 application, prerendered to static
HTML and served by GitHub Pages from this repository's root.

Because the owning account is `Oqthara`, this is GitHub's *user site* repository: the site
is served from the domain root, not from a `/oqthara/` project path.

## Documentation is not stored here

`Oqthara/oqthara` holds the only authoritative documentation. This repository keeps no copy
of any specification, decision record, generated reference or changelog. A documentation
page fetches its Markdown from GitHub when a reader opens it.

- **Development** reads the `main` branch, so a documentation change merged into `main`
  appears here with no site change, rebuild or redeploy.
- **A release channel** reads its own tag, so a released manual stays exactly as it was
  even after `main` moves on.

The page's source link always points at the GitHub blob it came from.

### Propagation delay

A merged documentation change is visible within about **ten minutes**: GitHub's raw
endpoint serves `cache-control: max-age=300` (five minutes), and this site holds each
document in memory for five minutes (`CACHE_TTL_MS` in `src/github-docs.js`). Refresh
happens in the background and the previously rendered text stays on screen, so a slow
network never blanks a page that already loaded.

### Discoverability

`docs/catalog.json` in the language repository lists every document. It is generated and
validated there by `scripts/gen-docs-catalog.py`. Adding a document to that repository adds
it here without editing this repository.

### Trade-off, stated plainly

Rendering documentation in the browser is **not** server rendering. A documentation page
arrives as a shell with navigation and a loading state; the document text appears after the
fetch. Search engines and readers without JavaScript see the shell plus a direct link to
the canonical GitHub file, not the rendered document. That is the price of keeping exactly
one source of truth without a build step that reads another repository.

## Development

```bash
npm ci
npm run dev        # local server
npm test           # unit and integration tests (no network)
npm run build      # prerender the static routes into _site/
node verify.mjs    # structural checks over _site/
```

A real-source check is available and skipped by default:

```bash
OQ_LIVE_DOCS=1 npm test
```

It fetches the production URLs and asserts the catalog, the specification and a pinned tag
all resolve.

## Releasing a documentation channel

```bash
npm run refresh:releases
```

This rewrites `releases.json` from the GitHub releases API and is also runnable by hand. It
never runs during a build: adding or removing a channel is a reviewable change.

## Deployment

`.github/workflows/pages.yml` builds, tests, verifies, validates the HTML and publishes
`_site/` with GitHub Actions Pages, then smoke-tests every route over the network. Publishing
requires Pages to be configured with **GitHub Actions** as its source, not a branch.

## Structure

```
src/source.js             every GitHub URL, channel lookup and link resolver
src/github-docs.js        fetching, caching, validation, typed errors
src/use-docs.js           React data hooks used by the documentation pages
src/markdown-pipeline.js  remark/rehype configuration and sanitizer schema
src/components/           shared chrome, the Markdown component, playground
src/pages/                one component per route
prerender.mjs             writes the static routes and documentation shells
verify.mjs                structural verification of _site/
```

Markdown is rendered through `react-markdown` to React elements, so no Markdown is ever
inserted with `dangerouslySetInnerHTML`. Raw HTML is parsed by `rehype-raw` and then
sanitized by `rehype-sanitize`; `href` and `src` are restricted to `http`, `https` and
`mailto`, which removes `javascript:`, `data:` and `vbscript:` before a link is created.

## License

MIT, matching the language repository.
