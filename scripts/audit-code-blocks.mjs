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
//   0  every structure in the published blocks is one the grammar knows, and every untagged
//      block containing canonical structures still infers a language and renders coloured
//   1  usage error
//   2  drift: a block uses a structure the grammar cannot colour, or an untagged block that
//      contains canonical structures is left with no language at all and renders uncoloured
//   3  the documents could not be read
//
// "Untagged" and "uncoloured" are not the same thing. The site runs the same inference before
// rendering (`src/lib/infer-language.js`), so a bare fence is usually coloured anyway; only a
// block the inference *declines* renders plain. Transcribed output -- an `error:` diagnostic, a
// `codepath:` trace, a `$` prompt, or a diagram -- is expected to render plain, because colouring
// it would assert a program structure the text does not have.
//
// Usage
//   node scripts/audit-code-blocks.mjs --docs=/path/to/oqthara
//   node scripts/audit-code-blocks.mjs --docs=/path/to/oqthara --json

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { inferLanguage, looksLikeArt } from "../src/lib/infer-language.js";

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

/**
 * This site's own hand-written pages, which the allowlist above cannot describe.
 *
 * `publishedDocuments` walks a checkout of the *language* repository, so it sees only the
 * documents that repository carries. The site also writes prose of its own, and that prose
 * carries code blocks -- `language.md` at the repository root is the one a reader lands on.
 * Those blocks were never audited. A fabricated builtin and a fabricated keyword, fenced as
 * Oqthara and added to `language.md`, left the audit reporting 175 blocks and exiting 0.
 *
 * The list is explicit rather than a glob over `*.md` because the repository root also holds
 * review reports and recovery notes, whose code blocks are quotations and transcripts rather
 * than published pages. Adding a page here is a decision that the page is reader-facing.
 */
export const SITE_PAGES = ["language.md"];

/**
 * The site pages present in a checkout.
 *
 * `SITE_PAGES` is a list of pages that *should* be audited, and the audit's own test fixtures
 * build throwaway trees that carry none of them. Requiring every entry to exist would make each
 * fixture responsible for a file it is not testing. The real repository is where absence is
 * drift -- so the caller passes `sitePages` explicitly, and the default derives it from what is
 * actually on disk.
 */
export function existingSitePages(root) {
  return SITE_PAGES.filter((path) => {
    try {
      statSync(join(root, path));
      return true;
    } catch {
      return false;
    }
  });
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
 * The method names the reference lists under `## Methods on values`.
 *
 * Every `### type` subsection is a run of ``.name()` entries, so the whole section is read at
 * once rather than per type: a method that moves between types is still a method, and a block
 * calling `.to_list()` does not have to know which receiver it has.
 *
 * Read from the reference for the same reason `canonicalStructures` is: `oq doc` writes that
 * table from the registration table, so it cannot fall behind the implementation. It is a
 * third structure list the audit previously ignored entirely, which meant a method renamed in
 * the language left every example calling it silently uncoloured.
 */
export function canonicalMethods(markdown) {
  const start = markdown.indexOf("## Methods on values");
  if (start < 0) return null;
  const rest = markdown.slice(start + "## Methods on values".length);
  const next = rest.search(/\n## /);
  const section = next < 0 ? rest : rest.slice(0, next);
  const names = new Set();
  for (const match of section.matchAll(/`\.([a-z][a-z0-9_]*)\(\)`/g)) names.add(match[1]);
  return names.size > 0 ? names : null;
}

/**
 * Local calls a published block makes without declaring them, and why each is legitimate.
 *
 * Every entry is a name the *document* provides and the *language* does not, so no structure
 * list can contain it and the block is not at fault:
 *
 *   - `twice` and `Point` are declared by the `# helper.oq` block that introduces module
 *     splitting, and called by the `# main.oq` block beside it. The audit reads one block at a
 *     time, so it cannot see the declaration.
 *   - `expensive` is a placeholder in the concurrency example, deliberately undefined because
 *     the point is `spawn(fun() ... end)` rather than the body.
 *
 * A callable *binding* needs no allowance: `a = make_adder(10)` followed by `a(5)` is read as a
 * local name and is accounted for by `unresolvedCalls` itself, because a binding that assigns a
 * function to a name is ordinary Oqthara rather than a structure with a name of its own.
 *
 * The list is keyed by name and requires a reason, so a *new* undeclared call still fails. That
 * is the property that matters: this check exists to notice a language release adding a
 * structure the site does not know, and an allowance for two cross-block names and one
 * placeholder cannot hide the next one.
 */
const ALLOWED_UNRESOLVED = new Map([
  ["twice", "declared by the helper module in the module-splitting example"],
  ["Point", "declared by the helper module in the module-splitting example"],
  ["expensive", "a deliberate placeholder in the concurrency example"],
]);

/**
 * The call shapes in a block whose provider the document has to declare.
 *
 * Three shapes are structure the reference names, and each is checked by the caller against the
 * list that owns it: a global function, a builtin, and a method the reference lists. What is left
 * is a call whose provider is *local* -- `Counter()`, `p.with(...)`, `c.bump()` -- and that is
 * only legitimate when the block declares it, either by naming it in a `data`/`class`/`contract`
 * header or in a `fun` body. An undeclared local call is a structure the site cannot account
 * for, and it is reported.
 *
 * Java interoperability is exempt and for a principled reason: `use java.time.LocalDate` puts an
 * entire foreign class on the page, and `today.plusDays(30)` calls a method that belongs to the
 * JDK rather than to Oqthara. No list in this repository could enumerate those, so a block that
 * imports a Java package, or that calls a static member of a capitalised name, is not asked the
 * question.
 */
export function unresolvedCalls(body, { globals, methods, builtins }) {
  const stripped = stripCommentsAndStrings(body);
  // A block that reaches into Java -- an import, or `Comparator.naturalOrder()` -- is out of
  // scope for the whole block, because one `use` can introduce any number of members.
  if (/\buse\s+(?:java|javax|jdk)\./.test(stripped) || /\b[A-Z]\w*\.\w+\s*\(/.test(stripped)) {
    return [];
  }
  // Declarations the block makes itself: `data Point(x, y)`, `class Counter(v)`, `fun bump()`.
  // A method a block declares is structure the *example* introduces, so it is accounted for
  // exactly as a global function is.
  const declared = new Set(
    [...stripped.matchAll(/\b(?:fun|data|class|contract)\s+([A-Za-z_]\w*)/g)].map((m) => m[1]),
  );
  // A name the block binds itself. `a = make_adder(10)` then `a(5)` is a call through a local
  // variable, and the name is the example's choice rather than a structure with a provider.
  for (const match of stripped.matchAll(/^\s*([A-Za-z_]\w*)\s*=(?!=)/gm)) declared.add(match[1]);
  const calls = new Set([...globals, ...builtins]);

  const unresolved = new Set();
  // A method call: `[1].to_list()`. Its provider is the type the reference documents under
  // `## Methods on values`, so a method renamed in the language leaves the block calling a name
  // that no longer exists -- and the block would still render, because the grammar colours any
  // `name(`. That silent case is exactly what this check exists to catch.
  for (const match of stripped.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)) {
    if (!methods.has(match[1]) && !declared.has(match[1])) unresolved.add(match[1]);
  }
  // A local call: `Counter(1)`, `twice(3)`. The word after a declaration word is the name the
  // example chose, so it is not a call and is skipped.
  for (const match of stripped.matchAll(/(^|[^\w.])([A-Za-z_]\w*)\s*\(/g)) {
    const word = match[2];
    if (calls.has(word) || declared.has(word) || ALLOWED_UNRESOLVED.has(word)) continue;
    if (/\b(?:fun|class|contract|data)\s+$/.test(stripped.slice(0, match.index + match[1].length))) continue;
    unresolved.add(word);
  }
  return [...unresolved].sort();
}

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
 * A line that can only be program *output*, never program source.
 *
 * The canonical documents quote diagnostics inside bare fences: an `error:` line, a `help:`
 * hint, a `codepath:` launcher trace, or a `$` prompt introducing a command. Those blocks
 * mention canonical names -- `error`, `values` and `use` are grammar words in their own right --
 * so a word-matching test alone reports them. Plain rendering is correct for output, and
 * colouring it as Oqthara would assert a structure the transcript does not have.
 */
const OUTPUT_LINE =
  /^\s*(?:\$|>|PS>|error:|warning:|help:|note:|codepath:|Exception\b|at\s+[\w.$]+\()/;

/**
 * True when a block is a transcript or a diagram rather than a program.
 *
 * Two independent signals, both conservative:
 *
 *   - it is art (a diagram, a tree, or a table), which `looksLikeArt` already decides for the
 *     renderer, so the audit and the site agree about it by construction; or
 *   - every non-empty line is an output line, so there is no source line anywhere in it.
 */
export function isTranscript(body) {
  if (looksLikeArt(body)) return true;
  const lines = String(body ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length > 0 && lines.every((line) => OUTPUT_LINE.test(line));
}

/**
 * The audit itself: which canonical structures appear in the published blocks while the grammar
 * cannot colour them, and which Oqthara-shaped blocks carry no tag at all.
 *
 * A block is judged Oqthara-shaped by a positive signal -- a canonical keyword, a declaration
 * word, or a global function -- rather than by the absence of a shell prompt, because "not
 * obviously shell" is true of a great many blocks that are not Oqthara either.
 */
export function audit({ root, docs, grammar, known, canonical, methods = new Set(), sitePages = null }) {
  const sections = publishedSections(readFileSync(join(root, "src", "source.js"), "utf8"));
  if (!sections) return { evaluated: false, reason: "src/source.js no longer declares the allowlist" };

  const documents = publishedDocuments(docs, sections);
  if (documents.length === 0) return { evaluated: false, reason: "the allowlist admitted no documents" };

  // Each document is paired with the directory it lives in. The language repository's documents
  // are read from the checkout, the site's own pages from this repository, and a finding has to
  // name the file a maintainer can open.
  const sources = [
    ...documents.map((path) => ({ path, base: docs })),
    ...(sitePages ?? existingSitePages(root)).map((path) => ({ path, base: root })),
  ];

  const allCanonical = new Set([...canonical.keywords, ...canonical.functions, ...DECLARATION_WORDS]);
  const findings = [];
  const unusable = [];
  const untagged = [];
  const uncoloured = [];
  const unresolved = [];
  let blocks = 0;
  let oqBlocks = 0;
  let scannedBlocks = 0;

  let missing = 0;
  for (const { path: document, base } of sources) {
    let markdown;
    try {
      markdown = readFileSync(join(base, document), "utf8");
    } catch {
      // A page named in SITE_PAGES that no longer exists is drift, not a crash: the list is a
      // claim about what the site publishes, and a stale claim should fail the audit.
      missing += 1;
      unusable.push(document);
      continue;
    }
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
      // A method the reference lists is a canonical structure too, even though it is not in the
      // keyword or function lists: a block whose only recognisable content is `.to_list()` is
      // still an example of the language, and skipping it left the structure check unable to
      // see a block that calls one method it knows and one it does not.
      const methodsHere = [...block.body.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)]
        .map((match) => match[1])
        .filter((word) => methods.has(word));
      if (canonicalHere.length === 0 && methodsHere.length === 0) continue;
      scannedBlocks += 1;

      // A block is asked what *else* it calls only when it is Oqthara code. A `java` fence or a
      // transcript is somebody else's language, and its calls belong to that language.
      if (OQ_FENCES.has(block.language) || inferLanguage(block.body) === "oq") {
        for (const word of unresolvedCalls(block.body, { globals: canonical.functions, methods, builtins: known })) {
          unresolved.push({ document, line: block.line, word });
        }
      }
      if (!tagged) {
        // An untagged block is not automatically a defect: the site runs the same inference
        // used here before rendering, so most bare fences are coloured as Oqthara anyway. What
        // matters is whether inference *succeeds*. A block that contains canonical structures
        // and infers to nothing is the real finding -- it is rendered with no grammar at all.
        const inferred = inferLanguage(block.body);
        untagged.push({ document, line: block.line, inferred });
        if (inferred === null && !isTranscript(block.body)) {
          uncoloured.push({ document, line: block.line });
        }
      }

      for (const word of canonicalHere.sort()) {
        if (known.has(word)) continue;
        findings.push({ document, line: block.line, word });
      }
    }
  }

  return {
    evaluated: true,
    documents: sources.length,
    missing,
    blocks,
    oqBlocks,
    scannedBlocks,
    canonicalTotal: allCanonical.size,
    grammarTotal: known.size,
    methodTotal: methods.size,
    untagged,
    uncoloured,
    unresolved,
    findings,
    unusable,
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

  let reference;
  try {
    reference = readFileSync(join(docs, REFERENCE_PATH), "utf8");
  } catch {
    console.error(`audit-code-blocks: cannot read ${join(docs, REFERENCE_PATH)}`);
    process.exit(3);
  }
  const canonical = canonicalStructures(reference);
  if (!canonical) {
    console.error(`audit-code-blocks: ${REFERENCE_PATH} no longer lists keywords and functions`);
    process.exit(3);
  }
  const methods = canonicalMethods(reference);
  if (!methods) {
    console.error(`audit-code-blocks: ${REFERENCE_PATH} no longer lists the methods on values`);
    process.exit(3);
  }

  // The CLI enforces the declared list, so a page that moves or is renamed fails here rather
  // than dropping silently out of the audit. Callers that pass no list get the pages that
  // exist, which is what keeps a test fixture from having to carry every published page.
  const result = audit({
    root: process.cwd(),
    docs,
    grammar,
    known,
    canonical,
    methods,
    sitePages: SITE_PAGES,
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.evaluated) {
    console.log(`code blocks: not evaluated (${result.reason})`);
  } else {
    const lines = [
      `Oqthara code-block audit over ${result.documents} published documents`,
      `- ${result.blocks} fenced blocks, ${result.oqBlocks} tagged as Oqthara, ${result.scannedBlocks} containing canonical structures`,
      `- ${result.untagged.length} blocks carry no tag (${result.untagged.length - result.uncoloured.length} inferred as Oqthara and coloured anyway, ${result.uncoloured.length} left uncoloured)`,
      `- ${result.canonicalTotal} canonical structures, ${result.grammarTotal} the grammar can colour, ${result.methodTotal} methods on values`,
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
    if (result.uncoloured.length) {
      for (const block of result.uncoloured.slice(0, 5)) {
        lines.push(`  untagged and uncoloured \`${block.document}:${block.line}\``);
      }
      if (result.uncoloured.length > 5) {
        lines.push(`  ... and ${result.uncoloured.length - 5} more`);
      }
      lines.push("UNCOLOURED: an untagged block containing canonical structures infers no language.");
    }
    if (result.unusable.length) {
      for (const document of result.unusable) {
        lines.push(`  missing site page \`${document}\``);
      }
      lines.push("MISSING: SITE_PAGES names a page that is not in the repository.");
    }
    if (result.unresolved.length) {
      const byWord = new Map();
      for (const finding of result.unresolved) {
        byWord.set(finding.word, [...(byWord.get(finding.word) ?? []), `${finding.document}:${finding.line}`]);
      }
      for (const [word, where] of [...byWord].sort()) {
        lines.push(`  unaccounted call \`${word}\` at ${where.slice(0, 3).join(", ")}${where.length > 3 ? ` (+${where.length - 3} more)` : ""}`);
      }
      lines.push("UNACCOUNTED: an Oqthara block calls a name the reference does not list and the block does not declare.");
    }
    console.log(lines.join("\n"));
  }

  if (!result.evaluated) process.exit(3);
  const drift =
    result.findings.length > 0 ||
    result.uncoloured.length > 0 ||
    result.unresolved.length > 0 ||
    result.unusable.length > 0;
  process.exit(drift ? 2 : 0);
}

if (process.argv[1]?.endsWith("audit-code-blocks.mjs")) main();
