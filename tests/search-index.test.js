import test from "node:test";
import assert from "node:assert/strict";

import { ensureIndex, invalidate } from "../src/search-index.js";

// The search index is built from the mirror's catalogue and document bodies, then cached for the
// life of the page. A republish replaces every one of those, so an index built before it is wrong
// in the same way a stale document body is wrong: search keeps offering links and excerpts from
// content the site no longer serves. These cases pin the cache policy that prevents it.

test("a build is reused until it is invalidated", async () => {
  invalidate();
  let builds = 0;
  const build = () => {
    builds += 1;
    return [{ title: "Language" }];
  };

  const first = await ensureIndex("main", build);
  const second = await ensureIndex("main", build);

  assert.equal(builds, 1, "a second search must not rebuild the index");
  assert.equal(first, second, "and it must hand back the same entries");
});

test("a republish makes the next search rebuild", async () => {
  invalidate();
  let builds = 0;
  const build = () => {
    builds += 1;
    return [{ title: `build ${builds}` }];
  };

  await ensureIndex("main", build);
  invalidate();
  const after = await ensureIndex("main", build);

  assert.equal(builds, 2, "the index must be rebuilt from the current mirror");
  assert.equal(after[0].title, "build 2", "and the caller must get the new entries");
});

test("REGRESSION: a build overtaken by a republish is discarded, not cached", async () => {
  // The failure this pins: the index was built once per session and never invalidated, so search
  // answered from whichever catalogue happened to be present the first time it was opened. Even
  // after adding invalidation, a build that resolves *after* the republish would reinstall itself
  // unless its generation is checked - it read the old catalogue, so it describes old content.
  invalidate();
  let release;
  const slow = [];
  const build = () => {
    slow.push(1);
    return new Promise((resolve) => {
      release = () => resolve([{ title: "pre-republish" }]);
    });
  };

  const inFlight = ensureIndex("main", build);
  // `build` runs on a microtask, so let it start before invalidating mid-flight.
  await Promise.resolve();
  invalidate();
  release();
  assert.equal((await inFlight)[0].title, "pre-republish", "the caller still gets what it asked for");

  // The stale build must not have been installed, so the next search rebuilds.
  let rebuilt = false;
  const fresh = await ensureIndex("main", () => {
    rebuilt = true;
    return [{ title: "post-republish" }];
  });
  assert.ok(rebuilt, "the overtaken build must not satisfy a later search");
  assert.equal(fresh[0].title, "post-republish");
});

test("a failed build is dropped so a later search can retry", async () => {
  invalidate();
  let attempts = 0;
  const build = () => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error("GitHub is down"));
    return [{ title: "Language" }];
  };

  await assert.rejects(() => ensureIndex("main", build), /GitHub is down/);
  const entries = await ensureIndex("main", build);

  assert.equal(attempts, 2, "a transient failure must not make search permanently unavailable");
  assert.equal(entries[0].title, "Language");
});

test("each ref keeps its own index", async () => {
  // The site can be read at `main` or at a release. A search from a pinned manual must return
  // links into that manual, so one ref's index must never answer another's.
  invalidate();
  const build = (ref) => [{ title: ref }];

  await ensureIndex("main", build);
  const release = await ensureIndex("v0.3.0", build);

  assert.equal(release[0].title, "v0.3.0");
});

test("a build that fails after a newer one was installed does not evict the newer index", async () => {
  // Both builds race for one slot. The first fails late, after a republish has already started a
  // replacement. Evicting by key alone would throw the replacement away and force a third build,
  // so this pins the identity check that keeps the survivor.
  invalidate();
  let failFirst;
  let builds = 0;
  const build = () => {
    builds += 1;
    if (builds === 1) {
      return new Promise((_, reject) => {
        failFirst = () => reject(new Error("GitHub is down"));
      });
    }
    return Promise.resolve([{ title: "current" }]);
  };

  const doomed = ensureIndex("main", build).catch(() => "failed");
  await Promise.resolve();
  invalidate();
  const survivor = await ensureIndex("main", build);
  failFirst();

  assert.equal(await doomed, "failed");
  assert.deepEqual(await ensureIndex("main", build), survivor);
  assert.equal(builds, 2, "the failure of the abandoned build must not force a rebuild");
});

test("invalidating when nothing is cached is harmless", () => {
  invalidate();
  invalidate();
  assert.ok(true);
});
