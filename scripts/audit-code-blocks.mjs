// Detect language structures inside the documentation's code blocks that the site does not know.
//
// Why this exists
// ---------------
// `scripts/audit-grammar.mjs` answers a question about the *grammar*: is every keyword and
// builtin the language declares also a pattern the highlighter can match? It compares lists
// against lists. It cannot answer a question about the *documents*: does a block that is
// rendered as Oqthara actually contain anything a reader would expect to see coloured, and is
// anything in it a construct the grammar has never heard of?
//
// Those are different failures. A grammar can cover every keyword and still leave an example
// uncoloured because the block was never tagged and the inference declined it, and an example
// can use a construct correctly while the grammar colours it as an ordinary identifier -- which
// is what `class`, `contract` and `init` did until `OQ_CONTEXTUAL_KEYWORDS` existed. The second
// case is worse than a rendering bug: a reader sees a keyword drawn as a variable and learns
// the wrong shape.
//
// What counts as a structure
// --------------------------
// A name is *structure* when the language itself defines it, and an *identifier* when the
// document's own example defines it. `Counter` in `Counter(...)` is declared three lines above by
// the example, so the grammar cannot and should not know it; `path_normalize` is a global
// function the reference lists, so a grammar that cannot colour it teaches the wrong shape.
//
// The audit therefore takes two inputs and compares them: the reference (canonical structures)
// and the grammar (what can be coloured). A word in a published block that is canonical but
// unknown to the grammar is the finding. A word that is neither is an identifier and is silent.
//
// This is deliberately narrower than "any unrecognised word". A first attempt reported every
// user-defined class in the specification -- `Point`, `Counter`, `Account`, `BigDecimal`,
// `ArrayList` -- which is noise a maintainer would learn to ignore, and the real finding would be
// lost in it.
//
// Scope
// -----
// Only the documents the site publishes: the allowlist in `src/source.js`, which is the same
// list `tests/source.test.js` pins. Development documentation lives in the language repository
// and is deliberately not published, so auditing it here would check documents the site never
// renders and would drift from the allowlist the moment either changed.
//
// Exit codes
// ----------
//   0  every structure in the published blocks is one the grammar knows
//   1  usage error
//   2  drift: a block uses a structure the grammar cannot colour, or an Oqthara-looking block
//      is not tagged, so it is rendered with no grammar at all
//   3  the documents could not be read
//
// Usage
//   node scripts/audit-code-blocks.mjs --docs=/path/to/oqthara
//   node scripts/audit-code-blocks.mjs --docs=/path/to/oqthara --json

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The grammar's own source, read the same way `audit-grammar.mjs` reads it. */
const GRAMMAR_PATH = "src/lib/oqthara-grammar.js";

/** The generated reference in the language repository; the only hand-editing-proof source. */
const REFERENCE_PATH = "docs/stdlib/reference.md";

/**
 * Fences whose content is Oqthara, or is meant to be read as Oqthara.
 *
 * `text` is included because the canonical documents use it for program shapes that are not
 * meant to run; a structure in one of those is still a structure a reader has to recognise.
 */
const OQ_FENCES = new Set(["oq", "oqthara", "text"]);

/** A fence language that says the block is deliberately not Oqthara. */
const OTHER_FENCES = new Set([
  "bash", "sh", "shell", "console", "kotlin", "java", "js", "javascript", "json", "toml",
  "yaml", "yml", "xml", "html", "css", "sql", "powershell", "ps", "bat", "cmd", "diff",
  "ini", "properties", "csv", "markdown", "md", "python", "py", "go", "rust", "ts",
]);

const FENCE = /^```([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

/**
 * The documents the site publishes, from the allowlist in `src/source.js`.
 *
 * Read rather than hardcoded: a second copy of the list would let the audit and the publication
 * rule disagree, and the one that disagreed quietly would be the audit.
 */
export function publishedSections(source) {
  const sections = /const PUBLISHED_SECTIONS = new Set\(\[([^\]]*)\]\)/.exec(source);
  const roots = /const PUBLISHED_ROOT_FILES = new Set\(\[([^\]]*)\]\)/.exec(source);
  if (!sections || !roots) return null;
  const names = (text) => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1].toLowerCase());
  return { sections: names(sections[1]), rootFiles: names(roots[1]) };
}

/** Every markdown file the allowlist admits, relative to the repository root. */
export function publishedDocuments(root, { sections, rootFiles }) {
  const found = [];
  for (const section of sections) {
    const directory = join(root, "docs", section);
    for (const path of walk(directory)) found.push(relative(root, path));
  }
  for (const name of rootFiles) {
    for (const path of walk(root, { maxDepth: 1 })) {
      if (path.toLowerCase().endsWith("/" + name) || path.toLowerCase().endsWith(name)) {
        found.push(relative(root, path));
      }
    }
  }
  return [...new Set(found)].sort();
}

function walk(directory, { maxDepth = 8 } = {}) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return out;
  }
  if (maxDepth <= 0) return out;
  for (const entry of entries.sort()) {
    const path = join(directory, entry);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) out.push(...walk(path, { maxDepth: maxDepth - 1 }));
    else if (entry.toLowerCase().endsWith(".md")) out.push(path);
  }
  return out;
}

/** Every fenced block in a document, with its language tag and the line it starts on. */
export function fences(markdown) {
  const blocks = [];
  for (const match of markdown.matchAll(FENCE)) {
    const startLine = markdown.slice(0, match.index).split("\n").length;
    blocks.push({
      language: match[1].toLowerCase(),
      body: match[2],
      line: startLine,
    });
  }
  return blocks;
}

/**
 * The structures the grammar can colour.
 *
 * Empty entries are filtered: `readGrammarArrays` returns an empty array for a declaration it
 * could not parse, and treating that as "the grammar knows nothing" would report every word as
 * drift. A null answer means a required array is missing entirely, which the caller reports as
 * not evaluated rather than as a pass.
 */
export function knownStructures(source) {
  const arrays = new Map();
  for (const match of source.matchAll(/export const ([A-Z][A-Z0-9_]*) = \[([\s\S]*?)\];/g)) {
    arrays.set(match[1], [...match[2].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]));
  }
  const required = ["OQ_KEYWORDS", "OQ_BUILTINS", "OQ_STATEMENT_BUILTINS", "OQ_CONTEXTUAL_KEYWORDS"];
  if (required.some((name) => !arrays.has(name))) return null;
  const known = new Set();
  for (const name of required) for (const entry of arrays.get(name)) known.add(entry);
  return known;
}

/**
 * Every structure the language declares, from the generated reference.
 *
 * The reference is the only document that cannot disagree with the implementation, because `oq
 * doc` writes it from the registration table. Everything else -- including this audit's own idea
 * of what a keyword is -- is a transcription that can fall behind.
 */
export function canonicalStructures(markdown) {
  const keywords = new Set();
  const keywordSection = /## Keywords\n\n(.*?)\n/.exec(markdown);
  if (keywordSection) {
    for (const match of keywordSection[1].matchAll(/`([^`]+)`/g)) keywords.add(match[1]);
  }
  const functions = new Set();
  const start = markdown.indexOf("## Global functions");
  if (start >= 0) {
    const rest = markdown.slice(start + "## Global functions".length);
    const next = rest.search(/\n## /);
    const section = next < 0 ? rest : rest.slice(0, next);
    for (const match of section.matchAll(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|/gm)) functions.add(match[1]);
  }
  if (keywords.size === 0 && functions.size === 0) return null;
  return { keywords, functions };
}

/** Words that open a declaration or a block, and are structure wherever they appear. */
const DECLARATION_WORDS = new Set(["fun", "data", "class", "contract", "use", "immutable", "implements"]);

/**
 * The call-shaped words in a block: `name(` where `name` is not a method call and not part of a
 * declaration header.
 *
 * `fun parse(text)` names a function the program defines, so its name is an identifier the
 * document chose; only the `fun` is structure. Skipping the word after a declaration word is
 * what separates the two, and it is the difference between a report a maintainer acts on and
 * one they learn to ignore.
 */
export function callShapedWords(body) {
  const stripped = stripCommentsAndStrings(body);
  const found = new Map();
  for (const match of stripped.matchAll(/(^|[^\w.])([A-Za-z_]\w*)\s*\(/g)) {
    const word = match[2];
    // The word after `fun`/`class`/`contract`/`data` is the name the example chose, not structure.
    if (/\b(?:fun|class|contract|data)\s+$/.test(stripped.slice(0, match.index + match[1].length))) continue;
    found.set(word, (found.get(word) ?? 0) + 1);
  }
  return found;
}

/**
 * The declaration and block words in a block, taken as whole words.
 *
 * Only the words in `DECLARATION_WORDS` plus the language keywords are reported here; an
 * arbitrary identifier that happens to look like a word is not structure.
 */
export function structureWords(body) {
  const stripped = stripCommentsAndStrings(body);
  const found = new Map();
  for (const match of stripped.matchAll(/\b([a-z_]\w*)\b/g)) {
    const word = match[1];
    if (DECLARATION_WORDS.has(word)) found.set(word, (found.get(word) ?? 0) + 1);
  }
  return found;
}

/**
 * Removes comments and string contents so a structure named in prose is not counted.
 *
 * The canonical documents explain a construct in a comment or mention it in an example's output
 * string, and counting those made an earlier count of documented builtins read 76 when the
 * identifiers numbered 56. The same trap applies here: `# init is called once` must not report
 * `init` as an unknown structure when the grammar not knowing it is not the issue.
 */
export function stripCommentsAndStrings(body) {
  let out = "";
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === "#") {
      while (index < body.length && body[index] !== "\n") index += 1;
      continue;
    }
    if (char === '"') {
      const triple = body.startsWith('"""', index);
      const quote = triple ? '"""' : '"';
      index += quote.length;
      while (index < body.length && !body.startsWith(quote, index)) {
        if (body[index] === "\\") index += 1;
        index += 1;
      }
      index += quote.length;
      out += " ";
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * The audit itself: which canonical structures appear in the published blocks while the grammar
 * cannot colour them, and which Oqthara-shaped blocks carry no tag at all.
 *
 * A block is judged Oqthara-shaped by a positive signal -- a canonical keyword, a declaration
 * word, or a global function -- rather than by the absence of a shell prompt, because "not
 * obviously shell" is true of a great many blocks that are not Oqthara either.
 */
export function audit({ root, docs, grammar, known, canonical }) {
  const sections = publishedSections(readFileSync(join(root, "src", "source.js"), "utf8"));
  if (!sections) return { evaluated: false, reason: "src/source.js no longer declares the allowlist" };

  const documents = publishedDocuments(docs, sections);
  if (documents.length === 0) return { evaluated: false, reason: "the allowlist admitted no documents" };

  const allCanonical = new Set([...canonical.keywords, ...canonical.functions, ...DECLARATION_WORDS]);
  const findings = [];
  const untagged = [];
  let blocks = 0;
  let oqBlocks = 0;
  let scannedBlocks = 0;

  for (const document of documents) {
    const markdown = readFileSync(join(docs, document), "utf8");
    for (const block of fences(markdown)) {
      blocks += 1;
      const tagged = OQ_FENCES.has(block.language);
      if (tagged) oqBlocks += 1;
      if (OTHER_FENCES.has(block.language)) continue;

      const words = new Map([
        ...callShapedWords(block.body),
        ...structureWords(block.body),
      ]);
      const canonicalHere = [...words.keys()].filter((word) => allCanonical.has(word));
      if (canonicalHere.length === 0) continue;
      scannedBlocks += 1;
      if (!tagged) untagged.push({ document, line: block.line });

      for (const word of canonicalHere.sort()) {
        if (known.has(word)) continue;
        findings.push({ document, line: block.line, word });
      }
    }
  }

  return {
    evaluated: true,
    documents: documents.length,
    blocks,
    oqBlocks,
    scannedBlocks,
    canonicalTotal: allCanonical.size,
    grammarTotal: known.size,
    untagged,
    findings,
  };
}

function usage(message) {
  if (message) console.error(`audit-code-blocks: ${message}`);
  console.error("usage: node scripts/audit-code-blocks.mjs --docs=<path> [--json]");
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  let docs = "";
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--docs=")) docs = arg.slice("--docs=".length);
    else usage(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (!docs) usage("--docs=<path> is required");

  let grammar;
  try {
    grammar = readFileSync(GRAMMAR_PATH, "utf8");
  } catch {
    console.error(`audit-code-blocks: cannot read ${GRAMMAR_PATH}`);
    process.exit(3);
  }
  const known = knownStructures(grammar);
  if (!known) {
    console.error(`audit-code-blocks: ${GRAMMAR_PATH} no longer declares every structure list`);
    process.exit(3);
  }

  let canonical;
  try {
    canonical = canonicalStructures(readFileSync(join(docs, REFERENCE_PATH), "utf8"));
  } catch {
    console.error(`audit-code-blocks: cannot read ${join(docs, REFERENCE_PATH)}`);
    process.exit(3);
  }
  if (!canonical) {
    console.error(`audit-code-blocks: ${REFERENCE_PATH} no longer lists keywords and functions`);
    process.exit(3);
  }

  const result = audit({ root: process.cwd(), docs, grammar, known, canonical });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.evaluated) {
    console.log(`code blocks: not evaluated (${result.reason})`);
  } else {
    const lines = [
      `Oqthara code-block audit over ${result.documents} published documents`,
      `- ${result.blocks} fenced blocks, ${result.oqBlocks} tagged as Oqthara, ${result.scannedBlocks} containing canonical structures`,
      `- ${result.untagged.length} Oqthara-shaped blocks carry no tag`,
      `- ${result.canonicalTotal} canonical structures, ${result.grammarTotal} the grammar can colour`,
    ];
    if (result.findings.length) {
      const byWord = new Map();
      for (const finding of result.findings) {
        byWord.set(finding.word, [...(byWord.get(finding.word) ?? []), `${finding.document}:${finding.line}`]);
      }
      for (const [word, where] of [...byWord].sort()) {
        lines.push(`  unknown structure \`${word}\` at ${where.slice(0, 3).join(", ")}${where.length > 3 ? ` (+${where.length - 3} more)` : ""}`);
      }
      lines.push("DRIFT: a documented example uses a structure the grammar cannot colour.");
    } else {
      lines.push("  every structure in the published blocks is one the grammar knows");
    }
    console.log(lines.join("\n"));
  }

  if (!result.evaluated) process.exit(3);
  process.exit(result.findings.length > 0 ? 2 : 0);
}

if (process.argv[1]?.endsWith("audit-code-blocks.mjs")) main();
