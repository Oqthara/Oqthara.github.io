#!/usr/bin/env node
// Rewrites releases.json from the GitHub releases API.
//
// Run manually when a release is published:
//
//   npm run refresh:releases
//
// It is never run by the build. A deploy must not silently add or remove a documentation
// channel, and a build must not need the network or a token. The file it produces is
// committed, so the channel list a reader sees is reviewable in a pull request.

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "Oqthara/oqthara";
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "releases.json");

const MAIN = { id: "main", label: "Development (main)", ref: "main" };

const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, {
  headers: { Accept: "application/vnd.github+json" },
});

if (!response.ok) {
  console.error(`error: GitHub returned ${response.status} for the releases API`);
  process.exit(1);
}

const releases = await response.json();
const channels = [MAIN];
for (const release of releases) {
  if (release.draft) continue;
  const tag = String(release.tag_name ?? "");
  if (!tag) continue;
  channels.push({
    id: tag.replace(/^v/, ""),
    label: release.name?.trim() || tag,
    ref: tag,
  });
}

writeFileSync(target, `${JSON.stringify(channels, null, 2)}\n`, "utf8");
console.log(`wrote releases.json with ${channels.length} channels`);
for (const channel of channels) console.log(`  ${channel.id} -> ${channel.ref}`);
