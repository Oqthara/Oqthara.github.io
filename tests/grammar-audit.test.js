import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  grammarOperators,
  lexerOperators,
  parserRangeOperators,
  readGrammarArrays,
  referenceFunctions,
  referenceKeywords,
  uncoveredOperators,
} from "../scripts/audit-grammar.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const GRAMMAR = readFileSync(join(ROOT, "src", "lib", "oqthara-grammar.js"), "utf8");
const AUDIT = join(ROOT, "scripts", "audit-grammar.mjs");

/** A minimal stand-in for the generated reference, in the shape `oq doc` emits. */
const REFERENCE = [
  "# Standard library reference",
  "",
  "## Keywords",
  "",
  "`and`, `break`, `const`, `if`",
  "",
  "4 keywords (budget: 30).",
  "",
  "## Global functions",
  "",
  "| Function | Source |",
  "|---|---|",
  "| `abs` | built-in |",
  "| `print` | built-in |",
  "| `zip_decompress` | built-in |",
  "",
  "## Methods on values",
  "",
  "| Method | Applies to |",
  "|---|---|",
  "| `upper` | text |",
  "",
].join("\n");

test("the keyword section is read as a list", () => {
  assert.deepEqual(referenceKeywords(REFERENCE), ["and", "break", "const", "if"]);
  // A document without the section must be reported, not silently treated as empty.
  assert.equal(referenceKeywords("# Something else\n"), null);
});

test("the global functions table stops at the next section", () => {
  // `upper` appears under `## Methods on values` and is not a global function *in this fixture*.
  // Reading past the heading would import every method as a global and make the audit useless.
  assert.deepEqual(referenceFunctions(REFERENCE), ["abs", "print", "zip_decompress"]);
  assert.equal(referenceFunctions("# No table here\n"), null);
});

test("the grammar's exported arrays are read by name", () => {
  const arrays = readGrammarArrays(GRAMMAR);
  for (const name of ["OQ_KEYWORDS", "OQ_BUILTINS", "OQ_STATEMENT_BUILTINS", "OQ_RANGE_OPERATORS"]) {
    assert.ok(arrays.has(name), `${name} is declared`);
    assert.ok(arrays.get(name).length > 0, `${name} is not empty`);
  }
});

test("range operators are read from the parser's equality tests", () => {
  const parser = 'if (text.equals("to") || text.equals("until")) { return true; }';
  assert.deepEqual(parserRangeOperators(parser), ["to", "until"]);
  // A declaration-shaped refactor is understood too, so the audit does not rot on it.
  assert.deepEqual(parserRangeOperators('RANGE_OPERATORS = Set.of("until", "to")'), ["to", "until"]);
  // No operators at all is `null`, which the audit reports as not evaluated rather than green.
  assert.equal(parserRangeOperators("nothing here"), null);
});

test("the audit fails when the grammar is missing a structure", () => {
  // The defect this audit exists to catch, reproduced: a keyword the language defines but the
  // grammar does not list. The fixture is the grammar's own lists plus one invented keyword,
  // so `missing` is exactly that keyword and `unknown` is empty. Without this assertion the
  // audit could pass for the wrong reason.
  const arrays = readGrammarArrays(GRAMMAR);
  const keywords = arrays.get("OQ_KEYWORDS");
  const functions = grammarFunctions(arrays);
  // The invented keyword is appended to the reference, never to the grammar: the grammar is
  // what the site renders from, so it must stay exactly as shipped.
  const result = runAuditWithReference(referenceFor([...keywords, "zebra"], functions));

  assert.equal(result.status, 2, "drift exits 2");
  assert.match(result.stdout, /keywords \(22 canonical\): missing zebra/);
  // Nothing else drifted, so the only finding is the invented keyword. If this line read
  // `unknown ...` the fixture would be wrong, not the grammar.
  assert.doesNotMatch(result.stdout, /unknown /);
  assert.match(result.stdout, /global functions \(155 canonical\): in step/);
  assert.match(result.stdout, /DRIFT/);
});

test("the audit reports drift against a reference it cannot match", () => {
  // End to end, with no network: the fixture reference says four keywords and three global
  // functions, which the real grammar does not have. Exit code 2 is the documented drift code,
  // and both directions are reported — the grammar knows names the language does not.
  const result = runAuditWithReference(REFERENCE);
  assert.equal(result.status, 2, "drift exits 2");
  // Every fixture keyword is in the grammar (`const` included, since this audit is what found
  // it), so the grammar knows 17 names the fixture does not. That direction is drift too: a
  // grammar that colours a name the language does not define is as wrong as one that misses one.
  assert.match(result.stdout, /keywords \(4 canonical\): unknown catch, continue, data/);
  // Three canonical functions, all of which the grammar has, so nothing is missing. The fixture
  // also carries a `## Methods on values` table with `upper` in it; that it is counted as
  // unknown rather than canonical is what proves method rows are not imported as globals.
  assert.match(result.stdout, /global functions \(3 canonical\): unknown /);
  assert.match(result.stdout, /\bunknown [^\n]*\bupper\b/);
  assert.match(result.stdout, /range operators: not evaluated/);
  assert.match(result.stdout, /DRIFT/);
});

test("the audit is green against the real grammar and its own reference", () => {
  // Derived from the grammar itself, so this asserts the comparison logic is symmetric rather
  // than asserting a second copy of the language. The live check in CI is what compares those
  // lists with the canonical repository.
  const arrays = readGrammarArrays(GRAMMAR);
  const result = runAuditWithReference(referenceFor(arrays.get("OQ_KEYWORDS"), grammarFunctions(arrays)));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /No drift\./);
});

/** Every global the grammar knows, as the reference would list it: each name once. */
function grammarFunctions(arrays) {
  return [...new Set([...arrays.get("OQ_BUILTINS"), ...arrays.get("OQ_STATEMENT_BUILTINS")])];
}

/** The generated reference's shape, rendered from the given lists. */
function referenceFor(keywords, functions) {
  return [
    "# Standard library reference",
    "",
    "## Keywords",
    "",
    keywords.map((name) => `\`${name}\``).join(", "),
    "",
    `${keywords.length} keywords (budget: 30).`,
    "",
    "## Global functions",
    "",
    "| Function | Source |",
    "|---|---|",
    ...functions.map((name) => `| \`${name}\` | built-in |`),
    "",
  ].join("\n");
}

/**
 * Runs the audit against a reference written to a temporary checkout.
 *
 * `--local` also reads the parser for the range check. The fixture below contains no parser,
 * which exercises the honest "not evaluated" path instead of letting the check pass silently.
 */
function runAuditWithReference(reference) {
  const directory = mkdtempSync(join(tmpdir(), "oq-audit-"));
  const referencePath = join(directory, "docs", "stdlib");
  mkdirSync(referencePath, { recursive: true });
  writeFileSync(join(referencePath, "reference.md"), reference, "utf8");
  try {
    return spawnSync(process.execPath, [AUDIT, `--local=${directory}`], { encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

const LEXER = `
        TWO_CHAR.put("**", Token.Kind.STARSTAR);
        TWO_CHAR.put("==", Token.Kind.EQEQ);
        TWO_CHAR.put("!=", Token.Kind.NOTEQ);
        TWO_CHAR.put("<=", Token.Kind.LE);
        TWO_CHAR.put("+=", Token.Kind.PLUS_ASSIGN);
`;

test("lexerOperators reads the declared two-character table", () => {
  assert.deepEqual(lexerOperators(LEXER), ["!=", "**", "+=", "<=", "=="]);
  assert.equal(lexerOperators("no table here"), null);
});

test("grammarOperators separates the literals from the character class", () => {
  const rule = "    operator: /\\*\\*|->|[-+*/%=<>!|]=?/,";
  assert.deepEqual(grammarOperators(rule), {
    literals: ["**", "->"],
    classChars: "-+*/%=<>!|",
    optionalEquals: true,
  });
  assert.equal(grammarOperators("no operator rule"), null);
});

test("coverage accepts the compact character-class spelling", () => {
  const grammar = { literals: ["**", "->"], classChars: "-+*/%=<>!|", optionalEquals: true };
  assert.deepEqual(uncoveredOperators(["**", "==", "+=", "<="], grammar), { missing: [], canonical: 4 });
});

test("coverage reports an operator the grammar cannot match", () => {
  const grammar = { literals: ["**"], classChars: "-+", optionalEquals: false };
  const result = uncoveredOperators(["**", "==", "->"], grammar);
  assert.deepEqual(result.missing, ["->", "=="]);
});

test("coverage is evaluated, not skipped, when a source is unreadable", () => {
  assert.equal(uncoveredOperators(null, { literals: [], classChars: "", optionalEquals: false }), null);
  assert.equal(uncoveredOperators(["**"], null), null);
});

// The language has no `..` operator: the lexer reads two dots as a DOT then a DOT, and
// `x .. 3` is rejected as a missing field name. A grammar rule for it would colour a token that
// cannot occur, so this asserts the phantom stays gone.
test("the grammar defines no operator the language lacks", () => {
  const rule = /^\s*operator:\s*\/(.+?)\/,\s*$/m.exec(GRAMMAR);
  assert.ok(rule, "the top-level operator rule should be present");
  assert.ok(!rule[1].includes("\\."), "the operator rule must not carry a `..` alternative");
});

test("the grammar covers every operator the lexer declares", () => {
  // The lexer fixture above is the shape of `Lexer.TWO_CHAR`; the real table is read by the live
  // audit against GitHub, so this asserts the reader and the grammar agree on a realistic sample.
  const result = uncoveredOperators(lexerOperators(LEXER), grammarOperators(GRAMMAR));
  assert.deepEqual(result.missing, []);
  assert.equal(result.canonical, 5);
});
