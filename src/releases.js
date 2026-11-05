// Documentation channels. `releases.json` is the only list of channels the site trusts;
// `scripts/refresh-releases.mjs` rewrites it from the GitHub releases API on demand. It is
// never refreshed by the build, so a deploy cannot silently add or remove a channel.

import releases from "../releases.json" with { type: "json" };

const MAIN = { id: "main", label: "Development (main)", ref: "main" };

function normalise(entry) {
  if (!entry || typeof entry !== "object") return null;
  const { id, label, ref } = entry;
  if (typeof id !== "string" || !id.trim()) return null;
  if (typeof ref !== "string" || !ref.trim()) return null;
  return {
    id: id.trim(),
    label: typeof label === "string" && label.trim() ? label.trim() : ref.trim(),
    ref: ref.trim(),
  };
}

/** Development first, then release tags newest first, exactly as `releases.json` lists them. */
export const CHANNELS = Object.freeze(
  (Array.isArray(releases) ? releases : []).map(normalise).filter(Boolean),
);

export const DEFAULT_CHANNEL = CHANNELS[0] ?? MAIN;

/** The channel whose git ref is `ref`, or the development channel for an unknown ref. */
export function channelForRef(ref) {
  return CHANNELS.find((channel) => channel.ref === ref) ?? DEFAULT_CHANNEL;
}

/** The channel with `id`, or the development channel. */
export function channelById(id) {
  return CHANNELS.find((channel) => channel.id === id) ?? DEFAULT_CHANNEL;
}

/** A channel is pinned when it names a tag rather than the moving `main` branch. */
export function isPinned(ref) {
  return ref !== "main";
}
