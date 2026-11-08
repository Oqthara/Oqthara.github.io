// Tests for live content freshness.
//
// The contract being pinned:
//
//   * the first snapshot is a baseline, never a change;
//   * a new catalogue revision refreshes the data without touching the URL;
//   * the caches behind the page are dropped, so the refresh is not answered from stale copies;
//   * a subscription failure is reported once and never retried in a loop;
//   * an unsubscribe actually closes the listener.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  __stopContentFreshnessForTests,
  announceContentChange,
  invalidateContentCaches,
  onContentChange,
  revisionFingerprint,
  startContentFreshness,
} from "../src/freshness.js";
import {
  __resetCacheForTests,
  __setFirestoreForTests,
  readDoc,
} from "../src/firebase/firestore.js";
import { __resetCacheForTests as __resetGitHubCache } from "../src/github-docs.js";

/** A fake `firebase/firestore` module that exposes the snapshot listener for driving. */
function fakeSdk() {
  const handle = { unsubscribe: 0 };
  const state = { listeners: [], unsubscribed: 0, docCalls: [] };
  return {
    state,
    module: {
      doc: (_db, name, id) => {
        state.docCalls.push({ name, id });
        return { name, id };
      },
      onSnapshot: (ref, onValue, onError) => {
        state.listeners.push({ ref, onValue, onError });
        return () => {
          state.unsubscribed += 1;
          handle.unsubscribe += 1;
        };
      },
      getDoc: async (ref) => ({ id: ref.id, exists: () => true, data: () => ({ path: "docs/a.md" }) }),
    },
  };
}

/** Lets the async subscription in `subscribeDoc` finish wiring itself up. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const catalog = (overrides = {}) => ({
  published: true,
  status: "published",
  sourceRef: "main",
  sourceCommit: "a".repeat(40),
  updatedAt: "2026-01-01T00:00:00.000Z",
  counts: { written: 1, unchanged: 0, unpublished: 0, oversized: 0 },
  ...overrides,
});

afterEach(() => {
  __stopContentFreshnessForTests();
  __setFirestoreForTests(null);
  __resetCacheForTests();
  __resetGitHubCache();
});

describe("revisionFingerprint", () => {
  it("uses the content digest, so a release that moves no commit is still a change", () => {
    // Publishing a release pushes a tag, not a commit to `main`, so `sourceCommit` stays put
    // while the mirror gains a release document. A commit-only fingerprint reported "unchanged"
    // and the open page never learned about the release.
    const before = catalog({ contentDigest: "1".repeat(64) });
    const after = catalog({ contentDigest: "2".repeat(64) });
    assert.equal(before.sourceCommit, after.sourceCommit, "the commit is deliberately identical");
    assert.notEqual(revisionFingerprint(before), revisionFingerprint(after));
    assert.equal(revisionFingerprint(before), `content:${"1".repeat(64)}`);
  });

  it("uses the commit whenever the record proves one", () => {
    const fingerprint = revisionFingerprint(catalog({ sourceCommit: "b".repeat(40) }));
    assert.equal(fingerprint, `commit:${"b".repeat(40)}`);
  });

  it("ignores a malformed digest rather than treating it as an identity", () => {
    assert.equal(
      revisionFingerprint(catalog({ contentDigest: "not-a-digest" })),
      `commit:${"a".repeat(40)}`,
      "a bad digest must not outrank a commit the record can prove"
    );
  });

  it("is empty for a record that proves nothing, so two unknowns do not look like a change", () => {
    assert.equal(revisionFingerprint(null), "");
    assert.equal(revisionFingerprint({}), "");
    assert.equal(revisionFingerprint({ sourceCommit: "not-a-commit" }), "");
  });

  it("falls back to the publish time and counts when a commit is absent", () => {
    const early = revisionFingerprint(catalog({ sourceCommit: "", updatedAt: "2026-01-01T00:00:00.000Z" }));
    const later = revisionFingerprint(catalog({ sourceCommit: "", updatedAt: "2026-01-02T00:00:00.000Z" }));
    assert.notEqual(early, later, "a later publish of an unknown commit is still a different revision");
    assert.equal(revisionFingerprint({ sourceCommit: "", updatedAt: "" }), "");
  });
});

describe("content freshness", () => {
  it("treats the first snapshot as a baseline rather than a change", async () => {
    const fake = fakeSdk();
    __setFirestoreForTests(fake.module);
    let announcements = 0;
    onContentChange(() => {
      announcements += 1;
    });

    startContentFreshness();
    await settle();
    assert.equal(fake.state.listeners.length, 1, "one listener is opened");
    fake.state.listeners[0].onValue({ exists: () => true, id: "catalog", data: () => catalog() });
    assert.equal(announcements, 0, "the value already on screen is not news");
  });

  it("announces a new revision and refreshes every live subscriber", async () => {
    const fake = fakeSdk();
    __setFirestoreForTests(fake.module);
    const seen = [];
    onContentChange((fingerprint) => seen.push(fingerprint));

    startContentFreshness();
    await settle();
    const listener = fake.state.listeners[0];
    listener.onValue({ exists: () => true, id: "catalog", data: () => catalog() });
    listener.onValue({
      exists: () => true,
      id: "catalog",
      data: () => catalog({ sourceCommit: "c".repeat(40) }),
    });

    assert.deepEqual(seen, [`commit:${"c".repeat(40)}`]);
  });

  it("stays quiet when the catalogue republishes the same revision", async () => {
    const fake = fakeSdk();
    __setFirestoreForTests(fake.module);
    let announcements = 0;
    onContentChange(() => {
      announcements += 1;
    });

    startContentFreshness();
    await settle();
    const listener = fake.state.listeners[0];
    listener.onValue({ exists: () => true, id: "catalog", data: () => catalog() });
    listener.onValue({ exists: () => true, id: "catalog", data: () => catalog() });
    assert.equal(announcements, 0, "a repeated snapshot of one revision is not a change");
  });

  it("watches metadata/catalog, the one record the rules make readable", async () => {
    const fake = fakeSdk();
    __setFirestoreForTests(fake.module);
    startContentFreshness();
    await settle();
    assert.deepEqual(fake.state.docCalls, [{ name: "metadata", id: "catalog" }]);
  });

  it("closes the listener when the watch is stopped", async () => {
    const fake = fakeSdk();
    __setFirestoreForTests(fake.module);
    const watch = startContentFreshness();
    await settle();
    assert.equal(fake.state.unsubscribed, 0);
    watch.stop();
    assert.equal(fake.state.unsubscribed, 1, "an unmounted app must not keep a socket open");
  });

  it("does not open a second listener when started twice", async () => {
    const fake = fakeSdk();
    __setFirestoreForTests(fake.module);
    const first = startContentFreshness();
    const second = startContentFreshness();
    await settle();
    assert.equal(fake.state.listeners.length, 1);
    assert.equal(first, second);
  });

  it("survives the StrictMode start-stop-stop-start cycle without orphaning a listener", async () => {
    // React StrictMode runs every effect cleanup twice in development, and a cleanup can be
    // invoked again on a handle whose watch was already replaced. `stop()` used to null the
    // module's watch slot unconditionally, so stopping a *stale* handle wiped the slot belonging
    // to the live watch; its listener stayed open and the next `start()` opened another one,
    // leaking the previous socket for the life of the page.
    const fake = fakeSdk();
    __setFirestoreForTests(fake.module);

    const stale = startContentFreshness();
    await settle();
    stale.stop();

    const live = startContentFreshness();
    await settle();

    stale.stop();
    stale.stop();

    const afterStaleStop = startContentFreshness();
    await settle();

    assert.equal(fake.state.listeners.length, 2, "the live watch is reused, not replaced");
    assert.equal(afterStaleStop, live, "and its own handle is handed back");
    assert.equal(fake.state.unsubscribed, 1, "no listener was closed twice or abandoned");

    live.stop();
    assert.equal(fake.state.unsubscribed, 2, "the live listener is closed by its own handle");
  });

  it("reports a subscription failure once and keeps the site readable", async () => {
    const fake = fakeSdk();
    __setFirestoreForTests(fake.module);
    const errors = [];
    startContentFreshness({ onError: (error) => errors.push(error) });

    await settle();
    fake.state.listeners[0].onError({ code: "permission-denied", message: "denied" });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "permission-denied");
  });

  it("stops delivering snapshots after unsubscribe", async () => {
    const fake = fakeSdk();
    __setFirestoreForTests(fake.module);
    let announcements = 0;
    onContentChange(() => {
      announcements += 1;
    });

    const watch = startContentFreshness();
    await settle();
    const listener = fake.state.listeners[0];
    listener.onValue({ exists: () => true, id: "catalog", data: () => catalog() });
    watch.stop();
    listener.onValue({
      exists: () => true,
      id: "catalog",
      data: () => catalog({ sourceCommit: "d".repeat(40) }),
    });
    assert.equal(announcements, 0);
  });
});

describe("cache invalidation", () => {
  it("drops cached mirror reads so a refresh is not answered from the old copy", async () => {
    let reads = 0;
    const fake = fakeSdk();
    __setFirestoreForTests({
      ...fake.module,
      getDoc: async (ref) => {
        reads += 1;
        return { id: ref.id, exists: () => true, data: () => ({ path: `docs/${reads}.md` }) };
      },
    });

    const first = await readDoc("documentation", "docs__a.md");
    const cached = await readDoc("documentation", "docs__a.md");
    assert.equal(first.data.path, "docs/1.md");
    assert.equal(cached.data.path, "docs/1.md", "the second read is served from the cache");
    assert.equal(reads, 1);

    invalidateContentCaches();
    const after = await readDoc("documentation", "docs__a.md");
    assert.equal(after.data.path, "docs/2.md", "after invalidation the read asks the mirror again");
    assert.equal(reads, 2);
  });

  it("a read that fails after a newer one replaced it does not evict the newer entry", async () => {
    // `cachedRead` evicts a failed read so the next call retries. It must evict by identity:
    // deleting by key alone would drop the replacement that an invalidation had already started,
    // turning one late failure into an extra round trip against a rate-limited API.
    let failFirst;
    let reads = 0;
    const fake = fakeSdk();
    __setFirestoreForTests({
      ...fake.module,
      getDoc: async (ref) => {
        reads += 1;
        if (reads === 1) {
          return new Promise((_, reject) => {
            failFirst = () => reject(new Error("unavailable"));
          });
        }
        return { id: ref.id, exists: () => true, data: () => ({ path: `docs/${reads}.md` }) };
      },
    });

    const doomed = readDoc("documentation", "docs__a.md");
    invalidateContentCaches();
    const survivor = await readDoc("documentation", "docs__a.md");
    failFirst();

    assert.equal((await doomed).ok, false, "the abandoned read reports its failure to its caller");
    assert.equal(reads, 2);
    const reused = await readDoc("documentation", "docs__a.md");
    assert.equal(reused.cached, true, "the newer entry is still cached, so it was not evicted");
    assert.deepEqual(reused.data, survivor.data);
    assert.equal(reads, 2, "a late failure must not force a third read");
  });

  it("announcing a change clears the caches and notifies subscribers", async () => {
    let reads = 0;
    const fake = fakeSdk();
    __setFirestoreForTests({
      ...fake.module,
      getDoc: async (ref) => {
        reads += 1;
        return { id: ref.id, exists: () => true, data: () => ({ path: `docs/${reads}.md` }) };
      },
    });

    await readDoc("documentation", "docs__a.md");
    let notified = 0;
    onContentChange(() => {
      notified += 1;
    });
    announceContentChange(`commit:${"e".repeat(40)}`);
    assert.equal(notified, 1);

    await readDoc("documentation", "docs__a.md");
    assert.equal(reads, 2);
  });

  it("keeps refreshing the other subscribers when one of them throws", () => {
    let reached = 0;
    onContentChange(() => {
      throw new Error("a broken subscriber");
    });
    onContentChange(() => {
      reached += 1;
    });
    announceContentChange("commit:test");
    assert.equal(reached, 1);
  });

  it("stops notifying a subscriber that unsubscribed", () => {
    let notified = 0;
    const off = onContentChange(() => {
      notified += 1;
    });
    off();
    announceContentChange("commit:test");
    assert.equal(notified, 0);
  });
});
