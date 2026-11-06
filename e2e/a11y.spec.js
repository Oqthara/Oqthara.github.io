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

// Three defects that axe cannot see, because each one is about what the markup *says* once it
// is rendered rather than whether it breaks a rule.
test.describe("structure that assistive technology depends on", () => {
  test("a document page shows its own title as a visible heading", async ({ page }) => {
    await page.goto("/document.html?path=docs%2Fspec%2Fbackend.md&ref=main");
    const heading = page.locator("h1.doc-title");
    await expect(heading).toBeVisible({ timeout: 25000 });
    await expect(heading).toHaveText("Backend status and limitations");
    // A heading that exists but is clipped to 1px is not a title a reader can see.
    const box = await heading.boundingBox();
    expect(box.height).toBeGreaterThan(24);
  });

  test("a documentation index link is named by its title alone", async ({ page }) => {
    await page.goto("/docs.html");
    const snapshot = await page.locator(".doc-list").first().ariaSnapshot();
    // "Documentationdocs/README.md" was the old name: no separator, so the path ran into the
    // title. The path stays on screen, it just is not part of the name.
    expect(snapshot).toContain('link "Documentation"');
    expect(snapshot).not.toContain("Documentationdocs/");
    await expect(page.locator(".doc-list .doc-path").first()).toBeVisible();
  });

  test("header controls are big enough to hit on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("header a, header button, header input")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        // WCAG 2.2 AA asks for 24x24 (2.5.8); 44x44 is the comfortable target the site aims at.
        if (r.width < 44 || r.height < 44) {
          out.push(`${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      return out;
    });
    expect(small, "every header control must be at least 44x44 on a phone").toEqual([]);
  });
});
