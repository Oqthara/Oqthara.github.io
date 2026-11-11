// A Prism (refractor) grammar for Oqthara.
//
// There is no official Oqthara grammar for any highlighter, so this one is written from the
// canonical specification in Oqthara/oqthara's docs/spec/language.md: the keyword list, the
// literal forms, comments beginning with `#`, `{...}` string interpolation, and the operator
// set. It is registered with refractor so `rehype-prism-plus` can tokenise fenced blocks the
// same way it handles Python, Java, JSON or Bash.
//
// Keyword budget: the language fixes its keyword count at a budget of 30 and currently uses
// 21 (see the generated `docs/stdlib/reference.md` in the language repository, which renders
// both numbers from the implementation). The list below is that set, not an approximation.
//
// Nothing here is enforced by comment. `scripts/audit-grammar.mjs` compares these lists with
// the generated reference and fails when they disagree; before it existed the keyword list had
// silently fallen one keyword behind and the builtin list was missing 70 of 155 functions.
//
// The order of the token definitions matters: a function call must be recognised before a
// plain identifier, and a string before punctuation, or the first match wins and the rest of
// the line is coloured as plain text.

// The exact set from `Lexer.KEYWORDS` in Oqthara/oqthara, verified against the generated
// standard library reference, which counts 21 keywords with a budget of 30. Anything not on
// this list is an identifier. In particular `elseif`, `raise`, `is` and `until` are not
// keywords: `to` and `until` are contextual range operators recognised by the parser, and a
// block continuation is written `else` followed by `if`.
export const OQ_KEYWORDS = [
  "and", "break", "catch", "const", "continue",
  "data", "else", "end", "false", "for",
  "fun", "if", "in", "not", "nothing",
  "or", "return", "true", "try", "use",
  "while",
];

/** Range operators, which read as words but are not keywords. */
export const OQ_RANGE_OPERATORS = ["to", "until"];

/**
 * Global functions: the names that may be called as `name(...)` with no receiver.
 *
 * Taken from the generated standard library reference (`docs/stdlib/reference.md`, produced by
 * `oq doc` from the implementation), not from memory. That page's `## Global functions` table
 * is the whole list, and this array is a copy of it.
 *
 * A name may be both a global function and a method. `upper` was previously excluded here on
 * the argument that it is only a method, which was wrong: `upper("ab")` and `"ab".upper()` both
 * return `AB`. Forgetting a name is not harmless — it falls through to the identifier rule and
 * is coloured as a plain variable, which is the shape of a typo rather than a call.
 *
 * Methods that have *no* global equivalent (`.get()`, `.to_list()`) are still not listed. Only
 * the reference's global table is authoritative for this list.
 */
export const OQ_BUILTINS = [
  "abs", "append", "arg_parse", "args", "assert",
  "await", "base64_decode", "base64_encode", "bisect_left", "bisect_right",
  "ceil", "clamp", "clone", "contains", "copy_file",
  "cpu_count", "csv_parse", "csv_write", "cwd", "date_parse",
  "datetime", "db_execute", "db_query", "db_transaction", "dedent_text",
  "delete", "done", "enumerate", "env", "error",
  "exists", "exit", "file_size", "fill_text", "filter",
  "floor", "fnmatch", "format", "frozenset", "glob",
  "gzip_compress", "gzip_decompress", "heap_pop", "heap_push", "hex_decode",
  "hex_encode", "hmac_sha256", "http_get", "http_post", "indent_text",
  "input", "instant_parse", "is_dir", "is_file", "is_nothing",
  "is_number", "is_text", "is_uuid", "join", "json",
  "json_parse", "json_pretty", "json_write", "keys", "length",
  "list", "list_files", "log_debug", "log_enabled", "log_error",
  "log_info", "log_level", "log_warn", "lower", "make_dir",
  "map", "matches", "max", "md5", "mean",
  "median", "memory_mb", "min", "mode", "move_file",
  "mutex", "now", "number", "par_map", "path_join",
  "path_name", "path_parent", "pbkdf2_sha256", "percentile", "pop",
  "pow", "print", "push", "query_encode", "query_parse",
  "random", "random_item", "range", "range_list", "read",
  "read_bytes", "read_lines", "regex", "replace", "repr",
  "reverse", "round", "run_command", "save", "secure_equal",
  "secure_random_hex", "set", "sha1", "sha256", "shorten_text",
  "sleep", "sort", "sort_by", "sorted", "spawn",
  "split", "sqrt", "stdev", "sum", "text",
  "timestamp", "today", "trim", "type_of", "tz_convert",
  "unified_diff", "unique", "upper", "url_decode", "url_encode",
  "url_join", "url_parse", "uuid", "values", "variance",
  "walk", "wrap_text", "write", "write_bytes", "write_text",
  "zip", "zip_compress", "zip_decompress", "zlib_compress", "zlib_decompress",
];

/**
 * Global functions that also read as statements.
 *
 * `print "Hello"` and `input "Name? "` take their argument without parentheses, so they cannot
 * use the `name(` lookahead the call builtins rely on. Without this list they fell through to
 * the generic identifier rule and were coloured as ordinary variables.
 *
 * Both names are also in `OQ_BUILTINS`, because `print("Hello")` is equally valid — the two
 * patterns are alternatives, and listing a name in both is deliberate. The statement rules run
 * first, so the parenthesised form is still coloured as a call through the `builtin` rule below.
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
    //
    // `->` is the lambda arrow (`double = x -> x * 2`). It is not in the lexer's operator tables
    // because the parser recognises it, the same way it recognises `to` and `until`.
    // There is no `..` operator: the language has no such token, and the lexer reads two dots as
    // a DOT followed by a DOT, which the parser rejects as a missing field name.
    operator: /\*\*|->|[-+*/%=<>!|]=?/,
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
