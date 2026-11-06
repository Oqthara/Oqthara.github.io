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

import { OQ_KEYWORDS, OQ_BUILTINS } from "./oqthara-grammar.js";

const SHELL_COMMANDS = [
  "java", "javap", "javac", "jar", "gradle", "gradlew", "npm", "npx", "node", "python", "python3",
  "pip", "curl", "git", "cd", "ls", "mkdir", "rm", "cp", "mv", "cat", "echo", "export", "shasum",
  "sha256sum", "powershell", "irm", "iex", "docker", "unzip", "tar", "chmod", "./gradlew",
];

const KEYWORDS = new Set(OQ_KEYWORDS);
const LITERALS = new Set(["true", "false", "nothing"]);
const BUILTINS = new Set(OQ_BUILTINS);

/** Lines that only make sense in a shell transcript. */
const SHELL_LINE =
  /^\s*(?:\$|>|PS>)\s|^\s*(?:JAZZER_FUZZ|OQ_VERSION|JAVA_HOME)=|^\s*(?:[A-Za-z_][\w-]*=\S+\s+)?(?:\.\/)?(?:[\w.-]+\/)*gradlew\b/;

/** A block continuation, such as a shell command split over two lines with a trailing `\`. */
const CONTINUED = /\\\s*$/;

const OQ_ASSIGNMENT = /^[A-Za-z_]\w*\s*=\s*(?!=)(?!.*\b(?:if|then|fi)\b)/;
const OQ_CALL = /^[A-Za-z_]\w*\s*"/;

function shellScore(lines) {
  let score = 0;
  for (const line of lines) {
    if (SHELL_LINE.test(line)) score += 3;
    const first = /^\s*([A-Za-z_][\w.-]*)\s/.exec(line);
    if (first && SHELL_COMMANDS.includes(first[1])) score += 2;
    if (CONTINUED.test(line)) score += 1;
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
    if (OQ_ASSIGNMENT.test(trimmed)) score += 1;
    if (/\b(?:to|until)\b/.test(trimmed) && /\bfor\b/.test(trimmed)) score += 2;
    if (/->/.test(trimmed)) score += 1;
    if (/\{.*\}/.test(trimmed) && /"/.test(trimmed)) score += 1;
    if (/^\s*(?:end|else|else\s+if)\s*$/.test(trimmed)) score += 2;
    if (/\bfun\s+\w+\s*\(/.test(trimmed)) score += 3;
    if (/\bdata\s+[A-Z]\w*\s*\(/.test(trimmed)) score += 3;
  }
  return score;
}

/**
 * The language name for a fence body, or `null` when it is not recognisable.
 *
 * Shell wins ties because a transcript often contains words that are also Oqthara keywords
 * (`for`, `in`, `do`), while the reverse confusion is rare.
 */
export function inferLanguage(text) {
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
