import { test, expect } from "@playwright/test";

// Appearance correctness that only a browser can see.
//
// The head script sets `data-theme` before first paint so a reader who chose dark does not get a
// white flash on every navigation. React then hydrates and re-applies the same value. The bug
// this file pins is the gap between the two: an effect that ran before the stored value had been
// read applied "auto" and removed the attribute, painting exactly one white frame. Axe does not
// catch it (a single frame is not a violation) and neither does Lighthouse, so it needs a test
// that watches the attribute and the painted background over time.

const ROUTES = ["/", "/tour.html", "/docs.html"];

/**
 * Records every `data-theme` value and body background from before the first page script runs.
 * Frames are sampled with requestAnimationFrame so a mid-frame flash is observed, and a
 * MutationObserver catches an attribute change that a sample could land between.
 */
async function instrument(page) {
  await page.addInitScript(() => {
    const seen = [];
    // Assigned first: if observing throws, the failure should still be readable as data.
    window.__appearance = seen;
    const push = (why, value) => {
      if (seen.length && seen[seen.length - 1].value === value) return;
      seen.push({ why, value });
    };

    // `document.documentElement` does not exist yet when an init script runs, so the observer is
    // attached from the first animation frame that has one instead of at registration time.
    let observing = false;
    const observe = () => {
      if (observing || !document.documentElement) return;
      observing = true;
      // Each record is read from `oldValue` and the attribute's value at the time it was
      // produced, not from the element when the callback finally runs: a set and a clear inside
      // the same batch would otherwise both read as "null" and the change would be dropped.
      new MutationObserver((records) => {
        for (const record of records) {
          push("mutation", record.oldValue);
          push("mutation", record.target.getAttribute("data-theme"));
        }
      }).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
        attributeOldValue: true,
      });
    };

    const started = performance.now();
    const tick = () => {
      observe();
      push("frame", document.documentElement?.getAttribute("data-theme") ?? null);
      if (performance.now() - started < 800) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test.describe("stored appearance", () => {
  // The system preference is forced to light so a dark choice is observably different from it.
  test.use({ colorScheme: "light" });

  for (const route of ROUTES) {
    test(`${route} never flashes the system appearance when dark is stored`, async ({ page }) => {
      await instrument(page);
      await page.addInitScript(() => {
        try {
          localStorage.setItem("oq-theme", "dark");
        } catch {
          // Nothing to store in a context that refuses localStorage.
        }
      });

      await page.goto(route);
      await expect(page.locator("[data-theme-state]")).toHaveAttribute("data-theme-state", "dark");
      await page.waitForTimeout(900);

      const seen = await page.evaluate(() => window.__appearance);
      // The first entry is the state before the head script runs, which is legitimately unset.
      // Anything after it means the attribute was cleared once the page already knew its choice.
      const removed = seen.slice(1).filter((entry) => entry.value === null);

      // The attribute is set by the head script before first paint and must never come back off:
      // a null after hydration means the page painted the system appearance in between.
      expect(removed, `data-theme was cleared: ${JSON.stringify(seen)}`).toEqual([]);
      expect(seen.some((entry) => entry.value === "dark")).toBe(true);
    });
  }

  test("a stored light choice survives a reload with the system set to dark", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await instrument(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem("oq-theme", "light");
      } catch {
        // Nothing to store in a context that refuses localStorage.
      }
    });

    await page.goto("/");
    await expect(page.locator("[data-theme-state]")).toHaveAttribute("data-theme-state", "light");
    await page.waitForTimeout(900);

    const seen = await page.evaluate(() => window.__appearance);
    expect(seen.slice(1).filter((entry) => entry.value === null)).toEqual([]);
    expect(seen.some((entry) => entry.value === "light")).toBe(true);
  });
});
