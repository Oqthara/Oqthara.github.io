import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { createElement as h } from "react";

import {
  extractHeadings,
  tocFromHeadings,
  plainHeading,
  renderMarkdownElement,
  schema,
  remarkPlugins,
  rehypePlugins,
} from "../src/markdown-pipeline.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

function render(markdown, { path = "docs/guide.md", ref = "main" } = {}) {
  return renderToStaticMarkup(renderMarkdownElement({ markdown, path, ref }));
}

// A fixture that mirrors the shapes the real corpus uses: a table, a fenced `oq` block,
// a nested list and headings. It is inline on purpose; live corpus checks live in live.test.js.
const FIXTURE = [
  "# Language Guide",
  "",
  "Intro paragraph with `inline code`.",
  "",
  "## Statements",
  "",
  "- one",
  "  - nested",
  "- two",
  "",
  "### Loop",
  "",
  "```oq",
  "for n in 1 to 5",
  "  print n",
  "end",
  "```",
  "",
  "| Keyword | Meaning |",
  "| --- | --- |",
  "| `to` | inclusive range |",
  "| `end` | closes a block |",
].join("\n");

test("renders GFM tables with header and body cells", () => {
  const html = render(FIXTURE);
  assert.match(html, /<table>/);
  assert.match(html, /<thead>/);
  assert.match(html, /<th>Keyword<\/th>/);
  assert.match(html, /<td><code>to<\/code><\/td>/);
  assert.match(html, /<td>inclusive range<\/td>/);
  // The pipeline wraps tables so they can scroll on narrow screens.
  assert.match(html, /class="table-wrap"/);
});

test("a table wrapper can take focus so it can be scrolled by keyboard", () => {
  // `overflow-x: auto` makes the wrapper scroll, and an unfocusable scroll container cannot be
  // scrolled without a pointer. Asserted structurally rather than as an exact element string so
  // that unrelated attribute changes do not fail it.
  const html = render(FIXTURE);
  const wrapper = html.match(/<div[^>]*class="table-wrap"[^>]*>/i);
  assert.ok(wrapper, "the pipeline wraps tables in .table-wrap");
  assert.match(wrapper[0], /tabindex="0"/i);
});

test("fenced code carries a language class before the code component consumes it", () => {
  // The same plugin set without the custom `pre` shows the class the pipeline produces and
  // CodeBlock turns into the visible label.
  const html = renderToStaticMarkup(
    h(ReactMarkdown, {
      remarkPlugins,
      rehypePlugins,
      children: "```oq\nprint 1\n```",
    }),
  );
  assert.match(html, /<code class="language-oq">/);
});

test("renders fenced code with its language label and the real source", () => {
  const html = render(FIXTURE);
  // CodeBlock turns the fenced language into the visible label and keeps the text verbatim.
  assert.match(html, /<div class="code-label"><span>oq<\/span>/);
  // Highlighting splits the source into token spans, so the text is compared with the tags
  // removed. That is a stronger check than a substring match: it proves the source survives
  // tokenisation character for character, including the two-space indentation.
  const codeText = html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'");
  assert.ok(codeText.includes("for n in 1 to 5"), "source text is preserved verbatim");
  assert.ok(codeText.includes("  print n"), "indentation is preserved");
  assert.match(html, /<div class="code-block/);
  assert.match(html, /class="copy-button"/);
  // The raw fence markers must not leak into the output.
  assert.doesNotMatch(html, /```/);
});

test("renders nested lists", () => {
  const html = render(FIXTURE);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>one\s*<ul>/);
  assert.match(html, /<li>nested<\/li>/);
});

test("adds the same heading ids that extractHeadings reports", () => {
  const html = render(FIXTURE);
  const headings = extractHeadings(FIXTURE);
  assert.deepEqual(
    headings.map((heading) => [heading.level, heading.text, heading.id]),
    [
      [1, "Language Guide", "language-guide"],
      [2, "Statements", "statements"],
      [3, "Loop", "loop"],
    ],
  );
  for (const heading of headings) {
    assert.match(html, new RegExp(`id="${heading.id}"`));
  }
  // h2/h3 get an anchor link to their own id.
  assert.match(html, /<a class="heading-anchor" href="#statements"/);
});

test("sanitization removes script-bearing links and elements", () => {
  const inputs = [
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x]( javascript:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](vbscript:msgbox(1))",
    "[x](java\tscript:alert(1))",
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<iframe src=\"https://evil.example\"></iframe>",
    "<span style=\"color:red\">styled</span>",
    "<a href=\"javascript:alert(1)\">raw link</a>",
  ];
  for (const input of inputs) {
    const html = render(input);
    const lowered = html.toLowerCase();
    assert.doesNotMatch(lowered, /javascript:/, `unsafe javascript: survived: ${input}`);
    assert.doesNotMatch(lowered, /vbscript:/, `unsafe vbscript: survived: ${input}`);
    assert.doesNotMatch(lowered, /data:text\/html/, `unsafe data: survived: ${input}`);
    assert.doesNotMatch(lowered, /<script/, `script element survived: ${input}`);
    assert.doesNotMatch(lowered, /<iframe/, `iframe survived: ${input}`);
    assert.doesNotMatch(lowered, /onerror/, `event handler survived: ${input}`);
    assert.doesNotMatch(lowered, /style=/, `style attribute survived: ${input}`);
  }
});

test("dangerouslySetInnerHTML is never really used under src/", () => {
  // Comments that name it are fine; an assignment or JSX prop is not.
  const offenders = [];
  const pattern = /dangerouslySetInnerHTML\s*[:=]/;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(jsx?|mjs)$/.test(entry.name)) {
        const text = readFileSync(full, "utf8");
        if (pattern.test(text)) offenders.push(full);
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], "untrusted HTML must never be injected");
});

test("relative Markdown links resolve to canonical routes for a document in docs/adr/", () => {
  const markdown = [
    "[spec](../spec/language.md#grammar)",
    "",
    "[sibling](./0002-runtime.md)",
    "",
    "[example](../../examples/basics/hello.oq)",
    "",
    "[changelog](../../CHANGELOG.md)",
    "",
    "[license](../../LICENSE)",
  ].join("\n");
  const html = render(markdown, { path: "docs/adr/0003-bytecode.md", ref: "v0.1.0-alpha.2" });
  assert.match(
    html,
    /href="\/document\.html\?path=docs%2Fspec%2Flanguage\.md&amp;ref=v0\.1\.0-alpha\.2#grammar"/,
  );
  assert.match(
    html,
    /href="\/document\.html\?path=docs%2Fadr%2F0002-runtime\.md&amp;ref=v0\.1\.0-alpha\.2"/,
  );
  assert.match(
    html,
    /href="\/example\.html\?path=examples%2Fbasics%2Fhello\.oq&amp;ref=v0\.1\.0-alpha\.2"/,
  );
  assert.match(html, /href="\/changelog\.html"/);
  assert.match(html, /href="https:\/\/github\.com\/Oqthara\/oqthara\/blob\/v0\.1\.0-alpha\.2\/LICENSE"/);
});

test("relative images resolve to raw.githubusercontent.com and unsafe sources are dropped", () => {
  const markdown = ["![diagram](../assets/diagram.png)", "", "![bad](javascript:alert(1))"].join("\n");
  const html = render(markdown, { path: "docs/adr/0001-x.md", ref: "v1" });
  assert.match(
    html,
    /src="https:\/\/raw\.githubusercontent\.com\/Oqthara\/oqthara\/v1\/docs\/assets\/diagram\.png"/,
  );
  assert.match(html, /alt="diagram"/);
  assert.doesNotMatch(html.toLowerCase(), /javascript:/);
});

test("external links get noreferrer/noopener and open in a new tab", () => {
  const html = render("[GitHub](https://github.com/Oqthara/oqthara)");
  assert.match(html, /href="https:\/\/github\.com\/Oqthara\/oqthara"/);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.match(html, /target="_blank"/);
});

test("extractHeadings skips fenced code and dedupes repeated slugs", () => {
  const markdown = [
    "# Top",
    "",
    "```md",
    "# Not A Heading",
    "## Also Not",
    "```",
    "",
    "## Install",
    "",
    "## Install",
  ].join("\n");
  const headings = extractHeadings(markdown);
  assert.deepEqual(
    headings.map((heading) => heading.id),
    ["top", "install", "install-1"],
  );
  assert.equal(headings.some((heading) => heading.text === "Not A Heading"), false);
});

test("extractHeadings strips inline Markdown so ids match rehype-slug", () => {
  const markdown = "## [The `oq` CLI](#cli)\n";
  const [heading] = extractHeadings(markdown);
  assert.equal(heading.text, "The oq CLI");
  assert.equal(heading.id, "the-oq-cli");
  assert.equal(plainHeading("**bold** and _em_"), "bold and em");
});

test("tocFromHeadings keeps only h2 and h3", () => {
  const headings = extractHeadings("# H1\n\n## H2\n\n### H3\n\n#### H4\n");
  assert.deepEqual(
    tocFromHeadings(headings).map((heading) => heading.level),
    [2, 3],
  );
  assert.deepEqual(tocFromHeadings([]), []);
});

test("the plugin order parses raw HTML before sanitizing", async () => {
  const { default: rehypeRaw } = await import("rehype-raw");
  const { default: rehypeSanitize } = await import("rehype-sanitize");
  const { default: rehypeSlug } = await import("rehype-slug");
  const { inferLanguagePlugin } = await import("../src/lib/infer-language.js");
  assert.deepEqual(remarkPlugins.map((plugin) => plugin.name), ["remarkGfm"]);
  // raw HTML, language inference, Prism, sanitize, slug: highlighting and inference both run
  // before the sanitizer so the classes they add are on the allowlist and survive.
  assert.equal(rehypePlugins.length, 5);
  assert.equal(rehypePlugins[0], rehypeRaw);
  assert.equal(rehypePlugins[1], inferLanguagePlugin);
  assert.equal(typeof rehypePlugins[2][0], "function");
  assert.equal(rehypePlugins[3][0], rehypeSanitize);
  assert.equal(rehypePlugins[4], rehypeSlug);
  // Schema allows the class names the docs use and no clobber prefix.
  assert.equal(schema.clobberPrefix, "");
  assert.ok(schema.attributes.code.includes("className"));
  assert.deepEqual(schema.protocols.href, ["http", "https", "mailto"]);
});
