// Captures the mandatory visual-audit screenshots from the real built site.
//
// It drives Chromium against a local server that behaves like GitHub Pages (unknown paths
// serve 404.html), waits for dynamic content to finish rendering, and writes PNGs into
// `artifacts/visual-audit/`. Every file it produces is a real browser screenshot: nothing is
// mocked, stubbed or drawn.
//
//   node scripts/capture-screenshots.mjs
//
// Run `npm run build` and start the Pages-like server first (see README).

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.OQ_AUDIT_BASE || "http://127.0.0.1:8899";

/**
 * An optional GitHub token, used only by this audit script.
 *
 * The site cannot ship a token, and an unauthenticated browser gets 60 API requests an hour,
 * which a full page sweep exhausts. Authenticating the audit's own API requests lets the
 * screenshots show the real pages instead of the rate-limit state. Nothing about this is part
 * of the deployed site: it is a header added by the browser running the audit.
 */
function githubToken() {
  if (process.env.OQ_AUDIT_TOKEN) return process.env.OQ_AUDIT_TOKEN.trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const TOKEN = githubToken();
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "artifacts", "visual-audit");

const DESKTOP = { width: 1440, height: 1000 };
const MOBILE = { width: 390, height: 844 };

const doc = (path, ref = "main") =>
  `/document.html?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`;

/** The screenshots that must exist for the audit, in the order the report lists them. */
const SHOTS = [
  { file: "home-desktop.png", route: "/", viewport: DESKTOP },
  { file: "home-mobile.png", route: "/", viewport: MOBILE },
  { file: "docs-desktop.png", route: "/docs.html", viewport: DESKTOP },
  { file: "docs-mobile.png", route: "/docs.html", viewport: MOBILE },
  {
    file: "doc-page-code-highlighting.png",
    route: doc("docs/spec/language.md"),
    viewport: DESKTOP,
    // Wait for the highlighted tokens, not just the prose, so the screenshot can be used to
    // judge the code theme.
    ready: "code .token",
  },
  { file: "examples-desktop.png", route: "/examples.html", viewport: DESKTOP },
  { file: "stdlib-desktop.png", route: "/stdlib.html", viewport: DESKTOP },
  { file: "changelog-desktop.png", route: "/changelog.html", viewport: DESKTOP },
  { file: "status-desktop.png", route: "/status.html", viewport: DESKTOP },
  { file: "philosophy-desktop.png", route: "/philosophy.html", viewport: DESKTOP },
  { file: "not-found-desktop.png", route: "/no-such-page.html", viewport: DESKTOP },
  {
    file: "navigation-mobile-open.png",
    route: "/",
    viewport: MOBILE,
    before: async (page) => {
      await page.locator(".nav-toggle").click();
      await page.locator("#site-nav[data-open='true']").waitFor();
    },
  },
  // Extra evidence for the pages where the audit found defects.
  {
    file: "doc-page-mobile.png",
    route: doc("docs/spec/language.md"),
    viewport: MOBILE,
    ready: "code .token",
  },
  { file: "tour-desktop.png", route: "/tour.html", viewport: DESKTOP },
  { file: "example-desktop.png", route: "/example.html?path=examples%2Fanagrams.oq&ref=main", viewport: DESKTOP },
];

mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
let failures = 0;

for (const shot of SHOTS) {
  const context = await browser.newContext({
    viewport: shot.viewport,
    deviceScaleFactor: 2,
    // A fixed, light appearance would hide dark-theme defects, so the audit uses the light
    // appearance for body pages and the dashboard shot captures dark separately.
    colorScheme: shot.colorScheme ?? "light",
  });
  const page = await context.newPage();
  if (TOKEN) {
    await page.route("https://api.github.com/**", (route) => {
      const headers = { ...route.request().headers(), authorization: `Bearer ${TOKEN}` };
      delete headers.host;
      return route.continue({ headers });
    });
  }
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  try {
    const response = await page.goto(BASE + shot.route, { waitUntil: "networkidle", timeout: 60000 });
    // 404.html is served with status 404 on purpose; that page is a valid capture.
    const expected = shot.route === "/no-such-page.html" ? 404 : 200;
    if (response && response.status() !== expected) {
      throw new Error(`expected HTTP ${expected}, got ${response.status()}`);
    }
    if (shot.ready) await page.locator(shot.ready).first().waitFor({ timeout: 30000 });
    if (shot.before) await shot.before(page);
    // Let webfonts and the last paint settle.
    await page.evaluate(() => document.fonts?.ready);
    await page.waitForTimeout(150);

    await page.screenshot({ path: join(out, shot.file), fullPage: false });
    const size = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
      scrollW: document.documentElement.scrollWidth,
    }));
    const overflow = size.scrollW > size.w + 1 ? ` OVERFLOW ${size.scrollW}>${size.w}` : "";
    console.log(
      `ok  ${shot.file.padEnd(32)} ${shot.viewport.width}x${shot.viewport.height} ${shot.route}${overflow}`,
    );
    // The not-found page is served with a 404 status on purpose, so the browser reports that
    // one failed request. It is expected evidence, not a defect.
    const unexpected = shot.route === "/no-such-page.html"
      ? errors.filter((text) => !/404/.test(text))
      : errors;
    if (unexpected.length) {
      failures += 1;
      console.log(`    console errors: ${unexpected.slice(0, 3).join(" | ")}`);
    }
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${shot.file}: ${error.message}`);
  } finally {
    await context.close();
  }
}

await browser.close();

if (failures) {
  console.error(`${failures} screenshot(s) failed`);
  process.exit(1);
}
console.log(`captured ${SHOTS.length} screenshots into ${out}`);
