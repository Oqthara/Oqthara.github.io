import { createElement as h } from "react";
import { CodeBlock, INSTALL_COMMAND, INSTALL_COMMAND_WINDOWS } from "../components/Code.js";
import { hrefFor, Grid, Note, Card } from "../components/Layout.jsx";
import { documentRoute } from "../source.js";
import { PRINCIPLES } from "./PhilosophyPage.jsx";

// The homepage.
//
// It says what Oqthara is, shows real code, and sends the reader somewhere useful. It holds no
// version number, no release list and no capability claims: those change in the language, so
// they are read from canonical sources on the pages that display them.
//
// There is deliberately no Playground. This site is static hosting with no execution service,
// and an editor that cannot run a program would be a promise the project does not keep.

const HELLO = `print "Hello, World!"

data Point(x, y)
fun distance(a, b)
  dx = a.x - b.x
  dy = a.y - b.y
  return sqrt(dx ** 2 + dy ** 2)
end

p = Point(3, 4)
print distance(p, Point(0, 0))`;

const TOUR_SNIPPET = `for n in 1 to 5
  print n
end

names = ["ada", "grace", "alan"]
print names.map(name -> name.upper())`;

export function HomePage() {
  return h(
    "div",
    null,
    h(
      "section",
      { className: "hero", "aria-labelledby": "hero-title" },
      h(
        "div",
        { className: "content hero-inner" },
        h(
          "div",
          null,
          h("span", { className: "badge" }, h("span", { className: "badge-dot", "aria-hidden": "true" }), "JVM · MIT · Java 21+"),
          h("h1", { id: "hero-title" }, "A language that reads like the idea."),
          h(
            "p",
            { className: "lead" },
            "Oqthara is a small language for the JVM. No classes to wrap a script in, no ceremony between you and the program, and full access to every Java library when you need one.",
          ),
          h(
            "div",
            { className: "hero-actions" },
            h("a", { className: "button", href: hrefFor("/philosophy.html") }, "Read the philosophy"),
            h("a", { className: "button button-secondary", href: hrefFor("/tour.html") }, "Take the tour"),
          ),
        ),
        h(
          "div",
          { className: "hero-code" },
          h(CodeBlock, { code: HELLO, label: "hello.oq", language: "oq" }),
        ),
      ),
    ),

    h(
      "section",
      { className: "section", "aria-labelledby": "install" },
      h(
        "div",
        { className: "content" },
        h(
          "div",
          { className: "section-head" },
          h("h2", { id: "install" }, "Install"),
          h("p", null, "One command on macOS or Linux. The installer reads the latest published release, verifies the artifact before installing it, and can be pinned to a version with OQ_VERSION."),
        ),
        h(CodeBlock, { code: INSTALL_COMMAND, label: "macOS and Linux", language: "bash" }),
        h("div", { style: { height: "var(--space-3)" } }),
        h(CodeBlock, { code: INSTALL_COMMAND_WINDOWS, label: "Windows PowerShell", language: "bash" }),
        h(
          "p",
          { className: "meta-row", style: { marginTop: "var(--space-4)" } },
          h("a", { href: documentRoute("docs/reference/cli.md") }, "CLI reference"),
          h("a", { href: "https://github.com/Oqthara/oqthara/releases" }, "All releases"),
        ),
      ),
    ),

    h(
      "section",
      { className: "section", "aria-labelledby": "why" },
      h(
        "div",
        { className: "content" },
        h(
          "div",
          { className: "section-head" },
          h("h2", { id: "why" }, "Why another language?"),
          h("p", null, "Because the distance between an idea and a running program should be short, and because staying on the JVM should not mean writing Java in a different font."),
        ),
        h(
          Grid,
          null,
          h(Card, { title: "Reads like pseudocode", kicker: "Surface" },
            "Blocks close with end, statements end at a newline, and a program can be one line. Nothing is there to satisfy the parser."),
          h(Card, { title: "Real Java interop", kicker: "Runtime" },
            "use imports any Java class. Constructors, static methods and fields work the way you expect, without a wrapper layer."),
          h(Card, { title: "One language, two backends", kicker: "Semantics" },
            "The interpreter is authoritative and the compiler emits bytecode for the subset it can prove. A divergence between them is a bug."),
        ),
        h(
          "div",
          { style: { marginTop: "var(--space-6)" } },
          h(CodeBlock, { code: TOUR_SNIPPET, label: "loops.oq", language: "oq" }),
        ),
      ),
    ),

    h(
      "section",
      { className: "section", "aria-labelledby": "principles" },
      h(
        "div",
        { className: "content" },
        h(
          "div",
          { className: "section-head" },
          h("h2", { id: "principles" }, "What it optimises for"),
          h("p", null, "The short version. The full statement, with goals and non-goals, is the design document."),
        ),
        h(
          "div",
          { className: "principles" },
          PRINCIPLES.slice(0, 4).map((principle, index) =>
            h(
              "article",
              { className: "principle", key: principle.title },
              h("span", { className: "principle-number" }, String(index + 1).padStart(2, "0")),
              h("h3", null, principle.title),
              h("p", null, principle.body),
            ),
          ),
        ),
        h(
          "p",
          { style: { marginTop: "var(--space-5)" } },
          h("a", { className: "button button-secondary", href: hrefFor("/philosophy.html") }, "The full philosophy"),
        ),
      ),
    ),

    h(
      "section",
      { className: "section", "aria-labelledby": "explore" },
      h(
        "div",
        { className: "content" },
        h(
          "div",
          { className: "section-head" },
          h("h2", { id: "explore" }, "Where to go next"),
          h("p", null, "Everything below is read from the repository, so it reflects the language as it is today."),
        ),
        h(
          Grid,
          null,
          h(Card, { title: "The tour", kicker: "Learn", href: hrefFor("/tour.html") },
            "Values, control flow, functions, collections, data types, errors and interop in one sitting."),
          h(Card, { title: "Examples", kicker: "Read", href: hrefFor("/examples.html") },
            "Complete programs discovered from the repository, from calculators to data structures."),
          h(Card, { title: "Documentation", kicker: "Reference", href: hrefFor("/docs.html") },
            "The language specification, the CLI reference, decision records and the standard library."),
          h(Card, { title: "Changelog", kicker: "History", href: hrefFor("/changelog.html") },
            "What changed in each release, read from the repository changelog."),
          h(Card, { title: "Status", kicker: "Honesty", href: hrefFor("/status.html") },
            "What the compiler does today and what it deliberately refuses, from the documented boundary."),
          h(Card, { title: "GitHub", kicker: "Contribute", href: "https://github.com/Oqthara/oqthara" },
            "Source, issues and releases. The documentation you just read lives there too."),
        ),
      ),
    ),

    h(
      "section",
      { className: "section" },
      h(
        "div",
        { className: "content" },
        h(
          Note,
          null,
          h("strong", null, "Nothing here claims more than the language does. "),
          "Capabilities, versions and compiler limits are read from the repository at request time, so this site cannot quietly drift from the implementation.",
        ),
      ),
    ),
  );
}
