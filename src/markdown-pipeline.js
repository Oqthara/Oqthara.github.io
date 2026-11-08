// The Markdown pipeline shared by every page that displays repository text.
//
// `react-markdown` renders to React elements, so the site never assembles an HTML string
// from untrusted input and no raw-HTML injection point is needed. The plugin
// order matters: `rehype-raw` parses embedded HTML first, then `rehype-sanitize` removes
// everything not on the allowlist, then `rehype-slug` adds stable heading ids.

import { createElement as h } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import GithubSlugger from "github-slugger";
import rehypePrismGenerator from "rehype-prism-plus/generator";
import { refractor } from "refractor/core";
import { ensureLanguages } from "./lib/highlight.js";
import { inferLanguagePlugin } from "./lib/infer-language.js";
import { CodeBlock } from "./components/Code.js";
import { resolveImage, resolveRelative } from "./source.js";

// Grammars are registered once, in `lib/highlight.js`, which is also what the hand-written
// code samples use. Registering them here as well would let the two surfaces drift apart.
ensureLanguages();

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"];

/** Flattens React children to their text, which is what the copy button puts on the clipboard. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node.props) return textOf(node.props.children);
  return "";
}

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

// `rehype-prism-plus`'s default export highlights with `refractor/all`, which carries every
// grammar Prism ships. That is the whole reason the site bundle was 1.2 MB: this module never
// imported those grammars, the plugin pulled them in from underneath, so `refractor/core` above
// bought nothing. The `/generator` entry takes the refractor instance instead, which keeps the
// site on the nine grammars registered here.
const rehypePrism = rehypePrismGenerator(refractor);

export const rehypePlugins = [
  rehypeRaw,
  // Most canonical documents fence their samples with no language at all (84 of 96 blocks),
  // so a grammar is chosen from the content before highlighting runs. Blocks that already name
  // a language, and all inline code, are left alone.
  inferLanguagePlugin,
  // Syntax highlighting runs before sanitisation: it rewrites fenced blocks into nested
  // `token` spans, and the sanitizer would otherwise remove those classes (or the whole
  // rewrite would be undone).
  [rehypePrism, { ignoreMissing: true }],
  [rehypeSanitize, schema],
  rehypeSlug,
];

const EXTERNAL = /^(?:https?:)?\/\//i;

/**
 * React components for the elements whose targets must be rewritten. `fromPath` is the
 * repository path of the document, so a relative `backend.md` becomes a site route and a
 * relative image becomes a raw.githubusercontent.com URL.
 */
export function buildComponents({ path = "", ref = "main" } = {}) {
  return {
    // Copy controls on fenced blocks.
    //
    // The children arriving here are already highlighted (Prism ran in the rehype chain), so
    // they are rendered as-is. Only the plain text is extracted for the clipboard, by walking
    // the React children rather than reading the DOM, so this also works during SSR.
    pre({ node: _node, children, ...props }) {
      // `rehype-prism-plus` has already replaced the block with `pre > code.code-highlight`,
      // so the first child is the element to render. It must be passed through as the whole
      // `pre` body: wrapping it in another `code` produced `pre > code > code`, and the inner
      // element then matched the inline-code rule and was painted as a white pill.
      const codeChild = Array.isArray(children) ? children[0] : children;
      const raw = textOf(codeChild?.props?.children);
      const language = /language-([\w+-]+)/.exec(String(codeChild?.props?.className ?? ""))?.[1];
      return h(CodeBlock, { code: raw, label: language, highlighted: codeChild });
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
      // `overflow-x: auto` makes this a scroll container, so it has to take focus: without a
      // focus stop a keyboard cannot scroll a wide table at all.
      return h("div", { className: "table-wrap", tabIndex: 0 }, h("table", props, children));
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
