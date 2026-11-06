import { test, expect } from "@playwright/test";

// Deterministic tests. Every GitHub response comes from a fixture; nothing here leaves the
// machine, so these tests prove the discovery rules without depending on the live repository.

const DOC = (path, ref = "main") =>
  `/document.html?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`;

function treePayload(paths) {
  return {
    sha: "fixture-tree",
    truncated: false,
    tree: paths.map((path) => ({ path, type: "blob", mode: "100644", size: 128 })),
  };
}

const RELEASES = [
  {
    tag_name: "v0.2.0",
    name: "v0.2.0",
    draft: false,
    prerelease: false,
    published_at: "2026-10-01T00:00:00Z",
  },
  {
    tag_name: "v0.2.0-rc.1",
    name: "v0.2.0-rc.1",
    draft: false,
    prerelease: true,
    published_at: "2026-09-01T00:00:00Z",
  },
  {
    tag_name: "v0.3.0-draft",
    name: "v0.3.0-draft",
    draft: true,
    prerelease: false,
    published_at: "2026-11-01T00:00:00Z",
  },
  {
    tag_name: "v0.1.0",
    name: "v0.1.0",
    draft: false,
    prerelease: false,
    published_at: "2026-08-01T00:00:00Z",
  },
];

const BASE_TREE = [
  "docs/README.md",
  "docs/spec/language.md",
  "docs/spec/design.md",
  "docs/guides/new.md",
];

/**
 * Installs deterministic GitHub routes. `settings.treeStatus` and `settings.rawStatus` can be
 * changed between interactions to model a later failure.
 */
async function mockGithub(page, state = {}) {
  const settings = {
    tree: BASE_TREE,
    treeStatus: 200,
    treeBody: null,
    releases: RELEASES,
    raw: {
      "docs/guides/new.md":
        "# Brand new guide\n\nThis body came from a mocked raw file.\n\n## Details\n\nDynamic content.",
      "docs/README.md":
        "# Documentation\n\nSee the [language spec](spec/language.md) and the [guide](guides/new.md).\n",
      "docs/spec/language.md": "# Language\n\n## Syntax\n\nA specification body with enough prose to render.",
      "docs/spec/design.md": "# Design\n\n## Goals\n\nMocked design content.\n",
    },
    ...state,
  };
  state.settings = settings;

  await page.route("https://api.github.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/git/trees/")) {
      if (settings.treeStatus !== 200) {
        return route.fulfill({
          status: settings.treeStatus,
          contentType: "application/json",
          body: JSON.stringify({
            message:
              settings.treeStatus === 403
                ? "API rate limit exceeded for 203.0.113.9."
                : "Tree unavailable",
          }),
          headers: { "x-ratelimit-remaining": settings.treeStatus === 403 ? "0" : "42" },
        });
      }
      const body = settings.treeBody ?? JSON.stringify(treePayload(settings.tree));
      return route.fulfill({ status: 200, contentType: "application/json", body });
    }
    if (url.pathname.includes("/releases")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(settings.releases),
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.route("https://raw.githubusercontent.com/**", async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split("/").filter(Boolean);
    const repoPath = decodeURIComponent(parts.slice(3).join("/"));
    if (settings.rawStatus && settings.rawStatus !== 200) {
      return route.fulfill({ status: settings.rawStatus, body: "Not Found" });
    }
    const body = settings.raw[repoPath];
    if (body == null) return route.fulfill({ status: 404, body: "Not Found" });
    return route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body });
  });
}

/** The prose container. `.doc-article` wraps the rendered `.doc`, so the inner node holds the text. */
function article(page) {
  return page.locator(".doc-article .doc").first();
}

/**
 * Backdates every persisted content entry so the next read counts as stale.
 *
 * The cache serves a fresh entry without revalidating it, which is what stops a reading session
 * from burning the unauthenticated quota. A test about stale-content behaviour has to start
 * from an aged entry, otherwise the refresh it expects never happens. The age is past the
 * five-minute freshness window but inside the thirty-minute persistence window, so the entry is
 * still restored and then revalidated.
 */
async function agePersistedCache(page) {
  await page.evaluate(() => {
    const aged = Date.now() - 10 * 60 * 1000;
    for (const key of Object.keys(window.sessionStorage)) {
      if (!key.startsWith("oq-cache:")) continue;
      const entry = JSON.parse(window.sessionStorage.getItem(key));
      window.sessionStorage.setItem(key, JSON.stringify({ ...entry, at: aged }));
    }
  });
}

test.describe("mocked GitHub discovery", () => {
  test("a brand-new directory becomes a section without a site change", async ({ page }) => {
    await mockGithub(page);
    await page.goto("/docs.html");
    await expect(page.locator(".section-group h2", { hasText: "Guides" })).toBeVisible();
    await expect(page.locator('.doc-list a[href*="docs%2Fguides%2Fnew.md"]')).toBeVisible();
  });

  test("a document in the mocked tree opens and renders its mocked body", async ({ page }) => {
    await mockGithub(page);
    await page.goto(DOC("docs/guides/new.md"));
    await expect(article(page)).toContainText("This body came from a mocked raw file.");
    // The document heading is an h2: the page owns the only h1.
    await expect(article(page).locator("h2").first()).toHaveText(/Brand new guide/i);
  });

  test("a document states where its content came from", async ({ page }) => {
    await mockGithub(page);
    await page.goto(DOC("docs/guides/new.md"));
    await expect(article(page)).toBeVisible();
    // The provenance badge renders from the same state the page reads. With Firestore
    // unavailable this build falls back to GitHub, and the badge has to say so rather than
    // leaving a reader to guess which backend answered.
    await expect(page.locator('.content-source[data-source="github"]')).toBeVisible();
  });

  test("releases hide drafts, include prereleases and stable, newest first", async ({ page }) => {
    await mockGithub(page);
    await page.goto("/docs.html");
    const select = page.locator("#channel-select");
    await expect(select).toBeVisible();
    const values = await select.locator("option").evaluateAll((options) =>
      options.map((option) => option.value),
    );
    expect(values).not.toContain("v0.3.0-draft");
    expect(values).toContain("v0.2.0-rc.1");
    expect(values).toContain("v0.2.0");
    expect(values).toContain("v0.1.0");
    expect(values.indexOf("v0.2.0")).toBeLessThan(values.indexOf("v0.1.0"));
  });

  test("a tree 500 shows an error state and a retry control that recovers", async ({ page }) => {
    const state = {};
    await mockGithub(page, state);
    state.settings.treeStatus = 500;
    await page.goto("/docs.html");

    await expect(page.locator('[role="alert"]')).toBeVisible();
    await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();
    await expect(page.locator(".empty-state")).toHaveCount(0);

    state.settings.treeStatus = 200;
    await page.getByRole("button", { name: /try again/i }).click();
    await expect(page.locator(".doc-list a").first()).toBeVisible();
  });

  // A channel switch is an in-app navigation, so the hooks stay mounted: the previous list must
  // remain on screen while the new ref loads, and a failure must not blank it.
  test(
    "an already-rendered list survives a failed refresh",
    async ({ page }) => {
      const state = {};
      await mockGithub(page, state);
      await page.goto("/docs.html");
      await expect(page.locator(".doc-list a").first()).toBeVisible();

      state.settings.treeStatus = 500;
      // There is no in-page reload path; the closest affordance navigates away.
      await page.locator("#channel-select").selectOption("v0.2.0");
      await expect(page.locator('[role="alert"]')).toBeVisible();
      await expect(page.locator(".doc-list a").first()).toBeVisible();
    },
  );

  test("malformed tree JSON shows an error state, not an empty index", async ({ page }) => {
    const state = {};
    await mockGithub(page, state);
    state.settings.treeBody = "{not json";
    await page.goto("/docs.html");
    await expect(page.locator('[role="alert"]')).toBeVisible();
    await expect(page.locator(".empty-state")).toHaveCount(0);
  });

  test("a raw file 404 shows an error with a link to GitHub", async ({ page }) => {
    const state = {};
    await mockGithub(page, state);
    state.settings.rawStatus = 404;
    await page.goto(DOC("docs/guides/new.md"));
    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert.locator('a[href*="github.com"]').first()).toBeVisible();
  });

  // A document already read is kept in sessionStorage, so a reload after the source starts
  // failing still renders the saved text and says the refresh failed.
  //
  // The saved entry is aged past `CACHE_TTL_MS` first: a fresh entry is served without any
  // request at all, so there would be nothing to fail and no note to render.
  test("a cached document stays visible when a later refresh fails", async ({ page }) => {
    const state = {};
    await mockGithub(page, state);
    await page.goto(DOC("docs/guides/new.md"));
    await expect(article(page)).toContainText("This body came from a mocked raw file.");

    await agePersistedCache(page);
    state.settings.rawStatus = 500;
    await page.reload();
    await expect(article(page)).toContainText("This body came from a mocked raw file.");
    await expect(page.locator(".stale-note")).toBeVisible();
  });

  test("a 403 tree response names the rate limit", async ({ page }) => {
    const state = {};
    await mockGithub(page, state);
    state.settings.treeStatus = 403;
    await page.goto("/docs.html");
    await expect(page.locator('[role="alert"]')).toContainText(/rate limit/i);
  });
});
