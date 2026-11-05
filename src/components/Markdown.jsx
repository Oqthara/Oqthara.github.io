import { createElement as h } from "react";
import {
  buildComponents,
  extractHeadings,
  rehypePlugins,
  remarkPlugins,
  renderMarkdownElement,
  tocFromHeadings,
} from "../markdown-pipeline.js";

// The only Markdown component in the site. Every page that shows repository text renders
// through this file, so the sanitizer, the link resolver and the heading ids cannot drift
// between the documentation, the changelog and the standard library reference. The actual
// element construction lives in `markdown-pipeline.js` so the tests can render it in Node
// without a JSX transform; the plugin order there is:
//
//   remarkGfm -> rehypeRaw -> rehypeSanitize(schema) -> rehypeSlug
//
// `rehypeRaw` runs before the sanitizer, so embedded HTML is cleaned rather than trusted.

export { buildComponents, extractHeadings, rehypePlugins, remarkPlugins, tocFromHeadings };

export function Markdown({ markdown = "", path = "", ref = "main", className = "doc" }) {
  return h("article", { className }, renderMarkdownElement({ markdown, path, ref }));
}

/** The rendered document plus its table of contents. */
export function MarkdownWithToc({ markdown = "", path = "", ref = "main" }) {
  const toc = tocFromHeadings(extractHeadings(markdown));
  return h(
    "div",
    { className: toc.length ? "doc-layout" : null },
    toc.length
      ? h(
          "nav",
          { className: "toc", "aria-label": "On this page" },
          h("strong", null, "On this page"),
          h(
            "ul",
            null,
            toc.map((heading) =>
              h(
                "li",
                { key: heading.id, className: `toc-level-${heading.level}` },
                h("a", { href: `#${heading.id}` }, heading.text),
              ),
            ),
          ),
        )
      : null,
    h(Markdown, { markdown, path, ref }),
  );
}
