import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

// Browser tests against the real built site and the real upstream content. These are live:
// they use whatever the production stack serves, with no fixtures and no interception.
//
// Which backend answers depends on the ref. `main` reads the Firestore mirror first and falls
// back to GitHub; a pinned tag can only come from GitHub, because the mirror holds `main`
// alone. So both paths are covered here, and the `data-source` badge is what reports which one
// actually answered. Tests wait for the rendered result (a document heading, an index entry)
// rather than for a network idle that may never settle. No assertion depends on wall-clock time.

const DOC = (path, ref = "main") =>
  `/document.html?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`;
const EXAMPLE = (path, ref = "main") =>
  `/example.html?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`;

/**
 * An optional credential for GitHub's API. The site fetches api.github.com unauthenticated,
 * which is limited to 60 requests an hour per address; a shared address can exhaust that.
 * When a token is available the tests still exercise the real site and real GitHub, they
 * just avoid the shared quota. Nothing is required: without a token they run anonymously.
 */
function githubToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const TOKEN = githubToken();

test.beforeEach(async ({ page }) => {
  if (!TOKEN) return;
  await page.route("https://api.github.com/**", (route) => {
    const headers = { ...route.request().headers(), authorization: `Bearer ${TOKEN}` };
    delete headers.host;
    return route.continue({ headers });
  });
});

/** The prose container. A document page nests `.doc-with-toc > .doc-article > .doc`, so the
 *  inner `.doc` is the element that actually holds the rendered Markdown. */
function article(page) {
  return page.locator(".doc-article .doc").first();
}

async function waitForDocsIndex(page) {
  await expect(page.locator(".doc-list a").first()).toBeVisible({ timeout: 25000 });
}

async function waitForArticle(page) {
  await expect(article(page)).toBeVisible({ timeout: 25000 });
  await expect(article(page).locator("h1, h2").first()).toBeVisible();
}

async function openDocs(page) {
  await page.goto("/docs.html");
  await waitForDocsIndex(page);
}

test.describe("site", () => {
  test("1. homepage loads with an h1 and no Playground", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect(page.getByText("Playground", { exact: false })).toHaveCount(0);
  });

  test("2. main navigation reaches each route and h1", async ({ page }) => {
    // The nav is inline above the 960px collapse point and behind the menu button below it, so
    // this traversal pins a desktop width. Test 3 covers the collapsed menu at a phone width.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" });
    const destinations = [
      { link: "Docs", path: "/docs.html", heading: /Documentation/i },
      { link: "Examples", path: "/examples.html", heading: /Examples/i },
      { link: "Philosophy", path: "/philosophy.html", heading: /trying to be/i },
      { link: "Changelog", path: "/changelog.html", heading: /Changelog/i },
      { link: "Status", path: "/status.html", heading: /What works/i },
    ];
    for (const destination of destinations) {
      await nav.getByRole("link", { name: destination.link, exact: false }).click();
      await expect(page).toHaveURL(new RegExp(`${destination.path.replace(/[.]/g, "\\.")}$`));
      await expect(page.locator("main h1").first()).toHaveText(destination.heading);
    }
  });

  test("3. mobile navigation hides the nav and the menu button reveals it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" });
    const toggle = page.locator(".nav-toggle");
    await expect(nav).not.toBeVisible();
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(nav).toBeVisible();
    await nav.getByRole("link", { name: "Docs", exact: false }).click();
    await expect(page).toHaveURL(/\/docs\.html$/);
    await expect(page.locator("main h1").first()).toHaveText(/Documentation/i);
  });

  test("4. documentation index is discovered from GitHub and grouped", async ({ page }) => {
    await openDocs(page);
    expect(await page.locator(".doc-list a").count()).toBeGreaterThanOrEqual(10);
    expect(await page.locator(".section-group").count()).toBeGreaterThanOrEqual(1);
    await expect(page.locator(".section-group h2").first()).toBeVisible();
  });

  test("5. a discovered document opens through the document route", async ({ page }) => {
    await openDocs(page);
    await page.locator(".doc-list a").first().click();
    await expect(page).toHaveURL(/\/document\.html\?path=.+&ref=/);
    await waitForArticle(page);
    await expect(page.locator("main h1").first()).toBeVisible();
    await expect(article(page).locator("h2").first()).toBeVisible();
  });

  test("6. a document outside every site list opens directly", async ({ page }) => {
    // A published document that no index route links to still renders at its own address.
    await page.goto(DOC("docs/spec/states/04-unified.md"));
    await waitForArticle(page);
    const text = await article(page).innerText();
    expect(text.length).toBeGreaterThan(200);
  });

  // Development documentation lives on GitHub, next to the commits it describes. Accepting a
  // decision record here would publish 47 of them, so the boundary gets its own assertion rather
  // than trusting the allowlist to hold by accident.
  test("6b. development documentation is refused with an explanation", async ({ page }) => {
    await page.goto(DOC("docs/adr/0003-bytecode.md"));
    await expect(page.locator(".status-block[role=alert]")).toBeVisible({ timeout: 25000 });
    await expect(page.locator(".status-block[role=alert]")).toContainText("not published here");
  });

  test("7. a directory-derived section appears in the index", async ({ page }) => {
    await openDocs(page);
    await expect(page.locator(".section-group h2", { hasText: "Specification" })).toBeVisible();
  });

  test("8. relative Markdown links resolve to canonical document routes", async ({ page }) => {
    // docs/README.md carries no relative Markdown links; docs/spec/language.md links to
    // backend.md and fuzzing.md, which is what this rule is about.
    await page.goto(DOC("docs/spec/language.md"));
    await waitForArticle(page);
    const hrefs = await article(page).locator("a").evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute("href") ?? ""),
    );
    const canonical = hrefs
      .filter((href) => href.startsWith("/document.html?"))
      .map((href) => new URL(href, "http://site.local"))
      .filter((url) => (url.searchParams.get("path") ?? "").startsWith("docs/"));
    expect(canonical.length).toBeGreaterThan(0);
    expect(canonical.every((url) => !url.searchParams.get("path").endsWith(".html"))).toBe(true);
  });

  test("9. table of contents anchors scroll to a real target", async ({ page }) => {
    await page.goto(DOC("docs/spec/language.md"));
    await waitForArticle(page);
    const tocLinks = page.locator(".toc a");
    expect(await tocLinks.count()).toBeGreaterThan(0);
    const first = tocLinks.first();
    const href = await first.getAttribute("href");
    expect(href?.startsWith("#")).toBe(true);
    await first.click();
    await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    const id = href.slice(1);
    await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
  });

  test("10. the release channel changes the Git ref in the URL", async ({ page }) => {
    await page.goto("/docs.html");
    const select = page.locator("#channel-select");
    await expect(select).toBeVisible({ timeout: 25000 });
    const values = await select.locator("option").evaluateAll((options) =>
      options.map((option) => option.value),
    );
    expect(values.length).toBeGreaterThan(1);
    expect(values).toContain("v0.1.0-alpha.2");
    await select.selectOption("v0.1.0-alpha.2");
    await expect(page).toHaveURL(/ref=v0\.1\.0-alpha\.2/);
  });

  test("11. pinned alpha.1 and alpha.2 render different documents", async ({ page }) => {
    // Two pinned tags, each fetched from GitHub rather than the mirror, and each waited on for up
    // to 25s. The 30s default cannot cover two of those waits in sequence: this test was failing
    // intermittently at the full 25s while the same commit passed on a rerun. The budget is
    // raised rather than the wait shortened, because the wait is what distinguishes "GitHub is
    // slow" from "the pinned ref did not render".
    test.slow();
    await page.goto(DOC("docs/spec/language.md", "v0.1.0-alpha.1"));
    await waitForArticle(page);
    const alphaOne = await article(page).innerText();

    await page.goto(DOC("docs/spec/language.md", "v0.1.0-alpha.2"));
    await waitForArticle(page);
    const alphaTwo = await article(page).innerText();

    expect(alphaOne.length).toBeGreaterThan(100);
    expect(alphaTwo.length).toBeGreaterThan(100);
    expect(alphaOne.length).not.toBe(alphaTwo.length);
  });

  test("12. changelog renders release headings", async ({ page }) => {
    await page.goto("/changelog.html");
    await expect(
      page.locator("main h2", { hasText: /0\.1\.0-alpha/ }).first(),
    ).toBeVisible({ timeout: 25000 });
  });

  test("13. standard library renders a table", async ({ page }) => {
    await page.goto("/stdlib.html");
    await expect(page.locator("main table").first()).toBeVisible({ timeout: 25000 });
  });

  test("14. examples are discovered from the repository tree", async ({ page }) => {
    await page.goto("/examples.html");
    await expect(page.locator(".example-card").first()).toBeVisible({ timeout: 25000 });
    expect(await page.locator(".example-card").count()).toBeGreaterThanOrEqual(30);
  });

  test("15. opening an example fetches its source", async ({ page }) => {
    await page.goto("/examples.html");
    await expect(page.locator(".example-card").first()).toBeVisible({ timeout: 25000 });
    await page.locator(".example-card").first().click();
    await expect(page).toHaveURL(/\/example\.html\?path=.+&ref=/);
    const code = page.locator(".code-block pre").first();
    await expect(code).toBeVisible({ timeout: 25000 });
    const text = await code.innerText();
    expect(text.split("\n").filter((line) => line.trim() !== "").length).toBeGreaterThan(3);
  });

  test("16. philosophy renders docs/spec/design.md", async ({ page }) => {
    await page.goto("/philosophy.html");
    await expect(
      page.locator('.doc-source a[href*="docs/spec/design.md"]').first(),
    ).toBeVisible({ timeout: 25000 });
    expect(
      await page.locator(".doc-article h1, .doc-article h2, .doc-article h3").count(),
    ).toBeGreaterThan(0);
  });

  test("17. search finds dynamically discovered documents", async ({ page }) => {
    // The search index is discovered from the repository at runtime, so this test waits on a
    // network read before it can type into the box. `test.slow()` triples the budget for the
    // same reason as test 11.
    test.slow();
    await openDocs(page);
    const input = page.locator("#site-search");
    await expect(input).toBeVisible();
    await input.fill("bytecode");
    const results = page.locator(".search-results a");
    await expect(results.first()).toBeVisible({ timeout: 15000 });
    const hrefs = await results.evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute("href") ?? ""),
    );
    expect(hrefs.some((href) => href.includes("/document.html"))).toBe(true);
  });

  test("18. unknown routes serve the built 404 page with a 404 status", async ({ page }) => {
    // GitHub Pages answers unknown paths with 404.html, so the response status and the page
    // body must both be the real ones — not a fallback injected by the test.
    const response = await page.goto("/this-does-not-exist.html");
    expect(response.status()).toBe(404);
    await expect(page.locator("main h1").first()).toHaveText(/does not exist|not found/i);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("footer")).toBeVisible();
    await expect(page).toHaveTitle(/Oqthara/);
  });

  test("19. a valid documentation URL never renders NotFound", async ({ page }) => {
    await page.goto(DOC("docs/spec/language.md"));
    await waitForArticle(page);
    await expect(page.locator("main h1").first()).not.toHaveText(/does not exist/i);
  });

  test("20. refreshing a document URL keeps rendering it", async ({ page }) => {
    await page.goto(DOC("docs/spec/language.md"));
    await waitForArticle(page);
    await page.reload();
    await waitForArticle(page);
    await page.reload();
    await waitForArticle(page);
  });

  test("21. no uncaught exceptions or console errors across the routes", async ({ browser }) => {
    // Ten routes, each in its own context and each given a settle window for backend reads, so
    // this test spends most of its time waiting on purpose. The 30s default covers a single page
    // and is not enough here: WebKit, the slowest engine, hit it while still inside the settle
    // window on the last route. The budget is raised rather than the settle shortened, because
    // the settle is what makes a failed read report against the route that caused it.
    test.slow();
    const routes = [
      "/",
      "/philosophy.html",
      "/tour.html",
      "/docs.html",
      DOC("docs/spec/language.md"),
      "/examples.html",
      EXAMPLE("examples/hello.oq"),
      "/stdlib.html",
      "/changelog.html",
      "/status.html",
    ];
    // Each route gets its own context. Reusing one page means leaving the previous document,
    // and WebKit reports the teardown of the SDK's long-lived Firestore Listen channel as a
    // cross-origin `pageerror` naming the request URL. That is transport noise from the walk
    // itself, not a defect in the page, and it cannot be fixed from application code: the site
    // issues only one-shot getDocs/getDoc reads and owns no listener to close. A fresh context
    // per route measures what this test is for -- the errors a visitor actually causes by
    // loading a page -- rather than the errors caused by abandoning one.
    const failures = [];
    for (const route of routes) {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on("pageerror", (error) => failures.push(`${route} pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        // A missing favicon is a server detail, not a page error.
        if (/favicon\.ico/i.test(text)) return;
        failures.push(`${route} console: ${text}`);
      });

      await page.goto(route);
      await expect(page.locator("main")).toBeVisible();
      // Let backend reads land so a failure would be reported against this route, not the next.
      await page.waitForTimeout(2500);
      await context.close();
    }
    expect(failures).toEqual([]);
  });

  test("22. no unexpected same-origin 404 responses", async ({ page }) => {
    const missing = [];
    page.on("response", (response) => {
      if (response.status() !== 404) return;
      const url = new URL(response.url());
      if (url.origin !== "http://127.0.0.1:8811") return;
      if (url.pathname === "/favicon.ico") return;
      missing.push(url.pathname);
    });

    for (const route of [
      "/",
      "/philosophy.html",
      "/tour.html",
      "/docs.html",
      "/examples.html",
      "/stdlib.html",
      "/changelog.html",
      "/status.html",
    ]) {
      await page.goto(route);
      await expect(page.locator("main")).toBeVisible();
    }
    await page.goto(DOC("docs/spec/language.md"));
    await waitForArticle(page);
    await page.goto(EXAMPLE("examples/hello.oq"));
    await expect(page.locator("main")).toBeVisible();
    expect(missing).toEqual([]);
  });

  test("23. Markdown never emits an unsafe URL", async ({ page }) => {
    await page.goto(DOC("docs/spec/language.md"));
    await waitForArticle(page);
    const unsafe = await article(page)
      .locator("a, img")
      .evaluateAll((nodes) =>
        nodes
          .map((node) => node.getAttribute("href") ?? node.getAttribute("src") ?? "")
          .filter((value) => /^(javascript|data|vbscript):/i.test(value.trim())),
      );
    expect(unsafe).toEqual([]);
  });

  test("24. legacy document URLs redirect to the canonical route", async ({ page }) => {
    await page.goto("/docs/spec/language.html");
    await expect(page).toHaveURL(/\/document\.html\?path=docs%2Fspec%2Flanguage\.md/);
    await waitForArticle(page);
  });

  // Which backend answers is a production property, not a detail: `main` should come from the
  // mirror, a pinned tag must come from GitHub. Asserting it here means a misconfigured mirror
  // shows up as a test failure instead of silently degrading to GitHub and looking healthy.
  test("25. main is served by the mirror and a pinned tag by GitHub", async ({ page }) => {
    // Two full page loads, one of which waits on GitHub for a pinned tag, inside a 30s default.
    // It failed at 25s on one run and passed on the immediate rerun of the same commit.
    test.slow();
    await page.goto(DOC("docs/spec/language.md"));
    await waitForArticle(page);
    await expect(page.locator(".content-source").first()).toHaveAttribute("data-source", "firestore");

    await page.goto(DOC("docs/spec/language.md", "v0.1.0-alpha.2"));
    await waitForArticle(page);
    await expect(page.locator(".content-source").first()).toHaveAttribute("data-source", "github");
  });
});
