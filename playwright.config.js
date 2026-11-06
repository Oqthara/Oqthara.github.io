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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/serve-site-cli.mjs _site 8811",
    url: "http://127.0.0.1:8811/",
    // Never attach to whatever happens to hold the port locally: a plain static server has no
    // 404.html fallback, so the 404 assertions would be testing the wrong document.
    reuseExistingServer: false,
    timeout: 30000,
  },
});
