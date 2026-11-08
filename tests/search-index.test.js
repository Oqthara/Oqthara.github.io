import test from "node:test";
import assert from "node:assert/strict";

import {
  __resetIndexCacheForTests,
  ensureIndex,
  invalidate,
  onRebuild,
} from "../src/search-index.js";

// The search index is built from the mirror's catalogue and document bodies, then cached. A
// republish replaces every one of those, so an index built before it is wrong in the same way a
// stale document body is wrong: search keeps offering links and excerpts for content the site no
// longer serves, and an open results panel keeps showing them. These cases pin both halves of the
// fix - that the cache is dropped, and that a mounted surface is told to rebuild rather than left
// announcing a load that nothing started.

test.beforeEach(() => __resetIndexCacheForTests());

test("a build is reused until it is invalidated", async () => {
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

test("REGRESSION: an open panel is told to rebuild on republish", () => {
  // The failure this pins: invalidation and the rebuild were separate, and nothing connected
  // them. The component dropped its entries and rendered "Loading the search index..." while no
  // request was in flight, until the reader happened to type another character.
  let rebuilds = 0;
  const stop = onRebuild(() => {
    rebuilds += 1;
  });

  invalidate();
  assert.equal(rebuilds, 1, "a republish must notify every mounted search surface");

  stop();
  invalidate();
  assert.equal(rebuilds, 1, "and an unmounted surface must not be called");
});

test("a listener that throws does not stop the others rebuilding", () => {
  const seen = [];
  const stopBad = onRebuild(() => {
    throw new Error("this subscriber is broken");
  });
  const stopGood = onRebuild(() => seen.push("rebuilt"));

  invalidate();

  assert.deepEqual(seen, ["rebuilt"]);
  stopBad();
  stopGood();
});

test("REGRESSION: a build overtaken by a republish is not reused", async () => {
  // A build that resolves after the republish read the old catalogue. It still answers the caller
  // that awaited it, but it must not be left where a later search would reuse it.
  let release;
  const build = () =>
    new Promise((resolve) => {
      release = () => resolve([{ title: "pre-republish" }]);
    });

  const inFlight = ensureIndex("main", build);
  // `build` runs on a microtask, so let it start before invalidating mid-flight.
  await Promise.resolve();
  invalidate();
  release();
  assert.equal((await inFlight)[0].title, "pre-republish", "the caller still gets what it asked for");

  let rebuilt = false;
  const fresh = await ensureIndex("main", () => {
    rebuilt = true;
    return [{ title: "post-republish" }];
  });
  assert.ok(rebuilt, "the overtaken build must not satisfy a later search");
  assert.equal(fresh[0].title, "post-republish");
});

test("a failed build is dropped so a later search can retry", async () => {
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

test("a synchronous throw from the builder becomes a retryable rejection", async () => {
  let attempts = 0;
  const build = () => {
    attempts += 1;
    if (attempts === 1) throw new Error("bad catalogue");
    return [{ title: "Language" }];
  };

  await assert.rejects(() => ensureIndex("main", build), /bad catalogue/);
  assert.equal((await ensureIndex("main", build))[0].title, "Language");
});

test("each ref keeps its own index", async () => {
  // The site can be read at `main` or at a release. A search from a pinned manual must return
  // links into that manual, so one ref's index must never answer another's.
  const build = (ref) => [{ title: ref }];

  await ensureIndex("main", build);
  const release = await ensureIndex("v0.3.0", build);

  assert.equal(release[0].title, "v0.3.0");
});

test("a build that fails after a newer one was installed does not evict the newer index", async () => {
  // Both builds race for one slot. The first fails late, after an invalidation has started a
  // replacement. Evicting by key alone would throw the replacement away and force a third build,
  // so this pins the identity check that keeps the survivor.
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
  invalidate();
  const survivor = await ensureIndex("main", build);
  failFirst();

  assert.equal(await doomed, "failed");
  assert.deepEqual(await ensureIndex("main", build), survivor);
  assert.equal(builds, 2, "the failure of the abandoned build must not force a rebuild");
});
