import test from "node:test";
import assert from "node:assert/strict";

import {
  SEARCH_LIMIT,
  activeOptionId,
  keyAction,
  moveActive,
  optionId,
  rankEntries,
  tokenizeQuery,
} from "../src/search.js";

const ENTRIES = [
  { title: "Language", text: "Syntax and semantics of the language", url: "/docs/spec/language.html" },
  { title: "Bytecode", text: "The language compiles to bytecode", url: "/docs/adr/0003-bytecode.html" },
  { title: "Examples", text: "Hello world and anagrams", url: "/examples.html" },
  { title: "Language reference", text: "Tables of keywords", url: "/docs/reference/language.html" },
  { title: "Records", text: "language data definitions", url: "/docs/reference/records.html" },
];

test("tokenizeQuery lowercases, strips accents, splits and caps at eight tokens", () => {
  assert.deepEqual(tokenizeQuery("  Hello   World "), ["hello", "world"]);
  assert.deepEqual(tokenizeQuery("Café Résumé"), ["cafe", "resume"]);
  assert.deepEqual(tokenizeQuery(""), []);
  assert.deepEqual(tokenizeQuery(null), []);
  const many = tokenizeQuery("a b c d e f g h i j k");
  assert.equal(many.length, 8);
  assert.deepEqual(many, ["a", "b", "c", "d", "e", "f", "g", "h"]);
});

test("rankEntries returns [] for an empty query or a non-array index", () => {
  assert.deepEqual(rankEntries(ENTRIES, ""), []);
  assert.deepEqual(rankEntries(ENTRIES, "   "), []);
  assert.deepEqual(rankEntries(null, "language"), []);
  assert.deepEqual(rankEntries(undefined, "language"), []);
});

test("a title match outranks a body-only match", () => {
  const entries = [
    { title: "Runtime notes", text: "the bytecode format", url: "/docs/a.html" },
    { title: "Bytecode", text: "", url: "/docs/b.html" },
  ];
  const results = rankEntries(entries, "bytecode");
  assert.equal(results.length, 2);
  // Title contains "bytecode" (8) beats body-only (3), regardless of index order.
  assert.equal(results[0].title, "Bytecode");
  assert.equal(results[1].title, "Runtime notes");
});

test("a title that starts with the token outranks one that merely contains it", () => {
  const entries = [
    { title: "Reference for language", text: "", url: "" },
    { title: "Language", text: "", url: "" },
  ];
  const results = rankEntries(entries, "language");
  assert.deepEqual(results.map((entry) => entry.title), ["Language", "Reference for language"]);
});

test("every token must match", () => {
  const results = rankEntries(ENTRIES, "language bytecode");
  // Bytecode's title has "bytecode" and its body has "language": the only entry with both.
  assert.deepEqual(results.map((entry) => entry.title), ["Bytecode"]);
  // "language examples" matches nothing: no entry has both tokens.
  assert.deepEqual(rankEntries(ENTRIES, "language examples"), []);
});

test("a URL-only match still ranks but below body and title matches", () => {
  const entries = [
    { title: "Alpha", text: "", url: "/docs/bytecode/a.html" },
    { title: "Bytecode", text: "", url: "/x" },
    { title: "Beta", text: "bytecode text", url: "/x" },
  ];
  const results = rankEntries(entries, "bytecode");
  assert.deepEqual(results.map((entry) => entry.title), ["Bytecode", "Beta", "Alpha"]);
});

test("limit is respected and zero or negative limits return nothing", () => {
  const long = Array.from({ length: 30 }, (_, index) => ({
    title: `Language ${index}`,
    text: "",
    url: "",
  }));
  assert.equal(rankEntries(long, "language").length, SEARCH_LIMIT);
  assert.equal(rankEntries(long, "language", 3).length, 3);
  assert.equal(rankEntries(long, "language", 0).length, 0);
  assert.equal(rankEntries(long, "language", -2).length, 0);
  assert.equal(rankEntries(long, "language", 100).length, 30);
});

test("equal scores keep the index order, so results are stable", () => {
  const entries = [
    { title: "Language A", text: "", url: "" },
    { title: "Language B", text: "", url: "" },
    { title: "Language C", text: "", url: "" },
  ];
  const first = rankEntries(entries, "language").map((entry) => entry.title);
  const second = rankEntries(entries, "language").map((entry) => entry.title);
  assert.deepEqual(first, ["Language A", "Language B", "Language C"]);
  assert.deepEqual(first, second);
});

test("accent-insensitive matching works in titles and text", () => {
  const entries = [{ title: "Café", text: "", url: "" }];
  assert.equal(rankEntries(entries, "cafe").length, 1);
  assert.equal(rankEntries(entries, "CAFÉ").length, 1);
});

test("moveActive moves down, up and clamps at the ends", () => {
  assert.equal(moveActive(-1, "ArrowDown", 3), 0);
  assert.equal(moveActive(0, "ArrowDown", 3), 1);
  assert.equal(moveActive(2, "ArrowDown", 3), 2);
  assert.equal(moveActive(-1, "ArrowUp", 3), 2);
  assert.equal(moveActive(1, "ArrowUp", 3), 0);
  assert.equal(moveActive(0, "ArrowUp", 3), 0);
  assert.equal(moveActive(1, "Tab", 3), 1);
  assert.equal(moveActive(1, "ArrowDown", 0), -1);
  assert.equal(moveActive(1, "ArrowDown", -1), -1);
});

test("keyAction maps keyboard actions while collapsed and expanded", () => {
  assert.deepEqual(keyAction("Escape", { expanded: true }), { type: "close" });
  assert.equal(keyAction("Escape", { expanded: false }), null);

  assert.deepEqual(keyAction("Enter", { expanded: true, active: 2, count: 3 }), {
    type: "open",
    index: 2,
  });
  // No selection yet: Enter opens the first option.
  assert.deepEqual(keyAction("Enter", { expanded: true, active: -1, count: 3 }), {
    type: "open",
    index: 0,
  });
  assert.equal(keyAction("Enter", { expanded: false, count: 3 }), null);
  assert.equal(keyAction("Enter", { expanded: true, count: 0 }), null);

  assert.deepEqual(keyAction("ArrowDown", { expanded: true, active: 0, count: 3 }), {
    type: "move",
    index: 1,
  });
  assert.deepEqual(keyAction("ArrowUp", { expanded: true, active: 1, count: 3 }), {
    type: "move",
    index: 0,
  });
  // Arrows do nothing while the panel is collapsed or there are no results.
  assert.equal(keyAction("ArrowDown", { expanded: false, count: 3 }), null);
  assert.equal(keyAction("ArrowDown", { expanded: true, count: 0 }), null);
  assert.equal(keyAction("a", { expanded: true, count: 3 }), null);
});

test("optionId and activeOptionId agree with the markup contract", () => {
  assert.equal(optionId(0), "site-search-option-0");
  assert.equal(optionId(7), "site-search-option-7");
  assert.equal(activeOptionId(true, 2), "site-search-option-2");
  assert.equal(activeOptionId(true, -1), undefined);
  assert.equal(activeOptionId(false, 2), undefined);
  assert.equal(activeOptionId(true, 1.5), undefined);
  assert.equal(activeOptionId(true, null), undefined);
});
