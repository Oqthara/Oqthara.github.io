import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  extractHeadings,
  renderMarkdownElement,
  tocFromHeadings,
} from "../src/markdown-pipeline.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

const render = (markdown, path = "docs/spec/language.md", ref = "main") =>
  renderToStaticMarkup(renderMarkdownElement({ markdown, path, ref }));

test("renders GFM tables", () => {
  const html = render("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td>1<\/td>/);
});

test("renders fenced code with a language class", () => {
  const html = render("```oq\nprint 1\n```\n");
  assert.match(html, /<pre><code class="language-oq">/);
  assert.match(html, /print 1/);
});

test("renders lists and headings with anchors", () => {
  const html = render("## Two words\n\n- one\n- two\n");
  assert.match(html, /<h2 id="two-words">/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>one<\/li>/);
});

test("resolves relative document links against the source path", () => {
  const html = render("See [the spec](../spec/language.md#syntax).", "docs/adr/0009-x.md");
  assert.match(html, /href="\/docs\/spec\/language\.html#syntax"/);
});

test("resolves relative images to the raw GitHub path", () => {
  const html = render("![diagram](images/flow.png)", "docs/spec/design.md");
  assert.match(
    html,
    /src="https:\/\/raw\.githubusercontent\.com\/Oqthara\/oqthara\/main\/docs\/spec\/images\/flow\.png"/,
  );
});

test("leaves absolute URLs alone and marks them external", () => {
  const html = render("[Oqthara](https://oqthara.github.io/)");
  assert.match(html, /href="https:\/\/oqthara\.github\.io\/"/);
  assert.match(html, /rel="noreferrer noopener"/);
});

test("drops javascript: links", () => {
  const html = render("[x](javascript:alert(1))");
  assert.ok(!/javascript:/i.test(html), html);
});

test("drops javascript: links with mixed case", () => {
  const html = render("[x](JaVaScRiPt:alert(1))");
  assert.ok(!/javascript:/i.test(html), html);
});

test("drops data: links", () => {
  const html = render("[x](data:text/html;base64,PHNjcmlwdD4=)");
  assert.ok(!/data:/i.test(html), html);
});

test("drops vbscript: links", () => {
  const html = render("[x](vbscript:msgbox)");
  assert.ok(!/vbscript:/i.test(html), html);
});

test("sanitizes embedded script tags", () => {
  const html = render("before\n\n<script>alert(1)</script>\n\nafter\n");
  assert.ok(!html.includes("<script"), html);
  assert.ok(!html.includes("alert(1)"), html);
});

test("sanitizes inline event handlers", () => {
  const html = render('<img src="x" onerror="alert(1)">');
  assert.ok(!/onerror/i.test(html), html);
});

test("sanitizes iframes and style attributes", () => {
  const html = render('<iframe src="https://evil.example"></iframe>\n\n<p style="color:red">x</p>');
  assert.ok(!html.includes("<iframe"), html);
  assert.ok(!/style="/.test(html), html);
});

test("never uses dangerouslySetInnerHTML anywhere in src", () => {
  const offenders = [];
  const pattern = /dangerouslySetInnerHTML\s*[:=]/;
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(jsx|js)$/.test(entry)) continue;
      if (pattern.test(readFileSync(path, "utf8"))) offenders.push(path);
    }
  };
  walk(src);
  assert.deepEqual(offenders, []);
});

test("extractHeadings skips fenced code and keeps the ids rehype-slug assigns", () => {
  const headings = extractHeadings("# Title\n\n## First\n\n```\n## not a heading\n```\n\n### Second\n");
  assert.deepEqual(
    headings.map((heading) => [heading.level, heading.id]),
    [
      [1, "title"],
      [2, "first"],
      [3, "second"],
    ],
  );
  assert.deepEqual(
    tocFromHeadings(headings).map((heading) => heading.id),
    ["first", "second"],
  );
});

test("the Markdown component wraps the rendered document in an article", () => {
  // Tested from source rather than by importing the .jsx file, which plain Node cannot
  // load; the pipeline below is the part that has to be verifiable without a JSX loader.
  const wrapper = readFileSync(join(src, "components", "Markdown.jsx"), "utf8");
  assert.match(wrapper, /h\("article", \{ className \}/);
  assert.match(render("# Hi\n"), /<h1 id="hi">/);
});

test("a compiled-document table and fenced block both render together", () => {
  const html = render(
    "## Compiled subset\n\n| Feature | Status |\n| --- | --- |\n| loops | yes |\n\n```oq\nfor n in 1 to 3\nend\n```\n",
  );
  assert.match(html, /<h2 id="compiled-subset">/);
  assert.match(html, /<table>/);
  assert.match(html, /<pre><code class="language-oq">/);
});
