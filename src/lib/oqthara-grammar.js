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

/** Built-in functions are highlighted like calls, but are not keywords. */
export const OQ_BUILTINS = [
  "abs", "ceil", "clamp", "floor", "max", "min", "pow", "random", "round", "sqrt",
  "sum", "len", "type", "str", "num",
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
const RANGE_OPERATOR = new RegExp(`\\b(?:${OQ_RANGE_OPERATORS.join("|")})\\b`);
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

    // `"..."` and `'...'` with escapes. The `interpolation` inside is handled below.
    string: {
      pattern: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/,
      greedy: true,
      inside: {
        interpolation: {
          // `{expression}` is interpolated; `{{` is a literal brace.
          pattern: /\{(?!\{)[^{}]*\}/,
          inside: {
            punctuation: /\{|\}/,
            keyword: KEYWORD,
            boolean: LITERAL,
            number: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/,
            operator: /[+\-*/%<>=!]+/,
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

    operator: /[-+*/%=<>!]=?|\*\*|->|\.\./,
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
