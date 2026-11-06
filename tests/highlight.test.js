import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { createElement as h, Fragment } from "react";

import { renderMarkdownElement, remarkPlugins, rehypePlugins } from "../src/markdown-pipeline.js";
import { ensureLanguages, highlightToReact, resolveLanguage } from "../src/lib/highlight.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

function render(markdown, { path = "docs/guide.md", ref = "main" } = {}) {
  return renderToStaticMarkup(renderMarkdownElement({ markdown, path, ref }));
}

/** The text a reader would select, with the markup removed. */
function visibleText(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const FENCE = (language, code) => "```" + language + "\n" + code + "\n```";

test("every registered grammar resolves", () => {
  ensureLanguages();
  for (const name of ["oq", "oqthara", "python", "java", "json", "bash", "javascript"]) {
    assert.ok(resolveLanguage(name), `${name} is registered`);
  }
  assert.equal(resolveLanguage("frobnicate"), null);
});

test("an oq-tagged fence produces real token spans", () => {
  const html = render(FENCE("oq", 'name = "Ada"\ncount = 42\n# a comment\nprint name'));
  assert.ok(html.includes('class="language-oq"'), "the fence keeps its language class");
  assert.match(html, /token keyword|token variable/);
  assert.match(html, /token string/);
  assert.match(html, /token number/);
  assert.match(html, /token comment/);
});

test("an untagged Oqthara fence is inferred and highlighted", () => {
  const html = render(FENCE("", "for n in 1 to 5\n  print n\nend"));
  assert.ok(html.includes("language-oq"), "the block was labelled from its content");
  assert.match(html, /token keyword/);
  assert.match(html, /token range-operator/);
  assert.match(html, /token statement-builtin/);
});

test("an untagged shell fence is inferred as bash", () => {
  const html = render(FENCE("", "$ java -jar oq.jar build hello.oq\ncompiled hello.oq"));
  assert.ok(html.includes("language-bash"));
  assert.ok(html.includes("token"), "shell commands are tokenised");
});

test("python, java, json and bash fences all tokenise", () => {
  const samples = {
    python: 'def greet(name):\n    return f"hi {name}"',
    java: "public final class A { int x = 1; }",
    json: '{"a": 1}',
    bash: "curl -fsSL https://example.invalid/x | bash",
  };
  for (const [language, code] of Object.entries(samples)) {
    const html = render(FENCE(language, code));
    assert.ok(html.includes(`language-${language}`), `${language} keeps its class`);
    assert.ok(html.includes("token"), `${language} produced token spans`);
  }
});

test("an unknown language does not throw and renders as plain code", () => {
  const html = render(FENCE("frobnicate", "some text here"));
  assert.doesNotMatch(html, /token/);
  assert.ok(visibleText(html).includes("some text here"));
});

test("Markdown code is never double-wrapped in pre > code > code", () => {
  // The regression: the pre override wrapped the already-highlighted code element in a second
  // code, and the inner element then matched the inline-code rule and became a white pill on
  // the dark surface.
  const html = render(FENCE("oq", "print 1"));
  assert.doesNotMatch(html, /<pre><code[^>]*><code/);
});

test("the source text survives highlighting character for character", () => {
  const source = ['def  spaced():', '    return {"a": 1}', ''].join("\n");
  const html = render(FENCE("python", source));
  const text = visibleText(html);
  assert.ok(text.includes("def  spaced():"), "double space inside the source is preserved");
  assert.ok(text.includes('    return {"a": 1}'), "four-space indentation is preserved");
});

test("hand-written blocks highlight through the same grammar set", () => {
  const tokens = highlightToReact('print "Hello, {name}!"', "oq");
  assert.ok(tokens, "the oq grammar accepted the sample");
  // `highlightToReact` answers with the list of tokens, which is exactly what React wants as
  // children but not something `createElement` accepts as an element type. A fragment is the
  // shape a caller renders.
  const html = renderToStaticMarkup(h(Fragment, null, tokens));
  assert.match(html, /token statement-builtin/);
  assert.match(html, /token string/);
  assert.match(html, /token interpolation/);
});

test("python, java, json and bash highlight outside Markdown too", () => {
  for (const [language, code] of Object.entries({
    python: "x = 1",
    java: "int x = 1;",
    json: '{"a": 1}',
    bash: "echo hi",
  })) {
    const tokens = highlightToReact(code, language);
    assert.ok(tokens, `${language} highlighted`);
    assert.ok(renderToStaticMarkup(h(Fragment, null, tokens)).includes("token"));
  }
});

test("unknown source degrades to plain text instead of throwing", () => {
  assert.equal(highlightToReact("<<<>>>", "frobnicate"), null);
  assert.equal(highlightToReact("", "oq"), null);
});

test("a javascript: link never reaches the DOM", () => {
  const html = render("[click](javascript:alert(1))");
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /click/);
});

test("a data: link never reaches the DOM", () => {
  const html = render("[click](data:text/html,<script>alert(1)</script>)");
  assert.doesNotMatch(html, /data:text\/html/i);
});

test("raw script HTML is sanitized", () => {
  const html = render("before\n\n<script>alert(1)</script>\n\nafter");
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /alert\(1\)/);
  assert.ok(html.includes("before"));
  assert.ok(html.includes("after"));
});

test("an inline event handler is stripped", () => {
  const html = render('<img src="https://example.invalid/x.png" onerror="alert(1)">');
  assert.doesNotMatch(html, /onerror/i);
});

test("dangerouslySetInnerHTML is absent from the source tree", () => {
  // A plain substring scan on purpose: it cannot be fooled by a parser edge case, and the site
  // has no reason to mention the prop anywhere in `src`, including in prose. Two modules used
  // to explain in a comment why they do not need it; the comments now say "no HTML strings"
  // instead, so the scan needs no comment parsing and keeps its full strength.
  const offenders = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(?:js|jsx)$/.test(entry)) {
        const source = readFileSync(full, "utf8");
        if (source.includes("dangerouslySetInnerHTML")) offenders.push(full);
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, []);
});

test("the plugin order highlights before sanitizing", async () => {
  const { default: rehypeSanitize } = await import("rehype-sanitize");
  const sanitizeIndex = rehypePlugins.findIndex(
    (plugin) => Array.isArray(plugin) && plugin[0] === rehypeSanitize,
  );
  const prismIndex = rehypePlugins.findIndex(
    (plugin) => Array.isArray(plugin) && typeof plugin[0] === "function" && plugin[1]?.ignoreMissing,
  );
  assert.ok(prismIndex >= 0, "Prism is in the chain");
  assert.ok(sanitizeIndex >= 0, "the sanitizer is in the chain");
  assert.ok(prismIndex < sanitizeIndex, "highlighting runs before sanitizing");
  assert.deepEqual(remarkPlugins.map((plugin) => plugin.name), ["remarkGfm"]);
});

test("rendering the same markdown twice is stable", () => {
  // Guards against Prism state leaking between renders, which would make a prerendered page
  // disagree with the hydrated one.
  const markdown = FENCE("oq", "print 1");
  assert.equal(render(markdown), render(markdown));
});
