import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Browser tests against the real built site and the real Oqthara repository.
//
// Content is discovered from GitHub at runtime, so these tests wait for the rendered result
// (a document heading, an index entry) rather than for a network idle that may never settle.
// No assertion depends on wall-clock time.

const DOC = (path, ref = "main") =>
  `/document.html?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`;
const EXAMPLE = (path, ref = "main") =>
  `/example.html?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`;

const built404 = readFileSync(new URL("../_site/404.html", import.meta.url), "utf8");

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

/** The local Python server has no custom 404 handler, so serve the built 404 page for
 *  unknown paths exactly as GitHub Pages does. The page itself is the shipped artifact. */
async function serveBuilt404(page, pattern) {
  await page.route(pattern, (route) =>
    route.fulfill({ status: 404, contentType: "text/html; charset=utf-8", body: built404 }),
  );
}

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
    expect(await page.locator(".doc-list a").count()).toBeGreaterThanOrEqual(15);
    expect(await page.locator(".section-group").count()).toBeGreaterThanOrEqual(1);
    await expect(page.locator(".section-group h2").first()).toBeVisible();
  });

  test("5. a discovered document opens through the document route", async ({ page }) => {
    await openDocs(page);
    await page.locator(".doc-list a").first().click();
    await expect(page).toHaveURL(/\/document\.html\?path=.+&ref=/);
    await waitForArticle(page);
    await expect(article(page).locator("h1").first()).toBeVisible();
  });

  test("6. a document outside every site list opens directly", async ({ page }) => {
    await page.goto(DOC("docs/adr/0003-bytecode.md"));
    await waitForArticle(page);
    const text = await article(page).innerText();
    expect(text.length).toBeGreaterThan(200);
  });

  test("7. a directory-derived section appears in the index", async ({ page }) => {
    await openDocs(page);
    await expect(page.locator(".section-group h2", { hasText: "Decision records" })).toBeVisible();
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

  test("18. unknown routes render NotFound", async ({ page }) => {
    await serveBuilt404(page, "**/this-does-not-exist.html");
    await page.goto("/this-does-not-exist.html");
    await expect(page.locator("main h1").first()).toHaveText(/does not exist|not found/i);
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

  test("21. no uncaught exceptions or console errors across the routes", async ({ page }) => {
    const failures = [];
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      // A missing favicon is a server detail, not a page error.
      if (/favicon\.ico/i.test(text)) return;
      failures.push(`console: ${text}`);
    });

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
    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator("main")).toBeVisible();
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
    await serveBuilt404(page, "**/docs/spec/language.html");
    await page.goto("/docs/spec/language.html");
    await expect(page).toHaveURL(/\/document\.html\?path=docs%2Fspec%2Flanguage\.md/);
    await waitForArticle(page);
  });
});
