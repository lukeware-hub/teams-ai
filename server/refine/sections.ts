/**
 * Sections of the target project's docs, as backlog items cite them: numbered mermaid comments (`%% 7. OPME`, the
 * Kayron flow.md style) and markdown headings. Browser-safe: the refinement screen matches citations too.
 */
export interface DocSection {
  heading: string;
  /** The section's own lines, heading included. */
  text: string;
}

const NUMBERED = /^%%\s*(\d+\.\s+\S.*?)\s*$/;
const MARKDOWN = /^(#{1,6})\s+(\S.*?)\s*$/;
const FENCE = /^\s*```/;

export const normHeading = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** A cited heading matches a doc heading when either contains the other; under three characters it matches nothing. */
export function headingMatches(cited: string, heading: string): boolean {
  const given = normHeading(cited);
  const wanted = normHeading(heading);
  return given.length >= 3 && (given.includes(wanted) || wanted.includes(given));
}

/**
 * Every section in document order. A numbered mermaid section runs to the next numbered comment or the end of its
 * code block; a markdown section runs to the next heading of the same or a higher level outside code blocks.
 */
export function docSections(doc: string): DocSection[] {
  const lines = doc.split(/\r?\n/);
  const starts: Array<{ line: number; heading: string; level: number | 'numbered'; inCode: boolean }> = [];
  let inCode = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) inCode = !inCode;
    const numbered = NUMBERED.exec(line);
    const markdown = inCode ? null : MARKDOWN.exec(line);
    if (numbered) starts.push({ line: i, heading: numbered[1]!, level: 'numbered', inCode });
    else if (markdown) starts.push({ line: i, heading: markdown[2]!, level: markdown[1]!.length, inCode });
  });
  return starts.map((s) => {
    let end = lines.length;
    for (let i = s.line + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (s.level === 'numbered') {
        if (NUMBERED.test(line) || (s.inCode && FENCE.test(line))) { end = i; break; }
      } else {
        const next = starts.find((o) => o.line === i && o.level !== 'numbered');
        if (next && (next.level as number) <= s.level) { end = i; break; }
      }
    }
    return { heading: s.heading, text: lines.slice(s.line, end).join('\n') };
  });
}

/** The text of the section a citation names, preferring an exact heading over one that merely contains it; null if none. */
export function sectionText(doc: string, heading: string): string | null {
  const sections = docSections(doc);
  const exact = sections.find((s) => normHeading(s.heading) === normHeading(heading));
  return (exact ?? sections.find((s) => headingMatches(heading, s.heading)))?.text ?? null;
}
