// The one place a syntax-highlighting grammar set is assembled.
//
// Both Markdown rendering (through `rehype-prism-plus`) and the hand-written code samples on
// the homepage, tour and example pages use this module, so a language is registered once and
// every code surface agrees. `refractor/core` is used instead of `refractor/all`: the full
// bundle is roughly ten times larger and this site shows six languages.

import { createElement as h } from "react";
import { refractor } from "refractor/core";
import python from "refractor/python";
import java from "refractor/java";
import json from "refractor/json";
import bash from "refractor/bash";
import javascript from "refractor/javascript";
import typescript from "refractor/typescript";
import yaml from "refractor/yaml";
import markdown from "refractor/markdown";
import diff from "refractor/diff";
import { registerOqthara } from "./oqthara-grammar.js";
import { inferLanguage } from "./infer-language.js";

let registered = false;

/** Registers every grammar exactly once, which keeps module reloads from duplicating them. */
export function ensureLanguages() {
  if (registered) return refractor;
  for (const language of [python, java, json, bash, javascript, typescript, yaml, markdown, diff]) {
    refractor.register(language);
  }
  // Oqthara has no upstream grammar, so the site ships its own, written from the canonical
  // specification. See `oqthara-grammar.js`.
  registerOqthara(refractor);
  registered = true;
  return refractor;
}

/** Language aliases that should resolve to a registered grammar. */
const ALIASES = {
  oq: "oqthara",
  sh: "bash",
  shell: "bash",
  console: "bash",
  js: "javascript",
  ts: "typescript",
  py: "python",
  yml: "yaml",
};

/** The grammar name for a fence label, or `null` if that grammar is not registered. */
export function resolveLanguage(name) {
  ensureLanguages();
  const key = String(name ?? "").trim().toLowerCase();
  if (!key) return null;
  const candidates = [key, ALIASES[key]].filter(Boolean);
  for (const candidate of candidates) {
    if (refractor.registered(candidate)) return candidate;
  }
  return null;
}

/** Converts a hast node from refractor into a React element. */
function toReact(node, key) {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return null;
  const { tagName, properties = {}, children = [] } = node;
  const props = { key };
  if (properties.className) props.className = properties.className.join(" ");
  return h(tagName, props, children.map((child, index) => toReact(child, `${key}-${index}`)));
}

/**
 * Highlights source text into React elements, never into an HTML string.
 *
 * Returning elements rather than markup means the output cannot introduce HTML even if the
 * source contains tags, and it renders identically during prerendering and in the browser.
 * Unrecognised or missing languages return `null` so the caller falls back to plain text.
 */
export function highlightToReact(code, language) {
  const source = String(code ?? "");
  const name = resolveLanguage(language) ?? resolveLanguage(inferLanguage(source));
  if (!name || !source.trim()) return null;
  try {
    const tree = refractor.highlight(source.replace(/\n$/, ""), name);
    return tree.children.map((child, index) => toReact(child, `t${index}`));
  } catch {
    // A grammar that refuses this input must degrade to readable text, not break the page.
    return null;
  }
}
