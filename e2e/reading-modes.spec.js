import { test, expect } from "@playwright/test";

// Reading modes that no other spec exercises: keyboard-only navigation, reduced motion,
// forced colours, printing, and the states a page reaches when its backends are unavailable.
//
// These are not aesthetic checks. Each one asserts something a reader would lose if the
// behaviour regressed, and each is written so that removing the corresponding rule in
// `assets/site.css` fails it.

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

// Safari (and therefore WebKit) does not put links in the Tab order by default: Tab visits only
// form controls, and Option+Tab walks every focusable element. That is a documented browser
// convention, not a defect in this site, so the keyboard tests press whichever chord the engine
// actually uses for a full traversal instead of failing Safari for honouring its own model.
function traversalKey(browserName) {
  return browserName === "webkit" ? "Alt+Tab" : "Tab";
}

// --------------------------------------------------------------------------- keyboard only

test.describe("keyboard only", () => {
  test("the skip link is the first stop and it moves focus into the document", async ({
    page,
    browserName,
  }) => {
    await page.goto("/");

    await page.keyboard.press(traversalKey(browserName));
    await expect(page.locator(":focus")).toHaveClass(/skip-link/);

    await page.keyboard.press("Enter");
    await expect(page.locator(":focus")).toHaveAttribute("id", "main");
  });

  test("every header control is reachable by Tab and is focusable", async ({ page, browserName }) => {
    // This is the desktop traversal, so it pins a desktop width rather than inheriting the
    // project viewport. At a phone width the nav collapses behind the menu button and this
    // count would legitimately be smaller; the mobile test below covers that case.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");

    const key = traversalKey(browserName);
    // Derive the expectation from the rendered header instead of hard-coding a number, so adding
    // or renaming a nav item cannot quietly weaken this test.
    const expected = await page.evaluate(() => {
      const header = document.querySelector(".site-header");
      const visible = (el) => el.getClientRects().length > 0;
      return [...header.querySelectorAll("a, button, input")].filter(visible).length;
    });
    expect(expected).toBeGreaterThanOrEqual(10);

    const reached = [];
    for (let i = 0; i < 16; i += 1) {
      await page.keyboard.press(key);
      const descriptor = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return {
          tag: el.tagName.toLowerCase(),
          aria: el.getAttribute("aria-label"),
          inHeader: Boolean(el.closest(".site-header")),
          formControl: el.matches("a, button, input, select, textarea"),
        };
      });
      if (!descriptor) break;
      // The traversal deliberately starts before the header (the skip link is first), and once it
      // leaves the header for the page body this test is measuring something else.
      if (!descriptor.inHeader && reached.some((r) => r.inHeader)) break;
      reached.push(descriptor);
    }

    const headerControls = reached.filter((r) => r.inHeader);
    expect(headerControls.length).toBe(expected);
    expect(headerControls.every((r) => r.formControl)).toBe(true);
    expect(reached.some((r) => r.tag === "input")).toBe(true);
    expect(reached.some((r) => !r.inHeader)).toBe(true);
    // The menu toggle is display:none above the 960px collapse point, so it is correctly absent
    // from this desktop traversal; the mobile test below covers it at a phone width.
  });

  test("the mobile menu is operable without a pointer", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    // The accessible name flips between "Open navigation" and "Close navigation", so the toggle
    // is addressed by its stable class rather than by the name it currently happens to have.
    const toggle = page.locator(".nav-toggle");
    await expect(toggle).toHaveAttribute("aria-label", "Open navigation");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveAttribute("aria-label", "Close navigation");

    await page.keyboard.press("Escape");
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

// --------------------------------------------------------------------------- reduced motion

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("transitions are removed, not merely shortened", async ({ page }) => {
    await page.goto("/");

    const durations = await page.evaluate(() => {
      const pick = (selector) => {
        const el = document.querySelector(selector);
        return el ? getComputedStyle(el).transitionDuration : "0s";
      };
      return {
        card: pick(".card"),
        button: pick(".button"),
        navLink: pick(".site-nav a"),
      };
    });

    // The stylesheet sets 0.01ms globally under this media query; anything larger means the
    // reduced-motion block stopped applying.
    for (const [name, value] of Object.entries(durations)) {
      const longest = Math.max(
        ...value.split(",").map((part) => parseFloat(part) * (part.includes("ms") ? 0.001 : 1)),
      );
      expect(longest, `${name} transition`).toBeLessThan(0.01);
    }
  });

  test("the card lift is cancelled", async ({ page }) => {
    await page.goto("/");

    const card = page.locator("a.card").first();
    await card.hover();
    // The rule under the media query removes the transform outright, so a hovered card is in the
    // same place as a resting one.
    const transform = await card.evaluate((el) => getComputedStyle(el).transform);
    expect(transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)").toBe(true);
  });
});

// --------------------------------------------------------------------------- forced colours

test.describe("forced colours", () => {
  test.use({ forcedColors: "active" });

  // The mode exposes a small system palette -- Canvas, CanvasText, LinkText, Highlight, ButtonFace,
  // ButtonText -- and the stylesheet opts into it by naming those keywords. The engines differ in
  // one important way: Chromium also remaps author colours that are never named, so every surface
  // lands on the palette whether or not this site asks. WebKit maps only what is explicitly named.
  // The two also disagree on the values themselves: Chromium's Highlight is a dark navy and its
  // LinkText is #00009F, while WebKit's Highlight is a pale blue and its LinkText is #0000EE.
  //
  // So neither the values nor "the engine rewrote the page" can be asserted portably. What can be
  // asserted is what the stylesheet is responsible for: each colour it sets by keyword resolves to
  // the engine's own value *for that keyword*. Reading the palette from the engine keeps the check
  // discriminating without pinning it to one browser.
  //
  // Comparing against the specific keyword matters, not merely membership in the palette: author
  // white is `rgb(255, 255, 255)`, which is exactly this mode's `Canvas`, so a loose membership
  // test passes even when the rule that should have set `ButtonText` has been deleted.
  async function systemPalette(page) {
    return page.evaluate(() => {
      const probe = document.createElement("div");
      document.body.appendChild(probe);
      const palette = {};
      for (const keyword of [
        "Canvas",
        "CanvasText",
        "LinkText",
        "Highlight",
        "ButtonFace",
        "ButtonText",
      ]) {
        probe.style.color = "initial";
        probe.style.borderColor = "initial";
        probe.style.backgroundColor = "initial";
        probe.style.color = keyword;
        probe.style.borderColor = keyword;
        probe.style.backgroundColor = keyword;
        const style = getComputedStyle(probe);
        palette[keyword] = style.color;
        palette[`${keyword}Border`] = style.borderTopColor;
        palette[`${keyword}Background`] = style.backgroundColor;
      }
      probe.remove();
      return palette;
    });
  }

  const AUTHOR = {
    accent: "rgb(11, 107, 58)",
    pageText: "rgb(20, 18, 14)",
  };

  test("the badge dot stays visible instead of becoming Canvas on Canvas", async ({ page }) => {
    await page.goto("/");

    const dot = await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector(".badge-dot"));
      return {
        width: parseFloat(style.width),
        background: style.backgroundColor,
        borderWidth: parseFloat(style.borderTopWidth),
      };
    });

    // It was a background-only swatch, which this mode erases. The fix gives it a ring, so it
    // must be visible by its border rather than by a fill that the engine overwrote.
    expect(dot.borderWidth).toBeGreaterThan(0);
    expect(dot.width).toBeGreaterThanOrEqual(8);
    expect(dot.background).toBe("rgb(255, 255, 255)");
  });

  test("cards and callouts keep a border because the fill that carried them is gone", async ({
    page,
  }) => {
    await page.goto("/");

    for (const selector of [".card", ".note", ".code-block", ".principle"]) {
      const element = page.locator(selector).first();
      if ((await element.count()) === 0) continue;
      const border = await element.evaluate((el) => getComputedStyle(el).borderTopWidth);
      expect(parseFloat(border), `${selector} border`).toBeGreaterThan(0);
    }
  });

  test("system colours replaced the author palette on the elements the stylesheet controls", async ({
    page,
  }) => {
    await page.goto("/");

    const palette = await systemPalette(page);
    const colors = await page.evaluate(() => {
      const read = (selector, property) => {
        const el = document.querySelector(selector);
        return el ? getComputedStyle(el)[property] : null;
      };
      return {
        // `.button` and the two text accents are set to system keywords by the stylesheet.
        buttonText: read(".button", "color"),
        buttonBorder: read(".button", "borderTopColor"),
        principleNumber: read(".principle-number", "color"),
        brandMark: read(".brand-mark", "color"),
      };
    });

    // Each rule is checked against the keyword it names, not just "some system colour".
    const expectations = {
      buttonText: palette.ButtonText,
      buttonBorder: palette.ButtonTextBorder,
      principleNumber: palette.LinkText,
      brandMark: palette.LinkText,
    };
    for (const [name, expected] of Object.entries(expectations)) {
      expect(
        colors[name],
        `${name} should be the keyword colour ${expected}, not the author palette`,
      ).toBe(expected);
    }
    // Belt and braces: these were the author palette before the rule existed.
    expect(colors.principleNumber).not.toBe(AUTHOR.accent);
    expect(colors.brandMark).not.toBe(AUTHOR.accent);
    expect(colors.buttonText).not.toBe(AUTHOR.pageText);
  });

  test("the current page is still distinguishable in the navigation", async ({ page }) => {
    await page.goto("/tour.html");
    const current = page.locator('.site-nav a[aria-current="page"]');
    await expect(current).toHaveCount(1);
    // The accent-soft fill that marked it is erased, so it is marked with a Highlight border.
    // Assert the colour, not merely that a border exists: the rule sets `Highlight`, and a
    // regression that dropped the rule would leave no border at all.
    const palette = await systemPalette(page);
    const border = await current.evaluate((el) => ({
      width: parseFloat(getComputedStyle(el).borderTopWidth),
      color: getComputedStyle(el).borderTopColor,
    }));
    expect(border.width).toBeGreaterThan(0);
    expect(
      border.color,
      `aria-current border ${border.color} should be the engine's Highlight colour ${palette.HighlightBorder}`,
    ).toBe(palette.HighlightBorder);
    expect(border.color).not.toBe(AUTHOR.accent);
  });

  test("decorative washes are removed rather than printed as mud", async ({ page }) => {
    await page.goto("/");
    const grid = await page.evaluate(
      () => getComputedStyle(document.querySelector(".hero"), "::after").display,
    );
    expect(grid).toBe("none");
  });
});

// --------------------------------------------------------------------------- print

test.describe("print", () => {
  test("screen chrome is removed and code prints as ink", async ({ page }) => {
    await page.goto("/");
    await page.emulateMedia({ media: "print" });

    for (const selector of [".site-header", ".site-footer", ".skip-link", ".hero-actions"]) {
      const display = await page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).display);
      expect(display, `${selector} should not print`).toBe("none");
    }

    const code = await page.locator(".code-block").first().evaluate((el) => {
      const style = getComputedStyle(el);
      return { bg: style.backgroundColor, border: style.borderTopWidth };
    });
    // A dark plate on paper wastes ink and usually prints as a black rectangle.
    expect(code.bg).toBe("rgb(255, 255, 255)");
    expect(parseFloat(code.border)).toBeGreaterThan(0);
  });

  test("a documentation page prints as continuous prose", async ({ page }) => {
    await page.goto("/document.html?path=docs/spec/language.md&ref=main");
    await page.emulateMedia({ media: "print" });

    await expect(page.locator(".site-header")).toBeHidden();

    // The article itself must still be there; printing must not blank the content it is for.
    const article = page.locator(".doc-article .doc").first();
    await expect(article).toBeVisible({ timeout: 20000 });
  });
});

// --------------------------------------------------------------------------- nested routes

test.describe("direct nested routes", () => {
  for (const route of STATIC_ROUTES) {
    test(`${route} loads directly, without a client-side transition`, async ({ page }) => {
      const response = await page.goto(route);
      expect(response?.status()).toBe(200);
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.locator("main#main")).toBeVisible();
    });
  }

  test("a nested documentation route resolves on a cold load", async ({ page }) => {
    const response = await page.goto("/document.html?path=docs/spec/language.md&ref=main");
    expect(response?.status()).toBe(200);
    await expect(page.locator(".doc-article .doc").first()).toBeVisible({ timeout: 20000 });
  });

  test("an unknown path renders the 404 document", async ({ page }) => {
    const response = await page.goto("/this-route-does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(page.locator("h1")).toBeVisible();
  });
});

// --------------------------------------------------------------------------- backend states

test.describe("backends unavailable", () => {
  test("the site still renders when every Firestore and GitHub request fails", async ({ page }) => {
    // The mirror is a cache in front of GitHub; neither is allowed to be required for the site's
    // own pages to be readable.
    await page.route("**/*googleapis.com/**", (route) => route.abort());
    await page.route("**/api.github.com/**", (route) => route.abort());
    await page.route("**/raw.githubusercontent.com/**", (route) => route.abort());

    await page.goto("/");

    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator(".hero .lead")).toBeVisible();
    // Both static card grids render in full: three under "why" and six under "explore".
    await expect(page.locator('[aria-labelledby="why"] .card')).toHaveCount(3);
    await expect(page.locator('[aria-labelledby="explore"] .card')).toHaveCount(6);
  });

  test("a documentation page surfaces the failure instead of an empty article", async ({ page }) => {
    await page.route("**/*googleapis.com/**", (route) => route.abort());
    await page.route("**/api.github.com/**", (route) => route.abort());
    await page.route("**/raw.githubusercontent.com/**", (route) => route.abort());

    await page.goto("/document.html?path=docs/spec/language.md&ref=main");

    // Either an alert or error copy; what must not happen is a blank pane that looks loaded.
    const surfaced = page.locator('[role="alert"], .error, .empty-state');
    await expect(surfaced.first()).toBeVisible({ timeout: 25000 });
    expect((await surfaced.first().innerText()).trim().length).toBeGreaterThan(0);
  });
});
