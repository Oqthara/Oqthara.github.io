// Section grouping shared by the documentation index and the document sidebar.
//
// Two surfaces presented the same documents in two different orders: the index put Overview
// first and the sidebar sorted alphabetically, so "Decision records" led the sidebar. One
// function now decides, and both use it.

export const SECTION_ORDER = [
  "Overview",
  "Specification",
  "Reference",
  "Standard library",
  "Guides",
  "Decision records",
];

function rank(name) {
  const index = SECTION_ORDER.indexOf(name);
  return index === -1 ? SECTION_ORDER.length : index;
}

/** Groups documents into `[{ section, entries }]` in a stable, meaningful order. */
export function groupDocuments(docs) {
  if (!Array.isArray(docs)) return [];
  const groups = new Map();
  for (const doc of docs) {
    const key = doc.section || "Documentation";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(doc);
  }
  return [...groups.entries()]
    .map(([section, entries]) => ({
      section,
      entries: entries.slice().sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => rank(a.section) - rank(b.section) || a.section.localeCompare(b.section));
}
