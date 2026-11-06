import test from "node:test";
import assert from "node:assert/strict";

import { inferLanguage, inferLanguagePlugin, looksLikeArt } from "../src/lib/infer-language.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// The samples below are copied from the canonical repository rather than invented, so a test
// that passes here says something about what the site actually renders. The diagram and the
// shell transcript are the two shapes that used to be mislabelled.

const ARCHITECTURE_DIAGRAM = [
  "source (.oq)",
  "   |",
  "   v",
  " Lexer  -> tokens (with spans)",
  "   |",
  "   v",
  " Parser -> AST",
  "   |",
  "   v",
  " Interpreter (tree-walking, todays backend)",
  "   |",
  "   +-> Runtime values (List, Map, Set, OqData, OqRange, Java objects)",
  "   +-> Stdlib (text, files, JSON, time, HTTP, processes)",
  "   +-> JavaBridge (reflection for `use`, constructors, methods, static calls)",
].join("\n");

const ERROR_DIAGNOSTIC = [
  "main.oq:3:5: error: undefined name 'total'",
  "  3 |     print total",
  "    |           ^^^^^",
  "    |",
  "    --> did you mean 'tol'?",
].join("\n");

const OQ_SAMPLE = [
  'name = "Ada"',
  "count = 0",
  "count = count + 1",
].join("\n");

const OQ_BLOCK_SAMPLE = [
  "data Point(x, y)",
  "fun distance(a, b)",
  "  dx = a.x - b.x",
  "  return sqrt(dx * dx + dy * dy)",
  "end",
].join("\n");

const SHELL_SAMPLE = [
  "$ java -jar oq-cli/build/libs/oq.jar build build/oqdoc/hello.oq",
  "compiled build/oqdoc/hello.oq (0 functions, 5 main instructions)",
].join("\n");

const GRADLE_SAMPLE = [
  "# Every target, using each @FuzzTest(maxDuration = ...) annotation.",
  "JAZZER_FUZZ=1 ./gradlew --no-daemon fuzzTest",
].join("\n");

test("Oqthara samples are recognised", () => {
  assert.equal(inferLanguage(OQ_SAMPLE), "oq");
  assert.equal(inferLanguage(OQ_BLOCK_SAMPLE), "oq");
  assert.equal(inferLanguage("for n in 1 to 5\n  print n\nend"), "oq");
});

test("lambdas are recognised as Oqthara, not as diagram art", () => {
  assert.equal(inferLanguage("f = x -> x + 1\nprint f(2)"), "oq");
  assert.equal(inferLanguage('xs.map(x -> x * 2)'), "oq");
});

test("shell transcripts are recognised", () => {
  assert.equal(inferLanguage(SHELL_SAMPLE), "bash");
  assert.equal(inferLanguage(GRADLE_SAMPLE), "bash");
  assert.equal(inferLanguage("curl -fsSL https://example.invalid/install.sh | bash"), "bash");
});

test("an ASCII architecture diagram stays unlabelled", () => {
  // This is the second fenced block in docs/spec/design.md. It used to be labelled `oq`
  // because each `->` line scored as a lambda.
  assert.equal(looksLikeArt(ARCHITECTURE_DIAGRAM), true);
  assert.equal(inferLanguage(ARCHITECTURE_DIAGRAM), null);
});

test("an error diagnostic with pipes and an arrow stays unlabelled", () => {
  assert.equal(inferLanguage(ERROR_DIAGNOSTIC), null);
});

test("a box-drawing directory tree stays unlabelled", () => {
  const tree = ["docs/", "├── spec/", "│   └── language.md", "└── adr/"].join("\n");
  assert.equal(looksLikeArt(tree), true);
  assert.equal(inferLanguage(tree), null);
});

test("JSON is not silently labelled as Oqthara", () => {
  assert.equal(inferLanguage('{"a": 1, "b": [1, 2]}'), null);
});

test("already-tagged blocks are never retagged", () => {
  // The plugin is a rehype transformer over an hast tree. `language-bash` must survive, and a
  // block that names a language must not be given a second one.
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        children: [
          {
            type: "element",
            tagName: "code",
            properties: { className: ["language-bash"] },
            children: [{ type: "text", value: OQ_SAMPLE }],
          },
        ],
      },
    ],
  };
  inferLanguagePlugin()(tree);
  assert.deepEqual(tree.children[0].children[0].properties.className, ["language-bash"]);
});

test("inline code is never touched", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "p",
        children: [
          {
            type: "element",
            tagName: "code",
            properties: {},
            children: [{ type: "text", value: "for n in 1 to 5" }],
          },
        ],
      },
    ],
  };
  inferLanguagePlugin()(tree);
  assert.deepEqual(tree.children[0].children[0].properties, {});
});

test("an untagged pre gets the inferred language class", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        children: [
          {
            type: "element",
            tagName: "code",
            properties: {},
            children: [{ type: "text", value: OQ_SAMPLE }],
          },
        ],
      },
    ],
  };
  inferLanguagePlugin()(tree);
  assert.deepEqual(tree.children[0].children[0].properties.className, ["language-oq"]);
});

test("the grammar's keyword list matches the canonical lexer", () => {
  // Guard against the earlier defect: the grammar listed `elseif`, `raise`, `is` and `until`,
  // none of which the lexer defines, and omitted `true`, `false` and `nothing`.
  const source = readFileSync(join(HERE, "..", "src", "lib", "oqthara-grammar.js"), "utf8");
  const match = /export const OQ_KEYWORDS = \[([\s\S]*?)\];/.exec(source);
  assert.ok(match, "OQ_KEYWORDS array is present");
  const keywords = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]).sort();
  assert.deepEqual(keywords, [
    "and", "break", "catch", "continue", "data", "else", "end", "false", "for", "fun",
    "if", "in", "not", "nothing", "or", "return", "true", "try", "use", "while",
  ]);
  assert.equal(keywords.length, 20);
});
