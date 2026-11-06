// The Markdown pipeline shared by every page that displays repository text.
//
// `react-markdown` renders to React elements, so the site never assembles an HTML string
// from untrusted input and `dangerouslySetInnerHTML` is not needed anywhere. The plugin
// order matters: `rehype-raw` parses embedded HTML first, then `rehype-sanitize` removes
// everything not on the allowlist, then `rehype-slug` adds stable heading ids.

import { createElement as h } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import GithubSlugger from "github-slugger";
import { CodeBlock } from "./components/Code.js";
import { resolveImage, resolveRelative } from "./source.js";

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"];

/** Extends the default schema with the handful of attributes the documentation uses. */
export const schema = {
  ...defaultSchema,
  // Documentation ids are authored in this repository, and `rehype-slug` adds the rest.
  // No prefix keeps `#anchor` links and the generated table of contents in agreement.
  clobberPrefix: "",
  attributes: {
    ...defaultSchema.attributes,
    a: [...new Set([...(defaultSchema.attributes.a ?? []), "className"])],
    code: [...new Set([...(defaultSchema.attributes.code ?? []), "className"])],
    pre: [...new Set([...(defaultSchema.attributes.pre ?? []), "className"])],
    span: [...new Set([...(defaultSchema.attributes.span ?? []), "className"])],
    th: [...new Set([...(defaultSchema.attributes.th ?? []), "className", "align"])],
    td: [...new Set([...(defaultSchema.attributes.td ?? []), "className", "align"])],
    ...Object.fromEntries(
      HEADINGS.map((tag) => [tag, [...new Set([...(defaultSchema.attributes[tag] ?? []), "id"])]]),
    ),
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https", "mailto"],
  },
};

export const remarkPlugins = [remarkGfm];
export const rehypePlugins = [rehypeRaw, [rehypeSanitize, schema], rehypeSlug];

const EXTERNAL = /^(?:https?:)?\/\//i;

/**
 * React components for the elements whose targets must be rewritten. `fromPath` is the
 * repository path of the document, so a relative `backend.md` becomes a site route and a
 * relative image becomes a raw.githubusercontent.com URL.
 */
export function buildComponents({ path = "", ref = "main" } = {}) {
  return {
    // Copy controls on fenced blocks. `pre` receives the `code` child, so the text is read
    // from its props rather than the DOM, which keeps this working during server rendering.
    pre({ node: _node, children, ...props }) {
      const codeChild = Array.isArray(children) ? children[0] : children;
      const text = codeChild?.props?.children;
      const raw = Array.isArray(text) ? text.join("") : text;
      const language = /language-([\w+-]+)/.exec(String(codeChild?.props?.className ?? ""))?.[1];
      return h(CodeBlock, { code: typeof raw === "string" ? raw : "", label: language });
    },
    // The page supplies the single h1; a document's own h1 becomes an h2 so heading order stays
    // valid and no page ever has two top-level headings.
    h1({ node: _node, children, id, ...props }) {
      return h("h2", { id, ...props }, children, id ? h("a", { className: "heading-anchor", href: `#${id}`, "aria-label": "Link to this section" }, "#") : null);
    },
    h2({ node: _node, children, id, ...props }) {
      return h("h2", { id, ...props }, children, id ? h("a", { className: "heading-anchor", href: `#${id}`, "aria-label": "Link to this section" }, "#") : null);
    },
    h3({ node: _node, children, id, ...props }) {
      return h("h3", { id, ...props }, children, id ? h("a", { className: "heading-anchor", href: `#${id}`, "aria-label": "Link to this section" }, "#") : null);
    },
    a({ node: _node, href, children, ...props }) {
      const target = href === undefined ? null : resolveRelative(path, href, ref);
      if (target === null || target === undefined) {
        return h("span", null, children);
      }
      const external = EXTERNAL.test(target);
      return h(
        "a",
        {
          ...props,
          href: target,
          ...(external ? { rel: "noreferrer noopener", target: "_blank" } : null),
        },
        children,
      );
    },
    img({ node: _node, src, alt, ...props }) {
      const target = src === undefined ? null : resolveImage(path, src, ref);
      if (!target) return null;
      return h("img", { ...props, src: target, alt: alt ?? "", loading: "lazy" });
    },
    table({ node: _node, children, ...props }) {
      return h("div", { className: "table-wrap" }, h("table", props, children));
    },
  };
}

const CODE_FENCE = /^\s*(```|~~~)/;

/** Removes inline Markdown so heading text matches the text `rehype-slug` hashes. */
export function plainHeading(text) {
  return String(text ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~]/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/\[([^\]]+)\]/g, "$1")
    .trim();
}

/**
 * The headings a Markdown document will produce, with the ids `rehype-slug` assigns.
 * Fences are skipped so a `# comment` inside a code block never lands in the contents.
 */
export function extractHeadings(markdown) {
  const slugger = new GithubSlugger();
  const headings = [];
  let fence = null;
  for (const line of String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMatch = CODE_FENCE.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = plainHeading(match[2]);
    if (!text) continue;
    headings.push({ level: match[1].length, text, id: slugger.slug(text) });
  }
  return headings;
}

/** Levels shown in the page contents: `##` and `###`, matching the docs' structure. */
export function tocFromHeadings(headings) {
  return headings.filter((heading) => heading.level >= 2 && heading.level <= 3);
}

/**
 * The single rendering entry point, kept in a `.js` module so plain Node tests can call it
 * without a JSX loader. `components/Markdown.jsx` wraps the result in the article element.
 */
export function renderMarkdownElement({ markdown = "", path = "", ref = "main" } = {}) {
  return h(ReactMarkdown, {
    remarkPlugins,
    rehypePlugins,
    components: buildComponents({ path, ref }),
    children: markdown,
  });
}
