const SUBGRAPH = /^\s*subgraph\s+(?:[^\s[]+\s*\[\s*"?(.*?)"?\s*\]|(.+?))\s*$/;

/** The flow is one Mermaid block with no headings, so graphify sees one node; this lists each subgraph title as a heading. */
export function flowOutline(flow: string): string | null {
  const titles = flow.split('\n').flatMap((line) => {
    const match = SUBGRAPH.exec(line);
    return match ? [(match[1] ?? match[2]!).trim()] : [];
  });
  return titles.length ? `# Etapas do flow.md\n\n${titles.map((title) => `## ${title}`).join('\n\n')}\n` : null;
}
