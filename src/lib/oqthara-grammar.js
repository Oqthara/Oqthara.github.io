// A Prism (refractor) grammar for Oqthara.
//
// There is no official Oqthara grammar for any highlighter, so this one is written from the
// canonical specification in Oqthara/oqthara's docs/spec/language.md: the keyword list, the
// literal forms, comments beginning with `#`, `{...}` string interpolation, and the operator
// set. It is registered with refractor so `rehype-prism-plus` can tokenise fenced blocks the
// same way it handles Python, Java, JSON or Bash.
//
// Keyword budget: the language fixes its keyword count at 20 (see the docs sync check in the
// language repository). The list below is those keywords, not an approximation.
//
// The order of the token definitions matters: a function call must be recognised before a
// plain identifier, and a string before punctuation, or the first match wins and the rest of
// the line is coloured as plain text.

// The exact set from `Lexer.KEYWORDS` in Oqthara/oqthara, verified against the generated
// standard library reference, which counts 20 keywords with a budget of 30. Anything not on
// this list is an identifier. In particular `elseif`, `raise`, `is` and `until` are not
// keywords: `to` and `until` are contextual range operators recognised by the parser, and a
// block continuation is written `else` followed by `if`.
export const OQ_KEYWORDS = [
  "and",
  "break",
  "catch",
  "continue",
  "data",
  "else",
  "end",
  "false",
  "for",
  "fun",
  "if",
  "in",
  "not",
  "nothing",
  "or",
  "return",
  "true",
  "try",
  "use",
  "while",
];

/** Range operators, which read as words but are not keywords. */
export const OQ_RANGE_OPERATORS = ["to", "until"];

/**
 * Built-in functions that are always called with parentheses.
 *
 * Taken from the generated standard library reference (`docs/stdlib/reference.md`, produced by
 * `oq doc` from the implementation), not from memory. Methods such as `.upper()` are not listed:
 * `upper` is not a global function, and colouring it as one would be a lie.
 */
export const OQ_BUILTINS = [
  "abs", "append", "args", "assert", "await", "ceil", "clamp", "clone", "contains",
  "cpu_count", "cwd", "datetime", "delete", "done", "env", "error", "exists", "exit",
  "file_size", "filter", "floor", "format", "http_get", "http_post", "input", "is_nothing",
  "is_number", "is_text", "join", "json", "json_parse", "json_pretty", "json_write", "keys",
  "length", "list", "list_files", "lower", "make_dir", "map", "matches", "max", "memory_mb",
  "min", "now", "number", "par_map", "path_join", "path_name", "path_parent", "pop", "pow",
  "random", "random_item", "range", "range_list", "read", "read_lines", "regex", "replace",
  "repr", "reverse", "round", "run_command", "save", "set", "sleep", "sort", "sort_by",
  "spawn", "split", "sqrt", "sum", "text", "timestamp", "today", "trim", "type_of", "unique",
  "upper", "values", "write", "write_text", "zip",
];

/**
 * Built-ins that read as statements rather than calls.
 *
 * `print "Hello"` and `input "Name? "` take their argument without parentheses, so they cannot
 * use the `name(` lookahead the call built-ins rely on. Without this list they fell through to
 * the generic identifier rule and were coloured as ordinary variables.
 */
export const OQ_STATEMENT_BUILTINS = ["print", "input"];

const LITERALS = ["true", "false", "nothing"];
const KEYWORD = new RegExp(`\\b(?:${OQ_KEYWORDS.join("|")})\\b`);
const LITERAL = new RegExp(`\\b(?:${LITERALS.join("|")})\\b`);
// `to` and `until` are contextual, so they are operators only between two expressions on the
// same line. `fun count(from, until)` keeps `until` as a parameter name, and the second
// `until` in `for n in from until until` stays a variable while the first is the operator.
//
// The left operand is captured instead of asserted with a lookbehind. Prism slices the source
// before it matches an `inside` grammar, so a JavaScript lookbehind looks at the slice's own
// start, not at the code before it, and silently never matches. Prism's `lookbehind: true`
// drops the captured whitespace from the token, which is the mechanism that survives slicing.
const RANGE_OPERATOR = new RegExp(
  `(\\s+)(?:${OQ_RANGE_OPERATORS.join("|")})(?=[ \\t]+[-\\w(\\["'])`,
);
const BUILTIN = new RegExp(`\\b(?:${OQ_BUILTINS.join("|")})\\b(?=\\s*\\()`);
const STATEMENT_BUILTIN = new RegExp(`\\b(?:${OQ_STATEMENT_BUILTINS.join("|")})\\b`);

/**
 * The grammar object, built for a Prism instance.
 *
 * Kept as a factory so it can be unit-tested without a DOM.
 */
export function oqtharaGrammar(Prism) {
  void Prism;
  return {
    comment: {
      pattern: /#[^\n\r]*/,
      greedy: true,
    },

    // Triple-quoted multi-line text, then `"..."` and `'...'` with escapes. The multi-line
    // form must come first: the single-quote alternative would otherwise match the first two
    // quotes and leave the body uncoloured. `interpolation` inside is handled below.
    string: {
      pattern: /"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/,
      greedy: true,
      inside: {
        // `{{` and `}}` are literal braces and must be consumed before `interpolation`, or
        // `"{{like this}}"` would colour `{like this}` as an expression.
        "escaped-brace": {
          pattern: /\{\{|\}\}/,
        },
        interpolation: {
          // `{expression}` is interpolated. The lexer only treats a brace as interpolation
          // when its contents parse as an expression, and it explicitly rejects a `:` (JSON
          // or map-like text), so a colon-bearing brace stays plain.
          pattern: /\{(?!\{)(?![^{}]*:)[^{}]*\}/,
          inside: {
            punctuation: /\{|\}/,
            keyword: KEYWORD,
            boolean: LITERAL,
            number: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/,
            "range-operator": {
              pattern: RANGE_OPERATOR,
              lookbehind: true,
              greedy: true,
              alias: "operator",
            },
            operator: /\*\*|->|[-+*/%=<>!|]=?/,
            "function-call": { pattern: /[a-zA-Z_]\w*(?=\s*\()/, greedy: true },
            variable: /\b[a-zA-Z_]\w*\b/,
          },
        },
        escape: {
          pattern: /\\./,
          alias: "char",
        },
      },
    },

    number: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/,

    // `data Point(x, y)` declares a type; colour the name.
    //
    // `inside` patterns are matched against the whole match, not against a capture group, so
    // each sub-pattern is written unanchored. The anchored form silently matched nothing.
    "data-declaration": {
      pattern: /\bdata\s+[A-Z]\w*/,
      inside: {
        keyword: /\bdata\b/,
        "class-name": /[A-Z]\w*$/,
      },
    },

    "function-definition": {
      pattern: /\bfun\s+[a-zA-Z_]\w*/,
      inside: {
        keyword: /\bfun\b/,
        "function": /[a-zA-Z_]\w*$/,
      },
    },

    // `true`/`false`/`nothing` are keywords in the lexer, but they read as values, so they are
    // matched before the keyword rule to keep the constant colour.
    boolean: LITERAL,
    keyword: KEYWORD,
    builtin: BUILTIN,
    "statement-builtin": {
      pattern: STATEMENT_BUILTIN,
      alias: "builtin",
    },

    "range-operator": {
      pattern: RANGE_OPERATOR,
      // `greedy` is required with `lookbehind`: without it Prism matches against the current
      // string node only, which is already split around the operands, so the captured
      // whitespace and the operator end up in different nodes and the pattern never fires.
      lookbehind: true,
      greedy: true,
      alias: "operator",
    },

    // `Java.Thing`, `.method()`, and capitalised Java class names from `use`.
    "class-name": {
      pattern: /\b[A-Z]\w*\b/,
      greedy: true,
    },

    "function-call": {
      pattern: /\b[a-zA-Z_]\w*(?=\s*\()/,
      greedy: true,
    },

    variable: /\b[a-zA-Z_]\w*\b/,

    // Longest first, or `**` is read as two `*` tokens and `->` as `-` then `>`.
    operator: /\*\*|->|\.\.|[-+*/%=<>!|]=?/,
    punctuation: /[{}[\];,.:()]/,
  };
}

/**
 * The syntax function refractor registers.
 *
 * refractor's contract is `register(fn)` where `fn(prism)` installs the grammar, and `fn` must
 * carry a `displayName`. That is why this is a named function with a property rather than a
 * plain grammar object.
 */
export function oqtharaSyntax(prism) {
  prism.languages.oqthara = oqtharaGrammar(prism);
}
oqtharaSyntax.displayName = "oqthara";

/**
 * Registers the grammar and the `oq` alias used by the repository's fences.
 *
 * Returns the instance so the caller can chain. Kept separate from the grammar itself so a
 * test can register against a fresh instance and highlight in isolation.
 */
export function registerOqthara(refractor) {
  refractor.register(oqtharaSyntax);
  refractor.alias("oqthara", ["oq"]);
  return refractor;
}
