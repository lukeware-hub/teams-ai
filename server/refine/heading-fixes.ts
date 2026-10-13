import { approvalKey, docSections, normHeading } from './sections.js';

const MARKDOWN = /^(#{1,6})\s+\S/;

export interface HeadingFix {
  find: string;
  replace: string;
  reason: string;
}

/**
 * One patch per repeated markdown heading: a backlog item cites a section by its heading, so two sections with the
 * same one cannot be told apart. The new heading adds the parent heading, `Navegação (11.2 `hospital-web`)`.
 */
export function uniqueHeadingFixes(doc: string): HeadingFix[] {
  const all = docSections(doc);
  const parents: string[] = [];
  const rows = all.flatMap((s, i) => {
    const level = MARKDOWN.exec(s.text)?.[1]!.length ?? 0;
    if (level === 0 || approvalKey(s.heading)) return [];
    parents.length = level - 1;
    const parent = parents.filter(Boolean).at(-1);
    parents[level - 1] = s.heading;
    // The heading and its own lines, up to a nested heading.
    const nested = all[i + 1] ? s.text.indexOf(all[i + 1]!.text) : -1;
    return [{ heading: s.heading, parent, own: (nested > 0 ? s.text.slice(0, nested) : s.text).trimEnd() }];
  });
  const taken = new Set(rows.map((r) => normHeading(r.heading)));
  const fixes: HeadingFix[] = [];
  for (const r of rows) {
    if (rows.filter((o) => normHeading(o.heading) === normHeading(r.heading)).length < 2) continue;
    let heading = r.parent ? `${r.heading} (${r.parent})` : r.heading;
    for (let n = 2; taken.has(normHeading(heading)); n++) heading = `${r.heading} (${[r.parent, n].filter(Boolean).join(' ')})`;
    taken.add(normHeading(heading));
    // A section whose text is not unique cannot anchor a patch.
    if (doc.split(r.own).length !== 2) continue;
    fixes.push({
      find: r.own,
      replace: r.own.replace(/^(#{1,6})\s+.*/, (_line, hashes: string) => `${hashes} ${heading}`),
      reason: `O título "${r.heading}" se repete no design.md, e os itens do backlog citam a seção pelo título. "${heading}" deixa cada seção com título próprio.`,
    });
  }
  return fixes;
}
