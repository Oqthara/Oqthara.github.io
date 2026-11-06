import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(root, "_site");

// The suite deliberately does not build the site. A missing _site is a setup error, not a
// silent skip, so fail here with the one command that fixes it.
if (!existsSync(site)) {
  throw new Error("_site is missing. Run `npm run build` before `npx playwright test`.");
}

// Which engines to run. `chromium` is the default because it is the only engine CI is guaranteed
// to have installed everywhere. `PW_ENGINES=all` opts into the full matrix; it is set explicitly
// by CI after installing all three engines, so an engine can never be silently skipped: either it
// is named here and expected to run, or it is absent from the run on purpose.
const engines = process.env.PW_ENGINES === "all" ? "all" : "chromium";

const engineProjects =
  engines === "all"
    ? [
        { name: "chromium", use: { ...devices["Desktop Chrome"] } },
        // Firefox and WebKit are separate projects rather than extra browsers in one project so a
        // failure names the engine in the report instead of needing a repro.
        { name: "firefox", use: { ...devices["Desktop Firefox"] } },
        { name: "webkit", use: { ...devices["Desktop Safari"] } },
      ]
    : [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }];

export default defineConfig({
  testDir: "e2e",
  retries: 0,
  reporter: "list",
  timeout: 30000,
  workers: 1,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:8811",
    trace: "off",
  },
  projects: [
    ...engineProjects,
    // A phone profile runs the same specs at a touch viewport, which is where the header
    // collapse, the menu panel and the documentation rails behave differently. It is Chromium
    // based, so it is always available wherever the Chromium engine is.
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node scripts/serve-site-cli.mjs _site 8811",
    url: "http://127.0.0.1:8811/",
    // Never attach to whatever happens to hold the port locally: a plain static server has no
    // 404.html fallback, so the 404 assertions would be testing the wrong document.
    reuseExistingServer: false,
    timeout: 30000,
  },
});
