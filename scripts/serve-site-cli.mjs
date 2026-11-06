// Serves `_site` the way GitHub Pages does, for `npx playwright test` and manual browsing.
// `python3 -m http.server` is not a substitute: it answers unknown paths with its own error
// page, so the site's 404.html would never be exercised.
import { resolve } from "node:path";
import { serveSite } from "./lib/serve-site.mjs";

const siteDir = resolve(process.argv[2] ?? "_site");
const port = Number(process.env.PORT ?? process.argv[3] ?? 0);

const site = await serveSite({ siteDir, port });
console.log(`serving ${siteDir} at ${site.origin}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await site.close();
    process.exit(0);
  });
}
