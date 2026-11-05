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
    command: "python3 -m http.server 8811 -d _site",
    url: "http://127.0.0.1:8811/",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
