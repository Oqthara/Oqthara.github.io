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
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  audit,
  canonicalStructures,
  fences,
  knownStructures,
  publishedDocuments,
  publishedSections,
  isTranscript,
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

test("an untagged block that infers no language is reported as uncoloured", () => {
  // The site infers a language for a bare fence before rendering it, so an untagged block is
  // only a defect when the inference declines too: then the example is drawn with no grammar at
  // all. Two `print` lines score above the threshold, so the block is untagged but still
  // coloured, and the two counts must not be confused.
  const root = project({ document: "```\nprint upper(\"a\")\nprint length(\"a\")\n```\n" });
  const result = run(root);
  assert.equal(result.untagged.length, 1);
  assert.equal(result.uncoloured.length, 0, "inference colours this block, so it is not a defect");
  rmSync(root, { recursive: true, force: true });
});

test("an untagged block the inference declines is reported as uncoloured", () => {
  // A single short call carries one weak signal -- `upper` is a builtin, `fraction_add` is not
  // in the grammar's builtin list -- so the score stays under the threshold and the block would
  // render plain while still being Oqthara. This is the finding the phase exists to catch.
  const root = project({ document: "```\nfraction_add(1, 2)\n```\n" });
  const result = run(root);
  assert.deepEqual(
    result.uncoloured.map((u) => u.line),
    [1],
    "the block contains a canonical structure and infers no language",
  );
  rmSync(root, { recursive: true, force: true });
});

test("quoted diagnostics are output, not source, and are not reported", () => {
  // The canonical documents quote compiler output inside bare fences. `error` is itself a
  // grammar word, so a word-matching audit reports these blocks; plain rendering is correct for
  // them and colouring them as Oqthara would teach a structure the transcript does not have.
  const root = project({ document: "```\nerror: upper() needs 1 argument\n```\n" });
  const result = run(root);
  assert.equal(result.uncoloured.length, 0);
  assert.equal(isTranscript("error: upper() needs 1 argument"), true);
  rmSync(root, { recursive: true, force: true });
});

test("a shell prompt introducing a command is a transcript, not an example", () => {
  assert.equal(isTranscript("$ java -jar oq.jar build hello.oq"), true);
  assert.equal(isTranscript("codepath: interpreter launcher"), true);
  // A real program is never mistaken for a transcript, whichever line it starts on.
  assert.equal(isTranscript('print upper("a")'), false);
});

test("a diagram is not reported as an uncoloured example", () => {
  // `looksLikeArt` already decides this for the renderer, so the audit inherits the site's own
  // answer instead of inventing a second, disagreeing rule.
  const diagram = "source (.oq)\n   |\n   v\n Lexer -> tokens\n   |\n   v\n Parser -> AST";
  assert.equal(isTranscript(diagram), true);
});

test("an example that mentions an output line is still source", () => {
  // The exclusion must not swallow a real program: one source line is enough to keep the block.
  assert.equal(isTranscript('print upper("a")\nerror: nope'), false);
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

// The exit code is the audit's contract with CI, and it lives in the command-line entry point
// rather than in `audit()`, so it is only tested by running the script. Three mutations that
// broke the contract in the past were invisible to tests that called `audit()` directly.
// Run from the fixture root so the script resolves `src/lib/oqthara-grammar.js` against the
// fixture grammar. The script reads that path relative to the working directory, which is what
// lets a test control it without importing the module under test.
function runCli(root) {
  return spawnSync(process.execPath, [resolve("scripts/audit-code-blocks.mjs"), `--docs=${root}`], {
    cwd: root,
    encoding: "utf8",
  });
}

test("the audit exits 2 when an untagged block would render uncoloured", () => {
  // `upper` is in the grammar, so this block produces no drift finding. The only finding is
  // that it would render uncoloured, which is what makes this case isolate the exit contract:
  // an implementation that only counts grammar drift exits 0 here.
  const root = project({ document: "```\nupper(\"a\")\n```\n" });
  const result = runCli(root);
  assert.equal(result.status, 2, "a block that renders with no grammar is drift");
  assert.match(result.stdout, /UNCOLOURED/);
  rmSync(root, { recursive: true, force: true });
});

test("the audit exits 2 when a canonical structure is missing from the grammar", () => {
  const root = project({ document: "```oq\nfraction_add(1, 2)\n```\n" });
  const result = runCli(root);
  assert.equal(result.status, 2, "a structure the grammar cannot colour is drift");
  assert.match(result.stdout, /DRIFT/);
  rmSync(root, { recursive: true, force: true });
});

test("the audit exits 0 when every block is coloured and every structure known", () => {
  const root = project({ document: "```oq\nprint upper(\"a\")\n```\n" });
  const result = runCli(root);
  assert.equal(result.status, 0, "a clean baseline must not fail CI");
  rmSync(root, { recursive: true, force: true });
});

test("a reference with neither keywords nor functions is not read as an empty language", () => {
  assert.equal(canonicalStructures("# nothing here\n"), null);
});

test("a grammar missing a structure list is reported rather than treated as empty", () => {
  assert.equal(knownStructures('export const OQ_KEYWORDS = ["fun"];'), null);
});
