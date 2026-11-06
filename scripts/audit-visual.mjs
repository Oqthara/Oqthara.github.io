// Visual audit of the prerendered site.
//
// Serves `_site` from a small HTTP server, drives real Chromium through Playwright and checks,
// for every route and viewport:
//
//   * the document never scrolls sideways;
//   * there is exactly one h1;
//   * no element is wider than the viewport (scroll containers excepted);
//   * hydration produced no uncaught error.
//
// It also exercises the mobile menu: ARIA state, focus movement, Escape, links inside the
// viewport and a scrollable panel. Screenshots are written to `artifacts/visual-audit/`.
//
// GitHub's API allows 60 unauthenticated requests an hour. When `GH_TOKEN` is set (or
// `gh auth token` succeeds) the token is attached to api.github.com and
// raw.githubusercontent.com requests at the browser level. It is never written to disk.

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { serveSite } from "./lib/serve-site.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SITE = join(ROOT, "_site");
const OUT = join(ROOT, "artifacts", "visual-audit");
// The Pages-like server picks a free port, so parallel audit runs never collide.
let ORIGIN = "";

const ROUTES = [
  { path: "/", name: "home" },
  { path: "/philosophy.html", name: "philosophy" },
  { path: "/tour.html", name: "tour" },
  { path: "/docs.html", name: "docs" },
  { path: "/examples.html", name: "examples" },
  { path: "/stdlib.html", name: "stdlib" },
  { path: "/changelog.html", name: "changelog" },
  { path: "/status.html", name: "status" },
  { path: "/document.html?path=docs/spec/language.md", name: "document" },
  { path: "/example.html?path=examples/hello.oq", name: "example" },
  { path: "/no-such-page", name: "not-found" },
];

const VIEWPORTS = [
  { width: 1440, height: 900, label: "1440x900" },
  { width: 1024, height: 768, label: "1024x768" },
  { width: 768, height: 1024, label: "768x1024" },
  { width: 390, height: 844, label: "390x844" },
  { width: 320, height: 640, label: "320x640" },
];

const SHOTS = [
  { route: "/", viewport: 1440, file: "home-desktop.png" },
  { route: "/", viewport: 390, file: "home-mobile.png" },
  { route: "/docs.html", viewport: 1440, file: "docs-desktop.png" },
  { route: "/docs.html", viewport: 390, file: "docs-mobile.png" },
  { route: "/examples.html", viewport: 1440, file: "examples-desktop.png" },
  { route: "/stdlib.html", viewport: 1440, file: "stdlib-desktop.png" },
  { route: "/changelog.html", viewport: 1440, file: "changelog-desktop.png" },
  { route: "/status.html", viewport: 1440, file: "status-desktop.png" },
  { route: "/philosophy.html", viewport: 1440, file: "philosophy-desktop.png" },
  { route: "/no-such-page", viewport: 1440, file: "not-found-desktop.png" },
  { route: "/tour.html", viewport: 1440, file: "tour-desktop.png" },
];

/** The GitHub token, from the environment or the authenticated gh CLI. Never persisted. */
function githubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

async function attachToken(context, token) {
  if (!token) return;
  await context.route(
    /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//,
    (route) => route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } }),
  );
}

/** Layout measurements taken in the page. */
function measure() {
  const viewport = window.innerWidth;
  const scrollables = [];
  const isScrollable = (el) => {
    const style = getComputedStyle(el);
    return ["auto", "scroll", "hidden", "clip"].includes(style.overflowX);
  };
  for (let el = document.body; el; el = el.parentElement) {
    if (isScrollable(el)) scrollables.push(el);
  }

  const clipped = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest(".visually-hidden, .skip-link")) continue;
    if (el.matches(".visually-hidden, .skip-link")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.width <= viewport + 1) continue;
    // Content inside an element that scrolls sideways is allowed to be wider than the page.
    let ancestor = el.parentElement;
    let scrolled = false;
    while (ancestor) {
      if (isScrollable(ancestor)) {
        scrolled = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (scrolled) continue;
    clipped.push({
      tag: el.tagName.toLowerCase(),
      className: typeof el.className === "string" ? el.className : "",
      width: Math.round(rect.width),
    });
  }

  return {
    viewport,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    h1: document.querySelectorAll("h1").length,
    clipped: clipped.slice(0, 6),
  };
}

async function settle(page, route) {
  // Content routes fetch GitHub after hydration. Wait for the network to go quiet, but never
  // fail the audit just because GitHub is slow: layout is still checked.
  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    await page.waitForTimeout(500);
  }
  if (route === "/document.html?path=docs/spec/language.md" || route === "/example.html?path=examples/hello.oq") {
    try {
      await page.waitForFunction(
        () => !document.querySelector(".skeleton") && document.querySelector(".doc, .code-block"),
        null,
        { timeout: 15000 },
      );
    } catch {
      // Reported by the result row as "content not rendered".
    }
  }
}

function contentState() {
  return {
    skeleton: document.querySelectorAll(".skeleton").length,
    content: Boolean(document.querySelector(".doc, .code-block, .doc-list, .example-grid, .status-block")),
  };
}

async function run() {
  if (!existsSync(SITE)) {
    console.error(`_site is missing; run npm run build first (${SITE})`);
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const token = githubToken();
  if (!token) console.warn("! GH_TOKEN not set and gh is not authenticated: GitHub routes may hit the rate limit.");

  const server = await serveSite({ siteDir: SITE });
  ORIGIN = server.origin;
  const browser = await chromium.launch();
  const results = [];
  const failures = [];
  const shots = new Map();

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      colorScheme: "dark",
      deviceScaleFactor: 1,
    });
    await attachToken(context, token);

    for (const route of ROUTES) {
      const page = await context.newPage();
      const pageErrors = [];
      const consoleErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });

      let status = 0;
      try {
        const response = await page.goto(`${ORIGIN}${route.path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        status = response?.status() ?? 0;
        await settle(page, route.path);
      } catch (error) {
        pageErrors.push(`navigation: ${error.message}`);
      }

      const dark = await page.evaluate(measure);
      // The same layout must hold in the light appearance.
      await page.emulateMedia({ colorScheme: "light" });
      const light = await page.evaluate(measure);
      await page.emulateMedia({ colorScheme: "dark" });

      const state = await page.evaluate(contentState);
      const reasons = [];
      for (const [mode, m] of [["dark", dark], ["light", light]]) {
        if (m.scrollWidth > m.viewport + 1) reasons.push(`${mode}: horizontal overflow ${m.scrollWidth}px > ${m.viewport}px`);
        if (m.clipped.length) {
          const worst = m.clipped.map((c) => `${c.tag}.${c.className || "-"}=${c.width}px`).join(", ");
          reasons.push(`${mode}: element wider than viewport (${worst})`);
        }
      }
      if (dark.h1 !== 1) reasons.push(`h1 count is ${dark.h1}`);
      if (pageErrors.length) reasons.push(`page error: ${pageErrors[0]}`);
      const expectsContent = route.name === "document" || route.name === "example";
      if (expectsContent && state.skeleton > 0) reasons.push("GitHub content did not render");

      const row = {
        route: route.path,
        viewport: vp.label,
        status,
        scrollWidth: dark.scrollWidth,
        h1: dark.h1,
        content: state.content,
        consoleErrors,
        reasons,
      };
      results.push(row);
      if (reasons.length) failures.push(row);

      for (const shot of SHOTS) {
        if (shot.route === route.path && shot.viewport === vp.width) {
          shots.set(shot.file, page);
        }
      }

      if (route.name === "home" && (vp.width === 390 || vp.width === 320)) {
        const menu = await checkMenu(page, vp);
        if (!menu.ok) {
          failures.push({ route: `${route.path} (mobile menu)`, viewport: vp.label, reasons: menu.reasons });
          results.push({ route: "mobile menu", viewport: vp.label, status: "-", scrollWidth: "-", h1: "-", content: true, consoleErrors: [], reasons: menu.reasons });
        } else {
          results.push({ route: "mobile menu", viewport: vp.label, status: "-", scrollWidth: "-", h1: "-", content: true, consoleErrors: [], reasons: [] });
        }
        if (vp.width === 390) {
          await page.click(".nav-toggle");
          await page.waitForTimeout(120);
          await page.screenshot({ path: join(OUT, "navigation-mobile-open.png") });
          await page.keyboard.press("Escape");
        }
      }

      shotPage = page;
      await page.close();
    }
    await context.close();
  }

  // Screenshots need their own pages; re-create them in the right viewport.
  for (const shot of SHOTS) {
    const vp = VIEWPORTS.find((v) => v.width === shot.viewport);
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: "dark" });
    await attachToken(context, token);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}${shot.route}`, { waitUntil: "domcontentloaded" });
    await settle(page, shot.route);
    await page.screenshot({ path: join(OUT, shot.file) });
    await context.close();
  }

  await browser.close();
  await server.close();

  // ---------------------------------------------------------------- report

  console.log("\nVISUAL AUDIT — route x viewport\n");
  const header = ["route", "viewport", "status", "scrollW", "h1", "result"];
  const rows = results.map((r) => [
    r.route,
    r.viewport,
    String(r.status),
    String(r.scrollWidth),
    String(r.h1),
    r.reasons.length ? "FAIL" : "PASS",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));

  if (failures.length) {
    console.log("\nFAILURES\n");
    for (const f of failures) {
      console.log(`* ${f.route} @ ${f.viewport}`);
      for (const reason of f.reasons) console.log(`    - ${reason}`);
    }
  }

  const consoleProblems = results.filter((r) => r.consoleErrors.length);
  if (consoleProblems.length) {
    console.log("\nCONSOLE ERRORS\n");
    for (const r of consoleProblems) {
      console.log(`* ${r.route} @ ${r.viewport}: ${r.consoleErrors[0]}`);
    }
  }

  console.log(`\nScreenshots written to ${OUT}`);
  console.log(`${results.length - failures.length}/${results.length} checks passed.\n`);
  process.exit(failures.length ? 1 : 0);
}

let shotPage = null;

async function checkMenu(page, vp) {
  const reasons = [];
  const toggle = page.locator(".nav-toggle");
  await toggle.click();
  await page.waitForTimeout(100);

  const open = await page.evaluate(() => {
    const toggle = document.querySelector(".nav-toggle");
    const panel = document.querySelector(".site-nav");
    const rect = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    return {
      expanded: toggle.getAttribute("aria-expanded"),
      controls: toggle.getAttribute("aria-controls"),
      panelId: panel.id,
      panelDisplay: style.display,
      panelOverflowY: style.overflowY,
      panelTop: Math.round(rect.top),
      panelBottom: Math.round(rect.bottom),
      panelHeight: Math.round(rect.height),
      viewportH: window.innerHeight,
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
      activeInside: panel.contains(document.activeElement),
      activeTag: document.activeElement?.tagName,
      links: [...panel.querySelectorAll("a")].map((a) => {
        const b = a.getBoundingClientRect();
        return {
          text: a.textContent,
          left: Math.round(b.left),
          right: Math.round(b.right),
          top: Math.round(b.top),
          bottom: Math.round(b.bottom),
          visible: b.width > 0 && b.height > 0 && getComputedStyle(a).visibility !== "hidden",
        };
      }),
    };
  });

  if (open.expanded !== "true") reasons.push(`aria-expanded is ${open.expanded}`);
  if (open.controls !== open.panelId) reasons.push("aria-controls does not name the menu");
  if (open.panelDisplay === "none") reasons.push("menu panel is not displayed");
  if (open.panelOverflowY !== "auto" && open.panelOverflowY !== "scroll") reasons.push("menu panel cannot scroll");
  if (open.panelBottom > open.viewportH + 1) reasons.push(`menu panel extends ${open.panelBottom - open.viewportH}px below the viewport`);
  if (!open.activeInside) reasons.push(`focus did not move into the menu (${open.activeTag})`);

  for (const link of open.links) {
    if (!link.visible) reasons.push(`link "${link.text}" is not visible`);
    else if (link.left < -1 || link.right > vp.width + 1) reasons.push(`link "${link.text}" is outside the viewport`);
    if (link.top < open.panelTop - 1 || link.bottom > open.panelTop + open.panelHeight + 1) {
      reasons.push(`link "${link.text}" is clipped by the panel`);
    }
  }

  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  const closed = await page.evaluate(() => ({
    expanded: document.querySelector(".nav-toggle")?.getAttribute("aria-expanded"),
    display: getComputedStyle(document.querySelector(".site-nav")).display,
    focusOnToggle: document.activeElement === document.querySelector(".nav-toggle"),
  }));
  if (closed.expanded !== "false") reasons.push("Escape did not set aria-expanded=false");
  if (closed.display !== "none") reasons.push(`menu still displayed after Escape (${closed.display})`);
  if (!closed.focusOnToggle) reasons.push("focus did not return to the toggle after Escape");

  return { ok: reasons.length === 0, reasons };
}

await run();
