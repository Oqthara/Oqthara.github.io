import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// WCAG 2.2 AA, checked against the rendered result rather than the source.
//
// Lighthouse already scores these routes 100, but Lighthouse samples one viewport with its own
// reduced audit set and never opens a document or an example. These tests cover both themes, a
// mobile width, and the two content routes that only exist at runtime.

const STATIC_ROUTES = [
  "/",
  "/philosophy.html",
  "/tour.html",
  "/docs.html",
  "/examples.html",
  "/stdlib.html",
  "/changelog.html",
  "/status.html",
];

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

function summarise(violations) {
  return violations
    .map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0]?.target?.join(" ")}`)
    .join("\n");
}

async function scan(page) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return violations;
}

/**
 * Waits for the stored appearance to be in effect.
 *
 * The attribute is set by the head script before first paint, then re-applied by React after
 * hydration. Scanning in between would audit the system appearance while claiming to audit the
 * chosen one, which is how a theme-specific contrast failure can pass unnoticed.
 */
async function settleTheme(page, theme) {
  await page.waitForFunction((value) => document.documentElement.getAttribute("data-theme") === value, theme);
  await expect(page.locator("[data-theme-state]")).toHaveAttribute("data-theme-state", theme);
}

for (const theme of ["light", "dark"]) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem("oq-theme", value), theme);
    });

    for (const route of STATIC_ROUTES) {
      test(`${route} has no WCAG 2.2 AA violations`, async ({ page }) => {
        await page.goto(route);
        await settleTheme(page, theme);
        const violations = await scan(page);
        expect(violations.length, summarise(violations)).toBe(0);
      });
    }
  });
}

for (const theme of ["light", "dark"]) {
  test.describe(`${theme} theme: runtime content routes`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem("oq-theme", value), theme);
    });

    test("a document page has no violations", async ({ page }) => {
      await page.goto("/document.html?path=docs%2Fspec%2Flanguage.md&ref=main");
      await expect(page.locator(".doc-article .doc").first()).toBeVisible({ timeout: 25000 });
      await settleTheme(page, theme);
      const violations = await scan(page);
      expect(violations.length, summarise(violations)).toBe(0);
    });

    test("an example page has no violations", async ({ page }) => {
      await page.goto("/example.html?path=examples%2Fhello.oq&ref=main");
      await expect(page.locator("pre code").first()).toBeVisible({ timeout: 25000 });
      await settleTheme(page, theme);
      const violations = await scan(page);
      expect(violations.length, summarise(violations)).toBe(0);
    });
  });
}

for (const theme of ["light", "dark"]) {
  test.describe(`mobile width, ${theme} theme`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem("oq-theme", value), theme);
    });

    test("the homepage has no violations and does not scroll sideways", async ({ page }) => {
      await page.goto("/");
      await settleTheme(page, theme);
      const violations = await scan(page);
      expect(violations.length, summarise(violations)).toBe(0);
      const overflow = await page.evaluate(() =>
        Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      );
      expect(overflow, "page must not scroll horizontally at 390px").toBe(0);
    });

    test("the navigation opens and its links are reachable", async ({ page }) => {
      await page.goto("/");
      const toggle = page.getByRole("button", { name: /open navigation/i });
      await toggle.click();
      await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
      const violations = await scan(page);
      expect(violations.length, summarise(violations)).toBe(0);
    });
  });
}
