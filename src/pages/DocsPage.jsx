import { createElement as h } from "react";
import { hrefFor, Note, PageHead, Table } from "../components/Layout.jsx";
import { Code } from "../components/Code.jsx";
import { ChannelSelect } from "../components/ChannelSelect.jsx";
import { useCatalog } from "../use-docs.js";
import { DOC_INDEX_URL, channelById, routeForDoc } from "../source.js";

const COMMANDS = [
  ["oq file.oq", "Run a program"],
  ["oq run file.oq", "Same, explicit"],
  ["oq check file.oq", "Parse without running"],
  ["oq repl", "Interactive session"],
  ["oq fmt file.oq", "Canonical, idempotent formatting"],
  ["oq test [dir]", "Run test_*.oq and tests/"],
  ["oq new name", "Create a project"],
  ["oq build file.oq", "Produce an executable jar"],
  ["oq build file.oq --emit-ir", "Print the intermediate representation"],
  ["oq doc .", "Regenerate the stdlib reference"],
  ["oq version", "Show the version"],
  ["oq help", "Show the command list"],
];

const SECTION_TITLES = {
  spec: "Specification",
  adr: "Decision records",
  reference: "Reference",
  stdlib: "Standard library",
};

const SECTION_ORDER = ["spec", "reference", "stdlib", "adr"];

function sectionTitle(section) {
  return SECTION_TITLES[section] ?? section;
}

/**
 * The documentation index, built from the catalog published in Oqthara/oqthara.
 *
 * Nothing is bundled: the list comes from `docs/catalog.json` at the selected channel, so
 * adding a document to the language repository adds it here with no site change.
 */
function DocIndex({ docs, ref }) {
  const grouped = new Map();
  for (const doc of docs) {
    const key = doc.section || "other";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(doc);
  }
  const sections = [...grouped.keys()].sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a);
    const ib = SECTION_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

  return h(
    "div",
    { className: "doc-index" },
    sections.map((section) =>
      h(
        "section",
        { key: section },
        h("h2", null, sectionTitle(section)),
        h(
          "ul",
          { className: "doc-list" },
          grouped.get(section).map((doc) =>
            h(
              "li",
              { key: doc.path },
              h(
                "a",
                {
                  href: `${routeForDoc(doc.path)}${ref === "main" ? "" : `?ref=${encodeURIComponent(ref)}`}`,
                },
                doc.title,
              ),
              h("code", null, doc.path),
            ),
          ),
        ),
      ),
    ),
  );
}

function Loading({ what }) {
  return h(
    "div",
    { className: "doc-status", role: "status", "aria-live": "polite" },
    h("p", null, `Loading ${what} from GitHub…`),
    h("div", { className: "skeleton", "aria-hidden": "true" }),
  );
}

function LoadFailure({ error, what }) {
  return h(
    "div",
    { className: "doc-status doc-status-error", role: "alert" },
    h("h2", null, `Could not load ${what}`),
    h("p", null, error?.message ?? "GitHub could not be reached."),
    h(
      "p",
      null,
      error?.url
        ? h("a", { href: error.url }, "Open the document on GitHub")
        : h("a", { href: DOC_INDEX_URL }, "Browse the documentation on GitHub"),
    ),
  );
}

export function DocsPage({ versions = [], latest = null, query = {} }) {
  const channel = channelById(query.ref);
  const { status, data: docs, error } = useCatalog(channel.ref);

  return h(
    "div",
    null,
    h(PageHead, {
      eyebrow: "Documentation",
      title: "Documentation",
      lead: "Reference material for the language, the CLI, the compiler and the standard library. Every page here is fetched from Oqthara/oqthara when you open it, so this site never holds a second copy of the documentation.",
    }),

    h(ChannelSelect, { ref: channel.ref, path: "/docs.html" }),

    status === "loading" ? h(Loading, { what: "the documentation index" }) : null,
    status === "error" && !docs
      ? h(LoadFailure, { error, what: "the documentation index" })
      : null,
    docs ? h(DocIndex, { docs, ref: channel.ref }) : null,

    h(
      "p",
      null,
      "The ",
      h("a", { href: hrefFor("/stdlib.html") }, "standard library"),
      ", ",
      h("a", { href: hrefFor("/changelog.html") }, "changelog"),
      " and ",
      h("a", { href: hrefFor("/examples.html") }, "examples"),
      " pages are also rendered from their canonical sources.",
    ),

    h("h2", null, "The oq command"),
    h(Table, {
      head: ["Command", "What it does"],
      rows: COMMANDS.map(([command, what]) => [h("code", null, command), what]),
    }),

    h("h2", null, "Installation"),
    h(Code, null, `# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/Oqthara/oqthara/main/scripts/install.sh | bash

# Windows PowerShell
irm https://raw.githubusercontent.com/Oqthara/oqthara/main/scripts/install.ps1 | iex

# Docker
docker run --rm -v "$PWD:/work" oqthara/oq:latest hello.oq`),

    h(
      Note,
      null,
      "A compiled jar runs the interpreter for everything outside the compiled subset and emits real bytecode for the rest. The compiler documentation states the measured boundary; this page does not restate it from memory.",
    ),
  );
}
