// Tests for scripts/audit-code-blocks.mjs.
//
// The audit answers a question `audit-grammar.mjs` cannot: does a *document* render a structure
// the grammar cannot colour? A grammar can cover every keyword and still leave an example
// unreadable because the block was never tagged, and an example can be correct while the grammar
// draws its constructs as plain identifiers.
//
// Two failure modes are tested because a check that has only ever passed cannot be told apart
// from one that never runs:
//
//   * a block that uses a canonical structure the grammar does not know -- the real finding;
//   * a block that uses a name the *example itself* defines -- which must stay silent, because
//     a report full of user-defined classes is a report nobody reads.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  audit,
  canonicalStructures,
  fences,
  knownStructures,
  publishedDocuments,
  publishedSections,
  stripCommentsAndStrings,
} from "../scripts/audit-code-blocks.mjs";

const GRAMMAR = [
  'export const OQ_KEYWORDS = ["fun", "if", "end"];',
  'export const OQ_BUILTINS = ["upper", "length"];',
  'export const OQ_STATEMENT_BUILTINS = ["print"];',
  'export const OQ_CONTEXTUAL_KEYWORDS = ["class"];',
].join("\n");

const REFERENCE = [
  "# Standard library reference",
  "",
  "## Keywords",
  "",
  "`fun`, `if`, `end`",
  "",
  "## Global functions",
  "",
  "| Function | Source |",
  "|---|---|",
  "| `upper` | built-in |",
  "| `length` | built-in |",
  "| `fraction_add` | built-in |",
  "",
].join("\n");

/** A repository with an allowlist, the grammar, the reference and one document. */
function project({ document, source }) {
  const root = mkdtempSync(join(tmpdir(), "oqblocks-"));
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  mkdirSync(join(root, "docs", "spec"), { recursive: true });
  mkdirSync(join(root, "docs", "stdlib"), { recursive: true });
  writeFileSync(join(root, "src", "source.js"), source ??
    'const PUBLISHED_SECTIONS = new Set(["spec", "stdlib"]);\n' +
    'const PUBLISHED_ROOT_FILES = new Set(["README.md"]);\n');
  writeFileSync(join(root, "src", "lib", "oqthara-grammar.js"), GRAMMAR);
  writeFileSync(join(root, "docs", "stdlib", "reference.md"), REFERENCE);
  writeFileSync(join(root, "docs", "spec", "language.md"), document);
  return root;
}

function run(root) {
  return audit({
    root,
    docs: root,
    grammar: GRAMMAR,
    known: knownStructures(GRAMMAR),
    canonical: canonicalStructures(REFERENCE),
  });
}

test("the allowlist is read from source.js rather than hardcoded", () => {
  const parsed = publishedSections(
    'const PUBLISHED_SECTIONS = new Set(["spec", "guides"]);\n' +
    'const PUBLISHED_ROOT_FILES = new Set(["README.md"]);\n');
  assert.deepEqual(parsed.sections, ["spec", "guides"]);
  assert.deepEqual(parsed.rootFiles, ["readme.md"]);
});

test("a missing allowlist is reported, not guessed", () => {
  assert.equal(publishedSections("const NOTHING = 1;"), null);
});

test("documents are found under every allowed section", () => {
  const root = mkdtempSync(join(tmpdir(), "oqblocks-"));
  mkdirSync(join(root, "docs", "spec"), { recursive: true });
  mkdirSync(join(root, "docs", "design"), { recursive: true });
  writeFileSync(join(root, "docs", "spec", "language.md"), "# a");
  writeFileSync(join(root, "docs", "design", "notes.md"), "# b");
  const found = publishedDocuments(root, { sections: ["spec"], rootFiles: [] });
  assert.deepEqual(found, ["docs/spec/language.md"]);
  rmSync(root, { recursive: true, force: true });
});

test("fences keep their language tag and the line they start on", () => {
  const blocks = fences("# t\n\n```oq\nprint 1\n```\n\n```bash\necho\n```\n");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].language, "oq");
  assert.equal(blocks[0].line, 3);
  assert.equal(blocks[1].language, "bash");
});

test("comments and strings are stripped before a structure is counted", () => {
  const stripped = stripCommentsAndStrings('print fraction_add(1, 2)  # fraction_of is prose\nx = "fraction_text"');
  assert.ok(!stripped.includes("fraction_of"), "a structure named in a comment is not code");
  assert.ok(!stripped.includes("fraction_text"), "a structure named in a string is not code");
  assert.ok(stripped.includes("fraction_add"), "a structure in code is kept");
});

test("a canonical builtin the grammar cannot colour is reported", () => {
  const root = project({ document: "```oq\nfraction_add(1, 2)\n```\n" });
  const result = run(root);
  assert.equal(result.evaluated, true);
  assert.deepEqual(result.findings.map((f) => f.word), ["fraction_add"]);
  rmSync(root, { recursive: true, force: true });
});

test("a name the example itself defines is not reported", () => {
  // `Counter` is declared by the document and `class` is canonical. Reporting `Counter` would
  // bury the real finding in every user-defined type in the specification.
  const root = project({ document: "```oq\nclass Counter\n  init(n)\nend\nCounter(1)\n```\n" });
  const result = run(root);
  assert.deepEqual(result.findings, []);
  rmSync(root, { recursive: true, force: true });
});

test("a canonical structure the grammar knows is not reported", () => {
  const root = project({ document: "```oq\nprint upper(\"a\")\n```\n" });
  const result = run(root);
  assert.deepEqual(result.findings, []);
  rmSync(root, { recursive: true, force: true });
});

test("an Oqthara-shaped block with no tag is reported as untagged", () => {
  const root = project({ document: "```\nprint upper(\"a\")\n```\n" });
  const result = run(root);
  assert.equal(result.untagged.length, 1, "the block is Oqthara-shaped but carries no tag");
  rmSync(root, { recursive: true, force: true });
});

test("a block tagged with another language is not scanned", () => {
  // The body is Oqthara on purpose: were the language filter removed, this block would be
  // scanned and `fraction_add` reported. A body that is not Oqthara either way would let the
  // mutation through, which is how the first version of this test missed it.
  const root = project({ document: "```bash\nfraction_add(1, 2)\nprint upper(\"a\")\n```\n" });
  const result = run(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.untagged.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("an annotated shell comment is not mistaken for an Oqthara block", () => {
  // `# comment` alone is not structure; a block of ordinary prose must stay unreported.
  const root = project({ document: "```\n# just a note\nsome words here\n```\n" });
  const result = run(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.untagged.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("a reference with neither keywords nor functions is not read as an empty language", () => {
  assert.equal(canonicalStructures("# nothing here\n"), null);
});

test("a grammar missing a structure list is reported rather than treated as empty", () => {
  assert.equal(knownStructures('export const OQ_KEYWORDS = ["fun"];'), null);
});
