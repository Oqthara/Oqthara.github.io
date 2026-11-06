import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Guards the two ways this bundle silently regrew before.
//
// The first is grammatical: `rehype-prism-plus` defaults to `refractor/all`. Importing the
// default export drags in every grammar Prism ships even though only nine are registered,
// and nothing in the build output tells you which. The check is on source, because that is
// where the import is chosen and minification erases the strings that would distinguish them.
//
// The second is arithmetic: the entry chunk has a ceiling. A ceiling is blunt, but it is the
// only check that notices a new dependency arriving with a large graph, whatever the reason.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SITE = path.join(ROOT, "_site");
const present = existsSync(SITE);
const skip = present ? false : "_site is absent; run `npm run build`";

// The entry chunk was 1287 KiB raw / 428 KiB gzip while `refractor/all` was being pulled in.
// It is 730 KiB / 225 KiB with the generator entry. The headroom is deliberate: large enough
// that ordinary growth does not trip it, small enough that the full grammar set cannot fit
// back in unnoticed.
const GZIP_BUDGET = 300 * 1024;

function sourceFiles(directory, result = []) {
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) sourceFiles(full, result);
    else if (name.endsWith(".js") || name.endsWith(".jsx")) result.push(full);
  }
  return result;
}

test("no module imports the refractor/all grammar set", () => {
  const offenders = sourceFiles(path.join(ROOT, "src"))
    .filter((file) => /from\s+["']refractor\/all["']/.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(ROOT, file));
  // `refractor/core` plus explicit grammars is the only way to keep the set at nine.
  assert.deepEqual(offenders, [], "refractor/all ships every Prism grammar");
});

test("rehype-prism-plus is configured with the shared refractor instance", () => {
  const pipeline = readFileSync(path.join(ROOT, "src", "markdown-pipeline.js"), "utf8");

  // The default export is the trap: it resolves to `rehypePrismGenerator(refractorAll)`.
  assert.doesNotMatch(
    pipeline,
    /import\s+rehypePrism(?:Plus)?\s+from\s+["']rehype-prism-plus["']/,
    "the default export hardwires refractor/all; use rehype-prism-plus/generator",
  );
  assert.match(pipeline, /from\s+["']rehype-prism-plus\/generator["']/);
  assert.match(pipeline, /rehypePrismGenerator\(refractor\)/);
});

test("the entry chunk stays inside the gzip budget", { skip }, () => {
  const assets = path.join(SITE, "assets");
  const entry = readdirSync(assets)
    .filter((name) => /^index-.*\.js$/.test(name))
    .map((name) => ({ name, size: statSync(path.join(assets, name)).size }))
    .sort((a, b) => b.size - a.size)[0];

  assert.ok(entry, "no entry chunk found in _site/assets");

  const bytes = readFileSync(path.join(assets, entry.name));
  const gzip = gzipSync(bytes, { level: 9 }).length;
  assert.ok(
    gzip <= GZIP_BUDGET,
    `${entry.name} is ${(gzip / 1024).toFixed(0)} KiB gzipped, over the ${(GZIP_BUDGET / 1024).toFixed(0)} KiB budget`,
  );
});
