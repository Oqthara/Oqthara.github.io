// Chooses a language for a fenced code block that did not name one.
//
// The canonical documents in Oqthara/oqthara use mostly bare fences: 84 of the 96 blocks
// across the specification, reference and standard library carry no language tag. Prism
// therefore highlighted nothing, and every example rendered in one colour.
//
// The language repository is read-only for this project, so the inference has to happen here.
// It is deliberately conservative and evidence-based rather than clever: a block is only
// labelled when its content plainly matches, and an ambiguous block stays unlabelled so it is
// rendered as plain text instead of being coloured with the wrong grammar.

import { OQ_KEYWORDS, OQ_BUILTINS, OQ_STATEMENT_BUILTINS } from "./oqthara-grammar.js";

const SHELL_COMMANDS = [
  "java", "javap", "javac", "jar", "gradle", "gradlew", "npm", "npx", "node", "python", "python3",
  "pip", "curl", "git", "cd", "ls", "mkdir", "rm", "cp", "mv", "cat", "echo", "export", "shasum",
  "sha256sum", "powershell", "irm", "iex", "docker", "unzip", "tar", "chmod", "./gradlew",
];

const KEYWORDS = new Set(OQ_KEYWORDS);
const LITERALS = new Set(["true", "false", "nothing"]);
const BUILTINS = new Set([...OQ_BUILTINS, ...OQ_STATEMENT_BUILTINS]);

/** Lines that only make sense in a shell transcript. */
const SHELL_LINE =
  /^\s*(?:\$|>|PS>)\s|^\s*(?:JAZZER_FUZZ|OQ_VERSION|JAVA_HOME)=|^\s*(?:[A-Za-z_][\w-]*=\S+\s+)?(?:\.\/)?(?:[\w.-]+\/)*gradlew\b/;

/** A block continuation, such as a shell command split over two lines with a trailing `\`. */
const CONTINUED = /\\\s*$/;

const OQ_ASSIGNMENT = /^[A-Za-z_]\w*\s*=\s*(?!=)(?!.*\b(?:if|then|fi)\b)/;
const OQ_CALL = /^[A-Za-z_]\w*\s*"/;

/** Every `name(` in a line, so a builtin can be recognised where it is not the first word. */
const CALL_SITE = /(^|[^\w.])([A-Za-z_]\w*)\s*\(/g;

/**
 * A range written as an expression rather than as a loop header: `(5 to 1)`, `[0 until n]`.
 *
 * The parenthesis or bracket is the whole signal. `for x in 0 to 10` is already recognised by
 * the `for` rule, but the specification also shows ranges as values -- `(5 to 1).to_list()` and
 * `length(0 to 3000000000)` -- and those scored nothing at all.
 *
 * The closing bracket must follow the upper bound directly, so prose that merely mentions a
 * span -- `(5 to 10 seconds)` -- does not match and stays plain.
 */
const RANGE_VALUE = /\b(?:to|until)\s+[-\w."']+[)\]]/;

function shellScore(lines) {
  let score = 0;
  for (const line of lines) {
    if (SHELL_LINE.test(line)) score += 3;
    const first = /^\s*([A-Za-z_][\w.-]*)\s/.exec(line);
    if (first && SHELL_COMMANDS.includes(first[1])) score += 3;
    if (CONTINUED.test(line)) score += 1;
    // A pipeline into a shell interpreter, or a `curl`/`wget` invocation, is shell even when
    // it is the only line in the block. This is how the documentation writes its install
    // command, which used to stay unlabelled and render in one colour.
    if (/\|\s*(?:ba|z|k)?sh\b/.test(line)) score += 3;
    if (/\b(?:curl|wget)\b/.test(line)) score += 2;
  }
  return score;
}

function oqtharaScore(lines) {
  let score = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      score += 1; // a comment reads the same in Oqthara and in a shell script
      continue;
    }
    const word = /^([A-Za-z_]\w*)\b/.exec(trimmed);
    if (word) {
      if (KEYWORDS.has(word[1])) score += 3;
      else if (LITERALS.has(word[1]) && /\b(?:true|false|nothing)\b/.test(trimmed)) score += 1;
      else if (BUILTINS.has(word[1])) score += 2;
    }
    if (OQ_CALL.test(trimmed)) score += 2;
    // A builtin called anywhere on the line, not only as its first word. The specification
    // writes `print length(0 to 3000000000)` and `print (5 to 1).to_list()`, where the builtin
    // that makes the line Oqthara is `length` or `to_list`, never the leading `print`.
    //
    // A leading builtin is skipped: it was already scored above, and counting the same evidence
    // twice would lift a lone `fraction_add(1, 2)` over the threshold and label a block that
    // carries one weak signal as Oqthara.
    for (const call of trimmed.matchAll(CALL_SITE)) {
      if (call.index + call[1].length === 0) continue;
      if (BUILTINS.has(call[2])) {
        score += 2;
        break;
      }
    }
    if (RANGE_VALUE.test(trimmed)) score += 2;
    // A method call on a receiver, `xs.map(x -> x * 2)`, is Oqthara. It appears as a single
    // line in the language reference and scored nothing before.
    //
    // No space is allowed before the `(`. A transcript line such as
    // `wrote build/oqdoc/arith.jar (99 classes)` is not a method call, but `.\w+\s*\(`
    // accepted it — two such lines were enough to outvote the shell transcript they sit in and
    // label a compiler log as Oqthara source.
    if (/\b\w+\.\w+\(/.test(trimmed)) score += 2;
    if (OQ_ASSIGNMENT.test(trimmed)) score += 1;
    if (/\b(?:to|until)\b/.test(trimmed) && /\bfor\b/.test(trimmed)) score += 2;
    // A lambda arrow scores only when an expression precedes it. Diagram arrows (`+->`,
    // `-->`, `| ->`) are art, not code, and used to be enough to label an architecture
    // picture as Oqthara.
    if (/[\w)\]"']\s*->/.test(trimmed)) score += 1;
    if (/\{.*\}/.test(trimmed) && /"/.test(trimmed)) score += 1;
    if (/^\s*(?:end|else|else\s+if)\s*$/.test(trimmed)) score += 2;
    if (/\bfun\s+\w+\s*\(/.test(trimmed)) score += 3;
    if (/\bdata\s+[A-Z]\w*\s*\(/.test(trimmed)) score += 3;
  }
  return score;
}

/**
 * True when a block is ASCII art rather than source: an architecture diagram, a directory
 * tree, or a table drawn with box characters.
 *
 * The canonical design document contains such a picture between two real code samples, and
 * colouring it as Oqthara was worse than leaving it plain, because the colours implied a
 * structure the picture does not have.
 *
 * The signal is deliberately narrow. An earlier version counted any line containing a slash
 * or a dash, which also matched shell paths (`build/oqdoc/hello.oq`) and mislabelled a plain
 * transcript. What actually distinguishes a diagram is the presence of lines that carry no
 * words at all: `|`, `v`, `+-->`, and the box-drawing characters used for trees.
 */
const BOX_DRAWING = /[\u2500-\u257f]/;
const DRAWING_ONLY = /^(?:[|+*^<>v=_\-\\/.:]|\s)+$/i;

export function looksLikeArt(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  if (lines.length < 3) return false;

  let artLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    // A tree drawn with box characters is art on every line that uses them.
    if (BOX_DRAWING.test(trimmed)) {
      artLines += 1;
      continue;
    }
    // A line made only of drawing glyphs — `|`, `v`, `+--->`, `...` — has no words in it.
    if (!/[A-Za-z0-9]/.test(trimmed) && DRAWING_ONLY.test(trimmed)) artLines += 1;
  }
  // At least two such lines, and a visible share of the block, or it is ordinary code that
  // happens to contain a `|` or a `-`.
  return artLines >= 2 && artLines >= lines.length * 0.2;
}

/**
 * The language name for a fence body, or `null` when it is not recognisable.
 *
 * Shell wins ties because a transcript often contains words that are also Oqthara keywords
 * (`for`, `in`, `do`), while the reverse confusion is rare.
 */
export function inferLanguage(text) {
  if (looksLikeArt(text)) return null;
  const lines = String(text ?? "").split("\n");
  const shell = shellScore(lines);
  const oq = oqtharaScore(lines);
  if (shell >= 3 && shell >= oq) return "bash";
  if (oq >= 3) return "oq";
  return null;
}

/**
 * Tags untagged `pre > code` blocks with the inferred language.
 *
 * This is a rehype transformer, so it runs on the hast tree before Prism. It only ever adds a
 * `language-*` class to a block that has none; a block that already names a language, or an
 * inline code span, is never touched.
 */
export function inferLanguagePlugin() {
  return (tree) => {
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.tagName === "pre" && Array.isArray(node.children)) {
        for (const child of node.children) {
          if (child?.tagName !== "code") continue;
          const properties = child.properties ?? (child.properties = {});
          const existing = properties.className ?? [];
          const names = Array.isArray(existing) ? existing : [existing];
          if (names.some((name) => /^language-/.test(String(name)))) continue;
          const text = (child.children ?? [])
            .map((part) => (part.type === "text" ? part.value : ""))
            .join("");
          const language = inferLanguage(text);
          if (language) properties.className = [...names, `language-${language}`];
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}
