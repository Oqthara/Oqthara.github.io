# Oqthara website

The public website for [Oqthara](https://github.com/Oqthara/oqthara), served from
**https://oqthara.github.io/**.

It is a React 19 application built by Vite and prerendered to static HTML, so every route
works with JavaScript disabled and `curl` sees real content. GitHub Pages hosts the built
output; there is no server.

## Run it

```bash
npm ci
npm run dev      # http://localhost:5173
```

## Build and check

```bash
npm test         # Node's built-in test runner, no DOM required
npm run build    # client build, SSR build, then prerender.mjs writes _site/
node verify.mjs  # structural checks over _site/
```

`npm run build` is `npm run build:app`: `vite build`, then
`vite build --ssr src/prerender-entry.jsx --outDir .ssr`, then `node prerender.mjs`.
The prerenderer writes the seven static routes (`index`, `tour`, `docs`, `examples`,
`stdlib`, `changelog`, `status`), the search index, `.nojekyll` and the hashed assets
into `_site/`.

## How it deploys

`.github/workflows/pages.yml` runs on every push to `main`, on pull requests that touch the
app, and on manual dispatch. The build job installs, tests, builds, verifies, validates the
HTML with `html-validate`, and uploads `_site/` as the Pages artifact. The deploy job
publishes through the `github-pages` environment and then smoke-tests the live URLs: every
route must return HTTP 200, the deep link must serve prerendered text, and the referenced
assets must load.

Pages is configured with **GitHub Actions** as its source, not a branch.

## Documentation sources

`docs/` in [Oqthara/oqthara](https://github.com/Oqthara/oqthara) is the only authoritative
documentation. This repository does not own it and must not fork it.

When a local `docs/` tree happens to be present (a developer checkout), `prerender.mjs`
renders those Markdown files into `docs/spec/*.html` and `docs/adr/*.html`. When it is
absent, the build still emits the seven static routes and the docs index lists its sections
with links back to the language repository. A later stage renders the authoritative
documentation from GitHub at runtime, replacing both the local rendering and the snapshot.

## Snapshots

Two files under `content/` are copies from the language repository:

- `content/changelog.md` — a snapshot of `CHANGELOG.md`. The changelog page labels itself
  as a snapshot. A later stage fetches the file from GitHub at runtime instead.
- `content/stdlib.md` — a snapshot of the generated standard library reference. The stdlib
  page is rendered from it.

These are refreshed by CI from the language repository; they are never edited by hand here.
