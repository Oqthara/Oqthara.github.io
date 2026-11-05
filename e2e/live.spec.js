import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

// Live checks against the real repository. They are serial because each one spends the same
// unauthenticated GitHub quota, and they only run when explicitly asked for.

test.describe.configure({ mode: "serial" });
test.skip(process.env.OQ_LIVE_DOCS !== "1", "Set OQ_LIVE_DOCS=1 to run live GitHub checks.");

const REPO = "Oqthara/oqthara";
const TREE_API = `https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`;

const DOC = (path, ref = "main") =>
  `/document.html?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`;

/** Optional credential: the browser tests authenticate api.github.com when one is available. */
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

test("live docs index count equals the repository tree", async ({ page, request }) => {
  const response = await request.get(TREE_API, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  expect(response.status()).toBe(200);
  const payload = await response.json();
  const expected = new Set(
    (payload.tree ?? [])
      .map((entry) => entry.path)
      .filter((path) => /^docs\/.+\.md$/i.test(path)),
  );
  expect(expected.size).toBeGreaterThan(0);

  await page.goto("/docs.html");
  await expect(page.locator(".doc-list a").first()).toBeVisible({ timeout: 25000 });
  const count = await page.locator(".doc-list a").count();
  expect(count).toBe(expected.size);
});

test("live alpha.1 and alpha.2 both render the language document", async ({ page }) => {
  for (const ref of ["v0.1.0-alpha.1", "v0.1.0-alpha.2"]) {
    await page.goto(DOC("docs/spec/language.md", ref));
    const prose = page.locator(".doc-article .doc").first();
    await expect(prose).toBeVisible({ timeout: 25000 });
    await expect(prose.locator("h1")).toBeVisible();
    const text = await prose.innerText();
    expect(text.length).toBeGreaterThan(100);
  }
});
